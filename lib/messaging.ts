import { log } from './logger.js';

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

import type { SDKContext } from './context.js';
import { getKnownKey } from './crypto.js';
import {
    buildFromHeader,
    buildInnerMultipart,
    buildInnerText,
    buildPgpMimeEnvelope,
    bracketEmail,
    sendEncryptedMime,
} from './mime-build.js';

// ─── Text Message ───────────────────────────────────────────────────────────────

/** Send an encrypted text message (Viewtype::Text) */
export async function sendTextMessage(ctx: SDKContext, toEmail: string, text: string): Promise<string> {
    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    const fromHeader = buildFromHeader(ctx);
    const peerKey = getKnownKey(ctx.knownKeys, toEmail);

    if (peerKey && ctx.privateKey && ctx.publicKey) {
        // encrypt() wraps plaintext for Autocrypt-style text payloads (not raw MIME)
        const armored = await ctx.encrypt(text, peerKey, {
            from: ctx.credentials.email,
            to: toEmail,
        });
        const rawEmail = buildPgpMimeEnvelope({
            fromHeader,
            toHeader: bracketEmail(toEmail),
            msgId,
            date: now,
            outerHeaders: [dispositionNotificationHeader(ctx)],
            autocryptHeader: ctx.buildAutocryptHeader(),
            armored,
        });
        await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
        log.info('messaging', `Sent encrypted message to ${toEmail} [${msgId}]`);
        return msgId;
    }

    const rawEmail = [
        fromHeader,
        `To: ${bracketEmail(toEmail)}`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
        ctx.buildAutocryptHeader(),
        `Content-Type: text/plain; charset=utf-8`,
        `MIME-Version: 1.0`,
        '',
        text,
    ].join('\r\n');
    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('messaging', `Sent message to ${toEmail} [${msgId}]`);
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
    const fromHeader = buildFromHeader(ctx);

    let body = '';
    if (quotedText) {
        for (const line of quotedText.split('\n')) {
            body += `> ${line}\r\n`;
        }
        body += '\r\n';
    }
    body += text;

    const innerMime = buildInnerText(
        [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `In-Reply-To: ${parentMsgId}`,
            `Chat-Version: 1.0`,
        ],
        body,
    );

    const msgId = await sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: [`In-Reply-To: ${parentMsgId}`, `References: ${parentMsgId}`],
        innerMime,
        fromHeader,
    });
    log.info('messaging', `Sent reply to ${parentMsgId} → ${toEmail} [${msgId}]`);
    return msgId;
}

// ─── Reaction ───────────────────────────────────────────────────────────────────

/** Send a reaction (Content-Disposition: reaction, RFC 9078) */
export async function sendReaction(ctx: SDKContext, toEmail: string, targetMsgId: string, emoji: string): Promise<void> {
    const innerMime = buildInnerText(
        [
            `Content-Disposition: reaction`,
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            `From: <${ctx.credentials.email}>`,
            `To: ${bracketEmail(toEmail)}`,
            `In-Reply-To: ${targetMsgId}`,
        ],
        emoji,
    );

    await sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: [`In-Reply-To: ${targetMsgId}`],
        innerMime,
        fromHeader: `From: <${ctx.credentials.email}>`,
    });
    log.info('messaging', `Sent reaction ${emoji} to ${targetMsgId}`);
}

// ─── Delete ─────────────────────────────────────────────────────────────────────

/** Send a delete-for-everyone request (Chat-Delete header) */
export async function sendDelete(ctx: SDKContext, toEmail: string, targetMsgId: string): Promise<void> {
    const innerMime = buildInnerText(
        [
            `Chat-Delete: ${targetMsgId}`,
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            `From: <${ctx.credentials.email}>`,
            `To: ${bracketEmail(toEmail)}`,
        ],
        '🚮',
    );

    await sendEncryptedMime(ctx, {
        toEmail,
        innerMime,
        fromHeader: `From: <${ctx.credentials.email}>`,
    });
    log.info('messaging', `Sent delete request for ${targetMsgId} to ${toEmail}`);
}

// ─── Edit Message ───────────────────────────────────────────────────────────────

/** Send an edit-message request (Chat-Edit header) — updates text of an existing message */
export async function sendEdit(ctx: SDKContext, toEmail: string, targetMsgId: string, newText: string): Promise<void> {
    const fromHeader = buildFromHeader(ctx);
    const innerMime = buildInnerText(
        [
            `Chat-Edit: ${targetMsgId}`,
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
        ],
        newText,
    );

    await sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: [`Chat-Edit: ${targetMsgId}`],
        innerMime,
        fromHeader,
    });
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
    logLabel = 'file'
): Promise<string> {
    const fromHeader = buildFromHeader(ctx);
    const innerMime = buildInnerMultipart({
        headers: [
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `Chat-Version: 1.0`,
            ...extraHeaders,
        ],
        text: caption,
        parts: [{
            mimeType,
            filename,
            base64: base64Data,
            disposition: 'attachment',
        }],
    });

    const msgId = await sendEncryptedMime(ctx, {
        toEmail,
        innerMime,
        fromHeader,
    });
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
    return sendAttachmentMessage(ctx, toEmail, filename, base64Data, mimeType, caption, [], 'file');
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
    return sendAttachmentMessage(ctx, toEmail, filename, base64Data, mimeType, caption, [], 'image');
}

/**
 * Send sticker (Viewtype::Sticker).
 * Wire: image attachment + `Chat-Content: sticker` (core-compatible).
 */
export async function sendSticker(
    ctx: SDKContext,
    toEmail: string,
    base64Data: string,
    mimeType = 'image/webp',
    filename = 'sticker.webp',
): Promise<string> {
    return sendAttachmentMessage(
        ctx, toEmail, filename, base64Data, mimeType, '',
        ['Chat-Content: sticker'],
        'sticker',
    );
}

/**
 * Send animated GIF (Viewtype::Gif).
 * Wire: image/gif attachment (optionally tagged Chat-Content: gif).
 */
export async function sendGif(
    ctx: SDKContext,
    toEmail: string,
    base64Data: string,
    filename = 'image.gif',
    caption = '',
): Promise<string> {
    return sendAttachmentMessage(
        ctx, toEmail, filename, base64Data, 'image/gif', caption,
        ['Chat-Content: gif'],
        'gif',
    );
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
    return sendAttachmentMessage(ctx, toEmail, filename, base64Data, mimeType, caption, extra, 'video');
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
    return sendAttachmentMessage(ctx, toEmail, filename, base64Data, mimeType, caption, extra, 'audio');
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
    return sendAttachmentMessage(ctx, toEmail, 'voice-message.ogg', base64AudioData, mimeType, '', extra, 'voice');
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

// ─── Read receipts (MDN / RFC 6522) ──────────────────────────────────────────────

/** Ensure Message-ID is angle-bracketed like core / RFC 5322. */
function normalizeRfc724Mid(id: string): string {
    const t = (id || '').trim();
    if (!t) return t;
    if (t.startsWith('<') && t.endsWith('>')) return t;
    return `<${t.replace(/^<|>$/g, '')}>`;
}

/**
 * Build a Delta Chat–compatible MDN body (RFC 6522 multipart/report).
 * Core: mimefactory::render_mdn — desktop peers only recognize this shape.
 * Also includes Chat-Disposition + Original-Message-ID at the top for madcore peers.
 */
export function buildMdnMime(opts: {
    fromHeader: string;
    toEmail: string;
    selfEmail: string;
    originalMsgId: string;
    boundary?: string;
}): string {
    const mid = normalizeRfc724Mid(opts.originalMsgId);
    const boundary = opts.boundary || `mdn-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const self = opts.selfEmail;
    const machine = [
        `Original-Recipient: rfc822;${self}`,
        `Final-Recipient: rfc822;${self}`,
        `Original-Message-ID: ${mid}`,
        `Disposition: manual-action/MDN-sent-automatically; displayed`,
        '',
    ].join('\r\n');

    return [
        `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"; protected-headers="v1"`,
        opts.fromHeader,
        `To: ${bracketEmail(opts.toEmail)}`,
        `Chat-Version: 1.0`,
        `Auto-Submitted: auto-replied`,
        `In-Reply-To: ${mid}`,
        // Dual headers so madcore can detect MDNs without walking report parts
        `Chat-Disposition: display`,
        `Original-Message-ID: ${mid}`,
        '',
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        '',
        // Untranslated on purpose (matches core — do not reveal language)
        `This is a receipt notification.`,
        '',
        `--${boundary}`,
        `Content-Type: message/disposition-notification`,
        '',
        machine,
        `--${boundary}--`,
    ].join('\r\n');
}

/**
 * Send a read receipt for an original message.
 * Wire matches Delta Chat core (`MimeFactory::from_mdn` / `render_mdn`):
 * multipart/report; report-type=disposition-notification + Original-Message-ID.
 * Encrypts when a peer key is known; otherwise sends cleartext MDN.
 */
export async function sendReadReceipt(
    ctx: SDKContext,
    toEmail: string,
    originalMsgId: string,
): Promise<string> {
    const mid = normalizeRfc724Mid(originalMsgId);
    if (!mid) throw new Error('sendReadReceipt: missing original Message-ID');
    const fromHeader = buildFromHeader(ctx);
    const innerMime = buildMdnMime({
        fromHeader,
        toEmail,
        selfEmail: ctx.credentials.email,
        originalMsgId: mid,
    });

    const peerKey = getKnownKey(ctx.knownKeys, toEmail);
    if (peerKey && ctx.privateKey && ctx.publicKey) {
        const msgId = await sendEncryptedMime(ctx, {
            toEmail,
            subject: 'Receipt Notification',
            outerHeaders: [
                `Auto-Submitted: auto-replied`,
                `In-Reply-To: ${mid}`,
                // Outer copies help when the outer is not fully decrypted yet
                `Chat-Disposition: display`,
                `Original-Message-ID: ${mid}`,
            ],
            innerMime,
            fromHeader,
        });
        log.info('messaging', `Sent encrypted MDN for ${mid} → ${toEmail}`);
        return msgId;
    }

    // Unencrypted fallback (core can also emit cleartext MDNs without peer key)
    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    // Rebuild with outer envelope headers (From/To/Message-ID live outside the report)
    const boundary = `mdn-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const machine = [
        `Original-Recipient: rfc822;${ctx.credentials.email}`,
        `Final-Recipient: rfc822;${ctx.credentials.email}`,
        `Original-Message-ID: ${mid}`,
        `Disposition: manual-action/MDN-sent-automatically; displayed`,
        '',
    ].join('\r\n');
    const rawEmail = [
        fromHeader,
        `To: ${bracketEmail(toEmail)}`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: Receipt Notification`,
        `Chat-Version: 1.0`,
        `Auto-Submitted: auto-replied`,
        `In-Reply-To: ${mid}`,
        `Chat-Disposition: display`,
        `Original-Message-ID: ${mid}`,
        `MIME-Version: 1.0`,
        `Content-Type: multipart/report; report-type=disposition-notification; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        '',
        `This is a receipt notification.`,
        '',
        `--${boundary}`,
        `Content-Type: message/disposition-notification`,
        '',
        machine,
        `--${boundary}--`,
    ].join('\r\n');
    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('messaging', `Sent cleartext MDN for ${mid} → ${toEmail}`);
    return msgId;
}

/** Header value for requesting read receipts on outbound messages */
export function dispositionNotificationHeader(ctx: SDKContext): string {
    return `Chat-Disposition-Notification-To: ${ctx.credentials.email}`;
}

/**
 * Propagate 1:1 ephemeral timer change.
 * Wire: Chat-Ephemeral-Timer: <seconds>
 */
export async function sendEphemeralTimer(
    ctx: SDKContext,
    toEmail: string,
    seconds: number,
): Promise<string> {
    const fromHeader = buildFromHeader(ctx);
    const header = `Chat-Ephemeral-Timer: ${Math.max(0, Math.floor(seconds))}`;
    const text = seconds > 0
        ? `Disappearing messages set to ${seconds}s.`
        : 'Disappearing messages off.';
    const innerMime = buildInnerText(
        [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `Chat-Version: 1.0`,
            header,
        ],
        text,
    );
    const msgId = await sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: [header],
        innerMime,
        fromHeader,
    });
    log.info('messaging', `Sent ephemeral timer ${seconds}s → ${toEmail}`);
    return msgId;
}
