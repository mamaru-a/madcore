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

    /**
     * Build (or reuse) a contact invite URI.
     * Tokens are **stable** until withdrawn / regenerated so the inviter can
     * auto-answer `vc-request` after reload (persisted via config bag).
     */
    generateSecureJoinURI(opts?: { regenerate?: boolean }): string {
        if (opts?.regenerate || !this.myInviteNumber || !this.myAuthToken) {
            this.myInviteNumber = securejoinLib.randomToken(24);
            this.myAuthToken = securejoinLib.randomToken(24);
            this.configBag.set('securejoin_invite', this.myInviteNumber);
            this.configBag.set('securejoin_auth', this.myAuthToken);
            // Flush now — joiner may scan before debounced persist runs.
            void this.flushPersist();
            log.info('sdk', 'SecureJoin invite tokens created (persisted)');
        }
        return securejoinLib.generateSecureJoinURI(
            this.ctx(),
            this.myInviteNumber,
            this.myAuthToken,
        );
    }

    /** Restore invite tokens from config bag (called after loadFromStore). */
    protected restoreSecureJoinTokensFromConfig(): void {
        const inv = this.configBag.get('securejoin_invite');
        const auth = this.configBag.get('securejoin_auth');
        if (inv) this.myInviteNumber = inv;
        if (auth) this.myAuthToken = auth;
        if (inv && auth) {
            log.info('sdk', 'Restored SecureJoin invite tokens from store');
        }
    }

    async sendSecureJoinRequest(toEmail: string, inviteNumber: string, grpId?: string): Promise<void> {
        return securejoinLib.sendSecureJoinRequest(this.ctx(), toEmail, inviteNumber, grpId);
    }

    async sendSecureJoinAuth(toEmail: string, authToken: string, grpId?: string): Promise<void> {
        return securejoinLib.sendSecureJoinAuth(this.ctx(), toEmail, authToken, grpId);
    }

    /**
     * SecureJoin inbound (core `handle_securejoin_handshake` equivalent).
     * Inviter auto-answers request / request-with-auth; joiner-side steps only emit progress
     * (joiner state machine lives in `secureJoin()` / waitForMessage).
     */
    protected async handleIncomingSecureJoin(msg: ParsedMessage): Promise<void> {
        const step = (msg.secureJoinStep || '').trim().toLowerCase();
        const inviterSteps = new Set([
            'vc-request',
            'vg-request',
            'vc-request-with-auth',
            'vg-request-with-auth',
            'vc-request-pubkey',
        ]);
        const isInviterStep =
            inviterSteps.has(step) ||
            (!!msg.secureJoinInviteNumber && (!step || step === 'vc-request' || step === 'vg-request'));

        if (isInviterStep) {
            if (!this.myInviteNumber || !this.myAuthToken) {
                log.warn(
                    'sdk',
                    'SecureJoin inviter step ignored: no active invite tokens (open QR once so tokens persist)',
                );
                return;
            }
            this.emit('DC_EVENT_SECUREJOIN_INVITER_PROGRESS', {
                event: 'DC_EVENT_SECUREJOIN_INVITER_PROGRESS',
                msg,
                contactId: msg.from,
                data1: msg.secureJoinStep || step || 'vc-request',
            });
            try {
                await securejoinLib.handleIncomingSecureJoin(
                    this.ctx(),
                    msg,
                    this.myInviteNumber,
                    this.myAuthToken,
                );
                // After joiner proves auth, mark peer verified + open 1:1 chat (inviter).
                if (step === 'vc-request-with-auth' || step === 'vg-request-with-auth') {
                    const peerEmail = msg.from.toLowerCase();
                    const peerKey =
                        this.knownKeys.get(peerEmail) ||
                        this.knownKeys.get(peerEmail.replace(/@\[([^\]]+)\]/g, '@$1')) ||
                        '';
                    if (peerKey) {
                        await this.rememberPeerKey(peerEmail, peerKey);
                    }
                    let contactId = this.emailToContactId.get(peerEmail);
                    if (!contactId) {
                        contactId = generateAccountId();
                        this.emailToContactId.set(peerEmail, contactId);
                    }
                    const contact: StoredContact = {
                        id: contactId,
                        email: peerEmail,
                        name: this.contacts.get(contactId)?.name || peerEmail.split('@')[0],
                        avatar: this.contacts.get(contactId)?.avatar || this.peerAvatars.get(peerEmail),
                        publicKeyArmored: peerKey || this.contacts.get(contactId)?.publicKeyArmored || '',
                        verified: true,
                        lastSeen: Date.now(),
                    };
                    this.contacts.set(contactId, contact);
                    await this.store.saveContact(contact);
                    // Core creates a DM chat when SecureJoin succeeds — UI expects a chatlist row.
                    const chat = await this.getOrCreateChat(peerEmail);
                    if (contact.name && chat.name !== contact.name) {
                        chat.name = contact.name;
                        await this.store.saveChat(chat);
                    }
                    this.schedulePersist();
                    this.emit('DC_EVENT_SECUREJOIN_INVITER_PROGRESS', {
                        event: 'DC_EVENT_SECUREJOIN_INVITER_PROGRESS',
                        contactId: peerEmail,
                        chatId: peerEmail,
                        data1: '1000',
                        data2: 'verified',
                    });
                    this.emit('DC_EVENT_CONTACTS_CHANGED', {
                        event: 'DC_EVENT_CONTACTS_CHANGED',
                        contactId: peerEmail,
                    });
                    this.emit('DC_EVENT_MSGS_CHANGED', {
                        event: 'DC_EVENT_MSGS_CHANGED',
                        chatId: peerEmail,
                        msgId: '',
                    });
                    log.info('sdk', `SecureJoin inviter: verified contact ${peerEmail} + chat`);
                }
            } catch (e: any) {
                log.warn('sdk', `SecureJoin inviter step failed: ${e.message}`);
            }
            return;
        }

        // Joiner-side steps (auth-required, contact-confirm, pubkey, member-added, …)
        this.emit('DC_EVENT_SECUREJOIN_JOINER_PROGRESS', {
            event: 'DC_EVENT_SECUREJOIN_JOINER_PROGRESS',
            msg,
            contactId: msg.from,
            data1: msg.secureJoinStep || step,
        });
        if (step === 'vc-contact-confirm' || step === 'vg-member-added') {
            const peerEmail = msg.from.toLowerCase();
            // Ensure DM exists when phase-4 lands (covers waiters that finished via events).
            try {
                await this.getOrCreateChat(peerEmail);
            } catch {
                /* store may not be ready */
            }
            this.emit('DC_EVENT_SECUREJOIN_JOINER_PROGRESS', {
                event: 'DC_EVENT_SECUREJOIN_JOINER_PROGRESS',
                contactId: peerEmail,
                chatId: peerEmail,
                data1: '1000',
                data2: 'verified',
            });
            this.emit('DC_EVENT_MSGS_CHANGED', {
                event: 'DC_EVENT_MSGS_CHANGED',
                chatId: peerEmail,
                msgId: '',
            });
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
        const peerKey = this.knownKeys.get(peerEmail)
            || this.knownKeys.get(peerEmail.replace(/@\[([^\]]+)\]/g, '@$1'));
        // Extract display name from the invite URI
        const parsed = this.parseSecureJoinURI(uri);
        const peerName = parsed.name || peerEmail.split('@')[0];

        // Persist peer key into active store (Memory / IndexedDB)
        if (peerKey) {
            await this.rememberPeerKey(peerEmail, peerKey);
        }

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

        // Open 1:1 chat (or group) so the chatlist shows the peer after join.
        const chatKey = result.groupInfo?.grpId || peerEmail;
        if (result.groupInfo?.grpId) {
            // Group path: ensure a chat row keyed by grpId (best-effort).
            let gchat = await this.store.getChat(chatKey);
            if (!gchat) {
                gchat = {
                    id: chatKey,
                    name: result.groupInfo.name || chatKey,
                    peerEmail: '',
                    isGroup: true,
                    unreadCount: 0,
                    archived: false,
                    pinned: false,
                    muted: false,
                };
                await this.store.saveChat(gchat);
            }
        } else {
            const chat = await this.getOrCreateChat(peerEmail);
            if (peerName && chat.name !== peerName) {
                chat.name = peerName;
                await this.store.saveChat(chat);
            }
        }

        this.schedulePersist();
        this.emit('DC_EVENT_SECUREJOIN_JOINER_PROGRESS', {
            event: 'DC_EVENT_SECUREJOIN_JOINER_PROGRESS',
            contactId: peerEmail,
            chatId: chatKey,
            data1: '1000',
            data2: result.verified ? 'verified' : 'done',
        });
        this.emit('DC_EVENT_CONTACTS_CHANGED', {
            event: 'DC_EVENT_CONTACTS_CHANGED',
            contactId: peerEmail,
        });
        this.emit('DC_EVENT_MSGS_CHANGED', {
            event: 'DC_EVENT_MSGS_CHANGED',
            chatId: chatKey,
            msgId: '',
        });
        log.info(
            'sdk',
            `SecureJoin contact ${peerName} (${peerEmail}) id=${contactId} verified=${result.verified} chat=${chatKey}`,
        );

        return { contactId, contact, ...result };
    }


    // ═══════════════════════════════════════════════════════════════════════
}
