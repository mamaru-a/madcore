/**
 * AccountSecureJoin — QR / SecureJoin handshake.
 */
import type { StoredContact } from '../store.js';
import type { ParsedMessage } from '../types.js';
import * as securejoinLib from '../lib/securejoin.js';
import { log } from '../lib/logger.js';
import { generateAccountId } from './utils.js';
import { AccountGroups } from './groups.js';

export abstract class AccountSecureJoin extends AccountGroups {
    // SECUREJOIN (delegated to lib/securejoin.ts)
    // ═══════════════════════════════════════════════════════════════════════

    parseSecureJoinURI(uri: string): import('../types.js').SecureJoinParsed {
        // Handle shell-escape cleanup
        uri = uri.replace(/\\([#&=])/g, '$1');
        return securejoinLib.parseSecureJoinURI(uri);
    }

    generateSecureJoinURI(): string {
        this.myInviteNumber = securejoinLib.randomToken(24);
        this.myAuthToken = securejoinLib.randomToken(24);
        return securejoinLib.generateSecureJoinURI(this.ctx(), this.myInviteNumber, this.myAuthToken);
    }

    async sendSecureJoinRequest(toEmail: string, inviteNumber: string, grpId?: string): Promise<void> {
        return securejoinLib.sendSecureJoinRequest(this.ctx(), toEmail, inviteNumber, grpId);
    }

    async sendSecureJoinAuth(toEmail: string, authToken: string, grpId?: string): Promise<void> {
        return securejoinLib.sendSecureJoinAuth(this.ctx(), toEmail, authToken, grpId);
    }

    protected async handleIncomingSecureJoin(msg: ParsedMessage): Promise<void> {
        this.emit('DC_EVENT_SECUREJOIN_INVITER_PROGRESS', {
            event: 'DC_EVENT_SECUREJOIN_INVITER_PROGRESS',
            msg,
            contactId: msg.from,
            data1: msg.secureJoinStep,
        });
        try {
            await securejoinLib.handleIncomingSecureJoin(this.ctx(), msg, this.myInviteNumber, this.myAuthToken);
        } catch (e: any) {
            // Inviter replies may fail offline / without peer key — progress event still stands
            log.warn('sdk', `SecureJoin inviter step failed: ${e.message}`);
        }
    }

    async secureJoin(uri: string): Promise<{
        contactId: string;
        contact: StoredContact;
        peerEmail: string;
        verified: boolean;
        groupInfo?: { grpId: string; name: string; isBroadcast: boolean }
    }> {
        const result = await securejoinLib.secureJoin(this.ctx(), uri);

        // After SecureJoin, persist the peer's contact (display name + public key)
        const peerEmail = result.peerEmail.toLowerCase();
        const peerKey = this.knownKeys.get(peerEmail);
        // Extract display name from the invite URI
        const parsed = this.parseSecureJoinURI(uri);
        const peerName = parsed.name || peerEmail.split('@')[0];

        // Create contact with random ID (or update existing)
        let contactId = this.emailToContactId.get(peerEmail);
        if (!contactId) {
            contactId = generateAccountId();
            this.emailToContactId.set(peerEmail, contactId);
        }

        const contact: StoredContact = {
            id: contactId,
            email: peerEmail,
            name: peerName,
            avatar: this.contacts.get(contactId)?.avatar,
            publicKeyArmored: peerKey || this.contacts.get(contactId)?.publicKeyArmored || '',
            verified: result.verified,
            lastSeen: Date.now(),
        };
        this.contacts.set(contactId, contact);
        await this.store.saveContact(contact);
        this.schedulePersist();
        log.info('sdk', `SecureJoin contact ${peerName} (${peerEmail}) id=${contactId} verified=${result.verified}`);

        return { contactId, contact, ...result };
    }


    // ═══════════════════════════════════════════════════════════════════════
}
