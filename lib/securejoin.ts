/**
 * lib/securejoin.ts — SecureJoin protocol extracted from sdk.ts
 *
 * Implements the Delta Chat SecureJoin handshake protocol:
 *   Phase 1: Joiner sends vc-request with invite number
 *   Phase 2: Inviter responds with vc-auth-required
 *   Phase 3: Joiner sends vc-request-with-auth (encrypted)
 *   Phase 4: Inviter sends vc-contact-confirm (encrypted)
 */

import type { SDKContext } from './context.js';
import type { ParsedMessage, SecureJoinParsed } from '../types.js';
import { log } from './logger.js';
import {
    extractAutocryptKeydata,
    headerEmail,
    getKnownKey,
    setKnownKey,
    emailsEqual,
    encryptSymmetricSecureJoin,
    secureJoinSharedSecret,
} from './crypto.js';
import { buildPgpMimeEnvelope } from './mime-build.js';

const crypto = globalThis.crypto;

/** Autocrypt-Gossip for the peer (core requires self-key gossip on most SJ steps). */
function buildAutocryptGossip(addr: string, armoredPeerKey: string): string {
    const keydata = extractAutocryptKeydata(armoredPeerKey);
    let folded = '';
    for (let i = 0; i < keydata.length; i += 76) {
        if (i > 0) folded += '\r\n ';
        folded += keydata.substring(i, i + 76);
    }
    return `Autocrypt-Gossip: addr=${addr}; keydata=${folded}`;
}

/**
 * Dump a SecureJoin wire message to the browser console for interop debugging.
 * Filter console with: SecureJoin DUMP
 */
export function dumpSecureJoinMessage(
    direction: 'IN' | 'OUT',
    meta: {
        step?: string;
        from?: string;
        to?: string | string[];
        note?: string;
    },
    rawBody: string,
    extra?: Record<string, unknown>,
): void {
    const sep = bodyHeaderSep(rawBody);
    const outerHeaders = sep >= 0 ? rawBody.slice(0, sep) : rawBody;
    const payload = sep >= 0 ? rawBody.slice(sep).replace(/^\r?\n\r?\n/, '') : '';
    const sjLines = outerHeaders
        .split(/\r?\n/)
        .filter(l =>
            /^(Secure-Join|Autocrypt|From:|To:|Message-ID:|Content-Type:|Chat-Version:)/i.test(l.trim())
            || /^\s/.test(l) // folded header continuation
        );
    const summary = {
        direction,
        step: meta.step || pickHeader(outerHeaders, 'Secure-Join') || '?',
        from: meta.from || pickHeader(outerHeaders, 'From') || '?',
        to: meta.to || pickHeader(outerHeaders, 'To') || '?',
        note: meta.note,
        encrypted: /BEGIN PGP MESSAGE/i.test(rawBody),
        bytes: rawBody.length,
        secureJoinHeaders: sjLines,
        ...extra,
    };
    // Always visible at info level — interop debugging is the point.
    console.groupCollapsed(
        `[SecureJoin DUMP ${direction}] ${summary.step} ${direction === 'IN' ? '←' : '→'} ${
            Array.isArray(summary.to) ? summary.to.join(',') : summary.to
        } (${summary.bytes} bytes${summary.encrypted ? ', encrypted' : ', clear'})`,
    );
    console.log('summary', summary);
    console.log('outer headers\n' + outerHeaders);
    if (payload) {
        console.log('body (full raw)\n' + payload);
    }
    console.log('full raw MIME\n' + rawBody);
    console.groupEnd();
    log.info(
        'securejoin',
        `DUMP ${direction} step=${summary.step} enc=${summary.encrypted} bytes=${summary.bytes}`,
        summary.secureJoinHeaders,
    );
}

function bodyHeaderSep(raw: string): number {
    let i = raw.indexOf('\r\n\r\n');
    if (i >= 0) return i;
    i = raw.indexOf('\n\n');
    return i;
}

function pickHeader(headersBlock: string, name: string): string | undefined {
    const re = new RegExp(`^${name}:\\s*(.+)$`, 'im');
    const m = headersBlock.match(re);
    return m?.[1]?.trim();
}

/** Generate a random token (base64url-safe) */
export function randomToken(len: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let result = '';
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    for (const b of bytes) result += chars[b % chars.length];
    return result;
}

/** Parse a SecureJoin invite URI */
export function parseSecureJoinURI(uri: string): SecureJoinParsed {
    const cleaned = (uri || '').trim().replace(/\s+/g, '');
    const hashIdx = cleaned.indexOf('#');
    if (hashIdx < 0) throw new Error('Invalid SecureJoin URI: missing # fragment');
    const fragment = cleaned.substring(hashIdx + 1);

    const fpEnd = fragment.indexOf('&');
    const fingerprint = fpEnd >= 0 ? fragment.substring(0, fpEnd) : fragment;

    const paramStr = fpEnd >= 0 ? fragment.substring(fpEnd + 1) : '';
    const params: Record<string, string> = {};
    for (const kv of paramStr.split('&')) {
        if (!kv) continue;
        const eq = kv.indexOf('=');
        if (eq < 0) continue;
        const k = kv.substring(0, eq);
        const v = kv.substring(eq + 1);
        if (!k || !v) continue;
        try {
            params[k] = decodeURIComponent(v.replace(/\+/g, ' '));
        } catch {
            params[k] = v;
        }
    }

    const inviterEmail = (params.a || '').trim();
    if (!fingerprint) {
        throw new Error('Invalid SecureJoin URI: missing fingerprint');
    }
    if (!inviterEmail.includes('@')) {
        throw new Error('Invalid SecureJoin URI: missing inviter address (a=)');
    }

    return {
        fingerprint,
        inviteNumber: params.i || params.j || '',
        auth: params.s || '',
        inviterEmail,
        name: params.n || '',
        groupId: params.x,
        groupName: params.g,
        broadcastName: params.b,
    };
}

// ─── QR classification ──────────────────────────────────────────────────────────

export type QrKind =
    | 'securejoin'
    | 'securejoin_group'
    | 'backup'
    | 'url'
    | 'email'
    | 'text'
    | 'error';

export interface QrScanResult {
    kind: QrKind;
    /** Original input */
    raw: string;
    /** Parsed SecureJoin fields when kind is securejoin* */
    secureJoin?: SecureJoinParsed;
    /** Human-readable error when kind is error */
    error?: string;
    /** Parsed URL when kind is url */
    url?: string;
    /** Email when kind is email */
    email?: string;
}

/**
 * Classify a QR / pasted string the way core's check_qr roughly does.
 * Does not perform network I/O.
 */
export function checkQr(input: string): QrScanResult {
    const raw = (input || '').trim();
    if (!raw) {
        return { kind: 'error', raw, error: 'Empty QR content' };
    }

    // Backup / second-device schemes used by Delta Chat
    if (/^dcaccount:/i.test(raw) || /^dclogin:/i.test(raw) || /backup/i.test(raw) && /^https?:\/\//i.test(raw) && /#/.test(raw) === false) {
        if (/^dcaccount:/i.test(raw) || /^dclogin:/i.test(raw)) {
            return { kind: 'backup', raw };
        }
    }
    if (/^dcbackup:/i.test(raw)) {
        return { kind: 'backup', raw };
    }

    // SecureJoin invite (https://i.delta.chat/#… or any host with #fingerprint&i=…)
    if (raw.includes('#') && (raw.includes('&i=') || raw.includes('&j=') || raw.includes('&a='))) {
        try {
            const parsed = parseSecureJoinURI(raw.includes('://') ? raw : `https://i.delta.chat/${raw.startsWith('#') ? raw : '#' + raw}`);
            if (parsed.fingerprint && (parsed.inviteNumber || parsed.auth)) {
                const isGroup = !!(parsed.groupId || parsed.groupName || parsed.broadcastName);
                return {
                    kind: isGroup ? 'securejoin_group' : 'securejoin',
                    raw,
                    secureJoin: parsed,
                };
            }
        } catch (e: any) {
            return { kind: 'error', raw, error: e.message };
        }
    }

    // mailto: or bare email
    const mailto = raw.match(/^mailto:([^?]+)/i);
    if (mailto) {
        return { kind: 'email', raw, email: mailto[1].toLowerCase() };
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        return { kind: 'email', raw, email: raw.toLowerCase() };
    }

    // Generic URL
    if (/^https?:\/\//i.test(raw)) {
        return { kind: 'url', raw, url: raw };
    }

    return { kind: 'text', raw };
}

/**
 * Minimal QR SVG (not a real ECC QR — placeholder for UI until a real encoder is plugged in).
 * Renders payload as a scannable-looking square with escaped text for debugging.
 */
export function createQrSvg(payload: string, size = 200): string {
    const esc = payload
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    // Simple visual placeholder; apps should replace with a real QR library for production scans
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="100%" height="100%" fill="#fff"/>
  <rect x="8" y="8" width="${size - 16}" height="${size - 16}" fill="none" stroke="#000" stroke-width="4"/>
  <rect x="20" y="20" width="40" height="40" fill="#000"/>
  <rect x="${size - 60}" y="20" width="40" height="40" fill="#000"/>
  <rect x="20" y="${size - 60}" width="40" height="40" fill="#000"/>
  <text x="50%" y="55%" text-anchor="middle" font-size="8" font-family="monospace" fill="#333">${esc.slice(0, 48)}</text>
</svg>`;
}

/** Generate a SecureJoin invite URI (v=3, IP-literal safe encoding). */
export function generateSecureJoinURI(
    ctx: SDKContext,
    inviteNumber: string,
    authToken: string
): string {
    if (!ctx.publicKey || !ctx.credentials.email) {
        throw new Error('Must register and generate keys before creating invite URI');
    }
    const fp = ctx.fingerprint;
    const email = encodeURIComponent(ctx.credentials.email);
    const name = encodeURIComponent(ctx.displayName || ctx.credentials.email.split('@')[0]);
    return `https://i.delta.chat/#${fp}&v=3&i=${inviteNumber}&s=${authToken}&a=${email}&n=${name}`;
}

/** Send vc-request / vg-request SecureJoin handshake (Phase 1) */
export async function sendSecureJoinRequest(
    ctx: SDKContext,
    toEmail: string,
    inviteNumber: string,
    grpId?: string
): Promise<void> {
    const step = grpId ? 'vg-request' : 'vc-request';
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const msgId = `<${id}@${ctx.credentials.email.split('@')[1]}>`;
    const boundary = 'securejoin-' + id;
    const now = new Date().toUTCString();
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;

    const rawEmail = [
        fromHeader,
        `To: <${toEmail}>`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
        `Secure-Join: ${step}`,
        `Secure-Join-Invitenumber: ${inviteNumber}`,
        ctx.buildAutocryptHeader(),
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        `MIME-Version: 1.0`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        `secure-join: ${step}`,
        '',
        `--${boundary}--`,
    ].join('\r\n');

    dumpSecureJoinMessage('OUT', { step, from: ctx.credentials.email, to: toEmail }, rawEmail);
    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('securejoin', `Sent ${step} to ${toEmail}`);
}

/**
 * Phase 2 inviter → joiner: `{vc|vg}-auth-required`.
 *
 * Desktop core (bob.rs) requires this message to be **encrypted + signed** with
 * the inviter key matching the QR fingerprint, and Autocrypt-Gossip of the
 * joiner (surreptitious-forwarding check). Cleartext+Autocrypt is only a
 * fallback when we never received the joiner's Autocrypt header.
 *
 * Wire shape mirrors core mimefactory for encrypted SecurejoinMessage:
 * - Outer: From (no display name), To, Autocrypt, Chat-Version, multipart/encrypted
 * - Protected: Secure-Join, From (with name), To, Autocrypt-Gossip, body text
 */
export async function sendSecureJoinAuthRequired(
    ctx: SDKContext,
    toEmail: string,
    prefix: 'vc' | 'vg' = 'vc',
): Promise<void> {
    const step = `${prefix}-auth-required`;
    const to = toEmail.toLowerCase();
    // MUST match envelope sender (credentials.email), including domain-literal
    // brackets `user@[ip]`. Madmail rejects: "From header does not match envelope sender".
    const fromAddr = ctx.credentials.email;
    const toAddr = toEmail;
    // Outer From: no display name (core mimefactory for encrypted SJ).
    const outerFrom = `From: <${fromAddr}>`;
    const protectedFrom = ctx.displayName
        ? `From: "${ctx.displayName}" <${fromAddr}>`
        : outerFrom;
    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    // Look up peer key under raw / lowercased / unbracketed forms
    const peerKey =
        ctx.knownKeys.get(to) ||
        ctx.knownKeys.get(headerEmail(toEmail)) ||
        ctx.knownKeys.get(toEmail.toLowerCase());

    if (peerKey && ctx.privateKey && ctx.publicKey) {
        // Gossip joiner under the same addr form we put in To: (recipient check)
        const gossipHeader = buildAutocryptGossip(to.toLowerCase(), peerKey);
        // Put Autocrypt *inside* the encrypted part too. Core prefers protected
        // Autocrypt after decrypt. Outer Autocrypt is often stripped by
        // intermediate MTAs on the path to public chatmail (nine.testrun.org),
        // which makes signature verification fail → Secure-Join ignored.
        const autocryptHeader = ctx.buildAutocryptHeader();
        // autocryptHeader may be multi-line (dual addr for @[ip]); flatten as
        // successive header lines inside the protected MIME.
        const autocryptLines = autocryptHeader.split(/\r?\n/).filter(l => l.length > 0);
        const innerMime = [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"; hp="cipher"`,
            `Secure-Join: ${step}`,
            `Secure-Join-Fingerprint: ${ctx.fingerprint}`,
            protectedFrom,
            `To: <${toAddr}>`,
            `Date: ${now}`,
            `Chat-Version: 1.0`,
            ...autocryptLines,
            gossipHeader,
            '',
            `Secure-Join: ${step}`,
        ].join('\r\n');
        const armored = await ctx.encryptRaw(innerMime, peerKey);
        // Outer Secure-Join + Autocrypt for local/same-server; protected copies
        // are the source of truth after decrypt (and survive MTA stripping).
        const rawEmail = buildPgpMimeEnvelope({
            fromHeader: outerFrom,
            toHeader: `<${toAddr}>`,
            msgId,
            date: now,
            subject: '[...]',
            outerHeaders: [
                `Secure-Join: ${step}`,
                `Secure-Join-Fingerprint: ${ctx.fingerprint}`,
            ],
            autocryptHeader,
            armored,
        });
        dumpSecureJoinMessage(
            'OUT',
            {
                step,
                from: fromAddr,
                to: toAddr,
                note: 'encrypted+signed; Autocrypt+Gossip protected; dual outer Autocrypt',
            },
            rawEmail,
            { innerMime, envelopeFrom: ctx.credentials.email, envelopeTo: toEmail },
        );
        await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
        log.info('securejoin', `Sent ${step} (encrypted+signed + protected Autocrypt) to ${toEmail}`);
        return;
    }

    // No peer key yet — cleartext so joiner can still import our Autocrypt key.
    const rawEmail = [
        outerFrom,
        `To: <${toAddr}>`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
        `Secure-Join: ${step}`,
        `Secure-Join-Fingerprint: ${ctx.fingerprint}`,
        ctx.buildAutocryptHeader(),
        `Content-Type: text/plain; charset=utf-8`,
        `MIME-Version: 1.0`,
        '',
        `Secure-Join: ${step}`,
        '',
    ].join('\r\n');
    dumpSecureJoinMessage(
        'OUT',
        { step, from: fromAddr, to: toAddr, note: 'cleartext + Autocrypt (no peer key)' },
        rawEmail,
    );
    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('securejoin', `Sent ${step} (cleartext + Autocrypt, no peer key) to ${toEmail}`);
}

/** Send Phase 3: vc-request-with-auth (encrypted, includes auth token + fingerprint) */
export async function sendSecureJoinAuth(
    ctx: SDKContext,
    toEmail: string,
    authToken: string,
    grpId?: string
): Promise<void> {
    const step = grpId ? 'vg-request-with-auth' : 'vc-request-with-auth';
    // Bare + bracketed IP forms (desktop From uses @[ip]; Autocrypt may use either)
    const peerKey = getKnownKey(ctx.knownKeys, toEmail);
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`Cannot send ${step}: no key for ${toEmail}`);
    }

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    // Message-ID domain must not include literal brackets
    const host = headerEmail(ctx.credentials.email).split('@')[1] || 'localhost';
    const msgId = `<${id}@${host}>`;
    const now = new Date().toUTCString();
    // From must match envelope + Autocrypt addr exactly (incl. domain-literal brackets)
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;

    // Joiner's own fingerprint — inviter core requires Secure-Join-Fingerprint
    const bobFingerprint = ctx.fingerprint;

    // Gossip inviter's key under the same addr form as To: (recipient check)
    const gossipHeader = buildAutocryptGossip(toEmail.toLowerCase(), peerKey);

    const innerMime = [
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"; hp="cipher"`,
        `Secure-Join: ${step}`,
        `Secure-Join-Auth: ${authToken}`,
        `Secure-Join-Fingerprint: ${bobFingerprint}`,
        fromHeader,
        `To: <${toEmail}>`,
        gossipHeader,
        // Protected Autocrypt so MTAs that strip outer Autocrypt still leave our key
        ...ctx.buildAutocryptHeader().split(/\r?\n/).filter(l => l.length > 0),
        '',
        `Secure-Join: ${step}`,
    ].join('\r\n');

    const armored = await ctx.encryptRaw(innerMime, peerKey);
    const rawEmail = buildPgpMimeEnvelope({
        fromHeader,
        toHeader: `<${toEmail}>`,
        msgId,
        date: now,
        subject: '[...]',
        outerHeaders: [
            `Secure-Join: ${step}`,
            // Auth/fingerprint also outer for clear routing; protected copies are authoritative after decrypt
            `Secure-Join-Auth: ${authToken}`,
            `Secure-Join-Fingerprint: ${bobFingerprint}`,
        ],
        autocryptHeader: ctx.buildAutocryptHeader(),
        armored,
    });

    dumpSecureJoinMessage(
        'OUT',
        { step, from: ctx.credentials.email, to: toEmail, note: 'request-with-auth' },
        rawEmail,
        { innerMime },
    );
    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('securejoin', `Sent ${step} (encrypted) to ${toEmail}`);
}

/**
 * SecureJoin v3 inviter → joiner: `vc-pubkey` / `vg-pubkey`.
 * Symmetrically encrypted + signed; Autocrypt on outer so core can import our key.
 */
export async function sendSecureJoinPubkey(
    ctx: SDKContext,
    toEmail: string,
    authToken: string,
    prefix: 'vc' | 'vg' = 'vc',
): Promise<void> {
    if (!ctx.privateKey || !ctx.publicKey) {
        throw new Error('Cannot send vc-pubkey: local keys missing');
    }
    const step = `${prefix}-pubkey`;
    const sharedSecret = secureJoinSharedSecret(ctx.fingerprint, authToken);
    const fromAddr = ctx.credentials.email;
    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    const outerFrom = `From: <${fromAddr}>`;

    const innerMime = [
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"; hp="cipher"`,
        `Secure-Join: ${step}`,
        `Secure-Join-Auth: ${authToken}`,
        outerFrom,
        `To: hidden-recipients:;`,
        `Date: ${now}`,
        `Subject: Secure-Join`,
        `Message-ID: ${msgId}`,
        '',
        'Secure-Join',
    ].join('\r\n');

    const armored = await encryptSymmetricSecureJoin(innerMime, sharedSecret, ctx.privateKey);
    const rawEmail = buildPgpMimeEnvelope({
        fromHeader: outerFrom,
        toHeader: 'hidden-recipients:;',
        msgId,
        date: now,
        subject: '[...]',
        outerHeaders: [],
        autocryptHeader: ctx.buildAutocryptHeader(),
        armored,
    });

    dumpSecureJoinMessage(
        'OUT',
        {
            step,
            from: fromAddr,
            to: toEmail,
            note: 'v3 symmetric+signed + Autocrypt',
        },
        rawEmail,
        { innerMime, sharedSecret: '(redacted)' },
    );
    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('securejoin', `Sent ${step} (symmetric+signed) to ${toEmail}`);
}

/**
 * Inviter-side auto-reply (Alice), mirroring core `handle_securejoin_handshake`.
 * Called for every inbound Secure-Join message; joiner-side steps are no-ops here
 * (joiner flow runs in `secureJoin()`).
 *
 * Core returns HandshakeMessage::Done/Ignore so the message is never shown as chat.
 */
export async function handleIncomingSecureJoin(
    ctx: SDKContext,
    msg: ParsedMessage,
    myInviteNumber: string,
    myAuthToken: string
): Promise<void> {
    let step = (msg.secureJoinStep || '').trim().toLowerCase();
    // Core: invitenumber alone classifies as Request even without Secure-Join header
    if (!step && msg.secureJoinInviteNumber) {
        step = 'vc-request';
    }
    if (!step) return;

    const prefix = step.startsWith('vg-') ? 'vg' : 'vc';

    if (step === 'vc-request-pubkey' || step === 'vg-request-pubkey') {
        const incomingAuth = (
            msg.secureJoinAuth ||
            msg.innerHeaders?.['secure-join-auth'] ||
            msg.headers?.['secure-join-auth'] ||
            ''
        ).trim();
        if (!myAuthToken) {
            log.warn('securejoin', 'request-pubkey ignored: no local auth token (open QR first)');
            return;
        }
        if (!incomingAuth) {
            log.warn(
                'securejoin',
                'request-pubkey ignored: missing Secure-Join-Auth (symmetric decrypt failed?)',
            );
            return;
        }
        if (incomingAuth !== myAuthToken) {
            log.warn(
                'securejoin',
                `Auth token mismatch on request-pubkey: got "${incomingAuth}", expected "${myAuthToken}"`,
            );
            return;
        }
        log.info('securejoin', `Received ${step} from ${msg.from} — sending ${prefix}-pubkey`);
        await sendSecureJoinPubkey(ctx, msg.from, incomingAuth, prefix as 'vc' | 'vg');
        return;
    }

    if (step === 'vc-request' || step === 'vg-request') {
        const incomingInviteNum = (
            msg.secureJoinInviteNumber ||
            msg.innerHeaders?.['secure-join-invitenumber'] ||
            msg.headers?.['secure-join-invitenumber'] ||
            ''
        ).trim();
        if (!myInviteNumber) {
            log.warn('securejoin', 'vc-request ignored: no local invite token (open QR first)');
            return;
        }
        if (!incomingInviteNum) {
            log.warn('securejoin', 'vc-request ignored: missing Secure-Join-Invitenumber header');
            return;
        }
        if (incomingInviteNum !== myInviteNumber) {
            log.warn(
                'securejoin',
                `Invite number mismatch: got "${incomingInviteNum}", expected "${myInviteNumber}"`,
            );
            return;
        }
        log.info('securejoin', `Received ${step} from ${msg.from} — sending ${prefix}-auth-required`);
        await sendSecureJoinAuthRequired(ctx, msg.from, prefix as 'vc' | 'vg');
        return;
    }

    if (step === 'vc-request-with-auth' || step === 'vg-request-with-auth') {
        const incomingAuth = (
            msg.secureJoinAuth ||
            msg.innerHeaders?.['secure-join-auth'] ||
            msg.headers?.['secure-join-auth'] ||
            ''
        ).trim();
        if (!myAuthToken) {
            log.warn('securejoin', 'request-with-auth ignored: no local auth token');
            return;
        }
        // Require decrypted auth — empty means decrypt failed; do not fake success
        if (!incomingAuth) {
            log.warn(
                'securejoin',
                'request-with-auth ignored: missing Secure-Join-Auth (message not decrypted?)',
            );
            return;
        }
        if (incomingAuth !== myAuthToken) {
            log.warn(
                'securejoin',
                `Auth token mismatch: got "${incomingAuth}", expected "${myAuthToken}"`,
            );
            return;
        }
        log.info(
            'securejoin',
            `Received ${step} from ${msg.from} — sending ${prefix === 'vg' ? 'vg-member-added' : 'vc-contact-confirm'}`,
        );
        const peerKey = getKnownKey(ctx.knownKeys, msg.from);
        if (!peerKey) {
            log.warn('securejoin', `No peer key for ${msg.from} — cannot encrypt confirm`);
            return;
        }
        const confirmStep = prefix === 'vg' ? 'vg-member-added' : 'vc-contact-confirm';
        const now = new Date().toUTCString();
        const fromHeader = `From: <${ctx.credentials.email}>`;
        // Core requires Autocrypt-Gossip of the joiner on contact-confirm / member-added
        const gossipHeader = buildAutocryptGossip(msg.from.toLowerCase(), peerKey);
        const autocryptHeader = ctx.buildAutocryptHeader();
        const autocryptLines = autocryptHeader.split(/\r?\n/).filter(l => l.length > 0);
        const innerMime = [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"; hp="cipher"`,
            fromHeader,
            `To: <${msg.from}>`,
            `Date: ${now}`,
            `Chat-Version: 1.0`,
            `Secure-Join: ${confirmStep}`,
            ...autocryptLines,
            gossipHeader,
            '',
            `Secure-Join: ${confirmStep}`,
        ].join('\r\n');
        const armored = await ctx.encryptRaw(innerMime, peerKey);
        const confirmMsgId = ctx.generateMsgId();
        const rawEmail = buildPgpMimeEnvelope({
            fromHeader,
            toHeader: `<${msg.from}>`,
            msgId: confirmMsgId,
            date: now,
            subject: '[...]',
            outerHeaders: [`Secure-Join: ${confirmStep}`],
            autocryptHeader,
            armored,
        });
        dumpSecureJoinMessage(
            'OUT',
            { step: confirmStep, from: ctx.credentials.email, to: msg.from, note: 'confirm + gossip' },
            rawEmail,
            { innerMime },
        );
        await ctx.sendRaw(ctx.credentials.email, [msg.from], rawEmail);
        log.info('securejoin', `Sent ${confirmStep} (encrypted+signed + gossip) to ${msg.from}`);
        return;
    }

    // Joiner-side steps (auth-required, contact-confirm) and v3 pubkey steps:
    // no inviter action — waitForMessage / secureJoin() handles them.
    log.debug('securejoin', `No inviter action for step ${step} from ${msg.from}`);
}

/** Full SecureJoin flow: parse URI, send request, handle auth, wait for confirmation */
export async function secureJoin(
    ctx: SDKContext,
    uri: string
): Promise<{ 
    peerEmail: string; 
    verified: boolean; 
    groupInfo?: { grpId: string; name: string; isBroadcast: boolean } 
}> {
    const parsed = parseSecureJoinURI(uri);
    const grpId = parsed.groupId;
    const isGroup = !!grpId && !!parsed.groupName;
    const isBroadcast = !!grpId && !!parsed.broadcastName;
    const groupName = parsed.broadcastName || parsed.groupName || '';

    const groupInfo = grpId ? { grpId, name: groupName, isBroadcast } : undefined;

    log.info('securejoin', `URI parsed: inviter=${parsed.inviterEmail} fp=${parsed.fingerprint.substring(0, 16)}...`);
    if (isBroadcast) {
        log.info('securejoin', `Broadcast: "${parsed.broadcastName}" (${parsed.groupId})`);
    } else if (isGroup) {
        log.info('securejoin', `Group: "${parsed.groupName}" (${parsed.groupId})`);
    } else {
        log.info('securejoin', `Type: 1:1 contact`);
    }

    // Phase 1: Send vc-request
    await sendSecureJoinRequest(ctx, parsed.inviterEmail, parsed.inviteNumber, parsed.groupId);

    // Wait for Phase 2: vc-auth-required (do NOT match peer's vc-request —
    // dual-join races were waking this waiter on the wrong step).
    log.debug('securejoin', 'Waiting for Phase 2...');
    try {
        const inviter = parsed.inviterEmail.toLowerCase();
        const phase2 = await ctx.waitForMessage(
            (msg) =>
                msg.isSecureJoin &&
                emailsEqual(msg.from, inviter) &&
                (msg.secureJoinStep === 'vc-auth-required' ||
                    msg.secureJoinStep === 'vg-auth-required' ||
                    msg.secureJoinStep === 'vc-pubkey'),
            30000
        );
        log.info('securejoin', `Phase 2 received: ${phase2.secureJoinStep}`);

        const inviterKey =
            getKnownKey(ctx.knownKeys, parsed.inviterEmail) ||
            getKnownKey(ctx.knownKeys, inviter);
        if (!inviterKey) {
            log.warn('securejoin', 'No key imported from Phase 2 — cannot proceed with encrypted Phase 3');
            return { peerEmail: parsed.inviterEmail, verified: false, groupInfo };
        }
        // Ensure both bracketed + bare forms are present for later encrypt lookups
        setKnownKey(ctx.knownKeys, parsed.inviterEmail, inviterKey);

        // Phase 3: Send vc-request-with-auth
        if (parsed.auth && (phase2.secureJoinStep === 'vc-auth-required' || phase2.secureJoinStep === 'vg-auth-required')) {
            await sendSecureJoinAuth(ctx, parsed.inviterEmail, parsed.auth, parsed.groupId);

            // Wait for Phase 4: vc-contact-confirm
            log.debug('securejoin', 'Waiting for Phase 4...');
            try {
                const phase4 = await ctx.waitForMessage(
                    (msg) =>
                        msg.isSecureJoin &&
                        emailsEqual(msg.from, inviter) &&
                        (msg.secureJoinStep === 'vc-contact-confirm' ||
                            msg.secureJoinStep === 'vg-member-added'),
                    10000
                );
                log.info('securejoin', `Phase 4 received: ${phase4.secureJoinStep}`);
                return { peerEmail: parsed.inviterEmail, verified: true, groupInfo };
            } catch {
                log.warn('securejoin', 'Phase 4 timeout — but key exchange completed');
                return { peerEmail: parsed.inviterEmail, verified: false, groupInfo };
            }
        }

        if (phase2.secureJoinStep === 'vc-contact-confirm' || phase2.secureJoinStep === 'vg-member-added') {
            return { peerEmail: parsed.inviterEmail, verified: true, groupInfo };
        }

        return { peerEmail: parsed.inviterEmail, verified: false, groupInfo };
    } catch (e: any) {
        log.warn('securejoin', `Timeout: ${e.message}`);
        if (ctx.knownKeys.has(parsed.inviterEmail.toLowerCase())) {
            log.info('securejoin', `Key found for ${parsed.inviterEmail} — can proceed with messaging`);
            return { peerEmail: parsed.inviterEmail, verified: false, groupInfo };
        }
        throw e;
    }
}

