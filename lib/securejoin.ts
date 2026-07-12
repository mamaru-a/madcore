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
import { buildFromHeader, buildPgpMimeEnvelope } from './mime-build.js';

const crypto = globalThis.crypto;

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
    // Tolerate whitespace / newlines from paste or QR readers
    const cleaned = (uri || '').trim().replace(/\s+/g, '');
    const hashIdx = cleaned.indexOf('#');
    if (hashIdx < 0) throw new Error('Invalid SecureJoin URI: missing # fragment');
    const fragment = cleaned.substring(hashIdx + 1);

    // First segment before & is the fingerprint
    const fpEnd = fragment.indexOf('&');
    const fingerprint = fpEnd >= 0 ? fragment.substring(0, fpEnd) : fragment;

    // Parse remaining params — split only on first `=` so values may contain `=`
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
            // `+` in query-style names should be space; encodeURIComponent uses %20
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
        inviteNumber: params.i || params.j || '',  // `j` is used for broadcasts
        auth: params.s || '',
        inviterEmail,
        name: params.n || '',
        groupId: params.x,                          // `x` = grpid (group or broadcast)
        groupName: params.g,                         // `g` = group name
        broadcastName: params.b,                     // `b` = broadcast channel name
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

/** Generate a SecureJoin invite URI */
export function generateSecureJoinURI(
    ctx: SDKContext,
    inviteNumber: string,
    authToken: string
): string {
    if (!ctx.publicKey || !ctx.credentials.email) {
        throw new Error('Must register and generate keys before creating invite URI');
    }
    const fp = ctx.fingerprint;
    // encodeURIComponent keeps IP-literal brackets as %5B/%5D (required for a=)
    const email = encodeURIComponent(ctx.credentials.email);
    const name = encodeURIComponent(ctx.displayName || ctx.credentials.email.split('@')[0]);
    // v=3 matches current Delta Chat invite format (ignored by parsers that don't need it)
    return `https://i.delta.chat/#${fp}&v=3&i=${inviteNumber}&s=${authToken}&a=${email}&n=${name}`;
}

/** Domain part for Message-ID — handles IP-literal emails user@[1.2.3.4]. */
function msgIdDomain(email: string): string {
    const at = email.lastIndexOf('@');
    if (at < 0) return 'localhost';
    let host = email.slice(at + 1);
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
    return host || 'localhost';
}

/**
 * Unencrypted Secure-Join step as multipart/mixed (madmail/chatmail requirement).
 * Body must start with `secure-join: <step>` or the relay rejects it.
 */
export async function sendSecureJoinPlainStep(
    ctx: SDKContext,
    toEmail: string,
    step: string,
    extraHeaders: string[] = [],
): Promise<void> {
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const msgId = `<${id}@${msgIdDomain(ctx.credentials.email)}>`;
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
        ...extraHeaders,
        ctx.buildAutocryptHeader(),
        `MIME-Version: 1.0`,
        `Content-Type: multipart/mixed; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        // Madmail: body must contain `secure-join:` (header-only is rejected)
        `secure-join: ${step}`,
        '',
        `--${boundary}--`,
        '',
    ].join('\r\n');

    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('securejoin', `Sent ${step} to ${toEmail}`);
}

/** Send vc-request / vg-request SecureJoin handshake (Phase 1) */
export async function sendSecureJoinRequest(
    ctx: SDKContext,
    toEmail: string,
    inviteNumber: string,
    grpId?: string
): Promise<void> {
    const step = grpId ? 'vg-request' : 'vc-request';
    await sendSecureJoinPlainStep(ctx, toEmail, step, [
        `Secure-Join-Invitenumber: ${inviteNumber}`,
    ]);
}

/** Send Phase 3: vc-request-with-auth (encrypted, includes auth token + fingerprint) */
export async function sendSecureJoinAuth(
    ctx: SDKContext,
    toEmail: string,
    authToken: string,
    grpId?: string
): Promise<void> {
    const step = grpId ? 'vg-request-with-auth' : 'vc-request-with-auth';
    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`Cannot send ${step}: no key for ${toEmail}`);
    }

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const msgId = `<${id}@${ctx.credentials.email.split('@')[1]}>`;
    const now = new Date().toUTCString();
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;

    // Bob's own fingerprint — Alice's core requires this in Secure-Join-Fingerprint header
    const bobFingerprint = ctx.fingerprint;

    // Build Autocrypt-Gossip header for Alice's key (surreptitious forwarding protection)
    // Alice's core checks that its own key is gossiped back
    const peerKeyB64 = peerKey
        .replace(/-----BEGIN PGP PUBLIC KEY BLOCK-----/, '')
        .replace(/-----END PGP PUBLIC KEY BLOCK-----/, '')
        .replace(/\n/g, '')
        .trim();
    const gossipHeader = `Autocrypt-Gossip: addr=${toEmail}; keydata=${peerKeyB64}`;

    const innerMime = [
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
        `Secure-Join: ${step}`,
        `Secure-Join-Auth: ${authToken}`,
        `Secure-Join-Fingerprint: ${bobFingerprint}`,
        fromHeader,
        `To: <${toEmail}>`,
        gossipHeader,
        '',
        `secure-join: ${step}`
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
            `Secure-Join-Auth: ${authToken}`,
            `Secure-Join-Fingerprint: ${bobFingerprint}`,
        ],
        autocryptHeader: ctx.buildAutocryptHeader(),
        armored,
    });

    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('securejoin', `Sent ${step} (encrypted) to ${toEmail}`);
}

/** Handle incoming SecureJoin as INVITER (respond to vc-request, vc-request-with-auth) */
export async function handleIncomingSecureJoin(
    ctx: SDKContext,
    msg: ParsedMessage,
    myInviteNumber: string,
    myAuthToken: string
): Promise<void> {
    const step = msg.secureJoinStep?.trim();
    if (!step) return;

    if (step === 'vc-request' || step === 'vg-request') {
        const incomingInviteNum = msg.secureJoinInviteNumber || msg.innerHeaders['secure-join-invitenumber'] || msg.headers['secure-join-invitenumber'] || '';
        if (!myInviteNumber || incomingInviteNum !== myInviteNumber) {
            log.warn('securejoin', `Invite number mismatch: got "${incomingInviteNum}", expected "${myInviteNumber || '(none)'}"`);
            return;
        }
        // Phase 2: reply with *-auth-required + Autocrypt so the joiner learns
        // our public key. Madmail only accepts unencrypted SecureJoin as
        // multipart/mixed with body prefix `secure-join:` (header-only text/plain
        // is rejected as Invalid Unencrypted Mail).
        const authStep = step === 'vg-request' ? 'vg-auth-required' : 'vc-auth-required';
        log.info('securejoin', `Received ${step} from ${msg.from} — sending ${authStep}`);
        await sendSecureJoinPlainStep(ctx, msg.from, authStep);
        log.info('securejoin', `Sent ${authStep} (Autocrypt multipart) to ${msg.from}`);
    } else if (step === 'vc-request-with-auth' || step === 'vg-request-with-auth') {
        const incomingAuth = msg.secureJoinAuth || msg.innerHeaders['secure-join-auth'] || msg.headers['secure-join-auth'] || '';
        if (!myAuthToken || incomingAuth !== myAuthToken) {
            log.warn('securejoin', `Auth token mismatch: got "${incomingAuth}", expected "${myAuthToken || '(none)'}"`);
            return;
        }
        const confirmStep = step === 'vg-request-with-auth' ? 'vg-member-added' : 'vc-contact-confirm';
        log.info('securejoin', `Received ${step} from ${msg.from} — sending ${confirmStep}`);
        const peerKey = ctx.knownKeys.get(msg.from.toLowerCase());
        if (!peerKey) {
            log.warn('securejoin', `No key for ${msg.from} — cannot encrypt ${confirmStep}`);
            return;
        }
        const innerMime = [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            `From: <${ctx.credentials.email}>`,
            `To: <${msg.from}>`,
            `Date: ${new Date().toUTCString()}`,
            `Chat-Version: 1.0`,
            `Secure-Join: ${confirmStep}`,
            '',
            '',
        ].join('\r\n');
        const armored = await ctx.encryptRaw(innerMime, peerKey);
        const confirmMsgId = ctx.generateMsgId();
        const rawEmail = buildPgpMimeEnvelope({
            fromHeader: `From: <${ctx.credentials.email}>`,
            toHeader: `<${msg.from}>`,
            msgId: confirmMsgId,
            date: new Date().toUTCString(),
            subject: '[...]',
            outerHeaders: [`Secure-Join: ${confirmStep}`],
            autocryptHeader: ctx.buildAutocryptHeader(),
            armored,
        });
        await ctx.sendRaw(ctx.credentials.email, [msg.from], rawEmail);
        log.info('securejoin', `Sent ${confirmStep} (encrypted) to ${msg.from}`);
    }
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

    // Wait for Phase 2: vc-auth-required
    log.debug('securejoin', 'Waiting for Phase 2...');
    try {
        const phase2 = await ctx.waitForMessage(
            (msg) => msg.isSecureJoin && msg.from === parsed.inviterEmail.toLowerCase(),
            30000
        );
        log.info('securejoin', `Phase 2 received: ${phase2.secureJoinStep}`);

        if (!ctx.knownKeys.has(parsed.inviterEmail.toLowerCase())) {
            log.warn('securejoin', 'No key imported from Phase 2 — cannot proceed with encrypted Phase 3');
            return { peerEmail: parsed.inviterEmail, verified: false, groupInfo };
        }

        // Phase 3: Send vc-request-with-auth
        if (parsed.auth && (phase2.secureJoinStep === 'vc-auth-required' || phase2.secureJoinStep === 'vg-auth-required')) {
            await sendSecureJoinAuth(ctx, parsed.inviterEmail, parsed.auth, parsed.groupId);

            // Wait for Phase 4: vc-contact-confirm
            log.debug('securejoin', 'Waiting for Phase 4...');
            try {
                const phase4 = await ctx.waitForMessage(
                    (msg) => msg.isSecureJoin && msg.from === parsed.inviterEmail.toLowerCase() &&
                        (msg.secureJoinStep === 'vc-contact-confirm' || msg.secureJoinStep === 'vg-member-added'),
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

