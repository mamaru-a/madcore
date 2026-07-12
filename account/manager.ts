/**
 * DeltaChatSDK multi-account manager factory.
 */
import { log, setLogLevel } from '../lib/logger.js';
import {
    createStore,
    IndexedDBStore,
    type IDeltaChatStore,
    type PersistedAccountMeta,
} from '../store.js';
import { Transport } from '../lib/transport.js';
import type {
    RegisterResult,
    AccountInfo,
    SDKConfig,
} from '../types.js';
import { generateAccountId } from './utils.js';
import { DeltaChatAccount } from './account.js';

export interface IDeltaChatManager {
    /** Register a new account on a server, returns { id, email, password } */
    register(serverUrl: string, name?: string, options?: { token?: string }): Promise<RegisterResult>;

    /** Import credentials for an existing account (loads store snapshot if present) */
    addAccount(email: string, password: string, serverUrl: string): DeltaChatAccount;

    /**
     * Restore a previously persisted account (awaits IndexedDB load).
     * Prefer this on app startup after `listPersistedAccounts()`.
     */
    restoreAccount(email: string, password: string, serverUrl?: string): Promise<DeltaChatAccount>;

    /**
     * List accounts remembered in the browser registry
     * (`{baseName}__registry`). Empty when not using IndexedDB.
     */
    listPersistedAccounts(): Promise<PersistedAccountMeta[]>;

    /** Get an account handle by its random ID */
    getAccount(id: string): DeltaChatAccount;

    /** Find an account by email (returns first match or undefined) */
    findAccountByEmail(email: string): DeltaChatAccount | undefined;

    /** List all in-memory registered accounts with their IDs and emails */
    listAccounts(): AccountInfo[];

    /**
     * Remove an account from the manager and wipe all local data for it
     * (WebSocket, RAM, IndexedDB / memory store). Does NOT delete server-side.
     */
    removeAccount(id: string): Promise<void>;

    /**
     * Root store. With IndexedDB, each account also uses an isolated
     * per-email database (`{baseName}-{email}`).
     */
    readonly store: IDeltaChatStore;
}

/**
 * Pick a store for one account.
 * IndexedDB → dedicated DB per email; MemoryStore → shared (fine for tests).
 */
function storeForAccount(root: IDeltaChatStore, email: string): IDeltaChatStore {
    if (root instanceof IndexedDBStore) {
        return root.forAccount(email);
    }
    return root;
}

async function rememberIfIdb(
    root: IDeltaChatStore,
    meta: { email: string; serverUrl: string; displayName?: string },
): Promise<void> {
    if (root instanceof IndexedDBStore) {
        await root.rememberAccount(meta);
    }
}

/**
 * Factory function — the primary entry point for the SDK.
 *
 * @example
 * ```ts
 * // Browser: defaults to IndexedDB via createStore()
 * const dc = DeltaChatSDK({ logLevel: 'debug' });
 * const { account } = await dc.register('https://relay.example', 'Alice');
 * await account.connect();
 *
 * // Later session:
 * const list = await dc.listPersistedAccounts();
 * const acc = await dc.restoreAccount(list[0].email, password, list[0].serverUrl);
 * await acc.connect();
 * ```
 */
export function DeltaChatSDK(config: SDKConfig = {}): IDeltaChatManager {
    if (config.logLevel) setLogLevel(config.logLevel);

    // Browser → IndexedDB; Node/tests without IDB → MemoryStore
    const store = config.store ?? createStore();
    const accounts = new Map<string, DeltaChatAccount>();

    return {
        get store() { return store; },

        async register(serverUrl: string, name?: string, options?: { token?: string }): Promise<RegisterResult> {
            const tmpTransport = new Transport();
            const creds = await tmpTransport.register(serverUrl, options);
            log.info('sdk', `Registered: ${creds.email}`);

            const id = generateAccountId();
            const accStore = storeForAccount(store, creds.email);
            const acc = new DeltaChatAccount(accStore, id, creds.email, creds.password, serverUrl);
            accounts.set(id, acc);

            if (name) await acc.generateKeys(name);
            else acc.schedulePersist();
            await acc.flushPersist();
            await rememberIfIdb(store, {
                email: creds.email,
                serverUrl,
                displayName: name,
            });

            return { id, email: creds.email, password: creds.password, account: acc };
        },

        addAccount(email: string, password: string, serverUrl: string): DeltaChatAccount {
            const existing = [...accounts.values()].find(
                a => a.getCredentials().email.toLowerCase() === email.toLowerCase(),
            );
            if (existing) return existing;

            const id = generateAccountId();
            const accStore = storeForAccount(store, email);
            const acc = new DeltaChatAccount(accStore, id, email, password, serverUrl);
            accounts.set(id, acc);
            void (async () => {
                const ok = await acc.loadFromStore();
                if (ok) log.info('sdk', `Restored account ${email} from store`);
                else acc.schedulePersist();
                await rememberIfIdb(store, { email, serverUrl, displayName: acc.getDisplayName() });
            })();
            return acc;
        },

        async restoreAccount(email: string, password: string, serverUrl?: string): Promise<DeltaChatAccount> {
            const key = email.toLowerCase();
            let url = serverUrl;
            if (!url && store instanceof IndexedDBStore) {
                const list = await store.listPersistedAccounts();
                url = list.find(a => a.email === key)?.serverUrl;
            }
            if (!url) {
                // Try loading scoped DB for hints
                const probe = storeForAccount(store, key);
                const snap = await probe.getAccountByEmail(key) || await probe.getAccount();
                url = snap?.serverUrl;
            }
            if (!url) {
                throw new Error(
                    `Cannot restore ${email}: no serverUrl provided and none found in store registry`,
                );
            }

            const existing = [...accounts.values()].find(
                a => a.getCredentials().email.toLowerCase() === key,
            );
            if (existing) {
                await existing.loadFromStore();
                return existing;
            }

            const id = generateAccountId();
            const accStore = storeForAccount(store, key);
            const acc = new DeltaChatAccount(accStore, id, key, password, url);
            accounts.set(id, acc);
            const ok = await acc.loadFromStore();
            if (!ok) {
                // No snapshot yet — keep credentials so the caller can connect / generate keys
                acc.setCredentials(key, password, url);
                acc.schedulePersist();
            }
            await rememberIfIdb(store, {
                email: key,
                serverUrl: url,
                displayName: acc.getDisplayName(),
            });
            log.info('sdk', `restoreAccount ${key}: loaded=${ok}`);
            return acc;
        },

        async listPersistedAccounts(): Promise<PersistedAccountMeta[]> {
            if (store instanceof IndexedDBStore) {
                return store.listPersistedAccounts();
            }
            return [];
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

        async removeAccount(id: string): Promise<void> {
            const acc = accounts.get(id);
            if (!acc) return;
            let email = '';
            try {
                email = acc.getCredentials().email;
            } catch {
                /* already torn down */
            }
            // Full device wipe: WS + RAM + IDB madcore-{email} + registry
            try {
                await acc.destroyProfile();
            } catch (e: any) {
                log.warn('sdk', `removeAccount destroyProfile: ${e?.message || e}`);
                try {
                    acc.disconnect();
                } catch {
                    /* ignore */
                }
                if (store instanceof IndexedDBStore && email) {
                    try {
                        await store.wipeAccount(email);
                    } catch {
                        try {
                            await store.forgetAccount(email);
                        } catch {
                            /* ignore */
                        }
                    }
                }
            }
            accounts.delete(id);
            // Root store wipe (covers forAccount-scoped handles that share baseName)
            if (store instanceof IndexedDBStore && email) {
                try {
                    await store.wipeAccount(email);
                } catch {
                    /* already wiped by destroyProfile */
                }
            } else if (email && typeof store.wipeAccount === 'function') {
                try {
                    await store.wipeAccount(email);
                } catch {
                    /* ignore */
                }
            }
            log.info('sdk', `removeAccount complete: ${id}${email ? ` / ${email}` : ''}`);
        },
    };
}
