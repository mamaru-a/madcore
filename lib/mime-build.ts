/**
 * lib/mime-build.ts — Shared builders for inner MIME and PGP/MIME envelopes.
 *
 * All outbound encrypted messages (1:1 and group) should go through these helpers
 * so wire format stays consistent and later features (group reactions, stickers,
 * webxdc, MDNs) don't re-copy envelope boilerplate.
 */

import type { SDKContext } from './context';

const crypto = globalThis.crypto;

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface MimePart {
    mimeType: string;
    filename: string;
    /** Raw base64 (may be folded by the builder via ctx.foldBase64 if requested) */
    base64: string;
    disposition?: 'attachment' | 'inline';
    /** When true, fold base64 with ctx.foldBase64 */
    foldBase64?: boolean;
}

export interface PgpEnvelopeOptions {
    fromHeader: string;
    /** Outer To: header value (e.g. `<bob@x>` or full group list) */
    toHeader: string;
    msgId: string;
    date?: string;
    subject?: string;
    /** Extra outer headers (Chat-Version is always added if missing) */
    outerHeaders?: string[];
    autocryptHeader: string;
    armored: string;
}

// ─── Headers ────────────────────────────────────────────────────────────────────

/** Build From: header from display name + credentials */
export function buildFromHeader(ctx: SDKContext): string {
    return ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;
}

/** Bracket a single email for To: */
export function bracketEmail(email: string): string {
    return `<${email}>`;
}

// ─── Inner MIME ─────────────────────────────────────────────────────────────────

/**
 * Build a text/plain protected-headers inner payload.
 * `headers` should NOT include the blank line before body.
 */
export function buildInnerText(headers: string[], text: string): string {
    return [...headers.filter(h => h.length > 0), '', text].join('\r\n');
}

/**
 * Build multipart/mixed with a text part + file parts.
 * Puts Content-Type multipart line first if not already in headers.
 */
export function buildInnerMultipart(opts: {
    headers: string[];
    text: string;
    parts: MimePart[];
    foldBase64?: (b64: string) => string;
    boundary?: string;
}): string {
    const boundary = opts.boundary || `mixed-${crypto.randomUUID().slice(0, 8)}`;
    const hasContentType = opts.headers.some(h => /^Content-Type:/i.test(h));
    const headerLines = hasContentType
        ? opts.headers.filter(h => h.length > 0)
        : [
            `Content-Type: multipart/mixed; boundary="${boundary}"; protected-headers="v1"`,
            ...opts.headers.filter(h => h.length > 0),
        ];

    const lines: string[] = [...headerLines, ''];

    // Text part
    lines.push(
        `--${boundary}`,
        `Content-Type: text/plain; charset="utf-8"`,
        '',
        opts.text,
        '',
    );

    for (const part of opts.parts) {
        const disposition = part.disposition || 'attachment';
        const data = part.foldBase64 && opts.foldBase64
            ? opts.foldBase64(part.base64)
            : part.base64;
        lines.push(
            `--${boundary}`,
            `Content-Type: ${part.mimeType}; name="${part.filename}"`,
            `Content-Disposition: ${disposition}; filename="${part.filename}"`,
            `Content-Transfer-Encoding: base64`,
            '',
            data,
            '',
        );
    }

    lines.push(`--${boundary}--`);
    return lines.join('\r\n');
}

// ─── Outer PGP/MIME envelope ────────────────────────────────────────────────────

/**
 * Wrap armored ciphertext in a standard multipart/encrypted PGP/MIME message.
 * Matches the envelope used throughout messaging.ts / group.ts.
 */
export function buildPgpMimeEnvelope(opts: PgpEnvelopeOptions): string {
    const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;
    const date = opts.date || new Date().toUTCString();
    const subject = opts.subject ?? '[...]';

    const outer = opts.outerHeaders ? [...opts.outerHeaders] : [];
    const hasChatVersion = outer.some(h => /^Chat-Version:/i.test(h));
    if (!hasChatVersion) {
        outer.unshift('Chat-Version: 1.0');
    }

    return [
        opts.fromHeader,
        `To: ${opts.toHeader}`,
        `Date: ${date}`,
        `Message-ID: ${opts.msgId}`,
        `Subject: ${subject}`,
        ...outer.filter(h => h.length > 0),
        opts.autocryptHeader,
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
        opts.armored,
        '',
        `--${encBoundary}--`,
    ].join('\r\n');
}

// ─── High-level send ────────────────────────────────────────────────────────────

export interface SendEncryptedOptions {
    /** Envelope + encrypt recipient (SMTP RCPT) */
    toEmail: string;
    /** Outer To: header; defaults to `<toEmail>` */
    toHeader?: string;
    subject?: string;
    outerHeaders?: string[];
    /** Full inner MIME (already includes protected headers + body) */
    innerMime: string;
    /** Pre-generated Message-ID; generated if omitted */
    msgId?: string;
    date?: string;
    fromHeader?: string;
}

/**
 * Encrypt `innerMime` to `toEmail` and send a PGP/MIME envelope.
 * Throws if no key for recipient.
 */
export async function sendEncryptedMime(
    ctx: SDKContext,
    opts: SendEncryptedOptions,
): Promise<string> {
    const peerKey = ctx.knownKeys.get(opts.toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`No key for ${opts.toEmail} — cannot send encrypted message`);
    }

    const msgId = opts.msgId || ctx.generateMsgId();
    const fromHeader = opts.fromHeader || buildFromHeader(ctx);
    const toHeader = opts.toHeader || bracketEmail(opts.toEmail);
    const armored = await ctx.encryptRaw(opts.innerMime, peerKey);

    const rawEmail = buildPgpMimeEnvelope({
        fromHeader,
        toHeader,
        msgId,
        date: opts.date,
        subject: opts.subject,
        outerHeaders: opts.outerHeaders,
        autocryptHeader: ctx.buildAutocryptHeader(),
        armored,
    });

    await ctx.sendRaw(ctx.credentials.email, [opts.toEmail], rawEmail);
    return msgId;
}
