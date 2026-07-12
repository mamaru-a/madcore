/**
 * Delta Chat JSON-RPC compatibility layer for madcore.
 *
 * Exposes the **same method names, parameter order, and return shapes** as
 * real core (`context/core/deltachat-jsonrpc` / `@deltachat/jsonrpc-client`),
 * while implementing bodies with madcore APIs (chatmail WS + IndexedDB).
 *
 * Usage:
 * ```ts
 * import { DeltaChatSDK } from 'madcore';
 * import { DeltaChatJsonRpc } from 'madcore/jsonrpc';
 *
 * const sdk = DeltaChatSDK({ logLevel: 'info' });
 * const rpc = new DeltaChatJsonRpc(sdk, {
 *   defaultServerUrl: 'https://relay.example',
 *   onEvent: (accountId, event) => { ... },
 * });
 * await rpc.handleRpc('add_account', []);
 * await rpc.handleRpc('add_transport_from_qr', [1, 'dcaccount:https://relay.example']);
 * ```
 *
 * Coverage: see `methodCoverage()` / docs/jsonrpc-compat.md
 */

import QRCode from 'qrcode';
import { DeltaChatSDK, type IDeltaChatManager } from '../account/manager.js';
import type { DeltaChatAccount } from '../account/account.js';
import type { StoredChat, StoredContact, StoredMessage } from '../store.js';
import { storeTypeToViewtype } from '../lib/viewtype.js';
import { parseSecureJoinURI } from '../lib/securejoin.js';
import { log } from '../lib/logger.js';
import type { DCEvent, DCEventData } from '../types.js';
import {
    ALL_JSONRPC_METHODS,
    IMPLEMENTED_JSONRPC_METHODS,
    STUB_JSONRPC_METHODS,
    methodCoverage,
    isJsonRpcMethod,
} from './methods.js';
import { IdMap, SELF_CONTACT_ID, DEVICE_CONTACT_ID } from './id-map.js';
import {
    DC_CONNECTIVITY_CONNECTED,
    DC_CONNECTIVITY_CONNECTING,
    DC_CONNECTIVITY_NOT_CONNECTED,
    DC_STATE_IN_FRESH,
    DC_STATE_IN_SEEN,
    DC_STATE_OUT_PENDING,
    DC_STATE_OUT_FAILED,
    DC_STATE_OUT_DELIVERED,
    DC_STATE_OUT_MDN_RCVD,
    DC_STATE_OUT_DRAFT,
    DC_CHAT_ID_LAST_SPECIAL,
    DC_CHAT_ID_ARCHIVED_LINK,
    DC_GCL_ARCHIVED_ONLY,
    DC_GCL_NO_SPECIALS,
    DC_GCL_ADD_SELF,
    type AccountInfo,
    type JsonRpcEvent,
    type JsonRpcEventHandler,
} from './types.js';
import { RpcError, RpcNotImplemented } from './errors.js';

export type { AccountInfo, JsonRpcEvent, JsonRpcEventHandler };
export { methodCoverage, ALL_JSONRPC_METHODS, IMPLEMENTED_JSONRPC_METHODS, STUB_JSONRPC_METHODS, isJsonRpcMethod };
export { RpcError, RpcNotImplemented };

// ─── Options ────────────────────────────────────────────────────────────────────

export interface JsonRpcCompatOptions {
    /** Default chatmail/madmail server for dcaccount: registration */
    defaultServerUrl?: string;
    /** Desktop-style event sink (accountId, event) */
    onEvent?: JsonRpcEventHandler;
    /**
     * When true (default), unimplemented methods return null/[] instead of throwing.
     * Set false for strict parity testing.
     */
    softStubs?: boolean;
    /**
     * Host app persistence for credentials (madcore does not store passwords in IDB).
     * Called after successful configure / register.
     */
    onCredentialsSaved?: (info: {
        accountId: number;
        email: string;
        password: string;
        serverUrl: string;
        displayName?: string;
    }) => void;
    /** Called when an account is removed from this device */
    onAccountRemoved?: (info: { accountId: number; email?: string }) => void;
    /**
     * Restore configured accounts on startup (same shape as host account meta + password vault).
     * If empty/omitted, one unconfigured slot is created.
     */
    restoreAccounts?: Array<{
        id: number;
        email?: string;
        password?: string;
        serverUrl?: string;
        displayName?: string;
        configured: boolean;
    }>;
}

interface AccountSlot {
    id: number;
    configured: boolean;
    ioRunning: boolean;
    config: Record<string, string | null>;
    account: DeltaChatAccount | null;
    maps: IdMap;
    unsubs: Array<() => void>;
}

/**
 * Defaults for keys the desktop Settings UI batch-loads (see settingsKeys in
 * settings.ts). Missing/null values crash widgets that call filesize() etc.
 * Align with mock runtime + core Config defaults where applicable.
 */
function defaultConfig(): Record<string, string | null> {
    return {
        addr: null,
        configured_addr: null,
        displayname: '',
        selfstatus: '',
        selfavatar: null,
        is_chatmail: '1',
        e2ee_enabled: '1',
        mdns_enabled: '1',
        private_tag: null,
        // Settings screen (DownloadOnDemand, etc.)
        show_emails: '0',
        bcc_self: '1',
        delete_device_after: '0',
        delete_server_after: '0',
        download_limit: '0', // 0 = download all; filesize() requires a finite number
        only_fetch_mvbox: '0',
        media_quality: '0',
        mvbox_move: '1',
        who_can_call_me: '0',
        'ui.mentions_enabled': '1',
    };
}

function colorForId(id: number | string): string {
    const s = String(id);
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return `hsl(${Math.abs(h) % 360} 45% 45%)`;
}

function tsSec(ms?: number): number {
    if (!ms) return Math.floor(Date.now() / 1000);
    return ms > 1e12 ? Math.floor(ms / 1000) : Math.floor(ms);
}

function normalizeServerUrl(input: string, fallback: string): string {
    let url = (input || '').trim();
    if (!url) return fallback.replace(/\/+$/, '');
    if (/^dcaccount:/i.test(url)) url = url.replace(/^dcaccount:/i, '');
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    return url.replace(/\/+$/, '');
}

async function createQrSvg(content: string): Promise<string> {
    return QRCode.toString(content, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#000000', light: '#ffffff' },
    });
}

// ─── Main class ─────────────────────────────────────────────────────────────────

/**
 * Core-compatible JSON-RPC facade over madcore.
 * Method names are **snake_case** (wire format). Params are positional arrays.
 */
export class DeltaChatJsonRpc {
    readonly sdk: IDeltaChatManager;
    private slots = new Map<number, AccountSlot>();
    private order: number[] = [];
    selectedAccountId: number | null = null;
    private nextAccountId = 1;
    private stockStrings: Record<number, string> = {};
    private readonly defaultServerUrl: string;
    private readonly onEvent?: JsonRpcEventHandler;
    private readonly softStubs: boolean;
    private readonly onCredentialsSaved?: JsonRpcCompatOptions['onCredentialsSaved'];
    private readonly onAccountRemoved?: JsonRpcCompatOptions['onAccountRemoved'];
    private restorePromise: Promise<void> | null = null;
    private ready = false;
    private readonly restoreAccounts: JsonRpcCompatOptions['restoreAccounts'];

    constructor(sdk?: IDeltaChatManager, options: JsonRpcCompatOptions = {}) {
        this.sdk = sdk ?? DeltaChatSDK({ logLevel: 'info' });
        this.defaultServerUrl = (options.defaultServerUrl || 'https://nine.testrun.org').replace(/\/+$/, '');
        this.onEvent = options.onEvent;
        this.softStubs = options.softStubs !== false;
        this.onCredentialsSaved = options.onCredentialsSaved;
        this.onAccountRemoved = options.onAccountRemoved;
        this.restoreAccounts = options.restoreAccounts;
    }

    /**
     * Restore persisted accounts / create default unconfigured slot.
     * Call once from the host runtime after constructing the client.
     */
    async ensureReady(): Promise<void> {
        if (this.ready) return;
        if (this.restorePromise) return this.restorePromise;
        this.restorePromise = this.doEnsureReady();
        await this.restorePromise;
        this.ready = true;
    }

    private async doEnsureReady(): Promise<void> {
        const meta = this.restoreAccounts || [];
        if (meta.length === 0) {
            const id = this.nextAccountId++;
            this.slots.set(id, this.createSlot(id));
            this.order.push(id);
            this.selectedAccountId = id;
            return;
        }
        for (const m of meta) {
            const id = m.id;
            this.nextAccountId = Math.max(this.nextAccountId, id + 1);
            const slot = this.createSlot(id);
            this.slots.set(id, slot);
            this.order.push(id);
            if (m.displayName) slot.config.displayname = m.displayName;
            if (m.email) {
                slot.config.addr = m.email;
                slot.config.configured_addr = m.email;
            }
            if (m.configured && m.email && m.password && m.serverUrl) {
                try {
                    const acc = await this.sdk.restoreAccount(m.email, m.password, m.serverUrl);
                    slot.account = acc;
                    slot.configured = true;
                    this.wireEvents(slot);
                    // Idempotent — seeds core welcome labels if missing from older installs
                    void acc.updateDeviceChats().catch(() => {});
                    void this.startIo(id).catch(() => {});
                } catch (e) {
                    log.warn('jsonrpc', `restore account ${m.email}: ${(e as Error).message}`);
                    slot.configured = false;
                }
            }
        }
        this.selectedAccountId = this.order[0] ?? null;
    }

    /** Coverage stats for tooling / docs */
    coverage() {
        return methodCoverage();
    }

    /**
     * Primary entry — same wire contract as core JSON-RPC:
     * `handleRpc('send_msg', [accountId, chatId, msg])`
     */
    async handleRpc(method: string, rawParams?: unknown): Promise<unknown> {
        const params: unknown[] = Array.isArray(rawParams)
            ? rawParams
            : rawParams !== undefined && rawParams !== null
              ? [rawParams]
              : [];

        if (!isJsonRpcMethod(method) && !method.startsWith('_')) {
            log.debug('jsonrpc', `unknown method ${method}`);
        }

        // Prefer explicit case handlers for implemented methods
        try {
            return await this.dispatch(method, params);
        } catch (e) {
            if (e instanceof RpcNotImplemented && this.softStubs) {
                log.debug('jsonrpc', e.message);
                return this.softDefault(method);
            }
            throw e;
        }
    }

    private softDefault(method: string): unknown {
        if (method.startsWith('is_') || method.startsWith('can_')) return false;
        if (
            method.startsWith('get_') &&
            (method.includes('list') ||
                method.endsWith('_ids') ||
                method.endsWith('_contacts') ||
                method.endsWith('_msgs') ||
                method.endsWith('_receipts') ||
                method.endsWith('_updates') ||
                method.endsWith('_entries'))
        ) {
            return [];
        }
        if (method.endsWith('_cnt') || method.endsWith('_count') || method.endsWith('_size')) return 0;
        if (method.startsWith('get_')) return null;
        return null;
    }

    private emit(accountId: number, event: JsonRpcEvent) {
        this.onEvent?.(accountId, event);
    }

    private slot(id: number): AccountSlot {
        const s = this.slots.get(id);
        if (!s) throw new RpcError(`account ${id} does not exist`);
        return s;
    }

    private requireAccount(id: number): DeltaChatAccount {
        const s = this.slot(id);
        if (!s.account || !s.configured) throw new RpcError(`account ${id} is not configured`);
        return s.account;
    }

    private createSlot(id: number): AccountSlot {
        return {
            id,
            configured: false,
            ioRunning: false,
            config: defaultConfig(),
            account: null,
            maps: new IdMap(),
            unsubs: [],
        };
    }

    private wireEvents(slot: AccountSlot) {
        const acc = slot.account;
        if (!acc) return;
        for (const u of slot.unsubs) u();
        slot.unsubs = [];

        const map = (kind: DCEvent, data: DCEventData) => {
            const maps = slot.maps;
            const accountId = slot.id;
            try {
                switch (kind) {
                    case 'DC_EVENT_INCOMING_MSG': {
                        const chatKey = String(data.chatId || data.message?.chatId || '');
                        const msgKey = String(data.msgId || data.message?.id || '');
                        const chatId = chatKey ? maps.chatId(chatKey) : 0;
                        const msgId = msgKey ? maps.msgId(msgKey) : 0;
                        this.emit(accountId, { kind: 'IncomingMsg', chatId, msgId });
                        this.emit(accountId, { kind: 'MsgsChanged', chatId, msgId });
                        this.emit(accountId, { kind: 'ChatlistItemChanged', chatId });
                        this.emit(accountId, { kind: 'ChatlistChanged' });
                        break;
                    }
                    case 'DC_EVENT_MSGS_CHANGED': {
                        const chatKey = String(data.chatId || '');
                        const msgKey = String(data.msgId || '');
                        const chatId = chatKey ? maps.chatId(chatKey) : 0;
                        this.emit(accountId, {
                            kind: 'MsgsChanged',
                            chatId,
                            msgId: msgKey ? maps.msgId(msgKey) : 0,
                        });
                        if (chatId) this.emit(accountId, { kind: 'ChatlistItemChanged', chatId });
                        break;
                    }
                    case 'DC_EVENT_MSG_READ': {
                        const chatKey = String(data.chatId || '');
                        const msgKey = String(data.msgId || '');
                        this.emit(accountId, {
                            kind: 'MsgRead',
                            chatId: chatKey ? maps.chatId(chatKey) : 0,
                            msgId: msgKey ? maps.msgId(msgKey) : 0,
                        });
                        break;
                    }
                    case 'DC_EVENT_MSG_DELETED': {
                        const chatKey = String(data.chatId || '');
                        const msgKey = String(data.msgId || '');
                        this.emit(accountId, {
                            kind: 'MsgDeleted',
                            chatId: chatKey ? maps.chatId(chatKey) : 0,
                            msgId: msgKey ? maps.msgId(msgKey) : 0,
                        });
                        break;
                    }
                    case 'DC_EVENT_CONNECTIVITY_CHANGED':
                        this.emit(accountId, { kind: 'ConnectivityChanged' });
                        break;
                    case 'DC_EVENT_CONTACTS_CHANGED':
                        this.emit(accountId, { kind: 'ContactsChanged', contactId: null });
                        break;
                    case 'DC_EVENT_SELFAVATAR_CHANGED':
                        this.emit(accountId, { kind: 'SelfavatarChanged' });
                        break;
                    case 'DC_EVENT_SECUREJOIN_JOINER_PROGRESS': {
                        const contactKey = String(data.contactId || '');
                        const chatKey = String(data.chatId || data.contactId || '');
                        const progress =
                            data.data1 === '1000' || data.data1 === 1000
                                ? 1000
                                : Number(data.data1) || 0;
                        const contactIdNum = contactKey ? maps.contactId(contactKey) : 0;
                        const chatIdNum = chatKey ? maps.chatId(chatKey) : 0;
                        this.emit(accountId, {
                            kind: 'SecurejoinJoinerProgress',
                            contactId: contactIdNum,
                            progress: progress || 1000,
                        });
                        if (progress === 1000 || data.data2 === 'verified') {
                            this.emit(accountId, { kind: 'ContactsChanged', contactId: null });
                            this.emit(accountId, { kind: 'ChatlistChanged' });
                            if (chatIdNum) {
                                this.emit(accountId, { kind: 'ChatlistItemChanged', chatId: chatIdNum });
                                this.emit(accountId, { kind: 'MsgsChanged', chatId: chatIdNum, msgId: 0 });
                            }
                        }
                        break;
                    }
                    case 'DC_EVENT_SECUREJOIN_INVITER_PROGRESS': {
                        const contactKey = String(data.contactId || '');
                        const chatKey = String(data.chatId || data.contactId || '');
                        const progress =
                            data.data1 === '1000' || data.data1 === 1000
                                ? 1000
                                : Number(data.data1) || 0;
                        const contactIdNum = contactKey ? maps.contactId(contactKey) : 0;
                        const chatIdNum = chatKey ? maps.chatId(chatKey) : 0;
                        this.emit(accountId, {
                            kind: 'SecurejoinInviterProgress',
                            contactId: contactIdNum,
                            chatId: chatIdNum,
                            progress: progress || 1000,
                        });
                        if (progress === 1000 || data.data2 === 'verified') {
                            this.emit(accountId, { kind: 'ContactsChanged', contactId: null });
                            this.emit(accountId, { kind: 'ChatlistChanged' });
                            if (chatIdNum) {
                                this.emit(accountId, { kind: 'ChatlistItemChanged', chatId: chatIdNum });
                                this.emit(accountId, { kind: 'MsgsChanged', chatId: chatIdNum, msgId: 0 });
                            }
                        }
                        break;
                    }
                    case 'DC_EVENT_REACTIONS_CHANGED':
                    case 'DC_EVENT_INCOMING_REACTION': {
                        const chatKey = String(data.chatId || '');
                        const msgKey = String(data.msgId || '');
                        this.emit(accountId, {
                            kind: 'ReactionsChanged',
                            chatId: chatKey ? maps.chatId(chatKey) : 0,
                            msgId: msgKey ? maps.msgId(msgKey) : 0,
                        });
                        break;
                    }
                    case 'DC_EVENT_WEBXDC_STATUS_UPDATE': {
                        const msgKey = String(data.msgId || '');
                        this.emit(accountId, {
                            kind: 'WebxdcStatusUpdate',
                            msgId: msgKey ? maps.msgId(msgKey) : 0,
                            statusUpdateSerial: Number(data.data1 || 0),
                        });
                        break;
                    }
                    case 'DC_EVENT_LOCATION_CHANGED':
                        this.emit(accountId, { kind: 'LocationChanged', contactId: null });
                        break;
                    case 'DC_EVENT_INFO':
                        this.emit(accountId, { kind: 'Info', msg: String(data.data2 || data.data1 || '') });
                        break;
                    case 'DC_EVENT_WARNING':
                        this.emit(accountId, { kind: 'Warning', msg: String(data.data2 || data.data1 || '') });
                        break;
                    case 'DC_EVENT_ERROR':
                        this.emit(accountId, { kind: 'Error', msg: String(data.data2 || data.data1 || '') });
                        break;
                    default:
                        break;
                }
            } catch (e) {
                log.warn('jsonrpc', `event map error ${kind}: ${(e as Error).message}`);
            }
        };

        const events: DCEvent[] = [
            'DC_EVENT_INCOMING_MSG',
            'DC_EVENT_MSGS_CHANGED',
            'DC_EVENT_MSG_READ',
            'DC_EVENT_MSG_DELETED',
            'DC_EVENT_CONTACTS_CHANGED',
            'DC_EVENT_CONNECTIVITY_CHANGED',
            'DC_EVENT_SELFAVATAR_CHANGED',
            'DC_EVENT_SECUREJOIN_JOINER_PROGRESS',
            'DC_EVENT_SECUREJOIN_INVITER_PROGRESS',
            'DC_EVENT_REACTIONS_CHANGED',
            'DC_EVENT_INCOMING_REACTION',
            'DC_EVENT_WEBXDC_STATUS_UPDATE',
            'DC_EVENT_LOCATION_CHANGED',
            'DC_EVENT_INFO',
            'DC_EVENT_WARNING',
            'DC_EVENT_ERROR',
        ];
        for (const ev of events) {
            const handler = (data: DCEventData) => map(ev, data);
            acc.on(ev, handler);
            slot.unsubs.push(() => acc.off(ev, handler));
        }
    }

    // ── DTO builders ────────────────────────────────────────────────────────

    private contactDto(slot: AccountSlot, c: StoredContact | null, numericId: number, opts?: { self?: boolean; device?: boolean }): any {
        if (opts?.self || numericId === SELF_CONTACT_ID) {
            const email = slot.config.addr || slot.account?.getCredentials().email || '';
            const name = slot.config.displayname || slot.account?.getDisplayName() || email.split('@')[0] || 'Me';
            return {
                id: SELF_CONTACT_ID,
                address: email,
                displayName: name,
                name,
                authName: name,
                status: slot.config.selfstatus || '',
                color: colorForId(slot.id),
                profileImage: slot.config.selfavatar ?? null,
                nameAndAddr: email ? `${name} (${email})` : name,
                isBlocked: false,
                isKeyContact: true,
                e2eeAvail: true,
                isVerified: true,
                verifierId: null,
                lastSeen: 0,
                wasSeenRecently: true,
                isBot: false,
                isMuted: false,
                isSelf: true,
            };
        }
        if (opts?.device || numericId === DEVICE_CONTACT_ID) {
            return {
                id: DEVICE_CONTACT_ID,
                address: 'device@localhost',
                displayName: 'Device messages',
                name: 'Device messages',
                authName: 'Device messages',
                status: '',
                color: '#415e6b',
                profileImage: null,
                nameAndAddr: 'Device messages',
                isBlocked: false,
                isKeyContact: false,
                e2eeAvail: false,
                isVerified: false,
                verifierId: null,
                lastSeen: 0,
                wasSeenRecently: false,
                isBot: false,
                isMuted: false,
            };
        }
        if (!c) {
            return {
                id: numericId,
                address: '',
                displayName: 'Unknown',
                name: 'Unknown',
                authName: 'Unknown',
                status: '',
                color: '#999',
                profileImage: null,
                nameAndAddr: 'Unknown',
                isBlocked: false,
                isKeyContact: false,
                e2eeAvail: false,
                isVerified: false,
                verifierId: null,
                lastSeen: 0,
                wasSeenRecently: false,
                isBot: false,
                isMuted: false,
            };
        }
        const name = c.name || c.email.split('@')[0];
        return {
            id: numericId,
            address: c.email,
            displayName: name,
            name,
            authName: name,
            status: '',
            color: colorForId(c.id),
            profileImage: c.avatar ?? null,
            nameAndAddr: `${name} (${c.email})`,
            isBlocked: !!c.blocked,
            isKeyContact: !!c.publicKeyArmored,
            e2eeAvail: !!c.publicKeyArmored,
            isVerified: !!c.verified,
            verifierId: null,
            lastSeen: c.lastSeen ? tsSec(c.lastSeen) : 0,
            wasSeenRecently: false,
            isBot: false,
            isMuted: false,
        };
    }

    private msgState(msg: StoredMessage): number {
        if (msg.direction === 'incoming') {
            return msg.state === 'seen' ? DC_STATE_IN_SEEN : DC_STATE_IN_FRESH;
        }
        switch (msg.state) {
            case 'pending':
                return DC_STATE_OUT_PENDING;
            case 'failed':
                return DC_STATE_OUT_FAILED;
            case 'seen':
                return DC_STATE_OUT_MDN_RCVD;
            default:
                return DC_STATE_OUT_DELIVERED;
        }
    }

    private async messageDto(slot: AccountSlot, msg: StoredMessage): Promise<any> {
        const chatId = slot.maps.chatId(msg.chatId);
        const selfEmail = slot.account?.getCredentials().email || '';
        let fromId = SELF_CONTACT_ID;
        if (msg.direction === 'incoming') {
            if (msg.from === 'device' || msg.chatId === 'device-chat') fromId = DEVICE_CONTACT_ID;
            else {
                const c = slot.account?.findContactByEmail(msg.from);
                fromId = c ? slot.maps.contactId(c.id) : slot.maps.contactId(msg.from);
            }
        }
        const viewType = storeTypeToViewtype(msg.type as any) || 'Text';
        let file: string | null = null;
        if (msg.media?.data) {
            const mime = msg.media.mimeType || 'application/octet-stream';
            const d = msg.media.data;
            // Absolute/site paths (e.g. device welcome /images/intro1.png) and data/blob URLs
            if (
                d.startsWith('data:') ||
                d.startsWith('blob:') ||
                d.startsWith('/') ||
                d.startsWith('http://') ||
                d.startsWith('https://')
            ) {
                file = d;
            } else {
                file = `data:${mime};base64,${d}`;
            }
        }
        const isDevice = msg.chatId === 'device-chat' || msg.from === 'device';
        const sender = this.contactDto(
            slot,
            null,
            fromId,
            fromId === SELF_CONTACT_ID ? { self: true } : fromId === DEVICE_CONTACT_ID ? { device: true } : undefined,
        );
        // Prefer real contact for peers
        if (fromId !== SELF_CONTACT_ID && fromId !== DEVICE_CONTACT_ID && slot.account) {
            const key = slot.maps.contactKey(fromId);
            const contacts = await slot.account.getContacts();
            const c = contacts.find(x => x.id === key || x.email === key) || null;
            Object.assign(sender, this.contactDto(slot, c, fromId));
        }

        // UI messageAttachment.calculateHeight divides by width — 0×0 → NaN height warning.
        // Match mock runtime defaults for media viewtypes when unknown.
        let dimensionsHeight = 0;
        let dimensionsWidth = 0;
        if (viewType === 'Image' || viewType === 'Sticker' || viewType === 'Gif') {
            dimensionsHeight = 300;
            dimensionsWidth = 450;
        } else if (viewType === 'Video') {
            dimensionsHeight = 300;
            dimensionsWidth = 450;
        }
        let fileBytes = msg.media?.size ?? 0;
        if (!fileBytes && msg.media?.data && !msg.media.data.startsWith('/') && !msg.media.data.startsWith('http')) {
            // Approximate byte length from base64 / data-URL payload
            const b64 = msg.media.data.includes('base64,')
                ? msg.media.data.split('base64,')[1]
                : msg.media.data;
            fileBytes = Math.floor((b64.replace(/\s/g, '').length * 3) / 4);
        }

        return {
            kind: 'message',
            id: slot.maps.msgId(msg.id),
            chatId,
            fromId,
            quote: null,
            parentId: null,
            text: msg.text || '',
            isEdited: msg.type === 'edit' || !!msg.editTarget,
            hasLocation: msg.type === 'location',
            hasHtml: false,
            viewType,
            state: this.msgState(msg),
            error: null,
            timestamp: tsSec(msg.timestamp),
            sortTimestamp: tsSec(msg.timestamp),
            receivedTimestamp: tsSec(msg.timestamp),
            hasDeviatingTimestamp: false,
            subject: '',
            showPadlock: !!msg.encrypted && !isDevice,
            isInfo: !isDevice && (msg.type === 'system' || msg.type === 'securejoin'),
            isForwarded: false,
            isBot: false,
            systemMessageType: 'Unknown',
            infoContactId: null,
            duration: msg.media?.durationMs ? Math.round(msg.media.durationMs / 1000) : 0,
            dimensionsHeight,
            dimensionsWidth,
            overrideSenderName: null,
            sender,
            file,
            fileMime: msg.media?.mimeType ?? null,
            fileBytes,
            fileName: msg.media?.filename ?? null,
            webxdcHref: null,
            downloadState: 'Done',
            originalMsgId: null,
            savedMessageId: null,
            reactions: null,
            vcardContact: null,
        };
    }

    private async basicChat(slot: AccountSlot, chatId: number): Promise<any> {
        if (chatId === DC_CHAT_ID_ARCHIVED_LINK) {
            return {
                id: chatId,
                name: 'Archived chats',
                chatType: 'Single',
                isEncrypted: false,
                profileImage: null,
                archived: false,
                pinned: false,
                isUnpromoted: false,
                isSelfTalk: false,
                color: '#415e6b',
                isContactRequest: false,
                isDeviceChat: false,
                isMuted: false,
            };
        }
        const key = slot.maps.chatKey(chatId);
        const chat = key && slot.account ? await slot.account.getChat(key) : null;
        const isDevice = key === 'device-chat';
        const selfEmail = slot.account?.getCredentials().email || '';
        return {
            id: chatId,
            name: isDevice ? 'Device messages' : chat?.name || 'Chat',
            chatType: chat?.isBroadcast ? 'Broadcast' : chat?.isGroup ? 'Group' : 'Single',
            isEncrypted: !isDevice,
            profileImage: chat?.avatar ?? null,
            archived: !!chat?.archived,
            pinned: !!chat?.pinned,
            isUnpromoted: false,
            isSelfTalk: !!(chat && !chat.isGroup && chat.peerEmail === selfEmail && !isDevice),
            color: colorForId(chat?.id || chatId),
            isContactRequest: false,
            isDeviceChat: isDevice,
            isMuted: !!chat?.muted,
        };
    }

    // ── Dispatch ────────────────────────────────────────────────────────────

    private async dispatch(method: string, p: unknown[]): Promise<unknown> {
        const n = (i: number) => Number(p[i]);
        const s = (i: number) => String(p[i] ?? '');

        switch (method) {
            // ── lifecycle / events ──────────────────────────────────────────
            case 'get_next_event':
            case 'get_next_event_batch':
                // Core blocks; UI uses push events instead of polling in madweb.
                return new Promise(() => {});
            case 'sleep':
                await new Promise(r => setTimeout(r, Math.max(0, Number(p[0] || 0) * 1000)));
                return null;
            case 'set_stock_strings': {
                const obj = p[0];
                if (obj && typeof obj === 'object') Object.assign(this.stockStrings, obj as object);
                return null;
            }
            case 'check_email_validity': {
                const email = s(0);
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /@\[.+\]$/.test(email);
            }

            // ── accounts ────────────────────────────────────────────────────
            case 'add_account': {
                const id = this.nextAccountId++;
                this.slots.set(id, this.createSlot(id));
                this.order.push(id);
                return id;
            }
            case 'remove_account': {
                const id = n(0);
                const slot = this.slots.get(id);
                const email = slot?.config.addr || slot?.account?.getCredentials().email || undefined;
                if (slot?.account) {
                    try {
                        // Full device wipe: WS + RAM + IndexedDB madcore-{email}
                        await this.sdk.removeAccount(slot.account.id);
                    } catch {
                        try {
                            slot.account.disconnect();
                        } catch { /* ignore */ }
                    }
                }
                for (const u of slot?.unsubs || []) u();
                this.slots.delete(id);
                this.order = this.order.filter(x => x !== id);
                if (this.selectedAccountId === id) this.selectedAccountId = this.order[0] ?? null;
                try {
                    this.onAccountRemoved?.({ accountId: id, email: email || undefined });
                } catch {
                    /* host callback */
                }
                return null;
            }
            case 'get_all_account_ids':
                return [...this.order];
            case 'set_accounts_order': {
                const order = Array.isArray(p[0]) ? (p[0] as number[]).map(Number) : [];
                const remaining = new Set(this.order);
                const next: number[] = [];
                for (const id of order) if (remaining.delete(id)) next.push(id);
                for (const id of remaining) next.push(id);
                this.order = next;
                return null;
            }
            case 'select_account':
                this.selectedAccountId = n(0);
                return null;
            case 'get_selected_account_id':
                return this.selectedAccountId;
            case 'get_account_info':
                return this.getAccountInfo(n(0));
            case 'get_all_accounts':
                return this.order.map(id => this.getAccountInfo(id));
            case 'is_configured': {
                try {
                    return this.slot(n(0)).configured;
                } catch {
                    return false;
                }
            }
            case 'get_system_info':
                return {
                    deltachat_core_version: 'madcore-jsonrpc-compat',
                    sqlite_version: 'indexeddb',
                    arch: 'wasm',
                    num_cpus: '4',
                };
            case 'get_info':
                return { backend: 'madcore', level: 'awesome' };

            // ── IO ──────────────────────────────────────────────────────────
            case 'start_io':
                await this.startIo(n(0));
                return null;
            case 'stop_io':
                this.stopIo(n(0));
                return null;
            case 'start_io_for_all_accounts':
                for (const id of this.order) {
                    try { await this.startIo(id); } catch { /* ignore */ }
                }
                return null;
            case 'stop_io_for_all_accounts':
                for (const id of this.order) this.stopIo(id);
                return null;
            case 'maybe_network':
            case 'background_fetch': {
                for (const id of this.order) {
                    const slot = this.slots.get(id);
                    if (slot?.account && slot.ioRunning) {
                        try { await slot.account.backgroundFetch(); } catch { /* ignore */ }
                    }
                }
                return null;
            }
            case 'stop_background_fetch':
            case 'stop_ongoing_process':
                return null;
            case 'get_connectivity':
                return this.getConnectivity(n(0));
            case 'get_connectivity_html':
                return this.getConnectivityHtml(n(0));

            // ── transports / configure ──────────────────────────────────────
            case 'list_transports':
                return this.listTransports(n(0));
            case 'list_transports_ex':
                return this.listTransports(n(0)).map(param => ({ param, isUnpublished: false }));
            case 'add_transport_from_qr':
                await this.addTransportFromQr(n(0), s(1));
                return null;
            case 'add_transport':
            case 'add_or_update_transport':
                await this.addOrUpdateTransport(n(0), p[1] ?? {});
                return null;
            case 'delete_transport':
            case 'set_transport_unpublished':
                return null;

            // ── config ──────────────────────────────────────────────────────
            case 'get_config':
                return this.getConfig(n(0), s(1));
            case 'set_config':
                await this.setConfig(n(0), s(1), p[2] == null ? null : String(p[2]));
                return null;
            case 'batch_get_config': {
                const keys = (p[1] as string[]) || [];
                const out: Record<string, string | null> = {};
                for (const k of keys) out[k] = await this.getConfig(n(0), k);
                return out;
            }
            case 'batch_set_config': {
                const values = (p[1] as Record<string, string | null>) || {};
                for (const [k, v] of Object.entries(values)) {
                    await this.setConfig(n(0), k, v);
                }
                return null;
            }

            // ── contacts ────────────────────────────────────────────────────
            case 'get_contact':
                return this.getContact(n(0), n(1));
            case 'get_contact_ids':
                return this.getContactIds(n(0), p[1] as number | null, p[2] as string | null);
            case 'get_contacts': {
                const ids = await this.getContactIds(n(0), p[1] as number | null, p[2] as string | null);
                return this.getContactsByIds(n(0), ids);
            }
            case 'get_contacts_by_ids':
                return this.getContactsByIds(n(0), (p[1] as number[]) || []);
            case 'get_blocked_contacts':
                return this.getBlockedContacts(n(0));
            case 'create_contact':
                return this.createContact(n(0), s(1), p[2] == null ? null : String(p[2]));
            case 'block_contact':
                await this.requireAccount(n(0)).blockContact(this.slot(n(0)).maps.contactKey(n(1)) || '');
                this.emit(n(0), { kind: 'ContactsChanged', contactId: n(1) });
                return null;
            case 'unblock_contact':
                await this.requireAccount(n(0)).unblockContact(this.slot(n(0)).maps.contactKey(n(1)) || '');
                this.emit(n(0), { kind: 'ContactsChanged', contactId: n(1) });
                return null;
            case 'delete_contact': {
                const key = this.slot(n(0)).maps.contactKey(n(1));
                if (key) await this.requireAccount(n(0)).deleteContact(key);
                return null;
            }
            case 'change_contact_name':
                // madcore has no rename API yet — soft no-op for parity
                return null;
            case 'lookup_contact_id_by_addr': {
                const acc = this.slots.get(n(0))?.account;
                if (!acc) return null;
                const c = acc.findContactByEmail(s(1).trim().toLowerCase());
                return c ? this.slot(n(0)).maps.contactId(c.id) : null;
            }
            case 'create_chat_by_contact_id':
            case 'get_chat_id_by_contact_id':
                return this.createChatByContactId(n(0), n(1));

            // ── chats ───────────────────────────────────────────────────────
            case 'get_chatlist_entries':
                return this.getChatlistEntries(n(0), p[1] as number | null, p[2] as string | null, p[3] as number | null);
            case 'get_chatlist_items_by_entries': {
                const entries = (p[1] as number[]) || [];
                const out: Record<number, any> = {};
                for (const id of entries) out[id] = await this.getChatlistItem(n(0), id);
                return out;
            }
            case 'get_chat':
            case 'get_full_chat_by_id':
            case 'chatlist_get_full_chat_by_id':
                return this.getFullChat(n(0), n(1));
            case 'get_basic_chat_info':
                return this.basicChat(this.slot(n(0)), n(1));
            case 'get_fresh_msgs':
                return this.getFreshMsgs(n(0));
            case 'get_fresh_msg_cnt': {
                const slot = this.slot(n(0));
                const key = slot.maps.chatKey(n(1));
                if (!key || !slot.account) return 0;
                const chat = await slot.account.getChat(key);
                return chat?.unreadCount ?? 0;
            }
            case 'delete_chat': {
                const slot = this.slot(n(0));
                const key = slot.maps.chatKey(n(1));
                if (key) await this.requireAccount(n(0)).deleteChat(key);
                this.emit(n(0), { kind: 'ChatDeleted', chatId: n(1) });
                this.emit(n(0), { kind: 'ChatlistChanged' });
                return null;
            }
            case 'set_chat_visibility': {
                const acc = this.requireAccount(n(0));
                const key = this.slot(n(0)).maps.chatKey(n(1));
                const vis = s(2);
                if (key) {
                    if (vis === 'Archived') await acc.archiveChat(key, true);
                    else if (vis === 'Pinned') await acc.pinChat(key, true);
                    else {
                        await acc.archiveChat(key, false);
                        await acc.pinChat(key, false);
                    }
                }
                this.emit(n(0), { kind: 'ChatModified', chatId: n(1) });
                this.emit(n(0), { kind: 'ChatlistChanged' });
                return null;
            }
            case 'set_chat_name': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key) await this.requireAccount(n(0)).renameGroup(key, { newName: s(2) });
                this.emit(n(0), { kind: 'ChatModified', chatId: n(1) });
                return null;
            }
            case 'set_chat_description': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key) {
                    try {
                        await this.requireAccount(n(0)).updateGroupDescription(key, { newDescription: s(2) });
                    } catch { /* not a group */ }
                }
                return null;
            }
            case 'get_chat_description':
                return '';
            case 'set_chat_profile_image': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key && p[2]) {
                    await this.requireAccount(n(0)).setChatProfileImage(key, {
                        data: String(p[2]).replace(/^data:[^;]+;base64,/, ''),
                    });
                }
                return null;
            }
            case 'set_chat_ephemeral_timer': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key) await this.requireAccount(n(0)).setChatEphemeralTimer(key, n(2));
                return null;
            }
            case 'get_chat_ephemeral_timer': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (!key) return 0;
                return this.requireAccount(n(0)).getChatEphemeralTimer(key);
            }
            case 'set_chat_mute_duration': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                const dur = p[2] as any;
                const muted = dur && typeof dur === 'object' ? dur.kind !== 'NotMuted' : Number(dur) !== 0;
                if (key) await this.requireAccount(n(0)).muteChat(key, muted);
                return null;
            }
            case 'is_chat_muted': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (!key || !this.slot(n(0)).account) return false;
                const chat = await this.slot(n(0)).account!.getChat(key);
                return !!chat?.muted;
            }
            case 'marknoticed_chat': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key) await this.requireAccount(n(0)).markChatRead(key);
                this.emit(n(0), { kind: 'MsgsNoticed', chatId: n(1) });
                this.emit(n(0), { kind: 'ChatlistItemChanged', chatId: n(1) });
                return null;
            }
            case 'marknoticed_all_chats':
            case 'markfresh_chat':
            case 'accept_chat':
            case 'block_chat':
                return null;
            case 'leave_group': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key) await this.requireAccount(n(0)).leaveGroup(key);
                return null;
            }
            case 'add_contact_to_chat': {
                const gKey = this.slot(n(0)).maps.chatKey(n(1));
                const cKey = this.slot(n(0)).maps.contactKey(n(2));
                if (gKey && cKey) {
                    const acc = this.requireAccount(n(0));
                    const c = acc.getContact(cKey) || (await acc.getContacts()).find(x => x.id === cKey);
                    if (c) await acc.addGroupMember(gKey, { email: c.email });
                }
                this.emit(n(0), { kind: 'ChatModified', chatId: n(1) });
                return null;
            }
            case 'remove_contact_from_chat': {
                const gKey = this.slot(n(0)).maps.chatKey(n(1));
                const cKey = this.slot(n(0)).maps.contactKey(n(2));
                if (gKey && cKey) {
                    const acc = this.requireAccount(n(0));
                    const c = acc.getContact(cKey) || (await acc.getContacts()).find(x => x.id === cKey);
                    if (c) await acc.removeGroupMember(gKey, { email: c.email });
                }
                this.emit(n(0), { kind: 'ChatModified', chatId: n(1) });
                return null;
            }
            case 'create_group_chat':
            case 'create_group_chat_unencrypted': {
                const group = await this.requireAccount(n(0)).createGroup({
                    name: s(2) || 'Group',
                    members: [],
                });
                const chatId = this.slot(n(0)).maps.chatId(group.grpId);
                this.emit(n(0), { kind: 'ChatlistChanged' });
                return chatId;
            }
            case 'create_broadcast':
            case 'create_broadcast_list': {
                const ch = await this.requireAccount(n(0)).createChannel({ name: s(1) || 'Channel' });
                const chatId = this.slot(n(0)).maps.chatId(ch.grpId);
                this.emit(n(0), { kind: 'ChatlistChanged' });
                return chatId;
            }
            case 'get_chat_media':
                return this.getChatMedia(n(0), p[1] as number | null, p.slice(2) as Array<string | null>);
            case 'get_chat_contacts': {
                const full = await this.getFullChat(n(0), n(1));
                return full.contactIds || [];
            }
            case 'get_past_chat_contacts':
                return [];
            case 'can_send': {
                const basic = await this.basicChat(this.slot(n(0)), n(1));
                return !basic.isDeviceChat && !basic.isContactRequest;
            }
            case 'get_chat_encryption_info':
            case 'get_contact_encryption_info':
                return '';

            // ── messages ────────────────────────────────────────────────────
            case 'get_message_list_items':
                return this.getMessageListItems(n(0), n(1), !!p[3]);
            case 'get_message_ids': {
                const items = await this.getMessageListItems(n(0), n(1), false);
                return items.filter(i => i.kind === 'message').map(i => i.msg_id!);
            }
            case 'get_messages':
                return this.getMessages(n(0), (p[1] as number[]) || []);
            case 'get_message': {
                const all = await this.getMessages(n(0), [n(1)]);
                const m = all[n(1)];
                if (!m) return null;
                // singular get_message returns Message without MessageLoadResult wrapper
                const { kind: _k, ...rest } = m;
                return rest;
            }
            case 'send_msg':
            case 'misc_send_msg':
                return this.sendMessage(n(0), n(1), p[2] ?? {});
            case 'misc_send_text_message':
            case 'send_text_message':
                return this.sendMessage(n(0), n(1), { text: s(2) });
            case 'send_sticker':
                return this.sendMessage(n(0), n(1), {
                    text: '',
                    file: s(2),
                    filename: 'sticker.png',
                    viewtype: 'Sticker',
                });
            case 'misc_send_draft':
                return this.sendMessage(n(0), n(1), p[2] ?? {});
            case 'delete_messages':
            case 'delete_messages_for_me':
            case 'delete_messages_for_all':
                await this.deleteMessages(n(0), (p[1] as number[]) || []);
                return null;
            case 'markseen_msgs': {
                const acc = this.requireAccount(n(0));
                const slot = this.slot(n(0));
                for (const id of (p[1] as number[]) || []) {
                    const key = slot.maps.msgKey(id);
                    if (key) await acc.markMessageSeen(key);
                }
                return null;
            }
            case 'send_reaction':
                return this.sendReaction(n(0), n(1), (p[2] as string[]) || []);
            case 'get_message_reactions': {
                const msg = await this.getMessages(n(0), [n(1)]);
                return msg[n(1)]?.reactions ?? null;
            }
            case 'send_edit_request': {
                const acc = this.requireAccount(n(0));
                const key = this.slot(n(0)).maps.msgKey(n(1));
                if (key) {
                    const msg = await acc.store.getMessage(key);
                    if (msg) await acc.send(msg.chatId, { edit: { targetMessage: key, newText: s(2) } });
                }
                return null;
            }
            case 'search_messages':
                return this.searchMessages(n(0), s(1), p[2] as number | null);
            case 'message_ids_to_search_results':
                return this.messageIdsToSearchResults(n(0), (p[1] as number[]) || []);
            case 'forward_messages': {
                // p: accountId, msgIds, chatId
                const acc = this.requireAccount(n(0));
                const slot = this.slot(n(0));
                const destKey = slot.maps.chatKey(n(2));
                if (!destKey) return null;
                for (const mid of (p[1] as number[]) || []) {
                    const mKey = slot.maps.msgKey(mid);
                    if (!mKey) continue;
                    const msg = await acc.store.getMessage(mKey);
                    if (msg) {
                        await acc.send(destKey, {
                            forward: { originalMessage: mKey, originalFrom: msg.from },
                        });
                    }
                }
                return null;
            }
            case 'resend_messages':
            case 'download_full_message':
            case 'save_msgs':
            case 'get_first_unread_message_of_chat':
            case 'get_message_html':
                return null;
            case 'get_message_info':
            case 'get_message_info_object':
                return { rawText: '', serverUrls: [], receivedByMe: false };
            case 'get_message_notification_info':
                return { chatId: 0, chatName: '', chatProfileImage: null, image: null };
            case 'get_message_read_receipts':
                return [];
            case 'get_message_read_receipt_count':
                return 0;

            // ── drafts ──────────────────────────────────────────────────────
            case 'get_draft':
                return this.getDraft(n(0), n(1));
            case 'misc_set_draft':
                await this.setDraft(n(0), n(1), p[2] as string | null, p[3] as string | null, p[4] as string | null, p[5] as number | null, p[6] as string | null);
                return null;
            case 'remove_draft': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key) await this.requireAccount(n(0)).removeDraft(key);
                return null;
            }

            // ── QR / SecureJoin ─────────────────────────────────────────────
            case 'check_qr':
                return this.checkQr(n(0), s(1));
            case 'secure_join':
                return this.secureJoin(n(0), s(1));
            case 'secure_join_with_ux_info':
                return { chatId: await this.secureJoin(n(0), s(1)) };
            case 'get_chat_securejoin_qr_code':
                return this.getSecurejoinQr(n(0), p[1] == null ? null : n(1));
            case 'get_chat_securejoin_qr_code_svg': {
                const qr = this.getSecurejoinQr(n(0), p[1] == null ? null : n(1));
                const svg = await createQrSvg(qr);
                return [qr, svg];
            }
            case 'create_qr_svg':
                return createQrSvg(s(0));
            case 'set_config_from_qr':
                // treat as add transport from QR
                await this.addTransportFromQr(n(0), s(1));
                return null;

            // ── device ──────────────────────────────────────────────────────
            case 'add_device_message':
                return this.addDeviceMessage(n(0), s(1), p[2]);

            // ── blobs / stickers ─────────────────────────────────────────────
            case 'get_blob_dir':
                return 'blobs';
            case 'copy_to_blob_dir':
                return s(1);
            case 'misc_get_stickers':
                return {};
            case 'misc_get_sticker_folder':
                return 'stickers';
            case 'misc_save_sticker':
                return null;

            // ── backup ──────────────────────────────────────────────────────
            case 'export_backup': {
                const acc = this.slots.get(n(0))?.account;
                if (!acc) return '';
                return acc.exportBackup();
            }
            case 'import_backup': {
                const acc = this.slots.get(n(0))?.account;
                if (acc && p[1]) await acc.importBackup(String(p[1]));
                return null;
            }
            case 'get_backup':
            case 'get_backup_qr':
            case 'get_backup_qr_svg':
            case 'provide_backup':
                return method.endsWith('svg') ? '' : method === 'get_backup' ? null : '';

            // ── location ────────────────────────────────────────────────────
            case 'send_locations_to_chat': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key) await this.requireAccount(n(0)).sendLocationsToChat(key, { durationSec: n(2) });
                return null;
            }
            case 'set_location':
                await this.requireAccount(n(0)).setLocation({
                    lat: Number(p[1]),
                    lon: Number(p[2]),
                    accuracy: p[3] != null ? Number(p[3]) : undefined,
                });
                return null;
            case 'get_locations': {
                const acc = this.slots.get(n(0))?.account;
                if (!acc) return [];
                const chatKey = this.slot(n(0)).maps.chatKey(n(1) as number) || '';
                return acc.getLocations(chatKey);
            }
            case 'stop_sending_locations': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (key) await this.requireAccount(n(0)).stopSendingLocations(key);
                return null;
            }
            case 'is_sending_locations':
            case 'is_sending_locations_to_chat':
                return false;

            // ── calls ───────────────────────────────────────────────────────
            case 'place_outgoing_call': {
                const key = this.slot(n(0)).maps.chatKey(n(1));
                if (!key) return null;
                const r = await this.requireAccount(n(0)).placeOutgoingCall(key, {
                    video: !!p[2],
                });
                return r;
            }
            case 'accept_incoming_call':
                await this.requireAccount(n(0)).acceptIncomingCall(s(1));
                return null;
            case 'end_call':
                await this.requireAccount(n(0)).endCall(s(1));
                return null;
            case 'call_info':
                return null;
            case 'ice_servers':
                return this.slots.get(n(0))?.account?.getIceServers() ?? [];

            // ── webxdc ──────────────────────────────────────────────────────
            case 'get_webxdc_info':
                return {
                    name: 'Webxdc',
                    version: '1.0.0',
                    summary: '',
                    iconPath: null,
                    sourceCodeUrl: null,
                    internetAccess: false,
                };
            case 'get_webxdc_status_updates': {
                const acc = this.slots.get(n(0))?.account;
                if (!acc) return '[]';
                const msgKey = this.slot(n(0)).maps.msgKey(n(1));
                if (!msgKey) return '[]';
                const ups = await acc.getWebxdcStatusUpdates(msgKey, Number(p[2] || 0));
                return JSON.stringify(ups);
            }
            case 'send_webxdc_status_update': {
                // best-effort: needs contact + instance
                return null;
            }
            case 'get_webxdc_blob':
            case 'get_webxdc_href':
            case 'send_webxdc_realtime_data':
            case 'send_webxdc_realtime_advertisement':
            case 'leave_webxdc_realtime':
            case 'init_webxdc_integration':
            case 'set_webxdc_integration':
                return null;

            // ── remaining stubs (explicit for documentation / coverage) ─────
            default: {
                if (IMPLEMENTED_JSONRPC_METHODS.has(method)) {
                    // Listed as implemented but missing case — soft default
                    return this.softDefault(method);
                }
                if (STUB_JSONRPC_METHODS.has(method) || isJsonRpcMethod(method)) {
                    if (!this.softStubs) throw new RpcNotImplemented(method);
                    return this.softDefault(method);
                }
                if (!this.softStubs) throw new RpcNotImplemented(method);
                log.debug('jsonrpc', `unhandled method: ${method}`);
                return this.softDefault(method);
            }
        }
    }

    // ── Account helpers ─────────────────────────────────────────────────────

    getAccountInfo(id: number): AccountInfo {
        const slot = this.slot(id);
        if (!slot.configured || !slot.account) return { id, kind: 'Unconfigured' };
        const creds = slot.account.getCredentials();
        return {
            id,
            kind: 'Configured',
            addr: creds.email,
            displayName: slot.config.displayname || slot.account.getDisplayName() || creds.email,
            profileImage: slot.config.selfavatar ?? null,
            color: colorForId(id),
            privateTag: slot.config.private_tag ?? null,
            eventEmitterId: id,
            isMuted: false,
            wasSeenRecently: true,
        };
    }

    private async startIo(accountId: number) {
        const slot = this.slot(accountId);
        if (!slot.account || !slot.configured) return;
        slot.ioRunning = true;
        await slot.account.connect();
        this.emit(accountId, { kind: 'ConnectivityChanged' });
    }

    private stopIo(accountId: number) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return;
        slot.ioRunning = false;
        try { slot.account.disconnect(); } catch { /* ignore */ }
        this.emit(accountId, { kind: 'ConnectivityChanged' });
    }

    private getConnectivity(accountId: number): number {
        const slot = this.slots.get(accountId);
        if (!slot?.configured || !slot.account || !slot.ioRunning) return DC_CONNECTIVITY_NOT_CONNECTED;
        const c = slot.account.getConnectivity();
        if (c === 'connected') return DC_CONNECTIVITY_CONNECTED;
        if (c === 'connecting' || c === 'working') return DC_CONNECTIVITY_CONNECTING;
        return DC_CONNECTIVITY_NOT_CONNECTED;
    }

    private getConnectivityHtml(accountId: number): string {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return '<html><body><p>Not configured</p></body></html>';
        const body = slot.account.getConnectivityHtml();
        return `<!DOCTYPE html><html><body>${body}</body></html>`;
    }

    private listTransports(accountId: number): any[] {
        const slot = this.slots.get(accountId);
        if (!slot?.configured || !slot.account) {
            return [{
                addr: '', password: '',
                imapServer: null, imapPort: null, imapSecurity: null, imapUser: null,
                smtpServer: null, smtpPort: null, smtpSecurity: null, smtpUser: null,
                smtpPassword: null, certificateChecks: null, oauth2: null,
            }];
        }
        const c = slot.account.getCredentials();
        const host = slot.account.serverUrl.replace(/^https?:\/\//, '');
        return [{
            addr: c.email,
            password: c.password,
            imapServer: host, imapPort: 993, imapSecurity: 'ssl', imapUser: c.email,
            smtpServer: host, smtpPort: 465, smtpSecurity: 'ssl', smtpUser: c.email,
            smtpPassword: null, certificateChecks: 'automatic', oauth2: false,
        }];
    }

    private async addTransportFromQr(accountId: number, qr: string) {
        const slot = this.slot(accountId);
        const raw = qr.trim();
        this.emit(accountId, { kind: 'ConfigureProgress', progress: 100, comment: 'Parsing…' });

        if (/^dclogin:/i.test(raw)) {
            // dclogin:user@host?p=pass&ih=host
            const m = raw.match(/^dclogin:(.+)$/i);
            if (!m) throw new RpcError('Invalid dclogin');
            const rest = m[1];
            const q = rest.indexOf('?');
            const address = q >= 0 ? rest.slice(0, q) : rest;
            const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : '');
            const password = params.get('p') || '';
            const host = params.get('ih') || params.get('sh') || address.split('@').pop()?.replace(/^\[|\]$/g, '') || '';
            await this.configureCredentials(accountId, address, password, `https://${host}`);
            return;
        }

        let serverUrl = this.defaultServerUrl;
        let token: string | undefined;
        if (/^dcaccount:/i.test(raw)) {
            const body = raw.replace(/^dcaccount:/i, '');
            try {
                const u = new URL(/^https?:\/\//i.test(body) ? body : `https://${body}`);
                serverUrl = `${u.protocol}//${u.host}`;
                token = u.searchParams.get('token') || undefined;
            } catch {
                serverUrl = normalizeServerUrl(body, this.defaultServerUrl);
            }
        } else if (/^https?:\/\//i.test(raw) || raw.includes('.')) {
            serverUrl = normalizeServerUrl(raw, this.defaultServerUrl);
        }

        this.emit(accountId, { kind: 'ConfigureProgress', progress: 300, comment: `Registering on ${serverUrl}…` });
        const name = slot.config.displayname?.trim() || `User ${accountId}`;
        const reg = await this.sdk.register(serverUrl, name, token ? { token } : undefined);
        if (!reg.account.getFingerprint()) await reg.account.generateKeys(name);
        slot.account = reg.account;
        slot.configured = true;
        slot.config.addr = reg.email;
        slot.config.configured_addr = reg.email;
        slot.config.displayname = name;
        this.wireEvents(slot);
        this.emit(accountId, { kind: 'ConfigureProgress', progress: 900, comment: 'Connecting…' });
        await this.startIo(accountId);
        // Core: configure → update_device_chats (welcome image + text + saved messages)
        try {
            await reg.account.updateDeviceChats();
        } catch { /* ignore */ }
        try {
            this.onCredentialsSaved?.({
                accountId,
                email: reg.email,
                password: reg.password,
                serverUrl,
                displayName: name,
            });
        } catch {
            /* host callback */
        }
        this.emit(accountId, { kind: 'ConfigureProgress', progress: 1000, comment: 'Configured' });
        this.emit(accountId, { kind: 'TransportsModified' });
        this.emit(accountId, { kind: 'AccountsItemChanged' });
        this.emit(accountId, { kind: 'ChatlistChanged' });
    }

    private async addOrUpdateTransport(accountId: number, credentials: any) {
        const addr = String(credentials?.addr || '').trim();
        const password = String(credentials?.password || '');
        if (!addr || !password) throw new RpcError('addr and password required');
        const host = addr.includes('@')
            ? addr.split('@').pop()!.replace(/^\[|\]$/g, '')
            : this.defaultServerUrl.replace(/^https?:\/\//, '');
        const serverUrl = credentials?.imapServer
            ? `https://${String(credentials.imapServer).replace(/^imap\./, '')}`
            : `https://${host}`;
        await this.configureCredentials(accountId, addr, password, serverUrl);
    }

    private async configureCredentials(accountId: number, email: string, password: string, serverUrl: string) {
        const slot = this.slot(accountId);
        const name = slot.config.displayname?.trim() || email.split('@')[0] || `User ${accountId}`;
        let acc = this.sdk.findAccountByEmail(email);
        if (!acc) {
            acc = this.sdk.addAccount(email, password, serverUrl);
            await acc.loadFromStore();
        }
        if (!acc.getFingerprint()) await acc.generateKeys(name);
        slot.account = acc;
        slot.configured = true;
        slot.config.addr = email;
        slot.config.configured_addr = email;
        slot.config.displayname = name;
        this.wireEvents(slot);
        await this.startIo(accountId);
        // Core: configure → update_device_chats (welcome image + text + saved messages)
        try {
            await acc.updateDeviceChats();
        } catch { /* ignore */ }
        try {
            this.onCredentialsSaved?.({
                accountId,
                email,
                password,
                serverUrl,
                displayName: name,
            });
        } catch {
            /* host callback */
        }
        this.emit(accountId, { kind: 'ConfigureProgress', progress: 1000, comment: 'Configured' });
        this.emit(accountId, { kind: 'TransportsModified' });
        this.emit(accountId, { kind: 'AccountsItemChanged' });
        this.emit(accountId, { kind: 'ChatlistChanged' });
    }

    private async getConfig(accountId: number, key: string): Promise<string | null> {
        const slot = this.slots.get(accountId);
        if (!slot) return null;
        if (key in slot.config) {
            const v = slot.config[key];
            // Never hand null for keys the UI treats as numeric strings
            if (v != null) return v;
        }
        if (slot.account) {
            if (key === 'addr' || key === 'configured_addr') return slot.account.getCredentials().email;
            if (key === 'displayname') {
                return slot.account.getDisplayName() || slot.config.displayname || '';
            }
            try {
                const v = await slot.account.getConfig(key);
                if (v != null && v !== '') return v;
            } catch {
                /* fall through to defaults */
            }
        }
        // Built-in defaults so Settings never sees null for known keys
        const defaults = defaultConfig();
        if (key in defaults && defaults[key] != null) return defaults[key];
        return slot.config[key] ?? null;
    }

    private async setConfig(accountId: number, key: string, value: string | null) {
        const slot = this.slot(accountId);
        slot.config[key] = value;
        if (slot.account) {
            if (key === 'displayname' && value) slot.account.setDisplayName(value);
            try {
                await slot.account.setConfig(key, value ?? '');
            } catch { /* ignore */ }
        }
        if (key === 'displayname' || key === 'selfavatar' || key === 'selfstatus') {
            this.emit(accountId, { kind: 'AccountsItemChanged' });
            this.emit(accountId, { kind: 'ContactsChanged', contactId: SELF_CONTACT_ID });
        }
    }

    // ── Contacts / chats / messages (core shapes) ───────────────────────────

    private async getContact(accountId: number, contactId: number) {
        const slot = this.slot(accountId);
        if (contactId === SELF_CONTACT_ID) return this.contactDto(slot, null, SELF_CONTACT_ID, { self: true });
        if (contactId === DEVICE_CONTACT_ID) return this.contactDto(slot, null, DEVICE_CONTACT_ID, { device: true });
        if (!slot.account) return this.contactDto(slot, null, contactId);
        const key = slot.maps.contactKey(contactId);
        const contacts = await slot.account.getContacts();
        const c = contacts.find(x => x.id === key || x.email === key) || null;
        return this.contactDto(slot, c, contactId);
    }

    private async getContactIds(accountId: number, listFlags?: number | null, query?: string | null) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return [];
        let contacts = await slot.account.getContacts();
        const q = (query || '').trim().toLowerCase();
        if (q) contacts = contacts.filter(c => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
        const ids = contacts.filter(c => !c.blocked).map(c => slot.maps.contactId(c.id));
        if (listFlags != null && (listFlags & DC_GCL_ADD_SELF) !== 0) ids.unshift(SELF_CONTACT_ID);
        return ids;
    }

    private async getContactsByIds(accountId: number, ids: number[]) {
        const out: Record<number, any> = {};
        for (const id of ids) out[id] = await this.getContact(accountId, id);
        return out;
    }

    private async getBlockedContacts(accountId: number) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return [];
        const blocked = await slot.account.getBlockedContacts();
        return blocked.map(c => this.contactDto(slot, c, slot.maps.contactId(c.id)));
    }

    private async createContact(accountId: number, addr: string, name: string | null) {
        const acc = this.requireAccount(accountId);
        const slot = this.slot(accountId);
        const email = addr.trim().toLowerCase();
        const existing = acc.findContactByEmail(email);
        if (existing) return slot.maps.contactId(existing.id);
        const contact = await acc.createContact({
            email,
            name: name?.trim() || email.split('@')[0],
            key: '',
        });
        this.emit(accountId, { kind: 'ContactsChanged', contactId: slot.maps.contactId(contact.id) });
        return slot.maps.contactId(contact.id);
    }

    private async createChatByContactId(accountId: number, contactId: number) {
        const acc = this.requireAccount(accountId);
        const slot = this.slot(accountId);
        if (contactId === DEVICE_CONTACT_ID) return slot.maps.chatId('device-chat');
        if (contactId === SELF_CONTACT_ID) {
            const email = acc.getCredentials().email;
            await acc.setDraft(email, { text: '' });
            await acc.removeDraft(email);
            return slot.maps.chatId(email);
        }
        const key = slot.maps.contactKey(contactId);
        const contacts = await acc.getContacts();
        const c = contacts.find(x => x.id === key) || contacts.find(x => slot.maps.contactId(x.id) === contactId);
        if (!c) throw new RpcError(`contact ${contactId} not found`);
        await acc.setDraft(c.email, { text: '' });
        await acc.removeDraft(c.email);
        const chatId = slot.maps.chatId(c.email);
        this.emit(accountId, { kind: 'ChatlistChanged' });
        return chatId;
    }

    /** Normalize chat lastMessageTime to milliseconds for consistent sort. */
    private async refreshChatPreview(slot: AccountSlot, chat: StoredChat): Promise<StoredChat> {
        if (!slot.account) return chat;
        let lastMsg: StoredMessage | null = null;
        if (chat.lastMessageId) {
            lastMsg = (await slot.account.store.getMessage(chat.lastMessageId)) || null;
        }
        if (!lastMsg) {
            const msgs = await slot.account.store.getChatMessages(chat.id, 500, 0);
            if (msgs.length) lastMsg = msgs[msgs.length - 1];
        }
        if (lastMsg) {
            const t = lastMsg.timestamp > 1e12 ? lastMsg.timestamp : lastMsg.timestamp * 1000;
            const text = (lastMsg.text || '').substring(0, 100);
            if (
                chat.lastMessageId !== lastMsg.id ||
                chat.lastMessage !== text ||
                chat.lastMessageTime !== t
            ) {
                chat.lastMessage = text;
                chat.lastMessageId = lastMsg.id;
                chat.lastMessageTime = t;
                try {
                    await slot.account.store.saveChat(chat);
                } catch {
                    /* ignore */
                }
            }
        } else if (chat.lastMessageTime && chat.lastMessageTime < 1e12) {
            // Legacy seconds → ms
            chat.lastMessageTime = chat.lastMessageTime * 1000;
            try {
                await slot.account.store.saveChat(chat);
            } catch {
                /* ignore */
            }
        }
        return chat;
    }

    private async getChatlistEntries(
        accountId: number,
        listFlags?: number | null,
        queryString?: string | null,
        _queryContactId?: number | null,
    ) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return [];
        let chats = await slot.account.getChatList();
        // Rehydrate previews so sort order matches real last activity (desktop parity)
        chats = await Promise.all(chats.map(c => this.refreshChatPreview(slot, c)));
        const flags = listFlags ?? 0;
        const archivedOnly = (flags & DC_GCL_ARCHIVED_ONLY) !== 0;
        const noSpecials = (flags & DC_GCL_NO_SPECIALS) !== 0;
        chats = archivedOnly ? chats.filter(c => c.archived) : chats.filter(c => !c.archived);
        const q = (queryString || '').trim().toLowerCase();
        if (q) {
            chats = chats.filter(
                c =>
                    c.name.toLowerCase().includes(q) ||
                    (c.lastMessage || '').toLowerCase().includes(q) ||
                    (c.peerEmail || '').toLowerCase().includes(q),
            );
        }
        chats.sort((a, b) => {
            if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
            return (b.lastMessageTime || 0) - (a.lastMessageTime || 0);
        });
        const ids = chats.map(c => slot.maps.chatId(c.id));
        if (!q && !archivedOnly && !noSpecials && (await slot.account.getChatList()).some(c => c.archived)) {
            ids.unshift(DC_CHAT_ID_ARCHIVED_LINK);
        }
        return ids;
    }

    private async getChatlistItem(accountId: number, chatId: number) {
        if (chatId === DC_CHAT_ID_ARCHIVED_LINK) {
            return { kind: 'ArchiveLink', freshMessageCounter: 0 };
        }
        const slot = this.slot(accountId);
        const basic = await this.basicChat(slot, chatId);
        const key = slot.maps.chatKey(chatId);
        let chat = key && slot.account ? await slot.account.getChat(key) : null;
        if (chat) chat = await this.refreshChatPreview(slot, chat);

        let lastMsg: StoredMessage | null = null;
        if (chat?.lastMessageId && slot.account) {
            lastMsg = (await slot.account.store.getMessage(chat.lastMessageId)) || null;
        }

        let summaryText2 = (chat?.lastMessage || lastMsg?.text || '').trim();
        let summaryText1 = '';
        let summaryStatus = DC_STATE_IN_SEEN;
        let lastMessageType = 'Text';
        let summaryPreviewImage: string | null = null;

        if (chat?.draft && (chat.draft.text || chat.draft.file)) {
            summaryText1 = 'Draft';
            summaryText2 = (chat.draft.text || summaryText2 || '').trim();
            summaryStatus = DC_STATE_OUT_DRAFT;
        } else if (lastMsg) {
            summaryStatus = this.msgStateToCore(lastMsg);
            lastMessageType = storeTypeToViewtype(lastMsg.type as any) || 'Text';
            if (!summaryText2) {
                switch (lastMsg.type) {
                    case 'image':
                    case 'sticker':
                    case 'gif':
                        summaryText2 = '🖼';
                        break;
                    case 'voice':
                    case 'audio':
                        summaryText2 = '🎤';
                        break;
                    case 'video':
                        summaryText2 = '🎥';
                        break;
                    case 'file':
                    case 'webxdc':
                        summaryText2 = lastMsg.media?.filename || '📎';
                        break;
                    case 'location':
                        summaryText2 = '📍';
                        break;
                    case 'call':
                        summaryText2 = '📞';
                        break;
                    default:
                        break;
                }
            }
            if (
                lastMsg.media?.data &&
                (lastMsg.type === 'image' || lastMsg.type === 'gif' || lastMsg.type === 'sticker')
            ) {
                const mime = lastMsg.media.mimeType || 'image/jpeg';
                const d = lastMsg.media.data;
                summaryPreviewImage =
                    d.startsWith('data:') || d.startsWith('blob:') ? d : `data:${mime};base64,${d}`;
            }
        } else if ((chat?.unreadCount ?? 0) > 0) {
            summaryStatus = DC_STATE_IN_FRESH;
        }

        const lastUpdatedMs = chat?.lastMessageTime
            ? chat.lastMessageTime > 1e12
                ? chat.lastMessageTime
                : chat.lastMessageTime * 1000
            : null;
        const isGroup = basic.chatType === 'Group' || basic.chatType === 'Broadcast';

        // Flat fields — same as desktop core / mock runtime ChatListItem
        return {
            kind: 'ChatListItem',
            id: chatId,
            name: basic.name,
            avatarPath: basic.profileImage ?? null,
            color: basic.color,
            chatType: basic.chatType,
            lastUpdated: lastUpdatedMs,
            summaryText1,
            summaryText2,
            summaryStatus,
            summaryPreviewImage,
            isEncrypted: basic.isEncrypted ?? true,
            isGroup,
            freshMessageCounter: chat?.unreadCount ?? 0,
            isSelfTalk: basic.isSelfTalk,
            isDeviceTalk: !!basic.isDeviceChat,
            isSendingLocation: false,
            isSelfInGroup: true,
            isArchived: !!basic.archived,
            isPinned: !!basic.pinned,
            isMuted: !!basic.isMuted,
            isContactRequest: !!basic.isContactRequest,
            dmChatContact: null,
            wasSeenRecently: true,
            lastMessageType,
            lastMessageId: chat?.lastMessageId ? slot.maps.msgId(chat.lastMessageId) : 0,
        };
    }

    private msgStateToCore(msg: StoredMessage): number {
        if (msg.direction === 'incoming') {
            return msg.state === 'seen' ? DC_STATE_IN_SEEN : DC_STATE_IN_FRESH;
        }
        switch (msg.state) {
            case 'pending':
                return DC_STATE_OUT_PENDING;
            case 'failed':
                return DC_STATE_OUT_FAILED;
            case 'seen':
                return DC_STATE_OUT_MDN_RCVD;
            default:
                return DC_STATE_OUT_DELIVERED;
        }
    }

    private async getFullChat(accountId: number, chatId: number) {
        const slot = this.slot(accountId);
        const basic = await this.basicChat(slot, chatId);
        const key = slot.maps.chatKey(chatId);
        const chat = key && slot.account ? await slot.account.getChat(key) : null;
        let contactIds: number[] = [];
        if (basic.isDeviceChat) contactIds = [DEVICE_CONTACT_ID];
        else if (chat?.isGroup && slot.account) {
            const group = slot.account.getGroup(chat.id);
            contactIds = [SELF_CONTACT_ID];
            if (group) {
                for (const email of group.members) {
                    const c = slot.account.findContactByEmail(email);
                    contactIds.push(c ? slot.maps.contactId(c.id) : slot.maps.contactId(email));
                }
            }
        } else if (chat?.peerEmail && slot.account) {
            const self = slot.account.getCredentials().email;
            if (chat.peerEmail === self) contactIds = [SELF_CONTACT_ID];
            else {
                const c = slot.account.findContactByEmail(chat.peerEmail);
                contactIds = [c ? slot.maps.contactId(c.id) : slot.maps.contactId(chat.peerEmail)];
            }
        }
        const contacts = await Promise.all(contactIds.map(id => this.getContact(accountId, id)));
        return {
            ...basic,
            contactIds,
            contacts,
            pastContactIds: [],
            selfInGroup: contactIds.includes(SELF_CONTACT_ID),
            canSend: !basic.isDeviceChat && !basic.isContactRequest,
            ephemeralTimer: chat?.ephemeralTimer ?? 0,
            mailingListAddress: null,
            wasSeenRecently: true,
            isProtected: false,
            isProtectionBroken: false,
            freshMessageCounter: chat?.unreadCount ?? 0,
        };
    }

    private async getMessageListItems(accountId: number, chatId: number, addDaymarker: boolean) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return [];
        const key = slot.maps.chatKey(chatId);
        if (!key) return [];
        const msgs = await slot.account.getChatMessages(key, 500, 0);
        // oldest → newest (desktop chat transcript order); normalize sec/ms
        const toMs = (t: number) => (t > 1e12 ? t : t * 1000);
        const sorted = [...msgs].sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp));
        const result: Array<{ kind: string; msg_id?: number; timestamp?: number }> = [];
        let lastDay = '';
        for (const m of sorted) {
            if (m.type === 'reaction' || m.type === 'delete') continue;
            if (addDaymarker) {
                const d = new Date(toMs(m.timestamp));
                const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                if (day !== lastDay) {
                    lastDay = day;
                    result.push({ kind: 'dayMarker', timestamp: tsSec(m.timestamp) });
                }
            }
            result.push({ kind: 'message', msg_id: slot.maps.msgId(m.id) });
        }
        return result;
    }

    private async getMessages(accountId: number, msgIds: number[]): Promise<Record<number, any>> {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return {};
        const out: Record<number, any> = {};
        for (const id of msgIds) {
            const key = slot.maps.msgKey(id);
            if (!key) {
                out[id] = { kind: 'loadingError', error: `unknown message ${id}` };
                continue;
            }
            try {
                const msg = await slot.account.store.getMessage(key);
                if (msg) out[id] = await this.messageDto(slot, msg);
                else out[id] = { kind: 'loadingError', error: `not found ${id}` };
            } catch (e: any) {
                out[id] = { kind: 'loadingError', error: e?.message || String(e) };
            }
        }
        return out;
    }

    private async sendMessage(accountId: number, chatId: number, params: any): Promise<number> {
        const acc = this.requireAccount(accountId);
        const slot = this.slot(accountId);
        const key = slot.maps.chatKey(chatId);
        if (!key) throw new RpcError(`unknown chat ${chatId}`);
        const text = typeof params?.text === 'string' ? params.text : params?.text == null ? '' : String(params.text);
        const filePath = params?.file ?? null;
        const fileName = params?.filename ?? params?.fileName ?? null;
        const viewType = params?.viewtype ?? params?.viewType ?? (filePath ? 'File' : 'Text');
        let sendOpts: any = { text };
        if (filePath && String(filePath).startsWith('data:')) {
            const m = String(filePath).match(/^data:([^;]+);base64,(.+)$/);
            if (m) {
                const payload = { data: m[2], filename: fileName || 'file', mimeType: m[1], caption: text || undefined };
                switch (String(viewType)) {
                    case 'Image': sendOpts = { image: payload }; break;
                    case 'Gif': sendOpts = { gif: payload }; break;
                    case 'Sticker': sendOpts = { sticker: payload }; break;
                    case 'Video': sendOpts = { video: payload }; break;
                    case 'Audio': sendOpts = { audio: payload }; break;
                    case 'Voice': sendOpts = { voice: { data: m[2], durationMs: 1000 } }; break;
                    default: sendOpts = { file: payload };
                }
            }
        }
        const chat = await acc.getChat(key);
        const target = chat?.isGroup || chat?.isBroadcast ? key : chat?.peerEmail || key;
        const result = await acc.send(target, sendOpts);
        if (!result || !('msgId' in result)) {
            throw new RpcError('send produced no message id');
        }
        const msgId = slot.maps.msgId(result.msgId);
        this.emit(accountId, { kind: 'MsgsChanged', chatId, msgId });
        this.emit(accountId, { kind: 'ChatlistItemChanged', chatId });
        return msgId;
    }

    private async deleteMessages(accountId: number, msgIds: number[]) {
        const acc = this.requireAccount(accountId);
        const slot = this.slot(accountId);
        for (const id of msgIds) {
            const key = slot.maps.msgKey(id);
            if (!key) continue;
            const msg = await acc.store.getMessage(key);
            if (!msg) continue;
            try {
                await acc.send(msg.chatId, { delete: { targetMessage: key } });
            } catch {
                await acc.deleteLocalMessage(key);
            }
            this.emit(accountId, { kind: 'MsgDeleted', chatId: slot.maps.chatId(msg.chatId), msgId: id });
        }
    }

    private async sendReaction(accountId: number, msgId: number, emojis: string[]) {
        const acc = this.requireAccount(accountId);
        const slot = this.slot(accountId);
        const key = slot.maps.msgKey(msgId);
        if (!key) return msgId;
        const msg = await acc.store.getMessage(key);
        if (!msg) return msgId;
        await acc.send(msg.chatId, { reaction: { targetMessage: key, reaction: emojis?.[0] || '' } });
        this.emit(accountId, { kind: 'ReactionsChanged', chatId: slot.maps.chatId(msg.chatId), msgId });
        return msgId;
    }

    private async searchMessages(accountId: number, query: string, chatId?: number | null) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return [];
        const key =
            chatId != null && chatId > DC_CHAT_ID_LAST_SPECIAL ? slot.maps.chatKey(chatId) : undefined;
        const msgs = await slot.account.searchMessages(query, key);
        return msgs.map(m => slot.maps.msgId(m.id));
    }

    private async messageIdsToSearchResults(accountId: number, msgIds: number[]) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return {};
        const out: Record<number, any> = {};
        for (const id of msgIds) {
            const key = slot.maps.msgKey(id);
            if (!key) continue;
            const msg = await slot.account.store.getMessage(key);
            if (!msg) continue;
            const chat = await slot.account.getChat(msg.chatId);
            out[id] = {
                id,
                chatId: slot.maps.chatId(msg.chatId),
                authorName: msg.direction === 'outgoing' ? 'Me' : chat?.name || msg.from.split('@')[0],
                authorId: msg.direction === 'outgoing' ? SELF_CONTACT_ID : slot.maps.contactId(
                    slot.account.findContactByEmail(msg.from)?.id || msg.from,
                ),
                summary: msg.text?.slice(0, 100) || '',
                timestamp: tsSec(msg.timestamp),
            };
        }
        return out;
    }

    private async getDraft(accountId: number, chatId: number) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return null;
        const key = slot.maps.chatKey(chatId);
        if (!key) return null;
        const draft = await slot.account.getDraft(key);
        if (!draft || (!draft.text && !draft.file)) return null;
        const file = draft.file ? `data:${draft.file.mimeType};base64,${draft.file.data}` : null;
        return {
            id: 0,
            chatId,
            fromId: SELF_CONTACT_ID,
            text: draft.text || '',
            viewType: file ? 'File' : 'Text',
            state: DC_STATE_OUT_DRAFT,
            file,
            fileMime: draft.file?.mimeType ?? null,
            fileName: draft.file?.filename ?? null,
            quote: null,
            isInfo: false,
            showPadlock: true,
            timestamp: tsSec(draft.updatedAt),
            sortTimestamp: tsSec(draft.updatedAt),
            sender: this.contactDto(slot, null, SELF_CONTACT_ID, { self: true }),
        };
    }

    private async setDraft(
        accountId: number,
        chatId: number,
        text: string | null,
        file: string | null,
        fileName: string | null,
        _quotedMessageId: number | null,
        _viewType: string | null,
    ) {
        const acc = this.requireAccount(accountId);
        const key = this.slot(accountId).maps.chatKey(chatId);
        if (!key) return;
        const normalized = text ?? '';
        if (!file && !normalized) {
            await acc.removeDraft(key);
            return;
        }
        let filePayload: any;
        if (file && file.startsWith('data:')) {
            const m = file.match(/^data:([^;]+);base64,(.+)$/);
            if (m) filePayload = { data: m[2], filename: fileName || 'file', mimeType: m[1] };
        }
        await acc.setDraft(key, { text: normalized, file: filePayload });
    }

    private getSecurejoinQr(accountId: number, chatId: number | null): string {
        const acc = this.requireAccount(accountId);
        if (!acc.getFingerprint()) throw new RpcError('No keys — finish configure first');
        if (chatId != null && chatId > 0) {
            const key = this.slot(accountId).maps.chatKey(chatId);
            const uri = acc.generateSecureJoinURI();
            if (key) {
                const group = acc.getGroup(key);
                if (group && !uri.includes('&x=')) {
                    return `${uri}&x=${encodeURIComponent(group.grpId)}&g=${encodeURIComponent(group.name)}`;
                }
            }
            return uri;
        }
        return acc.generateSecureJoinURI();
    }

    private async secureJoin(accountId: number, qr: string): Promise<number> {
        const acc = this.requireAccount(accountId);
        const slot = this.slot(accountId);
        const result = await acc.secureJoin(qr);
        const chatKey = result.groupInfo?.grpId || result.peerEmail;
        await acc.setDraft(chatKey, { text: '' });
        await acc.removeDraft(chatKey);
        const chatId = slot.maps.chatId(chatKey);
        this.emit(accountId, {
            kind: 'SecurejoinJoinerProgress',
            contactId: slot.maps.contactId(result.contactId),
            progress: 1000,
        });
        this.emit(accountId, { kind: 'ChatlistChanged' });
        this.emit(accountId, { kind: 'ContactsChanged', contactId: null });
        return chatId;
    }

    private async checkQr(accountId: number, raw: string): Promise<any> {
        const trimmed = raw.trim();
        const lower = trimmed.toLowerCase();
        const slot = this.slots.get(accountId);

        if (
            trimmed.includes('#') &&
            (trimmed.includes('&i=') || trimmed.includes('&s=') || trimmed.includes('&a=') ||
                /i\.delta\.chat/i.test(trimmed) || lower.startsWith('openpgp4fpr:'))
        ) {
            try {
                const uri = trimmed.replace(/^openpgp4fpr:/i, 'https://i.delta.chat/#');
                const p = parseSecureJoinURI(
                    uri.includes('://') ? uri : `https://i.delta.chat/${uri.startsWith('#') ? uri : '#' + uri}`,
                );
                let contactId = 0;
                if (slot?.account && p.inviterEmail) {
                    const existing = slot.account.findContactByEmail(p.inviterEmail);
                    contactId = existing
                        ? slot.maps.contactId(existing.id)
                        : slot.maps.contactId(p.inviterEmail);
                }
                if (p.broadcastName && p.groupId) {
                    return {
                        kind: 'askJoinBroadcast',
                        name: p.broadcastName,
                        grpid: p.groupId,
                        contact_id: contactId,
                        fingerprint: p.fingerprint,
                        invitenumber: p.inviteNumber,
                        authcode: p.auth,
                    };
                }
                if (p.groupId || p.groupName) {
                    return {
                        kind: 'askVerifyGroup',
                        grpname: p.groupName || 'Group',
                        grpid: p.groupId || '',
                        contact_id: contactId,
                        fingerprint: p.fingerprint,
                        invitenumber: p.inviteNumber,
                        authcode: p.auth,
                    };
                }
                return {
                    kind: 'askVerifyContact',
                    contact_id: contactId,
                    fingerprint: p.fingerprint,
                    invitenumber: p.inviteNumber,
                    authcode: p.auth,
                };
            } catch (e: any) {
                return { kind: 'error', error: e.message || 'Invalid invite' };
            }
        }
        if (lower.startsWith('dcaccount:')) {
            const body = trimmed.replace(/^dcaccount:/i, '');
            let domain = this.defaultServerUrl.replace(/^https?:\/\//, '');
            try {
                const u = new URL(/^https?:\/\//i.test(body) ? body : `https://${body}`);
                domain = u.host;
            } catch {
                domain = body.replace(/^https?:\/\//, '').split(/[/?#]/)[0];
            }
            return { kind: 'account', domain };
        }
        if (lower.startsWith('dclogin:')) {
            return { kind: 'login', address: trimmed.slice('dclogin:'.length).split('?')[0] };
        }
        if (lower.startsWith('dcbackup:') || lower.startsWith('dcbk:')) return { kind: 'backup2' };
        if (lower.startsWith('http://') || lower.startsWith('https://')) return { kind: 'url', url: trimmed };
        return { kind: 'text', text: trimmed };
    }

    private async addDeviceMessage(accountId: number, label: string, msgData: any): Promise<number | null> {
        const acc = this.slots.get(accountId)?.account;
        if (!acc) return null;
        const slot = this.slot(accountId);
        if (msgData == null) {
            await acc.addDeviceMessage(label || '', null);
            return null;
        }
        let content: string | null | {
            text?: string | null;
            type?: StoredMessage['type'];
            media?: StoredMessage['media'];
        };
        if (typeof msgData === 'string') {
            content = msgData;
        } else {
            const text = msgData?.text != null ? String(msgData.text) : '';
            const file = msgData?.file ?? msgData?.filePath ?? null;
            const viewtype = String(msgData?.viewtype || msgData?.viewType || '').toLowerCase();
            if (file) {
                content = {
                    text,
                    type: viewtype === 'image' || viewtype === 'gif' || viewtype === 'sticker'
                        ? (viewtype === 'gif' ? 'gif' : viewtype === 'sticker' ? 'sticker' : 'image')
                        : 'file',
                    media: {
                        filename: msgData?.filename || msgData?.fileName || 'file',
                        mimeType: msgData?.fileMime || (viewtype === 'image' ? 'image/jpeg' : 'application/octet-stream'),
                        data: String(file),
                    },
                };
            } else if (text) {
                content = text;
            } else {
                await acc.addDeviceMessage(label || '', null);
                return null;
            }
        }
        const result = (await acc.addDeviceMessage(label || 'label', content)) as
            | { msgId: string; message: StoredMessage }
            | null
            | undefined;
        if (!result?.msgId) return null;
        const chatId = slot.maps.chatId('device-chat');
        const id = slot.maps.msgId(result.msgId);
        this.emit(accountId, { kind: 'IncomingMsg', chatId, msgId: id });
        this.emit(accountId, { kind: 'MsgsChanged', chatId, msgId: id });
        this.emit(accountId, { kind: 'ChatlistChanged' });
        return id;
    }

    private async getFreshMsgs(accountId: number): Promise<number[]> {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return [];
        const chats = await slot.account.getChatList();
        const out: number[] = [];
        for (const chat of chats) {
            if (!chat.unreadCount) continue;
            const msgs = await slot.account.getChatMessages(chat.id, 50, 0);
            for (const m of msgs) {
                if (m.direction === 'incoming' && m.state !== 'seen') out.push(slot.maps.msgId(m.id));
            }
        }
        return out;
    }

    private async getChatMedia(accountId: number, chatId: number | null, viewTypes: Array<string | null>) {
        const slot = this.slots.get(accountId);
        if (!slot?.account) return [];
        const wanted = new Set(viewTypes.filter((v): v is string => typeof v === 'string' && v.length > 0));
        const chats =
            chatId == null
                ? await slot.account.getChatList()
                : [await slot.account.getChat(slot.maps.chatKey(chatId) || '')].filter(Boolean);
        const out: number[] = [];
        for (const chat of chats as StoredChat[]) {
            const msgs = await slot.account.getChatMessages(chat.id, 500, 0);
            for (const m of msgs) {
                const vt = storeTypeToViewtype(m.type as any);
                if (vt && wanted.has(vt)) out.push(slot.maps.msgId(m.id));
            }
        }
        return out;
    }
}

/** Factory helper */
export function createJsonRpcCompat(
    sdk?: IDeltaChatManager,
    options?: JsonRpcCompatOptions,
): DeltaChatJsonRpc {
    return new DeltaChatJsonRpc(sdk, options);
}
