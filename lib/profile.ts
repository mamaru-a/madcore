/**
 * lib/profile.ts — Profile management (avatar, display name)
 *
 * Extracted from sdk.ts. Handles:
 *   - Setting/getting display name (core: Config::Displayname)
 *   - Setting profile photo as base64 or from file
 *   - Sending profile photo update as Chat-User-Avatar header
 *   - Broadcasting profile photo to all known contacts
 */

import type { SDKContext } from './context.js';
import { log } from './logger.js';
import { buildFromHeader, buildPgpMimeEnvelope, foldBase64 } from './mime-build.js';

// ─── Display Name ───────────────────────────────────────────────────────────────

/** Set the display name (maps to core Config::Displayname) */
export function setDisplayName(ctx: SDKContext, name: string): void {
    ctx.displayName = name;
    log.debug('profile', `Display name set to: "${name}"`);
}

/** Get current display name */
export function getDisplayName(ctx: SDKContext): string {
    return ctx.displayName;
}

// ─── Profile Photo ──────────────────────────────────────────────────────────────

/** Set profile photo from base64 data */
export function setProfilePhotoB64(ctx: SDKContext, base64Data: string, mimeType = 'image/jpeg') {
    ctx.profilePhotoB64 = base64Data;
    ctx.profilePhotoMime = mimeType;
    ctx.profilePhotoChanged = true;
    ctx.sentAvatarTo.clear();
    log.debug('profile', `Profile photo set (${Math.round(base64Data.length * 0.75 / 1024)}KB ${mimeType})`);
}

/** Get cached peer avatar data URI */
export function getPeerAvatar(ctx: SDKContext, email: string): string | null {
    return ctx.peerAvatars.get(email.toLowerCase()) || null;
}

/**
 * Build Chat-User-Avatar header for a contact (returns empty string if already sent).
 * Matches core's attach_selfavatar behavior.
 */
export function getAvatarHeaderForContact(ctx: SDKContext, toEmail: string): string {
    if (!ctx.profilePhotoChanged) return '';
    if (ctx.sentAvatarTo.has(toEmail.toLowerCase())) return '';

    if (ctx.profilePhotoB64) {
        return `Chat-User-Avatar: base64:${foldBase64(ctx.profilePhotoB64)}`;
    } else {
        return 'Chat-User-Avatar: 0';
    }
}

/** Mark that the profile photo has been sent to a contact */
export function markAvatarSent(ctx: SDKContext, toEmail: string) {
    ctx.sentAvatarTo.add(toEmail.toLowerCase());
}

/** Send profile photo update to a specific contact. Returns the generated msgId. */
export async function sendProfilePhoto(ctx: SDKContext, toEmail: string, text = 'Profile photo updated.'): Promise<string> {
    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`No key for ${toEmail} — cannot send profile photo`);
    }
    if (!ctx.profilePhotoB64) {
        throw new Error('No profile photo set — call setProfilePhotoB64 first');
    }

    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    const fromHeader = buildFromHeader(ctx);
    const avatarHeader = `Chat-User-Avatar: base64:${ctx.profilePhotoB64}`;

    const innerMime = [
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
        fromHeader,
        `To: <${toEmail}>`,
        `Chat-Version: 1.0`,
        avatarHeader,
        '',
        text
    ].join('\r\n');

    const armored = await ctx.encryptRaw(innerMime, peerKey);
    const rawEmail = buildPgpMimeEnvelope({
        fromHeader,
        toHeader: `<${toEmail}>`,
        msgId,
        date: now,
        subject: '[...]',
        outerHeaders: [],
        autocryptHeader: ctx.buildAutocryptHeader(),
        armored,
    });

    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    ctx.sentAvatarTo.add(toEmail.toLowerCase());
    log.info('profile', `Sent profile photo to ${toEmail}`);
    return msgId;
}

/** Broadcast profile photo to all known contacts */
export async function broadcastProfilePhoto(ctx: SDKContext): Promise<void> {
    const emails = Array.from(ctx.knownKeys.keys()).filter(
        e => e !== ctx.credentials.email.toLowerCase()
    );
    log.info('profile', `Broadcasting profile photo to ${emails.length} contacts...`);
    for (const email of emails) {
        try {
            await sendProfilePhoto(ctx, email);
        } catch (e: any) {
            log.error('profile', `Failed to send avatar to ${email}: ${e.message}`);
        }
    }
}

