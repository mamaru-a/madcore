/**
 * lib/mime.ts — MIME parsing and extraction
 *
 * Extracted from sdk.ts. Handles:
 *   - Parsing RFC 2822 headers (with folded continuation lines)
 *   - Extracting email addresses from From/To headers
 *   - Extracting text body from MIME messages
 *   - Extracting file attachments from multipart/mixed
 *   - Full incoming message parsing (decrypt + extract metadata)
 */

import type { Attachment, IncomingMessage, ParsedMessage } from '../types.js';
import * as cryptoLib from './crypto.js';
import type * as openpgp from 'openpgp';
import { log } from './logger.js';

// ─── Header Parsing ─────────────────────────────────────────────────────────────

/** Parse RFC 2822 headers from a raw message string */
export function parseHeaders(rawMessage: string): Record<string, string> {
    const headers: Record<string, string> = {};
    let headerEnd = rawMessage.indexOf('\r\n\r\n');
    if (headerEnd < 0) headerEnd = rawMessage.indexOf('\n\n');
    const headerBlock = headerEnd >= 0 ? rawMessage.substring(0, headerEnd) : rawMessage;

    // Unfold continuation lines (both \r\n and \n variants)
    const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, ' ');
    const lines = unfolded.split(/\r?\n/);

    for (const line of lines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
            const key = line.substring(0, colonIdx).trim().toLowerCase();
            const value = line.substring(colonIdx + 1).trim();
            headers[key] = value;
        }
    }
    return headers;
}

/** Extract email address from a From/To header value */
export function extractEmail(headerValue: string): string {
    const match = headerValue.match(/<([^>]+)>/);
    return match ? match[1].toLowerCase() : headerValue.trim().toLowerCase();
}

/** Decode RFC 2047 MIME encoded words (=?charset?encoding?data?=) */
export function decodeMimeWords(value: string): string {
    return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, _charset, encoding, data) => {
        if (encoding.toUpperCase() === 'B') {
            // Base64
            try {
                const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
                return new TextDecoder('utf-8').decode(bytes);
            } catch { return data; }
        } else {
            // Quoted-Printable
            return data
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_: string, hex: string) => String.fromCharCode(parseInt(hex, 16)));
        }
    });
}

/** Extract body text from a MIME message, handling multi-parts and encodings */
export function extractBody(rawMessage: string): string {
    const boundaryMatch = rawMessage.match(/boundary="?([^";\r\n]+)"?/i);
    if (boundaryMatch) {
        const boundary = boundaryMatch[1];
        const parts = rawMessage.split(`--${boundary}`);
        // First part is preamble, search in subsequent parts
        for (let i = 1; i < parts.length; i++) {
            const part = parts[i].trim();
            if (part === '--') break;
            const subBody = extractBody(part);
            if (subBody) return subBody;
        }
    }

    // Single part logic
    const headers = parseHeaders(rawMessage);
    const contentType = (headers['content-type'] || 'text/plain').toLowerCase();
    const encoding = (headers['content-transfer-encoding'] || '').toLowerCase();

    const m = rawMessage.replace(/\r\n/g, '\n');
    const splitIdx = m.indexOf('\n\n');
    
    // If no body separator, then the entire rawMessage is headers only
    if (splitIdx < 0) {
        // Only return if it's literally NOT containing headers
        if (!rawMessage.includes(':')) return rawMessage.trim();
        return '';
    }

    let body = m.substring(splitIdx + 1).trim();

    // If it's a non-text child part of a multipart, don't return it as "the" body.
    // Allow JSON control payloads (calls, location, webxdc status) used by the web SDK.
    const allowBody =
        contentType.startsWith('text/plain') ||
        contentType.includes('text/html') ||
        contentType.includes('application/json') ||
        contentType.includes('text/json');
    if (!allowBody) {
        // If this part has headers (detected by colons in the header section before separator)
        if (m.substring(0, splitIdx).includes(':')) return '';
    }

    if (encoding === 'base64') {
        try {
            const bytes = Uint8Array.from(atob(body.replace(/\s/g, '')), c => c.charCodeAt(0));
            body = new TextDecoder('utf-8').decode(bytes);
        } catch { /* use body as is */ }
    } else if (encoding === 'quoted-printable') {
        body = body
            .replace(/=\n/g, '')
            .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
    }

    // Strip signatures (matches core behavior in simplify.rs)
    // RFC 3676 standard: "-- \n", common variant: "--\n"
    // We look for dash-dash-space or dash-dash at the start of a line
    const sigRegex = /^-- ?$/m;
    const match = body.match(sigRegex);
    if (match && match.index !== undefined) {
        body = body.substring(0, match.index).trim();
    }

    return body;
}

// ─── Attachment Extraction ──────────────────────────────────────────────────────

/** Extract file attachments from a multipart MIME message */
export function extractAttachments(mimeMessage: string): Attachment[] {
    const attachments: Attachment[] = [];
    const boundaryMatch = mimeMessage.match(/boundary="?([^";\r\n]+)"?/i);
    if (!boundaryMatch) return attachments;

    const boundary = boundaryMatch[1];
    const parts = mimeMessage.split(`--${boundary}`);

    for (let i = 1; i < parts.length; i++) {
        const part = parts[i];
        if (part.startsWith('--')) break;

        const partHeaders = parseHeaders(part);
        const disposition = partHeaders['content-disposition'] || '';
        const contentType = partHeaders['content-type'] || '';

        // Only extract actual file attachments, not text/plain body parts
        if (disposition.includes('attachment') || (contentType && !contentType.startsWith('text/plain'))) {
            const fnMatch = disposition.match(/filename="?([^";\r\n]+)"?/i) || contentType.match(/name="?([^";\r\n]+)"?/i);
            const filename = fnMatch ? fnMatch[1].trim() : 'attachment';
            const mimeType = contentType.split(';')[0].trim();

            const bodyStart = part.indexOf('\r\n\r\n');
            const bodyStartAlt = part.indexOf('\n\n');
            const start = bodyStart >= 0 ? bodyStart + 4 : (bodyStartAlt >= 0 ? bodyStartAlt + 2 : -1);
            if (start < 0) continue;

            let base64Data = part.substring(start).trim();
            base64Data = base64Data.replace(/\r?\n--.*$/, '').trim();

            if (base64Data.length > 0) {
                attachments.push({
                    filename,
                    mimeType,
                    base64Data,
                    size: Math.round(base64Data.length * 0.75),
                });
            }
        }
    }
    return attachments;
}

// ─── Full Incoming Message Parser ───────────────────────────────────────────────

export interface ParseContext {
    email: string;
    privateKey: openpgp.PrivateKey | null;
    knownKeys: Map<string, string>;
    peerAvatars: Map<string, string>;
    /**
     * Persist a peer public key into the active account store
     * (MemoryStore or IndexedDB — whichever the SDK was constructed with).
     */
    onPeerKey?: (email: string, armoredKey: string) => void;
}

function rememberPeerKey(ctx: ParseContext, email: string, armoredKey: string): void {
    cryptoLib.setKnownKey(ctx.knownKeys, email, armoredKey);
    try {
        ctx.onPeerKey?.(email, armoredKey);
    } catch (e: any) {
        log.warn('mime', `onPeerKey failed for ${email}: ${e?.message || e}`);
    }
}

/**
 * Import every `Autocrypt:` header from a raw MIME source (outer or decrypted).
 *
 * Autocrypt is the *sender's* key. Index under `addr` and under From only when
 * they name the same mailbox (domain-literal / casing variants). Never map a
 * key onto a different mailbox — that is what Autocrypt-Gossip is for, and
 * doing so overwrote peer keys during SecureJoin (encrypt-to-wrong-key).
 */
function importAllAutocryptHeaders(
    source: string,
    from: string,
    ctx: ParseContext,
): void {
    // Unfold continuations then find each Autocrypt header line
    // (must not match Autocrypt-Gossip — handled separately)
    const unfolded = source.replace(/\r?\n[ \t]+/g, ' ');
    const re = /^Autocrypt:\s*(.+)$/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(unfolded)) !== null) {
        const parsed = cryptoLib.parseAutocryptHeader(m[1]);
        if (!parsed) continue;
        // Always refresh + persist to account store (Memory or IDB)
        rememberPeerKey(ctx, parsed.addr, parsed.armoredKey);
        if (from && cryptoLib.emailsEqual(from, parsed.addr)) {
            rememberPeerKey(ctx, from, parsed.armoredKey);
        }
        log.debug('mime', `Autocrypt imported for ${parsed.addr}`);
    }
}

/**
 * Import every `Autocrypt-Gossip:` header. Gossip is a third-party key —
 * store only under its declared `addr`, never under the message From.
 */
function importAllAutocryptGossipHeaders(source: string, ctx: ParseContext): void {
    const unfolded = source.replace(/\r?\n[ \t]+/g, ' ');
    const re = /^Autocrypt-Gossip:\s*(.+)$/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(unfolded)) !== null) {
        const parsed = cryptoLib.parseAutocryptHeader(m[1]);
        if (!parsed) continue;
        rememberPeerKey(ctx, parsed.addr, parsed.armoredKey);
        log.debug('mime', `Autocrypt-Gossip imported for ${parsed.addr}`);
    }
}

/**
 * Detect read receipts / MDNs (Delta Chat core + madcore dual format).
 *
 * Core sends RFC 6522:
 *   Content-Type: multipart/report; report-type=disposition-notification
 *   + message/disposition-notification with Original-Message-ID + Disposition: …; displayed
 *
 * Madcore also emits Chat-Disposition: display + Original-Message-ID (outer and protected).
 */
export function detectReadReceipt(opts: {
    headers: Record<string, string>;
    innerHeaders: Record<string, string>;
    outerSource: string;
    innerSource?: string;
    text?: string;
}): { isReadReceipt: boolean; readReceiptFor: string } {
    const { headers, innerHeaders, outerSource, innerSource = '', text = '' } = opts;
    const sources = [outerSource, innerSource].filter(Boolean);

    const pickOriginalId = (): string => {
        for (const h of [innerHeaders, headers]) {
            const v =
                h['original-message-id'] ||
                h['original-message-id'.toLowerCase()] ||
                '';
            if (v) return v.trim();
        }
        for (const src of sources) {
            const m = src.match(/Original-Message-ID:\s*(<[^>\r\n]+>|[^\s;,\r\n]+)/i);
            if (m) return m[1].trim();
        }
        // In-Reply-To as last resort (Exchange / some clients)
        const irt = innerHeaders['in-reply-to'] || headers['in-reply-to'] || '';
        if (irt) {
            const m = irt.match(/<[^>]+>/);
            if (m) return m[0];
            return irt.trim();
        }
        return '';
    };

    // 1) Chat-Disposition: display (madcore dual / older wire)
    const chatDisp = (
        innerHeaders['chat-disposition'] ||
        headers['chat-disposition'] ||
        ''
    ).toLowerCase();
    if (chatDisp === 'display') {
        const id = pickOriginalId();
        if (id) return { isReadReceipt: true, readReceiptFor: id };
    }

    // 2) RFC 6522 multipart/report
    const outerCt = (headers['content-type'] || '').toLowerCase();
    const innerCt = (innerHeaders['content-type'] || '').toLowerCase();
    const looksLikeReport =
        (outerCt.includes('multipart/report') && outerCt.includes('disposition-notification')) ||
        (innerCt.includes('multipart/report') && innerCt.includes('disposition-notification')) ||
        sources.some(
            s =>
                /multipart\/report/i.test(s) &&
                /report-type\s*=\s*disposition-notification/i.test(s),
        );

    const hasDispNotifPart = sources.some(
        s =>
            /Content-Type:\s*message\/disposition-notification/i.test(s) &&
            /Disposition:\s*[^\r\n]*displayed/i.test(s),
    );

    // Human part alone must not become a chat bubble
    const receiptText =
        /^this is a receipt notification\.?$/i.test(text.trim()) ||
        sources.some(s => /This is a receipt notification/i.test(s));

    if (looksLikeReport || hasDispNotifPart || (receiptText && /Original-Message-ID:/i.test(outerSource + innerSource))) {
        const id = pickOriginalId();
        if (id) return { isReadReceipt: true, readReceiptFor: id };
        // Report without id is still not a chat bubble — drop as control
        if (looksLikeReport || hasDispNotifPart) {
            return { isReadReceipt: true, readReceiptFor: '' };
        }
    }

    return { isReadReceipt: false, readReceiptFor: '' };
}

/** Parse an incoming raw message → decrypted ParsedMessage */
export async function parseIncoming(raw: IncomingMessage, ctx: ParseContext): Promise<ParsedMessage | null> {
    const body = raw.body || '';
    const headers = parseHeaders(body);
    // Prefer protected From after decrypt (hidden-recipients / list-id outer forms)
    let from = extractEmail(headers['from'] || '');
    const to = extractEmail(headers['to'] || '');
    const rfc724mid = headers['message-id'] || null;
    
    // Parse timestamp from Date header
    let timestamp = Date.now();
    if (headers['date']) {
        const parsedDate = Date.parse(headers['date']);
        if (!isNaN(parsedDate)) timestamp = parsedDate;
    }

    // Skip our own messages (bracketed vs bare IP must match)
    if (cryptoLib.emailsEqual(from, ctx.email)) return null;

    // Import every Autocrypt / Gossip header in the raw message (parseHeaders only keeps the last)
    importAllAutocryptHeaders(body, from, ctx);
    importAllAutocryptGossipHeaders(body, ctx);

    // SecureJoin detection (aligned with core securejoin.rs get_secure_join_step):
    // 1) Secure-Join-Invitenumber alone → vc-request / vg-request
    // 2) Secure-Join: v[cg]-* step header (outer or later inner)
    // 3) Body fallback "Secure-Join: vc-request" (legacy plain-text body)
    let sjHeader = (headers['secure-join'] || '').trim();
    let sjInviteNumber = (headers['secure-join-invitenumber'] || '').trim();
    let isSecureJoin = false;
    if (sjInviteNumber) {
        // Core: invitenumber presence is enough to classify as Request
        isSecureJoin = true;
        if (!sjHeader || !/^v[cg]-/i.test(sjHeader)) {
            const grp = headers['secure-join-group'] || headers['chat-group-id'] || '';
            sjHeader = grp ? 'vg-request' : 'vc-request';
        }
    } else if (/^v[cg]-/i.test(sjHeader)) {
        isSecureJoin = true;
    }

    // Try to decrypt
    let text = '';
    let encrypted = false;
    let innerHeaders: Record<string, string> = {};
    let isReaction = false;
    let isDelete = false;
    let isVoiceMessage = false;
    let voiceDurationMs: number | undefined;
    let avatarData: string | null | undefined = undefined;
    let attachments: Attachment[] = [];
    /** Decrypted inner MIME (or empty if cleartext) — used for MDN / report parsing */
    let decryptedSource = '';

    // Check outer headers for voice
    if (headers['chat-voice-message'] === '1') isVoiceMessage = true;
    if (headers['chat-duration']) voiceDurationMs = parseInt(headers['chat-duration'], 10);

    // Find body separator
    let headerEnd = body.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (headerEnd < 0) {
        headerEnd = body.indexOf('\n\n');
        sepLen = 2;
    }
    const rawBody = headerEnd >= 0 ? body.substring(headerEnd + sepLen) : body;

    if (rawBody.includes('-----BEGIN PGP MESSAGE-----') && ctx.privateKey) {
        const pgpData = cryptoLib.extractArmoredPgpMessage(rawBody) || rawBody;
        try {
            const decryptedStr = await cryptoLib.decrypt(pgpData, ctx.privateKey);
            encrypted = true;
            decryptedSource = decryptedStr;
            innerHeaders = parseHeaders(decryptedStr);

            // Check inner headers for voice
            if (innerHeaders['chat-voice-message'] === '1') isVoiceMessage = true;
            if (innerHeaders['chat-duration']) voiceDurationMs = parseInt(innerHeaders['chat-duration'], 10);

            // Prefer protected From (core + madcore put real addr inside ciphertext)
            const protectedFrom = extractEmail(innerHeaders['from'] || '');
            if (protectedFrom) {
                from = protectedFrom;
            }

            // Import Autocrypt / Gossip from decrypted protected headers (always refresh).
            // Order: sender Autocrypt first, then gossip (third-party only — never alias to From).
            importAllAutocryptHeaders(decryptedStr, from, ctx);
            importAllAutocryptGossipHeaders(decryptedStr, ctx);
            // Also pick up a single unfolded gossip value if parseHeaders folded it oddly
            const gossipHeader = innerHeaders['autocrypt-gossip'];
            if (gossipHeader) {
                const parsed = cryptoLib.parseAutocryptHeader(gossipHeader);
                if (parsed) {
                    cryptoLib.setKnownKey(ctx.knownKeys, parsed.addr, parsed.armoredKey);
                    log.debug('mime', `Imported gossip key for ${parsed.addr}`);
                }
            }

            // Check for SecureJoin in inner (protected) headers — preferred by core
            const innerSJ = (innerHeaders['secure-join'] || '').trim();
            const innerInvite = (innerHeaders['secure-join-invitenumber'] || '').trim();
            if (innerInvite) {
                isSecureJoin = true;
                sjInviteNumber = innerInvite;
                if (!innerSJ || !/^v[cg]-/i.test(innerSJ)) {
                    const grp = innerHeaders['secure-join-group'] || innerHeaders['chat-group-id'] || '';
                    sjHeader = grp ? 'vg-request' : 'vc-request';
                } else {
                    sjHeader = innerSJ;
                }
            } else if (/^v[cg]-/i.test(innerSJ)) {
                isSecureJoin = true;
                sjHeader = innerSJ;
            }

            // Check for reaction
            if (/Content-Disposition:\s*reaction/i.test(decryptedStr)) {
                isReaction = true;
                text = extractBody(decryptedStr);
            }
            // Check for delete
            else if (innerHeaders['chat-delete']) {
                isDelete = true;
                text = innerHeaders['chat-delete'];
            }
            // Regular text / multipart
            else {
                text = extractBody(decryptedStr);
            }

            // Extract attachments from multipart
            attachments = extractAttachments(decryptedStr);

            // Extract Chat-User-Avatar
            const avatarHeader = innerHeaders['chat-user-avatar'];
            if (avatarHeader) {
                if (avatarHeader === '0') {
                    avatarData = null;
                    ctx.peerAvatars.delete(from);
                    log.debug('mime', `${from} removed their profile photo`);
                } else if (avatarHeader.startsWith('base64:')) {
                    const b64 = avatarHeader.substring('base64:'.length).replace(/\s/g, '');
                    avatarData = `data:image/jpeg;base64,${b64}`;
                    ctx.peerAvatars.set(from, avatarData);
                    log.debug('mime', `${from} updated their profile photo (${Math.round(b64.length * 0.75 / 1024)}KB)`);
                }
            }
        } catch (e: any) {
            // Keep a visible but non-empty error so the UI does not render blank bubbles.
            // Do not invent Secure-Join / MDN state from undecryptable ciphertext.
            encrypted = true;
            text = '';
            log.warn('mime', `Decrypt failed from ${from}: ${e?.message || e}`);
            // Surface in message list as a short placeholder
            text = '⚠️ Cannot decrypt this message';
        }
    } else {
        // Prefer full-message extract; fall back to raw body for JSON control payloads
        // (extractBody on body-only JSON returns '' because of bare "key: value" colons).
        text = extractBody(body);
        if (!text && rawBody.trim()) {
            text = rawBody.trim();
        }
        // Unencrypted control messages (tests + rare cleartext)
        if (
            /content-disposition:\s*reaction/i.test(body) ||
            (headers['content-disposition'] || '').toLowerCase() === 'reaction'
        ) {
            isReaction = true;
        }
        if (headers['chat-delete']) {
            isDelete = true;
            text = headers['chat-delete'];
        }
    }

    // Body-text fallback: cores sometimes put "Secure-Join: vc-request" as the
    // only visible body line. Treat as control traffic, not a chat bubble.
    if (!isSecureJoin) {
        const bodySj = (text || '').match(/^\s*secure-join:\s*([vV][cCgG]-[\w-]+)/im);
        if (bodySj) {
            isSecureJoin = true;
            sjHeader = bodySj[1];
            log.debug('mime', `SecureJoin detected from body text: ${sjHeader}`);
        }
    }
    // Prefer invite number from whichever source we found
    if (!sjInviteNumber) {
        sjInviteNumber = (
            innerHeaders['secure-join-invitenumber'] ||
            headers['secure-join-invitenumber'] ||
            ''
        ).trim();
        if (sjInviteNumber && !isSecureJoin) {
            isSecureJoin = true;
            if (!sjHeader) sjHeader = 'vc-request';
        }
    }

    // Extract group/chat context from inner headers (preferred) or outer
    const groupId = innerHeaders['chat-group-id'] || headers['chat-group-id'] || undefined;
    const rawGroupName = innerHeaders['chat-group-name'] || headers['chat-group-name'] || undefined;
    const groupName = rawGroupName ? decodeMimeWords(rawGroupName) : undefined;

    // Extract member management headers
    const memberAdded = innerHeaders['chat-group-member-added'] || headers['chat-group-member-added'] || undefined;
    const memberRemoved = innerHeaders['chat-group-member-removed'] || headers['chat-group-member-removed'] || undefined;
    
    // Extract description
    const rawDesc = innerHeaders['chat-group-description'] || headers['chat-group-description'] || undefined;
    const groupDescription = rawDesc ? decodeMimeWords(rawDesc) : undefined;

    // Extract broadcast info
    const isBroadcast = !!(innerHeaders['chat-group-is-broadcast'] || headers['chat-group-is-broadcast'] || innerHeaders['chat-list-id'] || headers['chat-list-id']);
    const broadcastSecret = innerHeaders['chat-broadcast-secret'] || headers['chat-broadcast-secret'] || undefined;


    // Extract edit info
    const editHeader = innerHeaders['chat-edit'] || headers['chat-edit'] || '';
    const isEdit = editHeader.length > 0;

    // Read receipts — Delta Chat core uses RFC 6522 multipart/report MDNs;
    // madcore also accepts Chat-Disposition: display (legacy dual header).
    const mdn = detectReadReceipt({
        headers,
        innerHeaders,
        outerSource: body,
        innerSource: decryptedSource,
        text,
    });
    const isReadReceipt = mdn.isReadReceipt;
    const originalMsgId = mdn.readReceiptFor;
    // Never surface MDN human part ("This is a receipt notification.") as chat text
    if (isReadReceipt) text = '';

    // Ephemeral timer (control message or sticky on chat)
    const ephemeralRaw = innerHeaders['chat-ephemeral-timer'] || headers['chat-ephemeral-timer'];
    const ephemeralTimer = ephemeralRaw !== undefined && ephemeralRaw !== ''
        ? parseInt(ephemeralRaw, 10)
        : undefined;

    // Group avatar (Chat-Group-Avatar: base64:… | 0)
    let groupAvatarUpdate: string | null | undefined = undefined;
    const groupAvatarHeader = innerHeaders['chat-group-avatar'] || headers['chat-group-avatar'];
    if (groupAvatarHeader) {
        if (groupAvatarHeader === '0') {
            groupAvatarUpdate = null;
        } else if (groupAvatarHeader.startsWith('base64:')) {
            const b64 = groupAvatarHeader.substring('base64:'.length).replace(/\s/g, '');
            groupAvatarUpdate = `data:image/jpeg;base64,${b64}`;
        }
    }

    // Stickers / GIFs / webxdc / location / calls (Chat-Content or attachment MIME)
    const chatContent = (innerHeaders['chat-content'] || headers['chat-content'] || '').toLowerCase();
    const isSticker = chatContent === 'sticker';
    const firstAttMime = attachments[0]?.mimeType?.toLowerCase() || '';
    const isGif = chatContent === 'gif' || firstAttMime === 'image/gif';
    const isWebxdc = chatContent === 'app' || firstAttMime === 'application/webxdc'
        || (attachments[0]?.filename || '').endsWith('.xdc');
    const isWebxdcStatus = chatContent === 'webxdc-status';
    const isLocation = chatContent === 'location' || chatContent === 'location-stream';
    const isCall = chatContent === 'call';

    // Best-effort viewtype for UI consumers
    let viewtype: import('../types.js').Viewtype | undefined;
    if (isReaction || isDelete || isEdit || isSecureJoin || isReadReceipt || isWebxdcStatus || isCall) {
        viewtype = undefined;
    } else if (isWebxdc) {
        viewtype = 'Webxdc';
    } else if (isSticker) {
        viewtype = 'Sticker';
    } else if (isGif) {
        viewtype = 'Gif';
    } else if (isVoiceMessage) {
        viewtype = 'Voice';
    } else if (attachments.length > 0) {
        if (firstAttMime.startsWith('video/')) viewtype = 'Video';
        else if (firstAttMime.startsWith('audio/')) viewtype = 'Audio';
        else if (firstAttMime.startsWith('image/')) viewtype = 'Image';
        else viewtype = 'File';
    } else if (isLocation) {
        viewtype = undefined;
    } else {
        viewtype = 'Text';
    }

    return {
        uid: raw.uid,
        rfc724mid,
        from,
        to,
        text,
        encrypted,
        timestamp,
        headers,
        innerHeaders,
        isReaction,
        isDelete,
        isSecureJoin,
        isVoiceMessage,
        secureJoinStep: isSecureJoin ? (sjHeader.trim() || 'vc-request') : undefined,
        secureJoinInviteNumber: sjInviteNumber || undefined,
        secureJoinAuth: innerHeaders['secure-join-auth'] || headers['secure-join-auth'] || undefined,
        avatarUpdate: avatarData,
        attachments,
        voiceDurationMs,
        groupId,
        groupName,
        groupDescription,
        isBroadcast,
        broadcastSecret,
        memberAdded,
        memberRemoved,
        isEdit,
        editTargetMsgId: isEdit ? editHeader : undefined,
        isReadReceipt,
        readReceiptFor: isReadReceipt ? originalMsgId : undefined,
        ephemeralTimer: ephemeralTimer !== undefined && !Number.isNaN(ephemeralTimer)
            ? ephemeralTimer
            : undefined,
        groupAvatarUpdate,
        isSticker,
        isGif,
        isWebxdc,
        isWebxdcStatus,
        isLocation,
        isCall,
        viewtype,
    };
}
