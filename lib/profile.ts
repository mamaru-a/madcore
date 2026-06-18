/**
 * lib/profile.ts — Profile management (avatar, display name)
 *
 * Extracted from sdk.ts. Handles:
 *   - Setting/getting display name (core: Config::Displayname)
 *   - Setting profile photo as base64 or from file
 *   - Sending profile photo update as Chat-User-Avatar header
 *   - Broadcasting profile photo to all known contacts
 */

import type { SDKContext } from './context';
import { log } from './logger';

const crypto = globalThis.crypto;

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
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;

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
    ctx.sentAvatarTo.add(toEmail.toLowerCase());
    log.info('profile', `Sent profile photo to ${toEmail}`);
    return msgId;
}

/** Alias for sendProfilePhoto that explicitly returns the msgId */
export const sendProfilePhotoReturningId = sendProfilePhoto;

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

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Fold base64 data with space every 78 chars (RFC 2822 header continuation) */
function foldBase64(b64: string): string {
    let result = '';
    for (let i = 0; i < b64.length; i += 78) {
        if (i > 0) result += '\r\n ';
        result += b64.substring(i, i + 78);
    }
    return result;
}
