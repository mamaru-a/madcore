/**
 * AccountBase — shared state, lifecycle, transport, events, and crypto wiring.
 * Feature layers extend this class.
 */
import * as openpgp from 'openpgp';
import { log, addLogSink } from '../lib/logger.js';
import { IndexedDBStore, type IDeltaChatStore, type StoredChat, type StoredMessage, type StoredContact, type StoredAccount, type StoredGroup } from '../store.js';
import { Transport } from '../lib/transport.js';
import * as cryptoLib from '../lib/crypto.js';
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
import {
    dedupeRelaysByServerUrl,
    generateAccountId,
    normalizeServerUrl,
    type RelayRecord,
} from './utils.js';

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
            const url = normalizeServerUrl(serverUrl);
            const relayId = generateAccountId();
            this.relays.set(relayId, { id: relayId, serverUrl: url, email, password });
            this.primaryRelayId = relayId;
            // Create initial transport
            const t = new Transport();
            t.configure(url, { email, password });
            this.transports.set(url, t);
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
            buildAutocryptHeader: () => cryptoLib.buildAutocryptHeader(this.credentials.email, this.autocryptKeydata),
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
        // Re-bind primary credentials right before send so a stale transport
        // config (after loadFromStore / multi-relay churn) cannot 401.
        const creds = this.credentials;
        const url = normalizeServerUrl(this.serverUrl);
        if (creds.email && creds.password && url) {
            const t = this.transports.get(url) || this.transport;
            t.configure(url, { email: creds.email, password: creds.password });
            if (!this.transports.has(url)) this.transports.set(url, t);
        }
        return this.transport.send(from, to, body);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LIFECYCLE
    // ═══════════════════════════════════════════════════════════════════════

    /** Register a new account on the given server (standalone usage) */
    async register(serverUrl: string, options?: { token?: string }): Promise<Credentials & { dclogin_url?: string }> {
        const url = normalizeServerUrl(serverUrl);
        const t = new Transport();
        const creds = await t.register(url, options);
        const relayId = this.upsertRelay(
            { email: creds.email, password: creds.password, serverUrl: url },
            true,
        );
        if (this.store instanceof IndexedDBStore) {
            this.store.reopenForAccount(creds.email);
        }
        this.schedulePersist();
        log.info('sdk', `Registered relay ${relayId}: ${creds.email} on ${url}`);
        return creds;
    }

    /** Set credentials manually (creates/updates primary relay) */
    setCredentials(email: string, password: string, serverUrl: string): void {
        const url = normalizeServerUrl(serverUrl);
        if (!email?.trim() || !password || !url) {
            log.warn('sdk', 'setCredentials ignored: missing email, password, or serverUrl');
            return;
        }
        // Upsert by serverUrl — never append a duplicate primary
        this.upsertRelay({ email, password, serverUrl: url }, true);
    }

    /**
     * Insert or update a single relay keyed by normalized serverUrl.
     * Drops any other rows that share the same URL (repairs bloated snapshots).
     */
    protected upsertRelay(
        relay: { email: string; password: string; serverUrl: string; id?: string },
        makePrimary = false,
        opts?: { persist?: boolean },
    ): string {
        const url = normalizeServerUrl(relay.serverUrl);
        let keepId = relay.id || '';
        // Prefer existing id for this URL; remove all other clones
        for (const [id, r] of [...this.relays.entries()]) {
            if (normalizeServerUrl(r.serverUrl) !== url) continue;
            if (!keepId) keepId = id;
            if (id !== keepId) this.relays.delete(id);
        }
        if (!keepId) keepId = generateAccountId();

        const prev = this.relays.get(keepId);
        const password =
            relay.password ||
            prev?.password ||
            '';
        const email = relay.email || prev?.email || '';
        const unchanged =
            prev &&
            prev.email === email &&
            prev.password === password &&
            normalizeServerUrl(prev.serverUrl) === url &&
            (!makePrimary || this.primaryRelayId === keepId);

        this.relays.set(keepId, {
            id: keepId,
            serverUrl: url,
            email,
            password,
        });

        // Collapse transport keys for this URL
        let t: Transport | undefined;
        for (const [key, tr] of [...this.transports.entries()]) {
            if (normalizeServerUrl(key) === url) {
                if (!t) {
                    t = tr;
                    if (key !== url) {
                        this.transports.delete(key);
                        this.transports.set(url, tr);
                    }
                } else if (key !== url) {
                    this.transports.delete(key);
                }
            }
        }
        if (!t) {
            t = new Transport();
            this.transports.set(url, t);
        }
        t.configure(url, { email, password });

        if (makePrimary || !this.primaryRelayId || !this.relays.has(this.primaryRelayId)) {
            this.primaryRelayId = keepId;
        }
        // Avoid write storms: reapplyVaultCredentials / connect call setCredentials often
        if (opts?.persist !== false && !unchanged) {
            this.schedulePersist();
        }
        return keepId;
    }

    /** Collapse duplicate serverUrl rows in memory (and transports). */
    protected compactRelays(primaryUrl?: string): void {
        const primary =
            normalizeServerUrl(primaryUrl || this.primaryRelay.serverUrl || this.serverUrl);
        const list = dedupeRelaysByServerUrl(this.relays.values());
        // Ensure primary wins if present
        if (primary) {
            const hit = list.find(r => r.serverUrl === primary);
            if (hit) {
                // move to end of dedupe source already unique
            }
        }
        this.relays.clear();
        for (const r of list) this.relays.set(r.id, r);

        // Drop orphan transports
        const urls = new Set(list.map(r => r.serverUrl));
        for (const key of [...this.transports.keys()]) {
            if (!urls.has(normalizeServerUrl(key))) this.transports.delete(key);
        }
        // Prefer primary id for primaryUrl
        if (primary) {
            const p = list.find(r => r.serverUrl === primary);
            if (p) this.primaryRelayId = p.id;
            else if (list[0]) this.primaryRelayId = list[0].id;
        } else if (!this.relays.has(this.primaryRelayId) && list[0]) {
            this.primaryRelayId = list[0].id;
        }
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

        // Rebuild relays: one row per serverUrl (repairs 30+ duplicate primaries).
        const memPassword = this.credentials.password || '';
        const keepPassword =
            (acct.password && acct.password.length > 0 ? acct.password : memPassword) || '';
        const primaryUrl = normalizeServerUrl(acct.serverUrl);
        const incoming: RelayRecord[] = [];
        if (acct.relays?.length) {
            for (const r of acct.relays) {
                incoming.push({
                    id: r.id,
                    serverUrl: r.serverUrl,
                    email: r.email,
                    password: r.password || keepPassword,
                });
            }
        }
        // Top-level credentials always win for the primary server
        incoming.push({
            id: generateAccountId(),
            serverUrl: primaryUrl,
            email: acct.email,
            password: keepPassword,
        });
        // Prefer stable id already in memory for primary URL
        for (const [id, r] of this.relays) {
            if (normalizeServerUrl(r.serverUrl) === primaryUrl) {
                incoming.push({
                    id,
                    serverUrl: primaryUrl,
                    email: acct.email,
                    password: keepPassword || r.password,
                });
            }
        }
        const unique = dedupeRelaysByServerUrl(incoming);
        this.relays.clear();
        for (const r of unique) this.relays.set(r.id, r);
        const primary = unique.find(r => r.serverUrl === primaryUrl) || unique[0];
        this.primaryRelayId = primary?.id || '';

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
        // Restore open SecureJoin invite so inviter can answer after reload
        this.myInviteNumber = acct.secureJoinInviteNumber || '';
        this.myAuthToken = acct.secureJoinAuthToken || '';

        // Restore known keys and contact registry from stored contacts
        for (const contact of await this.store.getAllContacts()) {
            if (contact.publicKeyArmored) {
                this.knownKeys.set(contact.email.toLowerCase(), contact.publicKeyArmored);
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
        this.knownKeys.set(acct.email.toLowerCase(), acct.publicKeyArmored || '');

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

        // Restore config
        if (acct.config) {
            for (const [k, v] of Object.entries(acct.config)) this.configBag.set(k, v);
            if (acct.config.watched_mailboxes) {
                this.watchedMailboxes = acct.config.watched_mailboxes.split(',').map(s => s.trim()).filter(Boolean);
            }
        }

        // One transport per unique relay (no 32× duplicate sockets config)
        this.transports.clear();
        for (const r of this.relays.values()) {
            const url = normalizeServerUrl(r.serverUrl);
            const t = new Transport();
            t.configure(url, { email: r.email, password: r.password });
            this.transports.set(url, t);
        }
        log.info(
            'sdk',
            `Loaded account: ${acct.email} (groups=${this.groups.size}, relays=${this.relays.size}, lastUid=${this.lastSeenUid})`,
        );
        return true;
    }

    /** Save current account snapshot + contact keys to persistent store */
    async saveToStore(): Promise<void> {
        if (!this.credentials.email) return;

        // Always compact before write so IDB never re-grows to 30+ clones
        this.compactRelays(this.serverUrl);

        const groups: StoredGroup[] = [...this.groups.values()].map(g => ({
            grpId: g.grpId,
            name: g.name,
            description: g.description,
            members: [...g.members],
            type: g.type,
            broadcastSecret: g.broadcastSecret,
        }));

        // Never persist an empty password over a previous good secret.
        let passwordToSave = this.credentials.password;
        if (!passwordToSave) {
            try {
                const prev = await this.store.getAccountByEmail(this.credentials.email)
                    || await this.store.getAccount();
                if (prev?.password) passwordToSave = prev.password;
            } catch {
                /* ignore */
            }
        }
        const primaryUrl = normalizeServerUrl(this.serverUrl);
        const acct: StoredAccount = {
            email: this.credentials.email.toLowerCase(),
            password: passwordToSave,
            serverUrl: primaryUrl,
            displayName: this.displayName,
            fingerprint: this.fingerprint,
            privateKeyArmored: this.privateKey ? this.privateKey.armor() : '',
            publicKeyArmored: this.publicKey ? this.publicKey.armor() : '',
            autocryptKeydata: this.autocryptKeydata,
            profilePhotoB64: this.profilePhotoB64 || undefined,
            profilePhotoMime: this.profilePhotoMime || undefined,
            config: Object.fromEntries(this.configBag),
            // Always persist deduped relays (one per serverUrl)
            relays: dedupeRelaysByServerUrl(this.relays.values()).map(r => ({
                id: r.id,
                serverUrl: r.serverUrl,
                email: r.email,
                password: r.password,
            })),
            groups,
            lastSeenUid: this.lastSeenUid || undefined,
            secureJoinInviteNumber: this.myInviteNumber || undefined,
            secureJoinAuthToken: this.myAuthToken || undefined,
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
        this.knownKeys.set(this.credentials.email.toLowerCase(), keys.armoredPublicKey);

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

        targetUrl = normalizeServerUrl(targetUrl);

        // Find the relay credentials for this server URL
        let relayCreds: Credentials = this.credentials;
        for (const [, r] of this.relays) {
            if (normalizeServerUrl(r.serverUrl) === targetUrl) {
                relayCreds = { email: r.email, password: r.password };
                break;
            }
        }

        let t = this.transports.get(targetUrl);
        if (!t) {
            // Legacy key without normalize
            for (const [key, tr] of this.transports) {
                if (normalizeServerUrl(key) === targetUrl) {
                    t = tr;
                    if (key !== targetUrl) {
                        this.transports.delete(key);
                        this.transports.set(targetUrl, tr);
                    }
                    break;
                }
            }
        }
        if (!t) {
            t = new Transport();
            t.configure(targetUrl, relayCreds);
            this.transports.set(targetUrl, t);
        } else {
            t.configure(targetUrl, relayCreds);
        }

        // Set up push handler for incoming messages
        t.setPushHandler(async (msg: any) => {
            // madmail: action "new_message" with summary { uid, ... }
            // some docs also mention "push" with optional body
            if (msg.action === 'new_message' || msg.action === 'push') {
                try {
                    await this.handlePushMessage(msg.data ?? msg);
                } catch (e: any) {
                    log.warn('sdk', `push handle failed: ${e?.message || e}`);
                }
            } else {
                log.debug('sdk', `WS[${targetUrl}] unknown push:`, msg.action, msg);
            }
        });

        try {
            await t.connect(sinceUID);
        } catch (e: any) {
            const msg = e?.message || String(e);
            throw new Error(
                `WebIMAP WebSocket connect failed for ${targetUrl}: ${msg}. ` +
                `Use a madmail host with webimap enabled (classic chatmail without WebIMAP cannot serve the browser client).`,
            );
        }
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
        this.knownKeys.set(email.toLowerCase(), armoredKey);
        this.schedulePersist();
    }

    /** Get the full status of this account including all relay connection states */
    status(): AccountStatus {
        // Safety net: never surface duplicate serverUrl rows to apps
        if (this.relays.size > 1) {
            const urls = new Set(
                [...this.relays.values()].map(r => normalizeServerUrl(r.serverUrl)),
            );
            if (urls.size < this.relays.size) this.compactRelays();
        }
        const relayList: RelayInfo[] = [];
        for (const [, r] of this.relays) {
            const url = normalizeServerUrl(r.serverUrl);
            const t = this.transports.get(url) || this.transports.get(r.serverUrl);
            relayList.push({
                id: r.id,
                serverUrl: url,
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
        const url = normalizeServerUrl(serverUrl);
        let email: string, password: string;

        // Already have this host → update in place (do not grow duplicates)
        for (const r of this.relays.values()) {
            if (normalizeServerUrl(r.serverUrl) === url && opts) {
                const id = this.upsertRelay({
                    id: r.id,
                    email: opts.email,
                    password: opts.password,
                    serverUrl: url,
                }, false);
                return {
                    id,
                    serverUrl: url,
                    email: opts.email,
                    password: opts.password,
                    isConnected: this.transports.get(url)?.isConnected ?? false,
                    state: this.transports.get(url)?.state ?? 'disconnected',
                };
            }
            if (normalizeServerUrl(r.serverUrl) === url && !opts) {
                // Same server without new creds — return existing, do not re-register
                return {
                    id: r.id,
                    serverUrl: url,
                    email: r.email,
                    password: r.password,
                    isConnected: this.transports.get(url)?.isConnected ?? false,
                    state: this.transports.get(url)?.state ?? 'disconnected',
                };
            }
        }

        if (opts) {
            email = opts.email;
            password = opts.password;
        } else {
            // Register new identity on this server
            const t = new Transport();
            const creds = await t.register(url);
            email = creds.email;
            password = creds.password;
        }

        const relayId = this.upsertRelay(
            { email, password, serverUrl: url },
            !this.primaryRelayId,
        );

        log.info('sdk', `Added relay ${relayId}: ${email} on ${url}`);
        return {
            id: relayId,
            serverUrl: url,
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
        let host = this.credentials.email.split('@').pop() || 'localhost';
        // IP-literal addresses: user@[203.0.113.1]
        if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
        return `<${id}@${host}>`;
    }


    /** Handle a WS push message (new_message / push) */
    protected async handlePushMessage(summary: any): Promise<void> {
        // Dedup is handled inside processIncomingRaw
        const uid = Number(summary?.uid ?? summary?.summary?.uid ?? 0);
        // Some servers include the full body in the push payload
        if (summary?.body && typeof summary.body === 'string') {
            await this.processIncomingRaw({
                uid: uid > 0 ? uid : 0,
                body: summary.body,
                envelope: summary.envelope ?? summary.summary?.envelope,
            });
            return;
        }
        if (!uid) {
            log.warn('sdk', 'push without uid/body — ignored', summary);
            return;
        }
        let raw: IncomingMessage;
        try {
            const detail = await this.transport.wsRequest('fetch', { mailbox: 'INBOX', uid });
            // madmail flattens MessageDetail: { uid, body, envelope, ... }
            raw = {
                uid: Number(detail?.uid ?? detail?.summary?.uid ?? uid),
                body: detail?.body || '',
                envelope: detail?.envelope ?? detail?.summary?.envelope,
            };
        } catch {
            raw = await this.transport.fetchMessage(uid);
        }
        if (!raw.body) {
            log.warn('sdk', `push fetch uid ${uid}: empty body`);
            return;
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
