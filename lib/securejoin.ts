/**
 * lib/securejoin.ts — SecureJoin protocol extracted from sdk.ts
 *
 * Implements the Delta Chat SecureJoin handshake protocol:
 *   Phase 1: Joiner sends vc-request with invite number
 *   Phase 2: Inviter responds with vc-auth-required
 *   Phase 3: Joiner sends vc-request-with-auth (encrypted)
 *   Phase 4: Inviter sends vc-contact-confirm (encrypted)
 */

import type { SDKContext } from './context';
import type { ParsedMessage, SecureJoinParsed } from '../types';
import { log } from './logger';

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
    const hashIdx = uri.indexOf('#');
    if (hashIdx < 0) throw new Error('Invalid SecureJoin URI: missing # fragment');
    const fragment = uri.substring(hashIdx + 1);

    // First segment before & is the fingerprint
    const fpEnd = fragment.indexOf('&');
    const fingerprint = fpEnd >= 0 ? fragment.substring(0, fpEnd) : fragment;

    // Parse remaining params
    const paramStr = fpEnd >= 0 ? fragment.substring(fpEnd + 1) : '';
    const params: Record<string, string> = {};
    for (const kv of paramStr.split('&')) {
        const [k, v] = kv.split('=');
        if (k && v) params[k] = decodeURIComponent(v);
    }

    return {
        fingerprint,
        inviteNumber: params.i || params.j || '',  // `j` is used for broadcasts
        auth: params.s || '',
        inviterEmail: params.a || '',
        name: params.n || '',
        groupId: params.x,                          // `x` = grpid (group or broadcast)
        groupName: params.g,                         // `g` = group name
        broadcastName: params.b,                     // `b` = broadcast channel name
    };
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
    const email = encodeURIComponent(ctx.credentials.email);
    const name = encodeURIComponent(ctx.displayName || ctx.credentials.email.split('@')[0]);
    return `https://i.delta.chat/#${fp}&i=${inviteNumber}&s=${authToken}&a=${email}&n=${name}`;
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

    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('securejoin', `Sent ${step} to ${toEmail}`);
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
    const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

    const rawEmail = [
        fromHeader,
        `To: <${toEmail}>`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
        `Secure-Join: ${step}`,
        `Secure-Join-Auth: ${authToken}`,
        `Secure-Join-Fingerprint: ${bobFingerprint}`,
        ctx.buildAutocryptHeader(),
        `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${encBoundary}"`,
        `MIME-Version: 1.0`,
        '',
        `--${encBoundary}`,
        `Content-Type: application/pgp-encrypted`,
        `Content-Description: PGP/MIME version identification`,
        '',
        `Version: 1`,
        '',
        `--${encBoundary}`,
        `Content-Type: application/octet-stream; name="encrypted.asc"`,
        `Content-Description: OpenPGP encrypted message`,
        `Content-Disposition: inline; filename="encrypted.asc"`,
        '',
        armored,
        '',
        `--${encBoundary}--`
    ].join('\r\n');

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

    if (step === 'vc-request') {
        const incomingInviteNum = msg.secureJoinInviteNumber || msg.innerHeaders['secure-join-invitenumber'] || msg.headers['secure-join-invitenumber'] || '';
        if (incomingInviteNum !== myInviteNumber) {
            log.warn('securejoin', `Invite number mismatch: got "${incomingInviteNum}", expected "${myInviteNumber}"`);
            return;
        }
        log.info('securejoin', `Received vc-request from ${msg.from} — sending vc-auth-required`);
        const peerKey = ctx.knownKeys.get(msg.from.toLowerCase());
        if (peerKey) {
            await sendSecureJoinAuth(ctx, msg.from, 'vc-auth-required', myAuthToken);
        } else {
            await sendSecureJoinRequest(ctx, msg.from, myInviteNumber);
            const fromHeader = ctx.displayName
                ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
                : `From: <${ctx.credentials.email}>`;
            const sjMsgId = ctx.generateMsgId();
            const rawEmail = [
                fromHeader,
                `To: <${msg.from}>`,
                `Date: ${new Date().toUTCString()}`,
                `Message-ID: ${sjMsgId}`,
                `Subject: [...]`,
                `Chat-Version: 1.0`,
                `Secure-Join: vc-auth-required`,
                ctx.buildAutocryptHeader(),
                `Content-Type: text/plain; charset=utf-8`,
                `MIME-Version: 1.0`,
                '',
                ''
            ].join('\r\n');
            await ctx.sendRaw(ctx.credentials.email, [msg.from], rawEmail);
            log.info('securejoin', `Sent vc-auth-required (unencrypted with Autocrypt) to ${msg.from}`);
        }
    } else if (step === 'vc-request-with-auth') {
        const incomingAuth = msg.secureJoinAuth || msg.innerHeaders['secure-join-auth'] || msg.headers['secure-join-auth'] || '';
        if (incomingAuth !== myAuthToken) {
            log.warn('securejoin', `Auth token mismatch: got "${incomingAuth}", expected "${myAuthToken}"`);
            return;
        }
        log.info('securejoin', `Received vc-request-with-auth from ${msg.from} — sending vc-contact-confirm`);
        const peerKey = ctx.knownKeys.get(msg.from.toLowerCase());
        if (peerKey) {
            const innerMime = [
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                `From: <${ctx.credentials.email}>`,
                `To: <${msg.from}>`,
                `Date: ${new Date().toUTCString()}`,
                `Chat-Version: 1.0`,
                `Secure-Join: vc-contact-confirm`,
                '',
                ''
            ].join('\r\n');
            const armored = await ctx.encryptRaw(innerMime, peerKey);
            const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;
            const confirmMsgId = ctx.generateMsgId();
            const rawEmail = [
                `From: <${ctx.credentials.email}>`,
                `To: <${msg.from}>`,
                `Date: ${new Date().toUTCString()}`,
                `Message-ID: ${confirmMsgId}`,
                `Subject: [...]`,
                `Chat-Version: 1.0`,
                `Secure-Join: vc-contact-confirm`,
                ctx.buildAutocryptHeader(),
                `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${encBoundary}"`,
                `MIME-Version: 1.0`,
                '',
                `--${encBoundary}`,
                `Content-Type: application/pgp-encrypted`,
                `Content-Description: PGP/MIME version identification`,
                '',
                `Version: 1`,
                '',
                `--${encBoundary}`,
                `Content-Type: application/octet-stream; name="encrypted.asc"`,
                `Content-Description: OpenPGP encrypted message`,
                `Content-Disposition: inline; filename="encrypted.asc"`,
                '',
                armored,
                '',
                `--${encBoundary}--`
            ].join('\r\n');
            await ctx.sendRaw(ctx.credentials.email, [msg.from], rawEmail);
            log.info('securejoin', `Sent vc-contact-confirm (encrypted) to ${msg.from}`);
        }
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

