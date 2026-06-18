/**
 * Delta Chat Web SDK — Multi-Account, Multi-Transport Architecture
 *
 * Usage:
 *   const dc = DeltaChatSDK({ logLevel: 'debug' });
 *   const { id } = await dc.register('https://relay.example');
 *   const acc = dc.getAccount(id);
 *   await acc.connect();
 *   acc.on('DC_EVENT_INCOMING_MSG', handler);
 *
 * All heavy logic is extracted into lib/:
 *   - lib/transport.ts — WebSocket + REST API communication
 *   - lib/crypto.ts — PGP encryption, key gen, Autocrypt
 *   - lib/mime.ts — MIME parsing, decryption, attachments
 *   - lib/messaging.ts — All outbound message types
 *   - lib/securejoin.ts — SecureJoin protocol
 *   - lib/profile.ts — Avatar & display name management
 */

import * as openpgp from 'openpgp';
import { log, setLogLevel, getLogLevel } from './lib/logger';
import { MemoryStore, IndexedDBStore, type IDeltaChatStore, type StoredChat, type StoredMessage, type StoredContact, type StoredAccount } from './store';
import { Transport } from './lib/transport';
import { getFingerprintFromArmored } from './lib/crypto';
import * as cryptoLib from './lib/crypto';
import * as mimeLib from './lib/mime';
import * as messagingLib from './lib/messaging';
import * as securejoinLib from './lib/securejoin';
import * as profileLib from './lib/profile';
import * as groupLib from './lib/group';
import type { SDKContext } from './lib/context';

// ─── Re-exports ─────────────────────────────────────────────────────────────────

export { log, setLogLevel, getLogLevel } from './lib/logger';
export type { LogLevel } from './lib/logger';

export type {
    Credentials,
    RegisterResult,
    AccountInfo,
    AccountStatus,
    TransportStatus,
    RelayInfo,
    IncomingMessage,
    Attachment,
    ParsedMessage,
    DCEvent,
    DCEventData,
    SecureJoinParsed,
    SecureJoinResult,
    WSRequest,
    WSAction,
    MailboxInfo,
    MessageSummary,
    MessageDetail,
    FlagOperation,
    Viewtype,
    SDKConfig,
} from './types';

export type { GroupInfo } from './lib/group';
export type { StoredContact, StoredMessage } from './store';

import type {
    Credentials,
    RegisterResult,
    AccountInfo,
    AccountStatus,
    RelayInfo,
    IncomingMessage,
    ParsedMessage,
    DCEvent,
    DCEventData,
    SDKConfig,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT MANAGER (Multi-Account SDK Entry Point)
// ═══════════════════════════════════════════════════════════════════════════════

/** Generate a short random account ID */
function generateAccountId(): string {
    return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export interface IDeltaChatManager {
    /** Register a new account on a server, returns { id, email, password } */
    register(serverUrl: string, name?: string): Promise<RegisterResult>;

    /** Import / set credentials for an existing account, returns account with random ID */
    addAccount(email: string, password: string, serverUrl: string): DeltaChatAccount;

    /** Get an account handle by its random ID */
    getAccount(id: string): DeltaChatAccount;

    /** Find an account by email (returns first match or undefined) */
    findAccountByEmail(email: string): DeltaChatAccount | undefined;

    /** List all registered accounts with their IDs and emails */
    listAccounts(): AccountInfo[];

    /** Remove an account from the manager by ID (does NOT delete server-side) */
    removeAccount(id: string): void;

    /** Access the shared store */
    readonly store: IDeltaChatStore;
}

/**
 * Factory function — the primary entry point for the SDK.
 *
 * @example
 * ```ts
 * const dc = DeltaChatSDK({ logLevel: 'debug' });
 * const { id } = await dc.register('https://relay.example', 'Alice');
 * const acc = dc.getAccount(id);
 * await acc.connect();
 * acc.on('DC_EVENT_INCOMING_MSG', handler);
 * ```
 */
export function DeltaChatSDK(config: SDKConfig = {}): IDeltaChatManager {
    // Apply global config
    if (config.logLevel) setLogLevel(config.logLevel);

    const store = config.store || new MemoryStore();
    const accounts = new Map<string, DeltaChatAccount>();

    return {
        get store() { return store; },

        async register(serverUrl: string, name?: string): Promise<RegisterResult> {
            const tmpTransport = new Transport();
            const creds = await tmpTransport.register(serverUrl);
            log.info('sdk', `Registered: ${creds.email}`);

            // Create account handle with random ID
            const id = generateAccountId();
            const acc = new DeltaChatAccount(store, id, creds.email, creds.password, serverUrl);
            accounts.set(id, acc);

            // Generate keys immediately if name provided
            if (name) await acc.generateKeys(name);

            return { id, email: creds.email, password: creds.password, account: acc };
        },

        addAccount(email: string, password: string, serverUrl: string): DeltaChatAccount {
            const id = generateAccountId();
            const acc = new DeltaChatAccount(store, id, email, password, serverUrl);
            accounts.set(id, acc);
            return acc;
        },

        getAccount(id: string): DeltaChatAccount {
            const acc = accounts.get(id);
            if (!acc) throw new Error(`Account not found: ${id}. Call register() or addAccount() first.`);
            return acc;
        },

        findAccountByEmail(email: string): DeltaChatAccount | undefined {
            const key = email.toLowerCase();
            for (const acc of accounts.values()) {
                if (acc.getCredentials().email.toLowerCase() === key) return acc;
            }
            return undefined;
        },

        listAccounts(): AccountInfo[] {
            return [...accounts.entries()].map(([id, acc]) => ({
                id,
                email: acc.getCredentials().email,
            }));
        },

        removeAccount(id: string): void {
            const acc = accounts.get(id);
            if (acc) {
                acc.disconnect();
                accounts.delete(id);
            }
        },
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT CLASS (Per-Account State & Operations)
// ═══════════════════════════════════════════════════════════════════════════════

export class DeltaChatAccount {
    // ── Identity ──
    public readonly id: string;

    // ── Relay registry (relayId → config) ──
    private relays: Map<string, { id: string; serverUrl: string; email: string; password: string }> = new Map();
    private primaryRelayId = '';

    // ── Crypto state ──
    private privateKey: openpgp.PrivateKey | null = null;
    private publicKey: openpgp.Key | null = null;
    private fingerprint = '';
    private autocryptKeydata = '';
    private displayName = '';

    // ── Key store ──
    private knownKeys: Map<string, string> = new Map();   // email → armored public key
    private seenUIDs: Set<number> = new Set();

    // ── Contact registry (contactId → email) ──
    private contacts: Map<string, StoredContact> = new Map();  // contactId → contact
    private emailToContactId: Map<string, string> = new Map(); // email → contactId

    // ── Profile photo state ──
    public peerAvatars: Map<string, string> = new Map();
    private profilePhotoB64 = '';
    private profilePhotoMime = '';
    private profilePhotoChanged = false;
    private sentAvatarTo: Set<string> = new Set();

    // ── SecureJoin tokens ──
    private myInviteNumber = '';
    private myAuthToken = '';

    // ── Group registry (grpId → GroupInfo) ──
    private groups: Map<string, groupLib.GroupInfo> = new Map();

    // ── Event system ──
    private eventHandlers: Map<DCEvent, ((data: DCEventData) => void)[]> = new Map();
    private messageHandlers: ((msg: ParsedMessage) => void)[] = [];
    private rawHandlers: ((msg: IncomingMessage) => void)[] = [];

    // ── Multi-Transport ──
    /** All active transports keyed by serverUrl */
    private transports: Map<string, Transport> = new Map();
    public store: IDeltaChatStore;

    /** Get the primary relay config */
    get primaryRelay() {
        const r = this.relays.get(this.primaryRelayId);
        if (r) return r;
        const first = this.relays.values().next().value;
        if (first) return first;
        return { id: '', serverUrl: '', email: '', password: '' };
    }

    /** Backward-compat: primary relay credentials */
    get credentials(): Credentials {
        const r = this.primaryRelay;
        return { email: r.email, password: r.password };
    }

    /** Backward-compat: primary server URL */
    get serverUrl(): string { return this.primaryRelay.serverUrl; }

    /** Get the primary transport (first connected, or only one) */
    get transport(): Transport {
        const t = this.transports.get(this.primaryRelay.serverUrl);
        if (t) return t;
        // Fallback: return first transport or throw
        const first = this.transports.values().next().value;
        if (first) return first;
        throw new Error('No transports connected. Call connect() first.');
    }

    /**
     * @param store     - Storage backend
     * @param id        - Random account ID (auto-generated if omitted)
     * @param email     - Primary relay email
     * @param password  - Primary relay password
     * @param serverUrl - Primary relay server URL
     */
    constructor(store: IDeltaChatStore, id?: string, email?: string, password?: string, serverUrl?: string) {
        this.store = store;
        this.id = id || generateAccountId();
        if (email && password && serverUrl) {
            const relayId = generateAccountId();
            this.relays.set(relayId, { id: relayId, serverUrl, email, password });
            this.primaryRelayId = relayId;
            // Create initial transport
            const t = new Transport();
            t.configure(serverUrl, { email, password });
            this.transports.set(serverUrl, t);
        }
    }

    /** Static factory to load an account from a store */
    static async fromStore(store: IDeltaChatStore): Promise<DeltaChatAccount | undefined> {
        const acc = new DeltaChatAccount(store);
        const ok = await acc.loadFromStore();
        return ok ? acc : undefined;
    }

    /** Build an SDKContext for delegation to lib/ functions */
    private ctx(): SDKContext {
        return {
            serverUrl: this.serverUrl,
            credentials: this.credentials,
            privateKey: this.privateKey,
            publicKey: this.publicKey,
            fingerprint: this.fingerprint,
            autocryptKeydata: this.autocryptKeydata,
            displayName: this.displayName,
            knownKeys: this.knownKeys,
            peerAvatars: this.peerAvatars,
            profilePhotoB64: this.profilePhotoB64,
            profilePhotoMime: this.profilePhotoMime,
            profilePhotoChanged: this.profilePhotoChanged,
            sentAvatarTo: this.sentAvatarTo,
            generateMsgId: () => this.generateMsgId(),
            buildAutocryptHeader: () => cryptoLib.buildAutocryptHeader(this.credentials.email, this.autocryptKeydata),
            encryptRaw: (payload, recipientArmored) =>
                cryptoLib.encryptRaw(payload, recipientArmored, this.publicKey!, this.privateKey!),
            encrypt: (text, recipientArmored, opts) =>
                cryptoLib.encryptText(text, recipientArmored, this.publicKey!, this.privateKey!, { ...opts, displayName: this.displayName }),
            sendRaw: (from, to, body) => this.sendViaTransport(from, to, body),
            sendMessage: async (toEmail, text) => (await this.sendMessage(toEmail, text)).msgId,
            foldBase64: (b64) => { let r = ''; for (let i = 0; i < b64.length; i += 78) { if (i > 0) r += '\r\n '; r += b64.substring(i, i + 78); } return r; },
            waitForMessage: (pred, timeout) => this.waitForMessage(pred, timeout),
        };
    }

    /** Send raw message via primary transport (or first available) */
    private async sendViaTransport(from: string, to: string[], body: string): Promise<void> {
        return this.transport.send(from, to, body);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    /** Register a new account on the given server (standalone usage) */
    async register(serverUrl: string): Promise<Credentials> {
        const t = new Transport();
        const creds = await t.register(serverUrl);
        t.configure(serverUrl, creds);
        this.transports.set(serverUrl, t);
        // Add as relay
        const relayId = generateAccountId();
        this.relays.set(relayId, { id: relayId, serverUrl, email: creds.email, password: creds.password });
        if (!this.primaryRelayId) this.primaryRelayId = relayId;
        // Scope the store to this account for multi-account isolation
        if (this.store instanceof IndexedDBStore) {
            this.store.reopenForAccount(creds.email);
        }
        log.info('sdk', `Registered relay ${relayId}: ${creds.email} on ${serverUrl}`);
        return creds;
    }

    /** Set credentials manually (creates/updates primary relay) */
    setCredentials(email: string, password: string, serverUrl: string): void {
        let relayId = '';
        // Update existing relay for this server, or create new
        for (const [id, r] of this.relays) {
            if (r.serverUrl === serverUrl) { relayId = id; break; }
        }
        if (!relayId) {
            relayId = generateAccountId();
            this.relays.set(relayId, { id: relayId, serverUrl, email, password });
        } else {
            this.relays.set(relayId, { id: relayId, serverUrl, email, password });
        }
        // Update or create transport
        let t = this.transports.get(serverUrl);
        if (!t) {
            t = new Transport();
            this.transports.set(serverUrl, t);
        }
        t.configure(serverUrl, { email, password });
        if (!this.primaryRelayId) this.primaryRelayId = relayId;
    }

    /** Load state from persistent store */
    async loadFromStore(): Promise<boolean> {
        // Try to load by email if we have credentials, otherwise load first account
        let acct: StoredAccount | null = null;
        if (this.credentials.email) {
            acct = await this.store.getAccountByEmail(this.credentials.email);
        }
        if (!acct) {
            acct = await this.store.getAccount();
        }
        if (!acct) return false;

        // Restore relay
        let relayId = '';
        for (const [id, r] of this.relays) {
            if (r.serverUrl === acct.serverUrl) { relayId = id; break; }
        }
        if (!relayId) {
            relayId = generateAccountId();
        }
        this.relays.set(relayId, { id: relayId, serverUrl: acct.serverUrl, email: acct.email, password: acct.password });
        if (!this.primaryRelayId) this.primaryRelayId = relayId;

        if (acct.privateKeyArmored) {
            this.privateKey = await openpgp.readPrivateKey({ armoredKey: acct.privateKeyArmored });
        }
        if (acct.publicKeyArmored) {
            this.publicKey = await openpgp.readKey({ armoredKey: acct.publicKeyArmored });
            this.fingerprint = this.publicKey.getFingerprint().toUpperCase();
            this.autocryptKeydata = cryptoLib.extractAutocryptKeydata(acct.publicKeyArmored);
        }
        this.displayName = acct.displayName || '';

        // Scope the store to this account for multi-account isolation
        if (this.store instanceof IndexedDBStore) {
            this.store.reopenForAccount(acct.email);
            await this.store.saveAccount(acct);
        }

        // Restore known keys and contact registry from stored contacts
        for (const contact of await this.store.getAllContacts()) {
            // We no longer skip our own messages here, as they are needed for multi-device sync.
            // The SDK layer will handle deduplication.
            if (contact.publicKeyArmored) {
                // We no longer skip our own messages here, as they are needed for multi-device sync.
                // The SDK layer will handle deduplication.
                // The provided snippet was malformed. Assuming the intent was to add the original line.
                this.knownKeys.set(contact.email.toLowerCase(), contact.publicKeyArmored);
            }
            const cid = contact.id || generateAccountId();
            this.contacts.set(cid, { ...contact, id: cid });
            this.emailToContactId.set(contact.email.toLowerCase(), cid);
        }
        this.knownKeys.set(acct.email.toLowerCase(), acct.publicKeyArmored || '');

        // Ensure a transport exists for the loaded server
        if (!this.transports.has(acct.serverUrl)) {
            const t = new Transport();
            t.configure(acct.serverUrl, { email: acct.email, password: acct.password });
            this.transports.set(acct.serverUrl, t);
        } else {
            this.transports.get(acct.serverUrl)!.configure(acct.serverUrl, { email: acct.email, password: acct.password });
        }
        log.info('sdk', `Loaded account: ${acct.email}`);
        return true;
    }

    /** Save current state to persistent store */
    async saveToStore(): Promise<void> {
        const acct: StoredAccount = {
            email: this.credentials.email,
            password: this.credentials.password,
            serverUrl: this.serverUrl,
            displayName: this.displayName,
            fingerprint: this.fingerprint,
            privateKeyArmored: this.privateKey ? this.privateKey.armor() : '',
            publicKeyArmored: this.publicKey ? this.publicKey.armor() : '',
            autocryptKeydata: this.autocryptKeydata,
        };
        await this.store.saveAccount(acct);

        // Save known keys to contacts
        for (const [email, armored] of this.knownKeys) {
            if (email === this.credentials.email.toLowerCase()) continue;
            let contactId = this.emailToContactId.get(email);
            let contact = contactId ? this.contacts.get(contactId) : undefined;
            if (!contact) {
                contactId = generateAccountId();
                contact = { id: contactId, email, name: email.split('@')[0], verified: false };
                this.contacts.set(contactId, contact);
                this.emailToContactId.set(email, contactId);
            }
            contact.publicKeyArmored = armored;
            await this.store.saveContact(contact);
        }
    }

    /** Generate PGP keypair */
    async generateKeys(name?: string): Promise<void> {
        this.displayName = name || '';
        const keys = await cryptoLib.generateKeys(this.credentials.email, name);
        this.privateKey = keys.privateKey;
        this.publicKey = keys.publicKey;
        this.fingerprint = keys.fingerprint;
        this.autocryptKeydata = keys.autocryptKeydata;
        this.knownKeys.set(this.credentials.email.toLowerCase(), keys.armoredPublicKey);

        // Reconfigure all transports with updated credentials
        for (const t of this.transports.values()) {
            t.configure(this.serverUrl, this.credentials);
        }
        log.info('sdk', `Keys generated. Fingerprint: ${this.fingerprint.substring(0, 16)}...`);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TRANSPORT (multi-transport)
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Connect to a server via WebSocket.
     * If serverUrl is omitted, connects the primary (first registered) server.
     * Calling with different serverUrls adds additional transports.
     */
    async connect(serverUrlOrSinceUID?: string | number, sinceUID = 0): Promise<void> {
        let targetUrl: string;
        if (typeof serverUrlOrSinceUID === 'number') {
            // Legacy call: connect(sinceUID)
            targetUrl = this.primaryRelay.serverUrl;
            sinceUID = serverUrlOrSinceUID;
        } else {
            targetUrl = serverUrlOrSinceUID || this.primaryRelay.serverUrl;
        }

        if (!targetUrl) throw new Error('No server URL. Call register() or addRelay() first.');

        // Find the relay credentials for this server URL
        let relayCreds: Credentials = this.credentials;
        for (const [, r] of this.relays) {
            if (r.serverUrl === targetUrl) {
                relayCreds = { email: r.email, password: r.password };
                break;
            }
        }

        let t = this.transports.get(targetUrl);
        if (!t) {
            t = new Transport();
            t.configure(targetUrl, relayCreds);
            this.transports.set(targetUrl, t);
        } else {
            t.configure(targetUrl, relayCreds);
        }

        // Set up push handler for incoming messages
        t.setPushHandler(async (msg: any) => {
            if (msg.action === 'new_message') {
                await this.handlePushMessage(msg.data);
            } else {
                log.debug('sdk', `WS[${targetUrl}] unknown push:`, msg.action, msg);
            }
        });

        await t.connect(sinceUID);
        log.info('sdk', `Connected transport: ${targetUrl}`);
    }

    /** @deprecated Use connect() instead */
    async connectWebSocket(sinceUID = 0): Promise<void> {
        return this.connect(sinceUID);
    }

    /** Get a specific transport by server URL */
    getTransport(serverUrl: string): Transport {
        const t = this.transports.get(serverUrl);
        if (!t) throw new Error(`No transport for ${serverUrl}. Call connect('${serverUrl}') first.`);
        return t;
    }

    /** List all connected server URLs */
    listTransports(): string[] {
        return [...this.transports.keys()];
    }

    /** WS request passthrough (uses primary transport) */
    wsRequest(action: string, data: Record<string, any> = {}): Promise<any> {
        return this.transport.wsRequest(action, data);
    }

    /** Disconnect all transports, or a specific one by serverUrl */
    disconnect(serverUrl?: string) {
        if (serverUrl) {
            const t = this.transports.get(serverUrl);
            if (t) { t.disconnect(); this.transports.delete(serverUrl); }
        } else {
            for (const t of this.transports.values()) t.disconnect();
            this.transports.clear();
        }
    }

    /** Fetch messages via primary transport (WS preferred, REST fallback) */
    async fetchMessages(sinceUID = 0): Promise<IncomingMessage[]> {
        return this.transport.fetchMessages(sinceUID);
    }

    /** Fetch a single message by UID via primary transport */
    async fetchMessage(uid: number): Promise<IncomingMessage> {
        return this.transport.fetchMessage(uid);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // EVENT SYSTEM
    // ═══════════════════════════════════════════════════════════════════════

    on(event: DCEvent, handler: (data: DCEventData) => void) {
        if (!this.eventHandlers.has(event)) this.eventHandlers.set(event, []);
        this.eventHandlers.get(event)!.push(handler);
    }

    off(event: DCEvent, handler: (data: DCEventData) => void) {
        const handlers = this.eventHandlers.get(event);
        if (handlers) this.eventHandlers.set(event, handlers.filter(h => h !== handler));
    }

    private emit(event: DCEvent, data: DCEventData) {
        for (const h of this.eventHandlers.get(event) || []) h(data);
    }

    /** @deprecated Use on('DC_EVENT_INCOMING_MSG', ...) */
    onMessage(handler: (msg: ParsedMessage) => void) { this.messageHandlers.push(handler); }

    /** @deprecated Use on('DC_EVENT_INFO', ...) */
    onRaw(handler: (msg: IncomingMessage) => void) { this.rawHandlers.push(handler); }

    /** Wait for a message matching a predicate (with timeout) */
    waitForMessage(predicate: (msg: ParsedMessage) => boolean, timeoutMs = 60000): Promise<ParsedMessage> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
                reject(new Error(`Timeout waiting for message (${timeoutMs}ms)`));
            }, timeoutMs);
            const handler = (msg: ParsedMessage) => {
                if (predicate(msg)) {
                    clearTimeout(timer);
                    this.messageHandlers = this.messageHandlers.filter(h2 => h2 !== handler);
                    resolve(msg);
                }
            };
            this.messageHandlers.push(handler);
        });
    }

    // ═══════════════════════════════════════════════════════════════════════
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
    private resolveEmail(contactOrId: string | StoredContact): string {
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
    /** Build and persist an outgoing message, returning the result */
    private async persistOutgoing(toEmail: string, msgId: string, text: string, opts: Partial<StoredMessage> = {}): Promise<{ msgId: string; message: StoredMessage }> {
        const chatId = toEmail.toLowerCase();
        const now = Date.now();
        await this.getOrCreateChat(toEmail);
        const message: StoredMessage = {
            id: msgId,
            chatId,
            from: this.credentials.email,
            to: toEmail,
            text,
            timestamp: now,
            encrypted: true,
            direction: 'outgoing',
            type: 'text',
            state: 'sent',
            sentAt: now,
            ...opts,
        };
        await this.store.saveMessage(message);
        // Update chat summary
        const chat = await this.store.getChat(chatId);
        if (chat) {
            const safeText = text || '';
            chat.lastMessage = safeText.substring(0, 100);
            chat.lastMessageId = msgId;
            chat.lastMessageTime = now;
            await this.store.saveChat(chat);
        }
        return { msgId, message };
    }

    async sendMessage(contact: string | StoredContact, opts: { text: string; data?: string } | string): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const text = typeof opts === 'string' ? opts : opts.text;
        const data = typeof opts === 'string' ? undefined : opts.data;

        let msgId: string;
        if (data) {
            msgId = await messagingLib.sendImage(this.ctx(), toEmail, 'image.jpg', data, 'image/jpeg', text);
        } else {
            msgId = await messagingLib.sendTextMessage(this.ctx(), toEmail, text);
        }
        return this.persistOutgoing(toEmail, msgId, text, { type: data ? 'image' : 'text' });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED send() — accepts any target + message descriptor
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Universal send method.
     *
     * Target can be: contactId, StoredContact, groupId, or GroupInfo.
     *
     * The payload describes the message type. Only one of the message-type
     * fields should be set. If multiple are set, priority is:
     * delete > edit > reaction > forward > voice > audio > video > image > file > text
     *
     * @example
     * ```ts
     * // Text
     * await acc.send(bob, { text: 'Hello!' });
     *
     * // Image
     * await acc.send(bob, { image: { data: b64, filename: 'pic.jpg' } });
     *
     * // Reply to a message
     * await acc.send(bob, { text: 'I agree!', replyTo: originalMsg });
     *
     * // React
     * await acc.send(bob, { reaction: { targetMessage: msg, emoji: '👍' } });
     *
     * // Send to a group
     * await acc.send(group, { text: 'Hello group!' });
     * await acc.send(groupId, { text: 'By ID!' });
     * ```
     */
    async send(
        target: string | StoredContact | groupLib.GroupInfo,
        payload: {
            // ── Message types (pick one) ──
            text?: string;
            image?: { data: string; filename?: string; mimeType?: string; caption?: string };
            file?: { data: string; filename: string; mimeType: string; caption?: string };
            video?: { data: string; filename?: string; mimeType?: string; caption?: string; durationMs?: number };
            audio?: { data: string; filename?: string; mimeType?: string; caption?: string; durationMs?: number };
            voice?: { data: string; durationMs?: number; mimeType?: string };
            // ── Modifiers ──
            replyTo?: string | StoredMessage;
            quotedText?: string;
            // ── Actions on existing messages ──
            reaction?: { targetMessage: string | StoredMessage; reaction: string };
            edit?: { targetMessage: string | StoredMessage; newText: string };
            delete?: { targetMessage: string | StoredMessage };
            forward?: { originalMessage: string | StoredMessage; originalFrom: string };
        },
    ): Promise<{ msgId: string; message: StoredMessage } | void> {

        // ── Detect target type ──
        const isGroup = this.isGroupTarget(target);

        // ── Actions (no message creation) ──
        if (payload.delete) {
            if (isGroup) throw new Error('Cannot delete in groups via send()');
            return this.sendDelete(target as string | StoredContact, payload.delete);
        }
        if (payload.edit) {
            if (isGroup) throw new Error('Cannot edit in groups via send()');
            return this.sendEdit(target as string | StoredContact, payload.edit);
        }
        if (payload.reaction) {
            if (isGroup) throw new Error('Cannot react in groups via send()');
            return this.sendReaction(target as string | StoredContact, payload.reaction);
        }
        if (payload.forward) {
            if (isGroup) throw new Error('Cannot forward in groups via send()');
            return this.forwardMessage(target as string | StoredContact, payload.forward);
        }

        // ── Helper: apply replyTo to a just-sent result ──
        const applyReplyTo = async (result: { msgId: string; message: StoredMessage }) => {
            if (payload.replyTo) {
                const parentMsgId = this.resolveMsgId(payload.replyTo);
                result.message.inReplyTo = parentMsgId;
                if (payload.quotedText) result.message.quotedText = payload.quotedText;
                await this.store.saveMessage(result.message);
            }
            return result;
        };

        // ── Group target → route to group messaging ──
        if (isGroup) {
            const group = this.resolveGroup(target as string | groupLib.GroupInfo);
            // Media support for groups
            if (payload.image) {
                return applyReplyTo(await this.sendGroupMessage(group, { text: payload.image.caption || '', data: payload.image.data }));
            }
            if (payload.video) {
                return applyReplyTo(await this.sendGroupMessage(group, { text: payload.video.caption || '', data: payload.video.data }));
            }
            if (payload.audio) {
                return applyReplyTo(await this.sendGroupMessage(group, { text: payload.audio.caption || '', data: payload.audio.data }));
            }
            if (payload.voice) {
                const { msgId, message } = await this.sendGroupMessage(group, { text: 'Voice message', data: payload.voice.data });
                message.type = 'voice'; // override default image/text
                await this.store.saveMessage(message);
                return applyReplyTo({ msgId, message });
            }
            if (payload.file) {
                return applyReplyTo(await this.sendGroupMessage(group, { text: payload.file.caption || '', data: payload.file.data }));
            }

            // Default to text
            if (group.type === 'broadcast') {
                return applyReplyTo(await this.sendBroadcast(group, { text: payload.text || '' }));
            }
            return applyReplyTo(await this.sendGroupMessage(group, { text: payload.text || '' }));
        }

        // ── Contact target → route to contact messaging ──
        const contact = target as string | StoredContact;

        // Media types (priority order)
        if (payload.voice) {
            return applyReplyTo(await this.sendVoice(contact, payload.voice));
        }
        if (payload.audio) {
            return applyReplyTo(await this.sendAudio(contact, {
                filename: payload.audio.filename || 'audio',
                data: payload.audio.data,
                mimeType: payload.audio.mimeType,
                caption: payload.audio.caption,
                durationMs: payload.audio.durationMs,
            }));
        }
        if (payload.video) {
            return applyReplyTo(await this.sendVideo(contact, {
                filename: payload.video.filename || 'video.mp4',
                data: payload.video.data,
                mimeType: payload.video.mimeType,
                caption: payload.video.caption,
                durationMs: payload.video.durationMs,
            }));
        }
        if (payload.image) {
            return applyReplyTo(await this.sendImage(contact, {
                filename: payload.image.filename || 'image.jpg',
                data: payload.image.data,
                mimeType: payload.image.mimeType,
                caption: payload.image.caption,
            }));
        }
        if (payload.file) {
            return applyReplyTo(await this.sendFile(contact, payload.file));
        }

        // Text (with optional reply)
        const text = payload.text || '';
        if (payload.replyTo) {
            return this.sendReply(contact, {
                parentMessage: payload.replyTo,
                text,
                quotedText: payload.quotedText,
            });
        }

        return this.sendMessage(contact, text);
    }

    /** Check if a target is a group (GroupInfo object or a registered group ID) */
    private isGroupTarget(target: string | StoredContact | groupLib.GroupInfo): boolean {
        if (typeof target === 'object' && 'grpId' in target) return true;
        if (typeof target === 'string' && this.groups.has(target)) return true;
        return false;
    }

    /** Resolve a target to GroupInfo (only call if isGroupTarget returned true) */
    private resolveGroupTarget(target: string | StoredContact | groupLib.GroupInfo): groupLib.GroupInfo {
        if (typeof target === 'object' && 'grpId' in target) return target;
        return this.groups.get(target as string)!;
    }

    /** Resolve a message ID from either a string or a StoredMessage object */
    private resolveMsgId(msgOrId: string | StoredMessage): string {
        if (typeof msgOrId === 'object' && msgOrId.id) return msgOrId.id;
        return msgOrId as string;
    }

    async sendReply(contact: string | StoredContact, opts: {
        parentMessage: string | StoredMessage;
        text: string;
        quotedText?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const parentMsgId = this.resolveMsgId(opts.parentMessage);
        const msgId = await messagingLib.sendReply(this.ctx(), toEmail, parentMsgId, opts.text, opts.quotedText);
        return this.persistOutgoing(toEmail, msgId, opts.text, { inReplyTo: parentMsgId, quotedText: opts.quotedText });
    }

    async sendReaction(contact: string | StoredContact, opts: {
        targetMessage: string | StoredMessage;
        reaction: string;
    }): Promise<void> {
        const targetMsgId = this.resolveMsgId(opts.targetMessage);
        const toEmail = this.resolveEmail(contact);
        await messagingLib.sendReaction(this.ctx(), toEmail, targetMsgId, opts.reaction);

        // Persist locally
        const targetMsg = await this.store.getMessage(targetMsgId);
        if (targetMsg) {
            if (!targetMsg.reactions) targetMsg.reactions = [];
            // Remove previous reaction from same sender with same emoji (toggle) or just add
            // Actually usually reactions are stored as a list.
            targetMsg.reactions.push({ reaction: opts.reaction, from: this.credentials.email, at: Date.now() });
            await this.store.saveMessage(targetMsg);
        }
    }

    async sendDelete(contact: string | StoredContact, opts: {
        targetMessage: string | StoredMessage;
    }): Promise<void> {
        const targetMsgId = this.resolveMsgId(opts.targetMessage);
        await messagingLib.sendDelete(this.ctx(), this.resolveEmail(contact), targetMsgId);
        await this.store.deleteMessage(targetMsgId);
    }

    async sendEdit(contact: string | StoredContact, opts: {
        targetMessage: string | StoredMessage;
        newText: string;
    }): Promise<void> {
        const targetMsgId = this.resolveMsgId(opts.targetMessage);
        await messagingLib.sendEdit(this.ctx(), this.resolveEmail(contact), targetMsgId, opts.newText);
        const existing = await this.store.getMessage(targetMsgId);
        if (existing) {
            existing.text = opts.newText;
            await this.store.saveMessage(existing);
        }
    }

    async sendFile(contact: string | StoredContact, opts: {
        filename: string;
        data: string;
        mimeType: string;
        caption?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendFile(this.ctx(), toEmail, opts.filename, opts.data, opts.mimeType, opts.caption || '');
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.filename, { type: 'file', media: { filename: opts.filename, mimeType: opts.mimeType } });
    }

    async sendImage(contact: string | StoredContact, opts: {
        filename: string;
        data: string;
        mimeType?: string;
        caption?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendImage(this.ctx(), toEmail, opts.filename, opts.data, opts.mimeType || 'image/jpeg', opts.caption || '');
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.filename, { type: 'image', media: { filename: opts.filename, mimeType: opts.mimeType || 'image/jpeg' } });
    }

    async sendVideo(contact: string | StoredContact, opts: {
        filename: string;
        data: string;
        mimeType?: string;
        caption?: string;
        durationMs?: number;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendVideo(this.ctx(), toEmail, opts.filename, opts.data, opts.mimeType || 'video/mp4', opts.caption || '', opts.durationMs || 0);
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.filename, { type: 'video', media: { filename: opts.filename, mimeType: opts.mimeType || 'video/mp4', durationMs: opts.durationMs } });
    }

    async sendAudio(contact: string | StoredContact, opts: {
        filename: string;
        data: string;
        mimeType?: string;
        caption?: string;
        durationMs?: number;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendAudio(this.ctx(), toEmail, opts.filename, opts.data, opts.mimeType || 'audio/mpeg', opts.caption || '', opts.durationMs || 0);
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.filename, { type: 'audio', media: { filename: opts.filename, mimeType: opts.mimeType || 'audio/mpeg', durationMs: opts.durationMs } });
    }

    async sendVoice(contact: string | StoredContact, opts: {
        data: string;
        durationMs?: number;
        mimeType?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendVoice(this.ctx(), toEmail, opts.data, opts.durationMs || 0, opts.mimeType || 'audio/ogg');
        return this.persistOutgoing(toEmail, msgId, '[voice message]', { type: 'voice', media: { mimeType: opts.mimeType || 'audio/ogg', durationMs: opts.durationMs } });
    }

    async forwardMessage(contact: string | StoredContact, opts: {
        originalMessage: string | StoredMessage;
        originalFrom: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const originalText = typeof opts.originalMessage === 'object' ? opts.originalMessage.text : opts.originalMessage;
        const msgId = await messagingLib.forwardMessage(this.ctx(), toEmail, originalText, opts.originalFrom);
        return this.persistOutgoing(toEmail, msgId, originalText);
    }

    async resendMessage(contact: string | StoredContact, opts: {
        originalMessage: string | StoredMessage;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const originalText = typeof opts.originalMessage === 'object' ? opts.originalMessage.text : opts.originalMessage;
        const msgId = await groupLib.resendMessage(this.ctx(), toEmail, originalText);
        return this.persistOutgoing(toEmail, msgId, originalText);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // GROUPS & BROADCASTS (delegated to lib/group.ts)
    // ═══════════════════════════════════════════════════════════════════════

    /** Resolve an array of contact IDs / objects to emails */
    private resolveEmails(members: (string | StoredContact)[]): string[] {
        return members.map(m => this.resolveEmail(m));
    }

    /** Resolve a group ID string or GroupInfo object to a full GroupInfo */
    private resolveGroup(groupOrId: string | groupLib.GroupInfo): groupLib.GroupInfo {
        if (typeof groupOrId === 'object' && groupOrId.grpId) return groupOrId;
        const g = this.groups.get(groupOrId as string);
        if (!g) throw new Error(`Group not found: ${groupOrId}. Create or join a group first.`);
        return g;
    }

    /** Register a group in the local registry */
    private registerGroup(group: groupLib.GroupInfo): groupLib.GroupInfo {
        this.groups.set(group.grpId, group);
        return group;
    }

    /** Get a group by ID */
    getGroup(groupId: string): groupLib.GroupInfo | undefined {
        return this.groups.get(groupId);
    }

    /** List all known groups */
    listGroups(): groupLib.GroupInfo[] {
        return [...this.groups.values()];
    }

    async createGroup(opts: {
        name: string;
        members?: (string | StoredContact)[];
        type?: 'group' | 'broadcast';
    }): Promise<groupLib.GroupInfo> {
        const group = await groupLib.createGroup(this.ctx(), opts.name, this.resolveEmails(opts.members || []), opts.type || 'group');
        return this.registerGroup(group);
    }

    async createChannel(opts: {
        name: string;
        description?: string;
        initialMembers?: (string | StoredContact)[];
    }): Promise<groupLib.GroupInfo> {
        const channel = await groupLib.createChannel(this.ctx(), opts.name, opts.description, this.resolveEmails(opts.initialMembers || []));
        return this.registerGroup(channel);
    }
    async joinGroup(uri: string): Promise<{ peerEmail: string; verified: boolean; groupInfo?: Partial<groupLib.GroupInfo> }> {
        const result = await groupLib.joinGroup(this.ctx(), uri);
        // Register group if we got full info
        if (result.groupInfo?.grpId && result.groupInfo.name && result.groupInfo.members) {
            this.registerGroup(result.groupInfo as groupLib.GroupInfo);
        }
        return result;
    }

    async sendGroupMessage(group: string | groupLib.GroupInfo, opts: {
        text: string;
        data?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const msgId = await groupLib.sendGroupMessage(this.ctx(), g, opts.text, opts.data);
        return this.persistOutgoing(g.grpId, msgId, opts.text, { type: opts.data ? 'image' : 'text' });
    }

    async sendBroadcast(group: string | groupLib.GroupInfo, opts: {
        text: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const msgId = await groupLib.sendBroadcast(this.ctx(), g, opts.text);
        return this.persistOutgoing(g.grpId, msgId, opts.text, { type: 'text' });
    }

    async addGroupMember(group: string | groupLib.GroupInfo, opts: {
        email: string | StoredContact;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const email = this.resolveEmail(opts.email);
        const msgId = this.ctx().generateMsgId();
        await groupLib.sendGroupMemberAdded(this.ctx(), g, email);
        if (!g.members.includes(email)) g.members.push(email);
        return this.persistOutgoing(g.grpId, msgId, `Member ${email} added.`, { type: 'system' });
    }
    async removeGroupMember(group: string | groupLib.GroupInfo, opts: {
        email: string | StoredContact;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const email = this.resolveEmail(opts.email);
        const msgId = this.ctx().generateMsgId();
        await groupLib.sendGroupMemberRemoved(this.ctx(), g, email);
        g.members = g.members.filter(m => m !== email);
        return this.persistOutgoing(g.grpId, msgId, `Member ${email} removed.`, { type: 'system' });
    }
    async renameGroup(group: string | groupLib.GroupInfo, opts: {
        newName: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const msgId = this.ctx().generateMsgId();
        await groupLib.renameGroup(this.ctx(), g, opts.newName);
        g.name = opts.newName;
        return this.persistOutgoing(g.grpId, msgId, `Group name changed to ${opts.newName}.`, { type: 'system' });
    }
    async updateGroupDescription(group: string | groupLib.GroupInfo, opts: { newDescription: string }): Promise<void> {
        const g = this.resolveGroup(group);
        await groupLib.updateGroupDescription(this.ctx(), g, opts.newDescription);
        g.description = opts.newDescription;
    }
    async leaveGroup(group: string | groupLib.GroupInfo): Promise<void> {
        const g = this.resolveGroup(group);
        await groupLib.leaveGroup(this.ctx(), g);
        this.groups.delete(g.grpId);
    }


    // ═══════════════════════════════════════════════════════════════════════
    // SECUREJOIN (delegated to lib/securejoin.ts)
    // ═══════════════════════════════════════════════════════════════════════

    parseSecureJoinURI(uri: string): import('./types').SecureJoinParsed {
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

    private async handleIncomingSecureJoin(msg: ParsedMessage): Promise<void> {
        return securejoinLib.handleIncomingSecureJoin(this.ctx(), msg, this.myInviteNumber, this.myAuthToken);
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
        log.info('sdk', `SecureJoin contact ${peerName} (${peerEmail}) id=${contactId} verified=${result.verified}`);

        return { contactId, contact, ...result };
    }


    // ═══════════════════════════════════════════════════════════════════════
    // PROFILE (delegated to lib/profile.ts)
    // ═══════════════════════════════════════════════════════════════════════

    setDisplayName(name: string): void { profileLib.setDisplayName(this.ctx(), name); this.displayName = name; }
    getDisplayName(): string { return this.displayName; }

    setProfilePhotoB64(base64Data: string, mimeType = 'image/jpeg') {
        profileLib.setProfilePhotoB64(this.ctx(), base64Data, mimeType);
        this.profilePhotoB64 = base64Data;
        this.profilePhotoMime = mimeType;
        this.profilePhotoChanged = true;
        this.sentAvatarTo.clear();
    }

    async setProfilePhoto(filePath: string) {
        // Node-specific, but using dynamic import to avoid breaking browser builds
        try {
            // @ts-ignore
            const fs: any = await import('fs');
            const data: any = fs.readFileSync(filePath);

            const ext = filePath.split('.').pop()?.toLowerCase() || 'jpg';
            const mimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
            // Use a portable way to convert to b64 if Buffer is not available
            const b64 = typeof (globalThis as any).Buffer !== 'undefined'
                ? (globalThis as any).Buffer.from(data).toString('base64')
                : ''; // Browser users should use setProfilePhotoB64 directly
            this.setProfilePhotoB64(b64, mimeMap[ext] || 'image/jpeg');
        } catch (e) {
            log.error('sdk', 'setProfilePhoto is only available in Node.js environments:', e);
        }
    }




    async sendProfilePhoto(contact: string | StoredContact, opts: { caption?: string; data?: string; mimeType?: string } | string = {}): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const caption = typeof opts === 'string' ? opts : (opts.caption || 'Profile photo updated.');
        const data = typeof opts === 'object' ? opts.data : undefined;
        const mimeType = typeof opts === 'object' ? opts.mimeType : undefined;

        if (data) {
            this.setProfilePhotoB64(data, mimeType || 'image/jpeg');
        }

        const msgId = await profileLib.sendProfilePhotoReturningId(this.ctx(), toEmail, caption);
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

    // ═══════════════════════════════════════════════════════════════════════
    // UTILITY
    // ═══════════════════════════════════════════════════════════════════════

    getCredentials(): Credentials { return this.credentials; }
    getFingerprint(): string { return this.fingerprint; }
    getKnownKeys(): Map<string, string> { return this.knownKeys; }
    getPublicKeyArmored(): string | null { return this.publicKey ? this.publicKey.armor() : null; }

    importKey(email: string, armoredKey: string) {
        this.knownKeys.set(email.toLowerCase(), armoredKey);
    }

    /** Get the full status of this account including all relay connection states */
    status(): AccountStatus {
        const relayList: RelayInfo[] = [];
        for (const [, r] of this.relays) {
            const t = this.transports.get(r.serverUrl);
            relayList.push({
                id: r.id,
                serverUrl: r.serverUrl,
                email: r.email,
                password: r.password,
                isConnected: t?.isConnected ?? false,
                state: t?.state ?? 'disconnected',
            });
        }

        return {
            id: this.id,
            email: this.primaryRelay.email,
            displayName: this.displayName,
            fingerprint: this.fingerprint,
            hasKeys: this.privateKey !== null && this.publicKey !== null,
            knownContacts: this.knownKeys.size,
            relays: relayList,
            isConnected: relayList.some(r => r.isConnected),
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // RELAY MANAGEMENT
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Add a new relay to this account.
     *
     * With just a serverUrl, registers a new identity on that server.
     * With opts, uses existing credentials.
     *
     * @example
     * ```ts
     * // Register new identity on another server
     * const relay = await acc.addRelay('https://relay2.example');
     *
     * // Or add with existing credentials
     * const relay = await acc.addRelay('https://relay3.example', {
     *     email: 'alice@relay3.example',
     *     password: 'secret123',
     * });
     * ```
     */
    async addRelay(serverUrl: string, opts?: { email: string; password: string }): Promise<RelayInfo> {
        const relayId = generateAccountId();
        let email: string, password: string;

        if (opts) {
            // Use existing credentials
            email = opts.email;
            password = opts.password;
        } else {
            // Register new identity on this server
            const t = new Transport();
            const creds = await t.register(serverUrl);
            email = creds.email;
            password = creds.password;
        }

        // Store relay
        this.relays.set(relayId, { id: relayId, serverUrl, email, password });

        // Create transport
        const t = new Transport();
        t.configure(serverUrl, { email, password });
        this.transports.set(serverUrl, t);

        // If no primary, set this
        if (!this.primaryRelayId) this.primaryRelayId = relayId;

        log.info('sdk', `Added relay ${relayId}: ${email} on ${serverUrl}`);
        return {
            id: relayId,
            serverUrl,
            email,
            password,
            isConnected: false,
            state: 'disconnected',
        };
    }

    /** List all relays */
    listRelays(): RelayInfo[] {
        return this.status().relays;
    }

    /** Get a relay by ID */
    getRelay(relayId: string): RelayInfo | undefined {
        const r = this.relays.get(relayId);
        if (!r) return undefined;
        const t = this.transports.get(r.serverUrl);
        return {
            id: r.id,
            serverUrl: r.serverUrl,
            email: r.email,
            password: r.password,
            isConnected: t?.isConnected ?? false,
            state: t?.state ?? 'disconnected',
        };
    }

    /** Remove a relay by ID (disconnects its transport) */
    removeRelay(relayId: string): void {
        const r = this.relays.get(relayId);
        if (!r) return;
        const t = this.transports.get(r.serverUrl);
        if (t) { t.disconnect(); this.transports.delete(r.serverUrl); }
        this.relays.delete(relayId);
        if (this.primaryRelayId === relayId) {
            this.primaryRelayId = this.relays.keys().next().value || '';
        }
        log.info('sdk', `Removed relay ${relayId}: ${r.email}`);
    }

    private generateMsgId(): string {
        const id = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        return `<${id}@${this.credentials.email.split('@')[1]}>`;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INCOMING MESSAGE HANDLING (private)
    // ═══════════════════════════════════════════════════════════════════════

    /** Handle a WS push message (new_message) */
    private async handlePushMessage(summary: any): Promise<void> {
        if (this.seenUIDs.has(summary.uid)) return;
        this.seenUIDs.add(summary.uid);

        let raw: IncomingMessage;
        try {
            const detail = await this.transport.wsRequest('fetch', { uid: summary.uid });
            raw = { uid: detail.uid, body: detail.body, envelope: detail.envelope };
        } catch {
            raw = await this.transport.fetchMessage(summary.uid);
        }

        for (const h of this.rawHandlers) h(raw);

        const parsed = await mimeLib.parseIncoming(raw, {
            email: this.credentials.email,
            privateKey: this.privateKey,
            knownKeys: this.knownKeys,
            peerAvatars: this.peerAvatars,
        });

        if (parsed) {
            // Inviter-side SecureJoin auto-response
            if (parsed.isSecureJoin && this.myInviteNumber) {
                await this.handleIncomingSecureJoin(parsed);
            }

            // Emit DC_EVENT_* events
            if (parsed.isSecureJoin) {
                this.emit('DC_EVENT_SECUREJOIN_JOINER_PROGRESS', { event: 'DC_EVENT_SECUREJOIN_JOINER_PROGRESS', msg: parsed, data1: parsed.secureJoinStep });
            } else if (parsed.isReaction) {
                this.emit('DC_EVENT_INCOMING_REACTION', { event: 'DC_EVENT_INCOMING_REACTION', msg: parsed, msgId: parsed.rfc724mid || undefined });
            } else if (parsed.isDelete) {
                this.emit('DC_EVENT_MSG_DELETED', { event: 'DC_EVENT_MSG_DELETED', msg: parsed, msgId: parsed.text });
            } else if (parsed.avatarUpdate !== undefined) {
                this.emit('DC_EVENT_CONTACTS_CHANGED', { event: 'DC_EVENT_CONTACTS_CHANGED', msg: parsed, contactId: parsed.from });
                this.emit('DC_EVENT_INCOMING_MSG', { event: 'DC_EVENT_INCOMING_MSG', msg: parsed, msgId: parsed.rfc724mid || undefined });
            } else {
                this.emit('DC_EVENT_INCOMING_MSG', { event: 'DC_EVENT_INCOMING_MSG', msg: parsed, msgId: parsed.rfc724mid || undefined });
            }

            for (const h of this.messageHandlers) h(parsed);
            await this.storeIncomingMessage(parsed);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CHAT & MESSAGE MANAGEMENT (store delegation)
    // ═══════════════════════════════════════════════════════════════════════

    async getChatList(): Promise<StoredChat[]> { return this.store.getAllChats(); }
    async searchChats(query: string): Promise<StoredChat[]> { return this.store.searchChats(query); }
    async getChat(chatId: string): Promise<StoredChat | null> { return this.store.getChat(chatId); }
    async getChatMessages(chatId: string, limit = 100, offset = 0): Promise<StoredMessage[]> { return this.store.getChatMessages(chatId, limit, offset); }

    async deleteChat(chatId: string): Promise<void> {
        await this.store.deleteChat(chatId);
        const msgs = await this.store.getChatMessages(chatId);
        for (const m of msgs) await this.store.deleteMessage(m.id);
    }

    async deleteLocalMessage(msgId: string): Promise<void> {
        const msg = await this.store.getMessage?.(msgId);
        await this.store.deleteMessage(msgId);
        if (msg) {
            const chat = await this.store.getChat(msg.chatId);
            if (chat && chat.lastMessageId === msgId) {
                const msgs = await this.store.getChatMessages(msg.chatId, 1, 0);
                if (msgs.length > 0) { chat.lastMessage = msgs[0].text; chat.lastMessageId = msgs[0].id; chat.lastMessageTime = msgs[0].timestamp; }
                else { chat.lastMessage = undefined; chat.lastMessageId = undefined; chat.lastMessageTime = undefined; }
                await this.store.saveChat(chat);
            }
        }
    }

    async archiveChat(chatId: string, archive: boolean): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (chat) { chat.archived = archive; await this.store.saveChat(chat); }
    }

    async pinChat(chatId: string, pin: boolean): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (chat) { chat.pinned = pin; await this.store.saveChat(chat); }
    }

    async muteChat(chatId: string, mute: boolean): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (chat) { chat.muted = mute; await this.store.saveChat(chat); }
    }

    async getUnreadCount(): Promise<number> {
        const chats = await this.store.getAllChats();
        return chats.reduce((sum, c) => sum + c.unreadCount, 0);
    }

    async getContacts(): Promise<StoredContact[]> { return this.store.getAllContacts(); }

    async searchContacts(query: string): Promise<StoredContact[]> {
        const all = await this.store.getAllContacts();
        const q = query.toLowerCase();
        return all.filter(c => c.email.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    }

    async searchMessages(query: string, chatId?: string): Promise<StoredMessage[]> {
        return this.store.searchMessages(query, chatId);
    }

    async getOrCreateChat(peerEmail: string): Promise<StoredChat> {
        const chatId = peerEmail.toLowerCase();
        let chat = await this.store.getChat(chatId);
        if (!chat) {
            chat = { id: chatId, name: peerEmail.split('@')[0], peerEmail, isGroup: false, unreadCount: 0, archived: false, pinned: false, muted: false };
            await this.store.saveChat(chat);
        }
        return chat;
    }

    private async storeIncomingMessage(parsed: ParsedMessage): Promise<void> {
        const peerEmail = parsed.from.toLowerCase();
        const chat = await this.getOrCreateChat(peerEmail);

        if (parsed.isDelete) {
            await this.store.deleteMessage(parsed.text);
            const msgs = await this.store.getChatMessages(peerEmail, 1, 0);
            if (msgs.length > 0) { const l = msgs[msgs.length - 1]; chat.lastMessage = l.text; chat.lastMessageId = l.id; chat.lastMessageTime = l.timestamp; }
            else { chat.lastMessage = undefined; chat.lastMessageId = undefined; chat.lastMessageTime = undefined; }
            await this.store.saveChat(chat);
            return;
        }

        if (parsed.isReaction) {
            // Attach reaction to the target message instead of creating a separate message
            const targetMsgId = parsed.innerHeaders['in-reply-to'] || parsed.headers['in-reply-to'];
            if (targetMsgId) {
                const targetMsg = await this.store.getMessage(targetMsgId);
                if (targetMsg) {
                    if (!targetMsg.reactions) targetMsg.reactions = [];
                    targetMsg.reactions.push({ reaction: parsed.text, from: parsed.from, at: Date.now() });
                    await this.store.saveMessage(targetMsg);
                }
            }
            return;
        }

        if (parsed.avatarUpdate !== undefined) {
            chat.avatar = parsed.avatarUpdate || undefined;
            const contact = await this.store.getContact(peerEmail);
            if (contact) { contact.avatar = parsed.avatarUpdate || undefined; await this.store.saveContact(contact); }
        }

        // Deduplication
        const msgId = parsed.rfc724mid || `msg-${parsed.uid}`;
        const existing = await this.store.getMessage(msgId);
        if (existing) {
            log.debug('sdk', `Skipping duplicate message ${msgId}`);
            return;
        }

        const isSelf = parsed.from === this.credentials.email.toLowerCase();
        let targetChatId: string;
        if (parsed.groupId) {
            targetChatId = parsed.groupId;
        } else {
            // For 1:1, if it's from us, it's addressed TO the peer (targetChatId is peerEmail)
            targetChatId = isSelf ? parsed.to.toLowerCase() : parsed.from.toLowerCase();
        }

        const msg: StoredMessage = {
            id: msgId,
            chatId: targetChatId,
            from: parsed.from,
            to: isSelf ? parsed.to : this.credentials.email,
            text: parsed.text,
            timestamp: parsed.timestamp,
            encrypted: parsed.encrypted,
            direction: isSelf ? 'outgoing' : 'incoming',
            type: 'text',
            inReplyTo: parsed.innerHeaders['in-reply-to'] || parsed.headers['in-reply-to'],
            state: 'sent',
            sentAt: parsed.timestamp,
            seenAt: isSelf ? parsed.timestamp : undefined,
        };
        await this.store.saveMessage(msg);

        // Update chat summary
        const chatObj = await this.store.getChat(targetChatId);
        if (chatObj) {
            chatObj.lastMessage = parsed.text.substring(0, 100);
            chatObj.lastMessageId = msg.id;
            chatObj.lastMessageTime = msg.timestamp;
            if (!isSelf) {
                chatObj.unreadCount++;
            }
            await this.store.saveChat(chatObj);
        } else if (!parsed.groupId) {
            // Ensure 1:1 chat exists
            await this.getOrCreateChat(targetChatId);
        }
    }


    async markChatRead(chatId: string): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (!chat) return;
        chat.unreadCount = 0;
        await this.store.saveChat(chat);

        // Mark all messages in this chat as seen
        const msgs = await this.store.getChatMessages(chatId, 1000, 0);
        const now = Date.now();
        for (const msg of msgs) {
            if (msg.direction === 'incoming' && msg.state !== 'seen') {
                msg.state = 'seen';
                msg.seenAt = now;
                await this.store.saveMessage(msg);
            }
        }
    }

    /** Mark a specific message as seen by the current user (or a peer in group) */
    async markMessageSeen(msgId: string, byEmail?: string): Promise<void> {
        const msg = await this.store.getMessage(msgId);
        if (!msg) return;
        const now = Date.now();
        msg.state = 'seen';
        if (!msg.seenAt) msg.seenAt = now;

        if (byEmail) {
            if (!msg.seenBy) msg.seenBy = [];
            if (!msg.seenBy.find(s => s.email === byEmail)) {
                msg.seenBy.push({ email: byEmail, at: now });
            }
        }
        await this.store.saveMessage(msg);
    }
}

export { getFingerprintFromArmored };
