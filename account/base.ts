/**
 * AccountBase — shared state, lifecycle, transport, events, and crypto wiring.
 * Feature layers extend this class.
 */
import * as openpgp from 'openpgp';
import { log, addLogSink } from '../lib/logger.js';
import { IndexedDBStore, type IDeltaChatStore, type StoredChat, type StoredMessage, type StoredContact, type StoredAccount, type StoredGroup } from '../store.js';
import { Transport } from '../lib/transport.js';
import * as cryptoLib from '../lib/crypto.js';
import { setKnownKey } from '../lib/crypto.js';
import { foldBase64 } from '../lib/mime-build.js';
import type { WebxdcStatusUpdate } from '../lib/webxdc.js';
import type { LocationStreamState, LocationPoint } from '../lib/location.js';
import type { CallSession, IceServer } from '../lib/calls.js';
import type { GroupInfo } from '../lib/group.js';
import type { SDKContext } from '../lib/context.js';
import type {
    Credentials,
    AccountStatus,
    RelayInfo,
    IncomingMessage,
    ParsedMessage,
    DCEvent,
    DCEventData,
} from '../types.js';
import { generateAccountId } from './utils.js';

export abstract class AccountBase {
    // ── Identity ──
    public readonly id: string;

    // ── Relay registry (relayId → config) ──
    protected relays: Map<string, { id: string; serverUrl: string; email: string; password: string }> = new Map();
    protected primaryRelayId = '';

    // ── Crypto state ──
    protected privateKey: openpgp.PrivateKey | null = null;
    protected publicKey: openpgp.Key | null = null;
    protected fingerprint = '';
    protected autocryptKeydata = '';
    protected displayName = '';

    // ── Key store ──
    protected knownKeys: Map<string, string> = new Map();   // email → armored public key
    protected seenUIDs: Set<number> = new Set();
    /** Highest mailbox UID processed (persisted for reconnect) */
    protected lastSeenUid = 0;
    /** Debounced account snapshot write */
    private persistTimer: ReturnType<typeof setTimeout> | null = null;

    // ── Contact registry (contactId → email) ──
    protected contacts: Map<string, StoredContact> = new Map();  // contactId → contact
    /** Emails blocked without a full contact record */
    protected blockedEmails: Set<string> = new Set();
    /** Local config bag */
    protected configBag: Map<string, string> = new Map();
    /** Webxdc status updates by instance msg id */
    protected webxdcUpdates: Map<string, WebxdcStatusUpdate[]> = new Map();
    /** Active location streams chatId → until ms */
    protected locationStreams: Map<string, LocationStreamState> = new Map();
    /** Stored location points (in-memory; also mirrored as messages) */
    protected locationPoints: LocationPoint[] = [];
    /** Active call sessions */
    protected calls: Map<string, CallSession> = new Map();
    /** ICE servers for WebRTC (optional) */
    protected iceServers: IceServer[] = [];
    /** Mailboxes to sync (default INBOX) */
    protected watchedMailboxes: string[] = ['INBOX'];
    /** Last transport error for connectivity diagnostics */
    protected lastTransportError: string | null = null;
    protected emailToContactId: Map<string, string> = new Map(); // email → contactId

    // ── Profile photo state ──
    public peerAvatars: Map<string, string> = new Map();
    protected profilePhotoB64 = '';
    protected profilePhotoMime = '';
    protected profilePhotoChanged = false;
    protected sentAvatarTo: Set<string> = new Set();

    // ── SecureJoin tokens ──
    protected myInviteNumber = '';
    protected myAuthToken = '';

    // ── Group registry (grpId → GroupInfo) ──
    protected groups: Map<string, GroupInfo> = new Map();

    // ── Event system ──
    protected eventHandlers: Map<DCEvent, ((data: DCEventData) => void)[]> = new Map();
    protected messageHandlers: ((msg: ParsedMessage) => void)[] = [];
    protected rawHandlers: ((msg: IncomingMessage) => void)[] = [];

    // ── Multi-Transport ──
    /** All active transports keyed by serverUrl */
    protected transports: Map<string, Transport> = new Map();
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
        // Bridge logger → DC_EVENT_INFO / WARNING / ERROR (browser-safe)
        this.logUnsub = addLogSink((level, tag, msg) => {
            if (level === 'info') {
                this.emit('DC_EVENT_INFO', { event: 'DC_EVENT_INFO', data1: tag, data2: msg });
            } else if (level === 'warn') {
                this.emit('DC_EVENT_WARNING', { event: 'DC_EVENT_WARNING', data1: tag, data2: msg });
            } else if (level === 'error') {
                this.emit('DC_EVENT_ERROR', { event: 'DC_EVENT_ERROR', data1: tag, data2: msg });
            }
        });
    }

    protected logUnsub: (() => void) | null = null;


    /** Implemented by AccountMessaging — required for SDKContext wiring */
    abstract sendMessage(
        contact: string | StoredContact,
        opts: { text: string; data?: string } | string,
    ): Promise<{ msgId: string; message: StoredMessage }>;

    /** Implemented by AccountInbox */
    abstract processIncomingRaw(raw: IncomingMessage): Promise<ParsedMessage | null>;

    /** Build an SDKContext for delegation to lib/ functions */
    protected ctx(): SDKContext {
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
            // Autocrypt addr must match MIME From exactly (core addr_cmp; no bare-IP twin).
            buildAutocryptHeader: () =>
                cryptoLib.buildAutocryptHeader(this.credentials.email, this.autocryptKeydata),
            encryptRaw: (payload, recipientArmored) =>
                cryptoLib.encryptRaw(payload, recipientArmored, this.publicKey!, this.privateKey!),
            encrypt: (text, recipientArmored, opts) =>
                cryptoLib.encryptText(text, recipientArmored, this.publicKey!, this.privateKey!, { ...opts, displayName: this.displayName }),
            sendRaw: (from, to, body) => this.sendViaTransport(from, to, body),
            sendMessage: async (toEmail, text) => (await this.sendMessage(toEmail, text)).msgId,
            foldBase64,
            waitForMessage: (pred, timeout) => this.waitForMessage(pred, timeout),
        };
    }

    /** Send raw message via primary transport (or first available) */
    protected async sendViaTransport(from: string, to: string[], body: string): Promise<void> {
        return this.transport.send(from, to, body);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    /** Register a new account on the given server (standalone usage) */
    async register(serverUrl: string, options?: { token?: string }): Promise<Credentials & { dclogin_url?: string }> {
        const t = new Transport();
        const creds = await t.register(serverUrl, options);
        t.configure(serverUrl, creds);
        this.transports.set(serverUrl, t);
        const relayId = generateAccountId();
        this.relays.set(relayId, { id: relayId, serverUrl, email: creds.email, password: creds.password });
        if (!this.primaryRelayId) this.primaryRelayId = relayId;
        if (this.store instanceof IndexedDBStore) {
            this.store.reopenForAccount(creds.email);
        }
        this.schedulePersist();
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
        this.schedulePersist();
    }

    /**
     * Debounced account snapshot write (keys, profile, groups, config, relays).
     * Chats/messages/contacts are written immediately via the store.
     */
    schedulePersist(): void {
        if (!this.credentials.email) return;
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            void this.saveToStore().catch((e: any) =>
                log.warn('sdk', `persist failed: ${e?.message || e}`),
            );
        }, 250);
    }

    /** Flush pending debounced persist immediately (useful in tests / before unload). */
    async flushPersist(): Promise<void> {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        await this.saveToStore();
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

        // Scope to per-account DB when using IndexedDB, then re-read.
        // Stores already created via forAccount(email) keep the same DB name.
        if (this.store instanceof IndexedDBStore) {
            this.store.reopenForAccount(acct.email);
            const scoped = await this.store.getAccountByEmail(acct.email)
                || await this.store.getAccount();
            if (scoped) acct = scoped;
        }

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
            this.autocryptKeydata = cryptoLib.extractAutocryptKeydata(acct.publicKeyArmored)
                || acct.autocryptKeydata || '';
        }
        this.displayName = acct.displayName || '';
        this.profilePhotoB64 = acct.profilePhotoB64 || '';
        this.profilePhotoMime = acct.profilePhotoMime || '';
        this.profilePhotoChanged = false;
        this.lastSeenUid = acct.lastSeenUid || 0;
        if (this.lastSeenUid > 0) this.seenUIDs.add(this.lastSeenUid);

        // Restore known keys and contact registry from stored contacts
        for (const contact of await this.store.getAllContacts()) {
            if (contact.publicKeyArmored) {
                setKnownKey(this.knownKeys, contact.email, contact.publicKeyArmored);
            }
            if (contact.avatar) {
                this.peerAvatars.set(contact.email.toLowerCase(), contact.avatar);
            }
            const cid = contact.id || generateAccountId();
            this.contacts.set(cid, { ...contact, id: cid });
            this.emailToContactId.set(contact.email.toLowerCase(), cid);
            if (contact.blocked) {
                this.blockedEmails.add(contact.email.toLowerCase());
            }
        }
        if (acct.publicKeyArmored) setKnownKey(this.knownKeys, acct.email, acct.publicKeyArmored);

        // Restore groups
        this.groups.clear();
        if (acct.groups?.length) {
            for (const g of acct.groups) {
                this.groups.set(g.grpId, {
                    grpId: g.grpId,
                    name: g.name,
                    description: g.description,
                    members: [...g.members],
                    type: g.type,
                    broadcastSecret: g.broadcastSecret,
                });
            }
        }

        // Restore config + multi-relay
        if (acct.config) {
            for (const [k, v] of Object.entries(acct.config)) this.configBag.set(k, v);
            if (acct.config.watched_mailboxes) {
                this.watchedMailboxes = acct.config.watched_mailboxes.split(',').map(s => s.trim()).filter(Boolean);
            }
            // SecureJoin invite tokens (inviter auto-reply needs these after reload)
            if (acct.config.securejoin_invite) {
                this.myInviteNumber = acct.config.securejoin_invite;
            }
            if (acct.config.securejoin_auth) {
                this.myAuthToken = acct.config.securejoin_auth;
            }
        }
        if (acct.relays) {
            for (const r of acct.relays) {
                this.relays.set(r.id, { ...r });
                if (!this.transports.has(r.serverUrl)) {
                    const t = new Transport();
                    t.configure(r.serverUrl, { email: r.email, password: r.password });
                    this.transports.set(r.serverUrl, t);
                }
            }
        }

        // Ensure a transport exists for the loaded server
        if (!this.transports.has(acct.serverUrl)) {
            const t = new Transport();
            t.configure(acct.serverUrl, { email: acct.email, password: acct.password });
            this.transports.set(acct.serverUrl, t);
        } else {
            this.transports.get(acct.serverUrl)!.configure(acct.serverUrl, { email: acct.email, password: acct.password });
        }
        log.info('sdk', `Loaded account: ${acct.email} (groups=${this.groups.size}, lastUid=${this.lastSeenUid})`);
        return true;
    }

    /** Save current account snapshot + contact keys to persistent store */
    async saveToStore(): Promise<void> {
        if (!this.credentials.email) return;

        const groups: StoredGroup[] = [...this.groups.values()].map(g => ({
            grpId: g.grpId,
            name: g.name,
            description: g.description,
            members: [...g.members],
            type: g.type,
            broadcastSecret: g.broadcastSecret,
        }));

        const acct: StoredAccount = {
            email: this.credentials.email.toLowerCase(),
            password: this.credentials.password,
            serverUrl: this.serverUrl,
            displayName: this.displayName,
            fingerprint: this.fingerprint,
            privateKeyArmored: this.privateKey ? this.privateKey.armor() : '',
            publicKeyArmored: this.publicKey ? this.publicKey.armor() : '',
            autocryptKeydata: this.autocryptKeydata,
            profilePhotoB64: this.profilePhotoB64 || undefined,
            profilePhotoMime: this.profilePhotoMime || undefined,
            config: Object.fromEntries(this.configBag),
            relays: [...this.relays.values()].map(r => ({
                id: r.id, serverUrl: r.serverUrl, email: r.email, password: r.password,
            })),
            groups,
            lastSeenUid: this.lastSeenUid || undefined,
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
            const avatar = this.peerAvatars.get(email);
            if (avatar) contact.avatar = avatar;
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
        setKnownKey(this.knownKeys, this.credentials.email, keys.armoredPublicKey);

        // Reconfigure all transports with updated credentials
        for (const t of this.transports.values()) {
            t.configure(this.serverUrl, this.credentials);
        }
        this.schedulePersist();
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

        // Default sinceUID from persisted mailbox cursor (reconnect sync)
        if (sinceUID === 0 && this.lastSeenUid > 0) {
            sinceUID = this.lastSeenUid;
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
        this.emit('DC_EVENT_CONNECTIVITY_CHANGED', {
            event: 'DC_EVENT_CONNECTIVITY_CHANGED',
            data1: 'connected',
            data2: targetUrl,
        });
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
        this.emit('DC_EVENT_CONNECTIVITY_CHANGED', {
            event: 'DC_EVENT_CONNECTIVITY_CHANGED',
            data1: 'not_connected',
            data2: serverUrl || 'all',
        });
    }

    /**
     * Permanently delete this profile from the device:
     * WebSocket disconnect, clear RAM, wipe IndexedDB (`madcore-{email}`) / memory store.
     * Does **not** delete the account on the mail server.
     */
    async destroyProfile(): Promise<void> {
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        // Stop I/O first so nothing rewrites the DB while we wipe it
        try {
            this.disconnect();
        } catch {
            /* ignore */
        }
        if (this.logUnsub) {
            try {
                this.logUnsub();
            } catch {
                /* ignore */
            }
            this.logUnsub = null as any;
        }

        const email = (() => {
            try {
                return this.credentials?.email?.toLowerCase() || '';
            } catch {
                return '';
            }
        })();

        // Clear in-memory state
        this.privateKey = null;
        this.publicKey = null;
        this.fingerprint = '';
        this.autocryptKeydata = '';
        this.displayName = '';
        this.knownKeys.clear();
        this.seenUIDs.clear();
        this.lastSeenUid = 0;
        this.contacts.clear();
        this.blockedEmails.clear();
        this.configBag.clear();
        this.webxdcUpdates.clear();
        this.locationStreams.clear();
        this.locationPoints = [];
        this.calls.clear();
        this.iceServers = [];
        this.watchedMailboxes = ['INBOX'];
        this.lastTransportError = null;
        this.emailToContactId.clear();
        this.peerAvatars.clear();
        this.profilePhotoB64 = '';
        this.profilePhotoMime = '';
        this.profilePhotoChanged = false;
        this.sentAvatarTo.clear();
        this.myInviteNumber = '';
        this.myAuthToken = '';
        this.groups.clear();
        this.relays.clear();
        this.primaryRelayId = '';
        this.eventHandlers.clear();

        // Wipe persistence for this account
        try {
            if (email && typeof this.store.wipeAccount === 'function') {
                await this.store.wipeAccount(email);
            } else {
                await this.store.clear();
                if (email) await this.store.deleteAccountByEmail(email);
            }
        } catch (e: any) {
            log.warn('sdk', `destroyProfile store wipe: ${e?.message || e}`);
        }

        log.info('sdk', `Profile destroyed on device${email ? ` (${email})` : ''}`);
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

    protected emit(event: DCEvent, data: DCEventData) {
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

    // ═══════════════════════════════════════════════════════════════════════
    // UTILITY
    // ═══════════════════════════════════════════════════════════════════════

    getCredentials(): Credentials { return this.credentials; }
    getFingerprint(): string { return this.fingerprint; }
    getKnownKeys(): Map<string, string> { return this.knownKeys; }
    getPublicKeyArmored(): string | null { return this.publicKey ? this.publicKey.armor() : null; }

    importKey(email: string, armoredKey: string) {
        setKnownKey(this.knownKeys, email, armoredKey);
        this.schedulePersist();
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
        this.schedulePersist();

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
        this.schedulePersist();
    }

    protected generateMsgId(): string {
        const id = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        // Domain-literal `@[ip]` breaks some MUAs/MTAs; use bare host like the PGP key UID.
        const domain = (this.credentials.email.split('@')[1] || 'localhost').replace(/^\[|\]$/g, '');
        return `<${id}@${domain}>`;
    }


    /** Handle a WS push message (new_message) */
    protected async handlePushMessage(summary: any): Promise<void> {
        // Dedup is handled inside processIncomingRaw
        let raw: IncomingMessage;
        try {
            const detail = await this.transport.wsRequest('fetch', { uid: summary.uid });
            raw = { uid: detail.uid, body: detail.body, envelope: detail.envelope };
        } catch {
            raw = await this.transport.fetchMessage(summary.uid);
        }

        await this.processIncomingRaw(raw);
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

}
