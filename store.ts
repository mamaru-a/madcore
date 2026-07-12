// Delta Chat Web SDK — Storage Layer
// Uses IndexedDB in browser, in-memory Map in Node.js

// ─── Data Types ─────────────────────────────────────────────────────────────────

/** Draft message saved for a chat (local only) */
export interface ChatDraft {
    text?: string;
    /** Optional pending attachment (base64) */
    file?: {
        data: string;
        filename: string;
        mimeType: string;
    };
    updatedAt: number;
}

export interface StoredChat {
    id: string;              // peerEmail (1:1) or group-id
    name: string;            // Display name
    peerEmail: string;       // For 1:1 chats
    isGroup: boolean;
    isBroadcast?: boolean;
    avatar?: string;         // base64 data URI
    lastMessage?: string;
    lastMessageId?: string;
    lastMessageTime?: number;
    unreadCount: number;
    archived: boolean;
    pinned: boolean;
    muted: boolean;
    /** Local draft (not synced) */
    draft?: ChatDraft;
    /** Ephemeral timer in seconds (0 = off) */
    ephemeralTimer?: number;
}

export interface StoredMessage {
    id: string;               // Message-ID (rfc724mid)
    chatId: string;           // Which chat this belongs to
    from: string;
    to: string;
    text: string;
    timestamp: number;        // creation time (Date.now())
    encrypted: boolean;
    direction: 'incoming' | 'outgoing';

    // ── Message type (aligned with Viewtype + control kinds; see lib/viewtype.ts) ──
    type: 'text' | 'image' | 'file' | 'video' | 'audio' | 'voice'
        | 'gif' | 'sticker' | 'webxdc' | 'html' | 'location' | 'call'
        | 'reaction' | 'delete' | 'edit' | 'securejoin' | 'system';

    // ── Lifecycle timestamps ──
    /** When the message was sent (confirmed by server or transport) */
    sentAt?: number;
    /** When the message was seen by the recipient (or first reader in group) */
    seenAt?: number;

    // ── State machine: pending → sent → seen (no 'delivered') ──
    state: 'pending' | 'sent' | 'seen' | 'failed';

    // ── Read receipts (group chats) ──
    /** List of people who have seen this message, with timestamps */
    seenBy?: { email: string; at: number }[];

    // ── Reactions ──
    /** Reactions from other users attached to this message */
    reactions?: { reaction: string; from: string; at: number }[];

    // ── Reply / quote ──
    inReplyTo?: string;       // Message-ID of parent
    quotedText?: string;

    // ── Media ──
    /** Attached media metadata */
    media?: {
        filename?: string;
        mimeType?: string;
        size?: number;
        durationMs?: number;
        data?: string;        // base64 data (for small inline media)
    };

    // ── Misc ──
    reactionTarget?: string;  // Message-ID of reaction target (for type='reaction')
    editTarget?: string;      // Message-ID of edit target (for type='edit')
    avatarUpdate?: string | null;
    /** Absolute ms timestamp when ephemeral message should be deleted locally */
    ephemeralExpiresAt?: number;
}

export interface StoredContact {
    id: string;              // Random contact ID
    email: string;
    name: string;
    avatar?: string;
    publicKeyArmored?: string;
    verified: boolean;
    lastSeen?: number;
    /** When true, inbound messages from this contact are dropped */
    blocked?: boolean;
}

/** Group/channel registry snapshot (persisted with the account) */
export interface StoredGroup {
    grpId: string;
    name: string;
    description?: string;
    members: string[];
    type: 'group' | 'broadcast';
    broadcastSecret?: string;
}

export interface StoredAccount {
    /** Always stored lowercase (IDB / map key) */
    email: string;
    password: string;
    serverUrl: string;
    displayName: string;
    fingerprint: string;
    privateKeyArmored: string;
    publicKeyArmored: string;
    autocryptKeydata: string;
    profilePhotoB64?: string;
    profilePhotoMime?: string;
    /** Local config bag (key → string value) */
    config?: Record<string, string>;
    /** Extra relays for multi-relay accounts */
    relays?: Array<{ id: string; serverUrl: string; email: string; password: string }>;
    /** Group / channel membership registry */
    groups?: StoredGroup[];
    /** Highest processed mailbox UID (for reconnect sync) */
    lastSeenUid?: number;
    /**
     * Active SecureJoin inviter tokens. Must survive reload so peers who scanned
     * our QR can complete the handshake while we are online later.
     */
    secureJoinInviteNumber?: string;
    secureJoinAuthToken?: string;
}

/** Webxdc status updates keyed by instance message id */
export interface StoredWebxdcUpdate {
    instanceMsgId: string;
    serial: number;
    payload: unknown;
    info?: string;
    summary?: string;
    document?: string;
    from: string;
    at: number;
}

/**
 * Lightweight multi-account index entry (lives in `{baseName}__registry` IDB).
 * Full account data lives in `{baseName}-{email}`.
 */
export interface PersistedAccountMeta {
    email: string;
    serverUrl: string;
    displayName?: string;
    /** Wall-clock ms when last remembered / updated */
    updatedAt: number;
}

// ─── Store Interface ────────────────────────────────────────────────────────────

export interface IDeltaChatStore {
    // Account
    getAccount(): Promise<StoredAccount | null>;
    getAccountByEmail(email: string): Promise<StoredAccount | null>;
    listAccounts(): Promise<StoredAccount[]>;
    saveAccount(account: StoredAccount): Promise<void>;
    deleteAccount(): Promise<void>;
    deleteAccountByEmail(email: string): Promise<void>;

    // Chats
    getChat(chatId: string): Promise<StoredChat | null>;
    getAllChats(): Promise<StoredChat[]>;
    saveChat(chat: StoredChat): Promise<void>;
    deleteChat(chatId: string): Promise<void>;

    // Messages
    getMessage(msgId: string): Promise<StoredMessage | null>;
    getChatMessages(chatId: string, limit?: number, offset?: number): Promise<StoredMessage[]>;
    saveMessage(msg: StoredMessage): Promise<void>;
    deleteMessage(msgId: string): Promise<void>;
    deleteMessagesForChat(chatId: string): Promise<void>;

    // Contacts
    getContact(email: string): Promise<StoredContact | null>;
    getAllContacts(): Promise<StoredContact[]>;
    saveContact(contact: StoredContact): Promise<void>;
    deleteContact(email: string): Promise<void>;

    // Search
    searchChats(query: string): Promise<StoredChat[]>;
    searchMessages(query: string, chatId?: string): Promise<StoredMessage[]>;

    // Bulk
    clear(): Promise<void>;
}

// ─── In-Memory Store (Node.js / fallback) ───────────────────────────────────────

export class MemoryStore implements IDeltaChatStore {
    private accounts: Map<string, StoredAccount> = new Map();
    private chats: Map<string, StoredChat> = new Map();
    private messages: Map<string, StoredMessage> = new Map();
    private contacts: Map<string, StoredContact> = new Map();

    async getAccount() {
        const vals = [...this.accounts.values()];
        return vals[0] || null;
    }
    async getAccountByEmail(email: string) {
        return this.accounts.get(email.toLowerCase()) || null;
    }
    async listAccounts() {
        return [...this.accounts.values()];
    }
    async saveAccount(account: StoredAccount) {
        const email = account.email.toLowerCase();
        this.accounts.set(email, { ...account, email });
    }
    async deleteAccount() {
        const first = [...this.accounts.keys()][0];
        if (first) this.accounts.delete(first);
    }
    async deleteAccountByEmail(email: string) {
        this.accounts.delete(email.toLowerCase());
    }

    async getChat(chatId: string) { return this.chats.get(chatId) || null; }
    async getAllChats() {
        return [...this.chats.values()].sort((a, b) =>
            (b.lastMessageTime || 0) - (a.lastMessageTime || 0)
        );
    }
    async saveChat(chat: StoredChat) { this.chats.set(chat.id, chat); }
    async deleteChat(chatId: string) { this.chats.delete(chatId); }

    async getMessage(msgId: string) { return this.messages.get(msgId) || null; }
    async getChatMessages(chatId: string, limit = 100, offset = 0) {
        return [...this.messages.values()]
            .filter(m => m.chatId === chatId)
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(offset, offset + limit);
    }
    async saveMessage(msg: StoredMessage) { this.messages.set(msg.id, msg); }
    async deleteMessage(msgId: string) { this.messages.delete(msgId); }
    async deleteMessagesForChat(chatId: string) {
        for (const [id, msg] of this.messages) {
            if (msg.chatId === chatId) this.messages.delete(id);
        }
    }

    async getContact(email: string) { return this.contacts.get(email.toLowerCase()) || null; }
    async getAllContacts() { return [...this.contacts.values()]; }
    async saveContact(contact: StoredContact) {
        this.contacts.set(contact.email.toLowerCase(), contact);
    }
    async deleteContact(email: string) { this.contacts.delete(email.toLowerCase()); }

    async searchChats(query: string) {
        const q = query.toLowerCase();
        return [...this.chats.values()].filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.peerEmail.toLowerCase().includes(q) ||
            (c.lastMessage || '').toLowerCase().includes(q)
        );
    }
    async searchMessages(query: string, chatId?: string) {
        const q = query.toLowerCase();
        return [...this.messages.values()].filter(m =>
            (!chatId || m.chatId === chatId) &&
            m.text.toLowerCase().includes(q)
        );
    }

    async clear() {
        this.accounts.clear();
        this.chats.clear();
        this.messages.clear();
        this.contacts.clear();
    }
}

// ─── IndexedDB Store (Browser) ──────────────────────────────────────────────────

export class IndexedDBStore implements IDeltaChatStore {
    /** Root name used before per-account scoping (e.g. `madcore`) */
    readonly baseName: string;
    private dbName: string;
    private db: IDBDatabase | null = null;

    constructor(dbName = 'madcore') {
        this.baseName = dbName;
        this.dbName = dbName;
    }

    /**
     * Reopen this instance scoped to one account.
     * DB name becomes `{baseName}-{email}` for multi-account isolation.
     */
    reopenForAccount(accountEmail: string) {
        this.dbName = `${this.baseName}-${accountEmail.toLowerCase()}`;
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    /**
     * Return a new store instance for one account (does not mutate this instance).
     * Prefer this for multi-account managers so accounts don't share one open DB handle.
     */
    forAccount(accountEmail: string): IndexedDBStore {
        const scoped = new IndexedDBStore(this.baseName);
        scoped.reopenForAccount(accountEmail);
        return scoped;
    }

    // ── Multi-account registry (root DB: `{baseName}__registry`) ─────────────

    private registryDbName(): string {
        return `${this.baseName}__registry`;
    }

    private async getRegistryDB(): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.registryDbName(), 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('accounts')) {
                    db.createObjectStore('accounts', { keyPath: 'email' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /** List accounts known to this browser (email + serverUrl). Does not load keys. */
    async listPersistedAccounts(): Promise<PersistedAccountMeta[]> {
        if (typeof indexedDB === 'undefined') return [];
        const db = await this.getRegistryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('accounts', 'readonly');
            const req = tx.objectStore('accounts').getAll();
            req.onsuccess = () => {
                const rows = (req.result as PersistedAccountMeta[]) || [];
                resolve(rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
            };
            req.onerror = () => reject(req.error);
        });
    }

    /** Remember an account email in the multi-account index (after register / restore). */
    async rememberAccount(meta: {
        email: string;
        serverUrl: string;
        displayName?: string;
    }): Promise<void> {
        if (typeof indexedDB === 'undefined') return;
        const entry: PersistedAccountMeta = {
            email: meta.email.toLowerCase(),
            serverUrl: meta.serverUrl,
            displayName: meta.displayName,
            updatedAt: Date.now(),
        };
        const db = await this.getRegistryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('accounts', 'readwrite');
            tx.objectStore('accounts').put(entry);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    /** Remove an email from the multi-account index (does not delete the account DB). */
    async forgetAccount(email: string): Promise<void> {
        if (typeof indexedDB === 'undefined') return;
        const db = await this.getRegistryDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('accounts', 'readwrite');
            tx.objectStore('accounts').delete(email.toLowerCase());
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    }

    private async getDB(): Promise<IDBDatabase> {
        if (this.db) return this.db;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('account')) {
                    db.createObjectStore('account', { keyPath: 'email' });
                }
                if (!db.objectStoreNames.contains('chats')) {
                    db.createObjectStore('chats', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('messages')) {
                    const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
                    msgStore.createIndex('chatId', 'chatId', { unique: false });
                    msgStore.createIndex('timestamp', 'timestamp', { unique: false });
                }
                if (!db.objectStoreNames.contains('contacts')) {
                    db.createObjectStore('contacts', { keyPath: 'email' });
                }
            };
            request.onsuccess = () => {
                this.db = request.result;
                resolve(this.db);
            };
            request.onerror = () => reject(request.error);
        });
    }

    private async tx<T>(storeName: string, mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            const request = fn(store);
            request.onsuccess = () => resolve(request.result as T);
            request.onerror = () => reject(request.error);
        });
    }

    // Account
    async getAccount(): Promise<StoredAccount | null> {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('account', 'readonly');
            const store = tx.objectStore('account');
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result[0] || null);
            request.onerror = () => reject(request.error);
        });
    }
    async getAccountByEmail(email: string): Promise<StoredAccount | null> {
        return await this.tx<StoredAccount | null>('account', 'readonly', s => s.get(email.toLowerCase())) || null;
    }
    async listAccounts(): Promise<StoredAccount[]> {
        return await this.tx<StoredAccount[]>('account', 'readonly', s => s.getAll());
    }
    async saveAccount(account: StoredAccount) {
        const normalized = { ...account, email: account.email.toLowerCase() };
        await this.tx('account', 'readwrite', s => s.put(normalized));
    }
    async deleteAccount() {
        await this.tx('account', 'readwrite', s => s.clear());
    }
    async deleteAccountByEmail(email: string) {
        await this.tx('account', 'readwrite', s => s.delete(email.toLowerCase()));
    }

    // Chats
    async getChat(chatId: string) {
        return await this.tx<StoredChat | null>('chats', 'readonly', s => s.get(chatId)) || null;
    }
    async getAllChats() {
        const all = await this.tx<StoredChat[]>('chats', 'readonly', s => s.getAll());
        return all.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));
    }
    async saveChat(chat: StoredChat) {
        await this.tx('chats', 'readwrite', s => s.put(chat));
    }
    async deleteChat(chatId: string) {
        await this.tx('chats', 'readwrite', s => s.delete(chatId));
    }

    // Messages
    async getMessage(msgId: string) {
        return await this.tx<StoredMessage | null>('messages', 'readonly', s => s.get(msgId)) || null;
    }
    async getChatMessages(chatId: string, limit = 100, offset = 0) {
        const db = await this.getDB();
        return new Promise<StoredMessage[]>((resolve, reject) => {
            const tx = db.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            const index = store.index('chatId');
            const request = index.getAll(chatId);
            request.onsuccess = () => {
                const msgs = (request.result as StoredMessage[])
                    .sort((a, b) => a.timestamp - b.timestamp)
                    .slice(offset, offset + limit);
                resolve(msgs);
            };
            request.onerror = () => reject(request.error);
        });
    }
    async saveMessage(msg: StoredMessage) {
        await this.tx('messages', 'readwrite', s => s.put(msg));
    }
    async deleteMessage(msgId: string) {
        await this.tx('messages', 'readwrite', s => s.delete(msgId));
    }
    async deleteMessagesForChat(chatId: string) {
        const msgs = await this.getChatMessages(chatId, 999999);
        const db = await this.getDB();
        const tx = db.transaction('messages', 'readwrite');
        const store = tx.objectStore('messages');
        for (const msg of msgs) store.delete(msg.id);
    }

    // Contacts
    async getContact(email: string) {
        return await this.tx<StoredContact | null>('contacts', 'readonly', s => s.get(email.toLowerCase())) || null;
    }
    async getAllContacts() {
        return await this.tx<StoredContact[]>('contacts', 'readonly', s => s.getAll());
    }
    async saveContact(contact: StoredContact) {
        contact.email = contact.email.toLowerCase();
        await this.tx('contacts', 'readwrite', s => s.put(contact));
    }
    async deleteContact(email: string) {
        await this.tx('contacts', 'readwrite', s => s.delete(email.toLowerCase()));
    }

    // Search
    async searchChats(query: string) {
        const all = await this.getAllChats();
        const q = query.toLowerCase();
        return all.filter(c =>
            c.name.toLowerCase().includes(q) ||
            c.peerEmail.toLowerCase().includes(q) ||
            (c.lastMessage || '').toLowerCase().includes(q)
        );
    }
    async searchMessages(query: string, chatId?: string) {
        const db = await this.getDB();
        return new Promise<StoredMessage[]>((resolve, reject) => {
            const tx = db.transaction('messages', 'readonly');
            const store = tx.objectStore('messages');
            const request = chatId
                ? store.index('chatId').getAll(chatId)
                : store.getAll();
            request.onsuccess = () => {
                const q = query.toLowerCase();
                resolve((request.result as StoredMessage[]).filter(m =>
                    m.text.toLowerCase().includes(q)
                ));
            };
            request.onerror = () => reject(request.error);
        });
    }

    async clear() {
        const db = await this.getDB();
        const tx = db.transaction(['account', 'chats', 'messages', 'contacts'], 'readwrite');
        tx.objectStore('account').clear();
        tx.objectStore('chats').clear();
        tx.objectStore('messages').clear();
        tx.objectStore('contacts').clear();
    }
}

// ─── Factory ────────────────────────────────────────────────────────────────────

/** Auto-detect environment and return the right store */
export function createStore(dbName = 'madcore'): IDeltaChatStore {
    if (typeof indexedDB !== 'undefined') {
        return new IndexedDBStore(dbName);
    }
    return new MemoryStore();
}
