/**
 * AccountProfile — display name and avatar.
 */
import type { StoredMessage, StoredContact } from '../store.js';
import * as profileLib from '../lib/profile.js';
import { log } from '../lib/logger.js';
import { bytesToBase64 } from './utils.js';
import { AccountSecureJoin } from './securejoin.js';

export abstract class AccountProfile extends AccountSecureJoin {
    // PROFILE (delegated to lib/profile.ts)
    // ═══════════════════════════════════════════════════════════════════════

    setDisplayName(name: string): void {
        profileLib.setDisplayName(this.ctx(), name);
        this.displayName = name;
        this.schedulePersist();
    }
    getDisplayName(): string { return this.displayName; }

    setProfilePhotoB64(base64Data: string, mimeType = 'image/jpeg') {
        profileLib.setProfilePhotoB64(this.ctx(), base64Data, mimeType);
        this.profilePhotoB64 = base64Data;
        this.profilePhotoMime = mimeType;
        this.profilePhotoChanged = true;
        this.sentAvatarTo.clear();
        this.emit('DC_EVENT_SELFAVATAR_CHANGED', {
            event: 'DC_EVENT_SELFAVATAR_CHANGED',
            data1: mimeType,
            data2: base64Data ? base64Data.length : 0,
        });
        this.schedulePersist();
    }

    /**
     * Set profile photo from browser-friendly sources.
     * Prefer this over path-based APIs in web apps.
     *
     * Accepts:
     * - `{ data: base64, mimeType? }` raw base64
     * - `Blob` / `File` (browser File input)
     * - `ArrayBuffer` / `Uint8Array`
     * - data URI string (`data:image/png;base64,...`)
     */
    async setProfilePhoto(
        input:
            | string
            | Blob
            | ArrayBuffer
            | Uint8Array
            | { data: string; mimeType?: string },
    ): Promise<void> {
        // Object form: already base64
        if (input && typeof input === 'object' && !(input instanceof Blob) && !(input instanceof ArrayBuffer) && !(input instanceof Uint8Array) && 'data' in input) {
            this.setProfilePhotoB64(input.data, input.mimeType || 'image/jpeg');
            return;
        }

        // data URI
        if (typeof input === 'string' && input.startsWith('data:')) {
            const m = input.match(/^data:([^;]+);base64,(.+)$/);
            if (!m) throw new Error('Invalid data URI for profile photo');
            this.setProfilePhotoB64(m[2], m[1] || 'image/jpeg');
            return;
        }

        // bare base64 string
        if (typeof input === 'string') {
            this.setProfilePhotoB64(input, 'image/jpeg');
            return;
        }

        // Blob / File
        if (typeof Blob !== 'undefined' && input instanceof Blob) {
            const buf = new Uint8Array(await input.arrayBuffer());
            const b64 = bytesToBase64(buf);
            this.setProfilePhotoB64(b64, input.type || 'image/jpeg');
            return;
        }

        // ArrayBuffer / Uint8Array
        let bytes: Uint8Array;
        if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
        else if (input instanceof Uint8Array) bytes = input;
        else throw new Error('Unsupported profile photo input (use base64, Blob, or ArrayBuffer)');

        this.setProfilePhotoB64(bytesToBase64(bytes), 'image/jpeg');
    }




    async sendProfilePhoto(contact: string | StoredContact, opts: { caption?: string; data?: string; mimeType?: string } | string = {}): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const caption = typeof opts === 'string' ? opts : (opts.caption || 'Profile photo updated.');
        const data = typeof opts === 'object' ? opts.data : undefined;
        const mimeType = typeof opts === 'object' ? opts.mimeType : undefined;

        if (data) {
            this.setProfilePhotoB64(data, mimeType || 'image/jpeg');
        }

        const msgId = await profileLib.sendProfilePhoto(this.ctx(), toEmail, caption);
        return this.persistOutgoing(toEmail, msgId, caption, { type: 'image' });
    }

    async broadcastProfilePhoto(): Promise<void> {
        return profileLib.broadcastProfilePhoto(this.ctx());
    }

    getPeerAvatar(email: string): string | null {
        return profileLib.getPeerAvatar(this.ctx(), email);
    }

    getAvatarHeaderForContact(toEmail: string): string {
        return profileLib.getAvatarHeaderForContact(this.ctx(), toEmail);
    }

    markAvatarSent(toEmail: string) {
        profileLib.markAvatarSent(this.ctx(), toEmail);
    }

}
