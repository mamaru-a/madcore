/**
 * AccountContacts — contact registry, block list, QR helpers.
 */
import type { StoredContact } from '../store.js';
import * as securejoinLib from '../lib/securejoin.js';
import { log } from '../lib/logger.js';
import { generateAccountId } from './utils.js';
import { AccountBase } from './base.js';

export abstract class AccountContacts extends AccountBase {
    // CONTACTS
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Create a contact manually.
     *
     * Requires the peer's public key so messages can be encrypted.
     * If you don't have the key, use `secureJoin()` instead.
     *
     * @returns The full StoredContact object
     *
     * @example
     * ```ts
     * const bob = await acc.createContact({
     *     email: 'bob@relay.example',
     *     name: 'Bob',
     *     key: armoredPublicKey,
     *     avatar: base64Avatar,  // optional
     * });
     * await acc.sendMessage(bob, 'Hello!');
     * ```
     */
    async createContact(opts: { email: string; name: string; key: string; avatar?: string }): Promise<StoredContact> {
        const emailKey = opts.email.toLowerCase();
        // Check if contact already exists for this email
        const existingId = this.emailToContactId.get(emailKey);
        if (existingId) {
            const existing = this.contacts.get(existingId)!;
            // Update fields
            existing.name = opts.name;
            existing.publicKeyArmored = opts.key;
            if (opts.avatar) existing.avatar = opts.avatar;
            this.knownKeys.set(emailKey, opts.key);
            await this.store.saveContact(existing);
            return existing;
        }

        const contactId = generateAccountId();
        const contact: StoredContact = {
            id: contactId,
            email: emailKey,
            name: opts.name,
            publicKeyArmored: opts.key,
            avatar: opts.avatar,
            verified: false,
            lastSeen: Date.now(),
        };
        this.contacts.set(contactId, contact);
        this.emailToContactId.set(emailKey, contactId);
        this.knownKeys.set(emailKey, opts.key);
        await this.store.saveContact(contact);
        log.info('sdk', `Created contact ${contact.name} (${emailKey}) id=${contactId}`);
        return contact;
    }

    /** Get contact by ID */
    getContact(contactId: string): StoredContact | undefined {
        return this.contacts.get(contactId);
    }

    /** Find contact by email */
    findContactByEmail(email: string): StoredContact | undefined {
        const id = this.emailToContactId.get(email.toLowerCase());
        return id ? this.contacts.get(id) : undefined;
    }

    /** Delete a contact by ID */
    /** Block a contact by id or email — inbound dropped, outbound rejected */
    async blockContact(contactOrEmail: string | StoredContact): Promise<void> {
        const email = this.resolveEmail(contactOrEmail).toLowerCase();
        this.blockedEmails.add(email);
        const c = this.findContactByEmail(email);
        if (c) {
            c.blocked = true;
            await this.store.saveContact(c);
        } else {
            // Persist a stub contact so block survives reload
            const stub: StoredContact = {
                id: generateAccountId(),
                email,
                name: email.split('@')[0],
                verified: false,
                blocked: true,
            };
            this.contacts.set(stub.id, stub);
            await this.store.saveContact(stub);
        }
        this.emit('DC_EVENT_CONTACTS_CHANGED', { event: 'DC_EVENT_CONTACTS_CHANGED', contactId: email });
        log.info('sdk', `Blocked ${email}`);
    }

    /** Unblock a contact by id or email */
    async unblockContact(contactOrEmail: string | StoredContact): Promise<void> {
        const email = this.resolveEmail(contactOrEmail).toLowerCase();
        this.blockedEmails.delete(email);
        const c = this.findContactByEmail(email);
        if (c) {
            c.blocked = false;
            await this.store.saveContact(c);
        }
        this.emit('DC_EVENT_CONTACTS_CHANGED', { event: 'DC_EVENT_CONTACTS_CHANGED', contactId: email });
        log.info('sdk', `Unblocked ${email}`);
    }

    /** List blocked contacts / emails */
    async getBlockedContacts(): Promise<StoredContact[]> {
        const all = await this.store.getAllContacts();
        const fromStore = all.filter(c => c.blocked);
        for (const email of this.blockedEmails) {
            if (!fromStore.find(c => c.email.toLowerCase() === email)) {
                fromStore.push({
                    id: '',
                    email,
                    name: email.split('@')[0],
                    verified: false,
                    blocked: true,
                });
            }
        }
        return fromStore;
    }

    isBlocked(email: string): boolean {
        const e = email.toLowerCase();
        if (this.blockedEmails.has(e)) return true;
        const c = this.findContactByEmail(e);
        return !!c?.blocked;
    }

    /** Classify a QR code / pasted invite string (no network) */
    checkQr(input: string): securejoinLib.QrScanResult {
        return securejoinLib.checkQr(input);
    }

    /** Placeholder QR SVG for invite payloads (use a real QR lib for production) */
    createQrSvg(payload: string, size = 200): string {
        return securejoinLib.createQrSvg(payload, size);
    }

    async deleteContact(contactId: string): Promise<void> {
        const c = this.contacts.get(contactId);
        if (c) {
            this.contacts.delete(contactId);
            this.emailToContactId.delete(c.email.toLowerCase());
            await this.store.deleteContact(c.email);
        }
    }

    /**
     * Resolve a contact ID or contact object to an email address.
     * Accepts either a string (contact ID) or a StoredContact object.
     * Throws if a string ID is provided and the contact doesn't exist.
     */
    protected resolveEmail(contactOrId: string | StoredContact): string {
        if (typeof contactOrId === 'object' && contactOrId.email) {
            return contactOrId.email;
        }
        const str = contactOrId as string;
        if (str.includes('@')) return str; // Pass-through emails
        const c = this.contacts.get(str);
        if (!c) throw new Error(`Contact not found: ${str}. Create a contact first via createContact() or secureJoin().`);
        return c.email;
    }

    // ═══════════════════════════════════════════════════════════════════════
}
