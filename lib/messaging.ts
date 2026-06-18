import { log } from './logger';

/**
 * lib/messaging.ts — All outbound message functions extracted from sdk.ts
 *
 * Each function receives an SDKContext for access to shared state (keys, credentials, etc.)
 * This matches the core's message-sending architecture:
 *   - sendMessage → Viewtype::Text
 *   - sendReply → In-Reply-To + quoted text
 *   - sendReaction → Content-Disposition: reaction (RFC 9078)
 *   - sendDelete → Chat-Delete header
 *   - sendFile → multipart/mixed with attachment (Viewtype::File)
 *   - sendImage → image/* MIME (Viewtype::Image)
 *   - sendVideo → video/* + Chat-Duration (Viewtype::Video)
 *   - sendAudio → audio/* + Chat-Duration (Viewtype::Audio)
 *   - sendVoice → audio/* + Chat-Voice-Message: 1 (Viewtype::Voice)
 *   - forwardMessage → "---------- Forwarded message ----------" prefix
 */

import type { SDKContext } from './context';

const crypto = globalThis.crypto;

// ─── Text Message ───────────────────────────────────────────────────────────────

/** Send an encrypted text message (Viewtype::Text) */
export async function sendTextMessage(ctx: SDKContext, toEmail: string, text: string): Promise<string> {
    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;

    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());

    const rawEmailLines = [
        fromHeader,
        `To: <${toEmail}>`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
        ctx.buildAutocryptHeader(),
    ];

    if (peerKey && ctx.privateKey && ctx.publicKey) {
        const armored = await ctx.encrypt(text, peerKey, {
            from: ctx.credentials.email,
            to: toEmail,
        });
        const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;
        rawEmailLines.push(
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
        );
    } else {
        rawEmailLines.push(
            `Content-Type: text/plain; charset=utf-8`,
            `MIME-Version: 1.0`,
            '',
            text
        );
    }

    const rawEmail = rawEmailLines.join('\r\n');
    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('messaging', `Sent${peerKey ? ' encrypted' : ''} message to ${toEmail} [${msgId}]`);
    return msgId;
}

// ─── Reply ──────────────────────────────────────────────────────────────────────

/** Send an encrypted reply with In-Reply-To and quoted text */
export async function sendReply(
    ctx: SDKContext,
    toEmail: string,
    parentMsgId: string,
    text: string,
    quotedText?: string
): Promise<string> {
    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`No key for ${toEmail} — cannot send encrypted reply`);
    }

    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;

    // Build quoted text block (same format as core: "> line\r\n")
    let body = '';
    if (quotedText) {
        for (const line of quotedText.split('\n')) {
            body += `> ${line}\r\n`;
        }
        body += '\r\n';
    }
    body += text;

    const innerMime = [
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
        fromHeader,
        `To: <${toEmail}>`,
        `In-Reply-To: ${parentMsgId}`,
        `Chat-Version: 1.0`,
        '',
        body
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
        `In-Reply-To: ${parentMsgId}`,
        `References: ${parentMsgId}`,
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
    log.info('messaging', `Sent reply to ${parentMsgId} → ${toEmail} [${msgId}]`);
    return msgId;
}

// ─── Reaction ───────────────────────────────────────────────────────────────────

/** Send a reaction (Content-Disposition: reaction, RFC 9078) */
export async function sendReaction(ctx: SDKContext, toEmail: string, targetMsgId: string, emoji: string): Promise<void> {
    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`No key for ${toEmail} — cannot send encrypted reaction`);
    }

    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();

    const reactionMime = [
        `Content-Disposition: reaction`,
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
        `From: <${ctx.credentials.email}>`,
        `To: <${toEmail}>`,
        `In-Reply-To: ${targetMsgId}`,
        '',
        emoji
    ].join('\r\n');

    const armored = await ctx.encryptRaw(reactionMime, peerKey);
    const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

    const rawEmail = [
        `From: <${ctx.credentials.email}>`,
        `To: <${toEmail}>`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
        `In-Reply-To: ${targetMsgId}`,
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
    log.info('messaging', `Sent reaction ${emoji} to ${targetMsgId}`);
}

// ─── Delete ─────────────────────────────────────────────────────────────────────

/** Send a delete-for-everyone request (Chat-Delete header) */
export async function sendDelete(ctx: SDKContext, toEmail: string, targetMsgId: string): Promise<void> {
    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`No key for ${toEmail} — cannot send encrypted delete`);
    }

    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();

    const deleteMime = [
        `Chat-Delete: ${targetMsgId}`,
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
        `From: <${ctx.credentials.email}>`,
        `To: <${toEmail}>`,
        '',
        '🚮'
    ].join('\r\n');

    const armored = await ctx.encryptRaw(deleteMime, peerKey);
    const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

    const rawEmail = [
        `From: <${ctx.credentials.email}>`,
        `To: <${toEmail}>`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
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
    log.info('messaging', `Sent delete request for ${targetMsgId} to ${toEmail}`);
}

// ─── Edit Message ───────────────────────────────────────────────────────────────

/** Send an edit-message request (Chat-Edit header) — updates text of an existing message */
export async function sendEdit(ctx: SDKContext, toEmail: string, targetMsgId: string, newText: string): Promise<void> {
    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`No key for ${toEmail} — cannot send encrypted edit`);
    }

    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;

    const editMime = [
        `Chat-Edit: ${targetMsgId}`,
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
        fromHeader,
        `To: <${toEmail}>`,
        '',
        newText
    ].join('\r\n');

    const armored = await ctx.encryptRaw(editMime, peerKey);
    const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

    const rawEmail = [
        fromHeader,
        `To: <${toEmail}>`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
        `Chat-Edit: ${targetMsgId}`,
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
    log.info('messaging', `Sent edit for ${targetMsgId} → "${newText.substring(0, 40)}..."`);
}

// ─── File Attachment ────────────────────────────────────────────────────────────

/** Build PGP/MIME with a file attachment (multipart/mixed inside encryption) */
async function sendAttachmentMessage(
    ctx: SDKContext,
    toEmail: string,
    filename: string,
    base64Data: string,
    mimeType: string,
    caption: string,
    extraHeaders: string[] = [],
    logEmoji = '📎',
    logLabel = 'file'
): Promise<string> {
    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`No key for ${toEmail} — cannot send encrypted ${logLabel}`);
    }

    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;
    const innerBoundary = `mixed-${crypto.randomUUID().slice(0, 8)}`;

    const headerLines = [
        `Content-Type: multipart/mixed; boundary="${innerBoundary}"; protected-headers="v1"`,
        fromHeader,
        `To: <${toEmail}>`,
        `Chat-Version: 1.0`,
        ...extraHeaders,
    ].filter(l => l.length > 0);

    const innerMime = [
        ...headerLines,
        '',
        `--${innerBoundary}`,
        `Content-Type: text/plain; charset="utf-8"`,
        '',
        caption,
        '',
        `--${innerBoundary}`,
        `Content-Type: ${mimeType}; name="${filename}"`,
        `Content-Disposition: attachment; filename="${filename}"`,
        `Content-Transfer-Encoding: base64`,
        '',
        base64Data,
        '',
        `--${innerBoundary}--`
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
    log.info('messaging', `Sent ${logLabel} "${filename}" (${mimeType}) to ${toEmail} [${msgId}]`);
    return msgId;
}

/** Send encrypted file attachment (Viewtype::File) */
export async function sendFile(
    ctx: SDKContext,
    toEmail: string,
    filename: string,
    base64Data: string,
    mimeType: string,
    caption = ''
): Promise<string> {
    return sendAttachmentMessage(ctx, toEmail, filename, base64Data, mimeType, caption, [], '📎', 'file');
}

/** Send encrypted image (Viewtype::Image) — same wire format, image/* MIME type */
export async function sendImage(
    ctx: SDKContext,
    toEmail: string,
    filename: string,
    base64Data: string,
    mimeType = 'image/jpeg',
    caption = ''
): Promise<string> {
    return sendAttachmentMessage(ctx, toEmail, filename, base64Data, mimeType, caption, [], '🖼️', 'image');
}

/** Send encrypted video (Viewtype::Video) — includes Chat-Duration */
export async function sendVideo(
    ctx: SDKContext,
    toEmail: string,
    filename: string,
    base64Data: string,
    mimeType = 'video/mp4',
    caption = '',
    durationMs = 0
): Promise<string> {
    const extra = durationMs > 0 ? [`Chat-Duration: ${durationMs}`] : [];
    return sendAttachmentMessage(ctx, toEmail, filename, base64Data, mimeType, caption, extra, '🎬', 'video');
}

/** Send encrypted audio (Viewtype::Audio) — non-voice, includes Chat-Duration */
export async function sendAudio(
    ctx: SDKContext,
    toEmail: string,
    filename: string,
    base64Data: string,
    mimeType = 'audio/mpeg',
    caption = '',
    durationMs = 0
): Promise<string> {
    const extra = durationMs > 0 ? [`Chat-Duration: ${durationMs}`] : [];
    return sendAttachmentMessage(ctx, toEmail, filename, base64Data, mimeType, caption, extra, '🎵', 'audio');
}

// ─── Voice Message ──────────────────────────────────────────────────────────────

/** Send encrypted voice message (Viewtype::Voice) — Chat-Voice-Message: 1 */
export async function sendVoice(
    ctx: SDKContext,
    toEmail: string,
    base64AudioData: string,
    durationMs = 0,
    mimeType = 'audio/ogg'
): Promise<string> {
    const extra = ['Chat-Voice-Message: 1'];
    if (durationMs > 0) extra.push(`Chat-Duration: ${durationMs}`);
    return sendAttachmentMessage(ctx, toEmail, 'voice-message.ogg', base64AudioData, mimeType, '', extra, '🎤', 'voice');
}

// ─── Forward ────────────────────────────────────────────────────────────────────

/**
 * Forward a message to another recipient.
 * Uses the same "---------- Forwarded message ----------" prefix as core's forward_msgs().
 */
export async function forwardMessage(
    ctx: SDKContext,
    toEmail: string,
    originalText: string,
    originalFrom: string
): Promise<string> {
    const fwdText = `---------- Forwarded message ----------\r\nFrom: ${originalFrom}\r\n\r\n${originalText}`;
    return sendTextMessage(ctx, toEmail, fwdText);
}
