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

import type { Attachment, IncomingMessage, ParsedMessage } from '../types';
import * as cryptoLib from './crypto';
import type * as openpgp from 'openpgp';
import { log } from './logger';

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

    // If it's a non-text child part of a multipart, don't return it as "the" body
    if (!contentType.startsWith('text/plain') && !contentType.includes('text/html')) {
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
}

/** Parse an incoming raw message → decrypted ParsedMessage */
export async function parseIncoming(raw: IncomingMessage, ctx: ParseContext): Promise<ParsedMessage | null> {
    const body = raw.body || '';
    const headers = parseHeaders(body);
    const from = extractEmail(headers['from'] || '');
    const to = extractEmail(headers['to'] || '');
    const rfc724mid = headers['message-id'] || null;
    
    // Parse timestamp from Date header
    let timestamp = Date.now();
    if (headers['date']) {
        const parsedDate = Date.parse(headers['date']);
        if (!isNaN(parsedDate)) timestamp = parsedDate;
    }

    // Skip our own messages
    if (from === ctx.email.toLowerCase()) return null;

    // Import Autocrypt key if present
    const autocrypt = headers['autocrypt'];
    if (autocrypt) {
        const parsed = cryptoLib.parseAutocryptHeader(autocrypt);
        if (parsed && !ctx.knownKeys.has(parsed.addr)) {
            ctx.knownKeys.set(parsed.addr, parsed.armoredKey);
            log.debug('mime', `Auto-imported key for ${parsed.addr}`);
        }
    }

    // Check for SecureJoin in outer headers
    let sjHeader = headers['secure-join'] || '';
    let isSecureJoin = /^v[cg]-/i.test(sjHeader.trim());

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
        const pgpStart = rawBody.indexOf('-----BEGIN PGP MESSAGE-----');
        const pgpData = rawBody.substring(pgpStart);
        try {
            const decryptedStr = await cryptoLib.decrypt(pgpData, ctx.privateKey);
            encrypted = true;
            innerHeaders = parseHeaders(decryptedStr);

            // Check inner headers for voice
            if (innerHeaders['chat-voice-message'] === '1') isVoiceMessage = true;
            if (innerHeaders['chat-duration']) voiceDurationMs = parseInt(innerHeaders['chat-duration'], 10);

            // Import Autocrypt from inner headers
            const innerAutocrypt = innerHeaders['autocrypt'];
            if (innerAutocrypt) {
                const parsed = cryptoLib.parseAutocryptHeader(innerAutocrypt);
                if (parsed && !ctx.knownKeys.has(parsed.addr)) {
                    ctx.knownKeys.set(parsed.addr, parsed.armoredKey);
                    log.debug('mime', `Imported key for ${parsed.addr} from encrypted headers`);
                }
            }

            // Import autocrypt-gossip
            const gossipHeader = innerHeaders['autocrypt-gossip'];
            if (gossipHeader) {
                const parsed = cryptoLib.parseAutocryptHeader(gossipHeader);
                if (parsed && !ctx.knownKeys.has(parsed.addr)) {
                    ctx.knownKeys.set(parsed.addr, parsed.armoredKey);
                    log.debug('mime', `Imported gossip key for ${parsed.addr}`);
                }
            }

            // Check for SecureJoin in inner headers
            const innerSJ = innerHeaders['secure-join'] || '';
            if (!isSecureJoin && /^v[cg]-/i.test(innerSJ.trim())) {
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
            text = `[Decryption failed: ${e.message}]`;
        }
    } else {
        text = extractBody(rawBody);
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
        secureJoinStep: isSecureJoin ? sjHeader.trim() : undefined,
        secureJoinInviteNumber: innerHeaders['secure-join-invitenumber'] || headers['secure-join-invitenumber'] || undefined,
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
    };
}
