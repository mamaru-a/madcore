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
 * Class hierarchy (account/):
 *   AccountBase → Contacts → Messaging → Groups → SecureJoin →
 *   Profile → Inbox → Features → DeltaChatAccount
 *
 * Supporting modules:
 *   - lib/transport.ts — WebSocket + REST API communication
 *   - lib/crypto.ts — PGP encryption, key gen, Autocrypt
 *   - lib/mime.ts — MIME parsing, decryption, attachments
 *   - lib/messaging.ts — Outbound message builders
 *   - lib/securejoin.ts — SecureJoin protocol
 *   - lib/profile.ts — Avatar & display name helpers
 *   - types.ts — Public type definitions
 *   - store.ts — Persistence backends
 */

import { getFingerprintFromArmored } from './lib/crypto.js';

// ─── Core API ───────────────────────────────────────────────────────────────────

export { DeltaChatSDK, type IDeltaChatManager } from './account/manager.js';
export { DeltaChatAccount } from './account/account.js';

// ─── Class layers (for extension / advanced use) ────────────────────────────────

export {
    AccountBase,
    AccountContacts,
    AccountMessaging,
    AccountGroups,
    AccountSecureJoin,
    AccountProfile,
    AccountInbox,
    AccountFeatures,
} from './account/index.js';

// ─── Logging ────────────────────────────────────────────────────────────────────

export { log, setLogLevel, getLogLevel } from './lib/logger.js';
export type { LogLevel } from './lib/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

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
    Connectivity,
} from './types.js';
export { ALL_DC_EVENTS, ALL_WS_ACTIONS } from './types.js';

export type { GroupInfo } from './lib/group.js';
export type {
    StoredContact,
    StoredMessage,
    StoredChat,
    StoredAccount,
    StoredGroup,
    ChatDraft,
    IDeltaChatStore,
    PersistedAccountMeta,
} from './store.js';
export {
    MemoryStore,
    IndexedDBStore,
    createStore,
} from './store.js';
export {
    viewtypeToStoreType,
    storeTypeToViewtype,
    storeTypeFromMime,
} from './lib/viewtype.js';
export type { MessageStoreType } from './lib/viewtype.js';
export type { QrScanResult, QrKind } from './lib/securejoin.js';export { checkQr, parseSecureJoinURI, generateSecureJoinURI } from './lib/securejoin.js';

export { getFingerprintFromArmored };

// ─── JSON-RPC compatibility (core wire API) ─────────────────────────────────────

export {
    DeltaChatJsonRpc,
    createJsonRpcCompat,
    ALL_JSONRPC_METHODS,
    IMPLEMENTED_JSONRPC_METHODS,
    STUB_JSONRPC_METHODS,
    isJsonRpcMethod,
    methodCoverage,
    RpcError,
    RpcNotImplemented,
} from './jsonrpc/index.js';
export type {
    JsonRpcCompatOptions,
    JsonRpcMethodName,
    JsonRpcEvent,
    JsonRpcEventHandler,
} from './jsonrpc/index.js';
