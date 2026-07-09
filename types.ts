/**
 * @module madcore-web/types
 *
 * Type definitions for the Delta Chat Web SDK.
 * All types, interfaces, and event definitions used across the SDK.
 *
 * @example
 * ```ts
 * import type { ParsedMessage, DCEvent, Credentials } from './types';
 * ```
 */

import type { IDeltaChatStore, StoredChat, StoredMessage, StoredContact } from './store';

// ─── SDK Configuration ──────────────────────────────────────────────────────────

/**
 * Configuration for the multi-account SDK factory.
 *
 * @example
 * ```ts
 * const dc = DeltaChatSDK({ logLevel: 'debug' });
 * ```
 */
export interface SDKConfig {
    /** Log level for the SDK (default: 'info') */
    logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'none';
    /** Custom store implementation (default: MemoryStore — pass IndexedDBStore for browser persistence) */
    store?: IDeltaChatStore;
}

// ─── Authentication ─────────────────────────────────────────────────────────────

/**
 * Message viewtype, matching core's `Viewtype` enum.
 *
 * | Viewtype | Description |
 * |----------|-------------|
 * | `Text` | Plain text message |
 * | `Image` | Image message (JPEG, PNG, WEBP) |
 * | `Gif` | Animated GIF |
 * | `Audio` | Audio file (MP3, M4A, FLAC, OGG) |
 * | `Voice` | Voice message recorded by user |
 * | `Video` | Video file (MP4, MOV, 3GP) |
 * | `File` | Any file attachment (PDF, DOC, etc.) |
 * | `Sticker` | Sticker image |
 */
export type Viewtype = 'Text' | 'Image' | 'Gif' | 'Audio' | 'Voice' | 'Video' | 'File' | 'Sticker' | 'Webxdc';

/** Connectivity enum inspired by core's dc_get_connectivity */
export type Connectivity =
    | 'not_connected'
    | 'connecting'
    | 'working'
    | 'connected';

/**
 * Credentials returned by the server after registration.
 *
 * @example
 * ```ts
 * const creds: Credentials = { email: 'abc123@relay.example', password: 'secret' };
 * ```
 */
export interface Credentials {
    /** Full email address (e.g. `abc123@relay.example`) */
    email: string;
    /** Machine-generated password for authentication */
    password: string;
}

/**
 * Result returned by `dc.register()` — includes the account handle.
 *
 * @example
 * ```ts
 * const { account, id, email } = await dc.register('https://relay.example', 'Alice');
 * await account.connect();
 * ```
 */
export interface RegisterResult extends Credentials {
    /** Random unique ID for this account */
    id: string;
    /** The DeltaChatAccount instance (ready to use) */
    account: any;
}

/**
 * Summary of a registered account (from `dc.listAccounts()`).
 */
export interface AccountInfo {
    /** Random unique ID */
    id: string;
    /** Account email address */
    email: string;
}

/**
 * Connection status of a single transport.
 */
export interface TransportStatus {
    /** Server URL this transport is connected to */
    serverUrl: string;
    /** WebSocket state: 'disconnected' | 'connecting' | 'connected' */
    state: 'disconnected' | 'connecting' | 'connected';
    /** Whether the WebSocket is currently open */
    isConnected: boolean;
}

/**
 * A relay identity — one account can have multiple relays,
 * each with its own email/password/server.
 *
 * @example
 * ```ts
 * const relay = acc.addRelay('https://relay2.example');
 * console.log(relay.id);       // 'r1a2b3c4d5e6'
 * console.log(relay.email);    // 'xyz@relay2.example'
 * console.log(relay.serverUrl);// 'https://relay2.example'
 * ```
 */
export interface RelayInfo {
    /** Random relay ID */
    id: string;
    /** Server URL */
    serverUrl: string;
    /** Email address on this relay */
    email: string;
    /** Password for this relay */
    password: string;
    /** Whether the WebSocket transport is connected */
    isConnected: boolean;
    /** Transport state */
    state: 'disconnected' | 'connecting' | 'connected';
}

/**
 * Full account status returned by `acc.status()`.
 *
 * @example
 * ```ts
 * const s = acc.status();
 * console.log(s.id);            // 'a1b2c3d4e5f6'
 * console.log(s.email);         // primary relay email
 * console.log(s.relays);        // [{ id, serverUrl, email, isConnected, ... }]
 * console.log(s.isConnected);   // true if any relay is connected
 * ```
 */
export interface AccountStatus {
    /** Random account ID */
    id: string;
    /** Primary relay email address */
    email: string;
    /** Display name (may be empty if not set) */
    displayName: string;
    /** PGP fingerprint (empty if keys not generated) */
    fingerprint: string;
    /** Whether PGP keys have been generated */
    hasKeys: boolean;
    /** Number of known contact public keys */
    knownContacts: number;
    /** All relays and their connection states */
    relays: RelayInfo[];
    /** True if at least one relay is connected */
    isConnected: boolean;
}

// ─── Raw Messages ───────────────────────────────────────────────────────────────

/**
 * Raw message from the server before parsing/decryption.
 * Returned by `fetchMessages()` / `fetchMessage()` / WS `fetch` action.
 */
export interface IncomingMessage {
    /** IMAP UID of the message */
    uid: number;
    /** Raw RFC 5322 message body (headers + MIME) */
    body: string;
    /** Optional IMAP envelope data */
    envelope?: any;
}

// ─── Attachments ────────────────────────────────────────────────────────────────

/**
 * A file attachment extracted from a multipart MIME message.
 *
 * @example
 * ```ts
 * if (msg.attachments.length > 0) {
 *   const file = msg.attachments[0];
 *   console.log(`${file.filename} (${file.mimeType}, ${file.size} bytes)`);
 * }
 * ```
 */
export interface Attachment {
    /** Original filename (e.g. `photo.jpg`, `document.pdf`) */
    filename: string;
    /** MIME type (e.g. `image/png`, `application/pdf`) */
    mimeType: string;
    /** Base64-encoded file content */
    base64Data: string;
    /** Approximate size in bytes (decoded) */
    size: number;
}

// ─── Parsed Messages ────────────────────────────────────────────────────────────

/**
 * A fully parsed and (optionally) decrypted incoming message.
 *
 * This is the main message type returned by the SDK's event handlers.
 * It includes the decrypted text, metadata, and any extracted attachments.
 *
 * @example
 * ```ts
 * sdk.on('DC_EVENT_INCOMING_MSG', (e) => {
 *   const msg: ParsedMessage = e.msg!;
 *   console.log(`From: ${msg.from}, Encrypted: ${msg.encrypted}`);
 *   console.log(`Text: ${msg.text}`);
 *   if (msg.isVoiceMessage) console.log(`Voice: ${msg.voiceDurationMs}ms`);
 *   if (msg.attachments.length) console.log(`${msg.attachments.length} file(s)`);
 * });
 * ```
 */
export interface ParsedMessage {
    /** IMAP UID of the message */
    uid: number;

    /** RFC 724 Message-ID (e.g. `<abc123@relay.example>`) or null */
    rfc724mid: string | null;

    /** Sender email address (lowercase) */
    from: string;

    /** Recipient email address (lowercase) */
    to: string;

    /** Decrypted/extracted text body of the message */
    text: string;

    /** Whether the message was PGP/MIME encrypted */
    encrypted: boolean;

    /** Original message timestamp (from Date header) in ms */
    timestamp: number;

    /** Outer (unencrypted) MIME headers */
    headers: Record<string, string>;

    /** Inner (decrypted) MIME headers — only present if message was encrypted */
    innerHeaders: Record<string, string>;

    /**
     * `true` if this message is a reaction (emoji response to another message).
     * The reaction emoji is in `text`. The target message is referenced in headers.
     */
    isReaction: boolean;

    /**
     * `true` if this message is a delete request for another message.
     * The Message-ID of the message to delete is in `text`.
     */
    isDelete: boolean;

    /**
     * `true` if this message is part of the SecureJoin handshake.
     * See `secureJoinStep` for the specific phase.
     */
    isSecureJoin: boolean;

    /**
     * `true` if this message is a voice message (has `Chat-Voice-Message: 1` header).
     */
    isVoiceMessage: boolean;

    /**
     * SecureJoin step identifier (e.g. `vc-request`, `vc-auth-required`,
     * `vg-request-with-auth`, `vc-contact-confirm`).
     * Only present when `isSecureJoin` is `true`.
     */
    secureJoinStep?: string;

    /** SecureJoin invite number (from `Secure-Join-Invitenumber` header) */
    secureJoinInviteNumber?: string;

    /** SecureJoin auth token (from `Secure-Join-Auth` header) */
    secureJoinAuth?: string;

    /**
     * Profile photo (avatar) update:
     * - `string`: Base64 data URI of the new avatar image
     * - `null`: Avatar was removed
     * - `undefined`: No avatar change in this message
     */
    avatarUpdate?: string | null;

    /**
     * File attachments extracted from multipart MIME.
     * Empty array if no attachments.
     */
    attachments: Attachment[];

    /**
     * Duration in milliseconds for voice messages.
     * Only present when `isVoiceMessage` is `true` and the sender included duration.
     */
    voiceDurationMs?: number;

    /**
     * Group ID from the `Chat-Group-ID` header.
     * Present when the message belongs to a group chat.
     * `undefined` for 1:1 messages.
     */
    groupId?: string;

    /**
     * Group name from the `Chat-Group-Name` header.
     * Present when the message belongs to a group or broadcast.
     */
    groupName?: string;
    /** Group description (mostly for channels) */
    groupDescription?: string;
    /** Whether this is a broadcast group */
    isBroadcast?: boolean;
    /** Shared secret for broadcast channel */
    broadcastSecret?: string;


    /**
     * `true` if this is a message edit (has `Chat-Edit` header).
     * The `editTargetMsgId` contains the original Message-ID.
     */
    isEdit: boolean;

    /**
     * `true` if this is a read-receipt / disposition notification.
     * Not shown as a chat bubble; updates the original message's seen state.
     */
    isReadReceipt?: boolean;

    /**
     * Original Message-ID this read receipt refers to.
     * Only set when `isReadReceipt` is true.
     */
    readReceiptFor?: string;

    /**
     * Ephemeral timer in seconds from `Chat-Ephemeral-Timer` (present when timer changes).
     */
    ephemeralTimer?: number;

    /**
     * Group avatar update:
     * - data URI string when set
     * - null when removed
     * - undefined when not an avatar message
     */
    groupAvatarUpdate?: string | null;

    /**
     * `true` if this is a sticker (`Chat-Content: sticker`).
     */
    isSticker?: boolean;

    /**
     * `true` if this is a GIF (`Chat-Content: gif` or image/gif attachment).
     */
    isGif?: boolean;

    /** Webxdc app instance attachment */
    isWebxdc?: boolean;
    /** Webxdc status update (not a new instance) */
    isWebxdcStatus?: boolean;
    /** Location point or stream control */
    isLocation?: boolean;
    /** Call signaling message */
    isCall?: boolean;

    /**
     * Best-effort viewtype for UI (Text/Image/Gif/Sticker/…).
     * Control messages may omit this.
     */
    viewtype?: Viewtype;

    /**
     * The Message-ID being edited (from `Chat-Edit` header).
     * Only present when `isEdit` is `true`.
     */
    editTargetMsgId?: string;

    /**
     * Email address of a member added to the group (from `Chat-Group-Member-Added` header).
     * Present when a new member joins the group.
     */
    memberAdded?: string;

    /**
     * Email address of a member removed from the group (from `Chat-Group-Member-Removed` header).
     * Present when a member is removed or leaves the group.
     */
    memberRemoved?: string;
}

// ─── Events ─────────────────────────────────────────────────────────────────────

/**
 * Delta Chat event types, following the core library naming convention.
 *
 * | Event | Description |
 * |-------|-------------|
 * | `DC_EVENT_INCOMING_MSG` | New message received and decrypted |
 * | `DC_EVENT_INCOMING_REACTION` | Emoji reaction received |
 * | `DC_EVENT_MSG_DELETED` | Message delete request received |
 * | `DC_EVENT_MSG_READ` | Peer read receipt for an outgoing message |
 * | `DC_EVENT_MSGS_CHANGED` | Messages in a chat changed |
 * | `DC_EVENT_SECUREJOIN_INVITER_PROGRESS` | SecureJoin progress (inviter side) |
 * | `DC_EVENT_SECUREJOIN_JOINER_PROGRESS` | SecureJoin progress (joiner side) |
 * | `DC_EVENT_SELFAVATAR_CHANGED` | Own avatar changed |
 * | `DC_EVENT_CONTACTS_CHANGED` | Contact info updated (name, avatar) |
 * | `DC_EVENT_REACTIONS_CHANGED` | Reactions on a message changed |
 * | `DC_EVENT_WEBXDC_STATUS_UPDATE` | Webxdc status update received |
 * | `DC_EVENT_LOCATION_CHANGED` | Location point or stream update |
 * | `DC_EVENT_INCOMING_CALL` | Incoming call signal |
 * | `DC_EVENT_CALL_ENDED` | Call ended |
 * | `DC_EVENT_CONNECTIVITY_CHANGED` | WebSocket connected/disconnected |
 * | `DC_EVENT_INFO` | Informational log message |
 * | `DC_EVENT_WARNING` | Warning log message |
 * | `DC_EVENT_ERROR` | Error log message |
 */
export type DCEvent =
    | 'DC_EVENT_INCOMING_MSG'
    | 'DC_EVENT_INCOMING_REACTION'
    | 'DC_EVENT_MSG_DELETED'
    | 'DC_EVENT_MSG_READ'
    | 'DC_EVENT_MSGS_CHANGED'
    | 'DC_EVENT_SECUREJOIN_INVITER_PROGRESS'
    | 'DC_EVENT_SECUREJOIN_JOINER_PROGRESS'
    | 'DC_EVENT_SELFAVATAR_CHANGED'
    | 'DC_EVENT_CONTACTS_CHANGED'
    | 'DC_EVENT_REACTIONS_CHANGED'
    | 'DC_EVENT_WEBXDC_STATUS_UPDATE'
    | 'DC_EVENT_LOCATION_CHANGED'
    | 'DC_EVENT_INCOMING_CALL'
    | 'DC_EVENT_CALL_ENDED'
    | 'DC_EVENT_CONNECTIVITY_CHANGED'
    | 'DC_EVENT_INFO'
    | 'DC_EVENT_WARNING'
    | 'DC_EVENT_ERROR';

/** Exhaustive list of SDK events (keep in sync with `DCEvent`) */
export const ALL_DC_EVENTS: readonly DCEvent[] = [
    'DC_EVENT_INCOMING_MSG',
    'DC_EVENT_INCOMING_REACTION',
    'DC_EVENT_MSG_DELETED',
    'DC_EVENT_MSG_READ',
    'DC_EVENT_MSGS_CHANGED',
    'DC_EVENT_SECUREJOIN_INVITER_PROGRESS',
    'DC_EVENT_SECUREJOIN_JOINER_PROGRESS',
    'DC_EVENT_SELFAVATAR_CHANGED',
    'DC_EVENT_CONTACTS_CHANGED',
    'DC_EVENT_REACTIONS_CHANGED',
    'DC_EVENT_WEBXDC_STATUS_UPDATE',
    'DC_EVENT_LOCATION_CHANGED',
    'DC_EVENT_INCOMING_CALL',
    'DC_EVENT_CALL_ENDED',
    'DC_EVENT_CONNECTIVITY_CHANGED',
    'DC_EVENT_INFO',
    'DC_EVENT_WARNING',
    'DC_EVENT_ERROR',
] as const;

/**
 * Data payload for SDK events.
 *
 * @example
 * ```ts
 * sdk.on('DC_EVENT_INCOMING_MSG', (data: DCEventData) => {
 *   console.log(data.event);  // 'DC_EVENT_INCOMING_MSG'
 *   console.log(data.msg);    // ParsedMessage
 *   console.log(data.msgId);  // '<abc123@relay.example>'
 * });
 * ```
 */
export interface DCEventData {
    /** The event type that triggered this callback */
    event: DCEvent;
    /** The parsed message associated with this event (if applicable) */
    msg?: ParsedMessage;
    /** The stored message associated with this event (if applicable) */
    message?: StoredMessage;
    /** Chat ID (for chat-level events) */
    chatId?: string;
    /** Message ID (RFC 724 format, e.g. `<abc@example>`) */
    msgId?: string;
    /** Contact email (for contact-level events) */
    contactId?: string;
    /** Primary event data (varies by event type) */
    data1?: any;
    /** Secondary event data (varies by event type) */
    data2?: any;
}

// ─── SecureJoin ─────────────────────────────────────────────────────────────────

/**
 * Parsed components of a SecureJoin invite URI.
 *
 * @example
 * ```ts
 * const parsed = sdk.parseSecureJoinURI('https://i.delta.chat/#...');
 * console.log(parsed.inviterEmail);  // 'alice@relay.example'
 * console.log(parsed.fingerprint);   // '89EDF8188BA275C5...'
 * ```
 */
export interface SecureJoinParsed {
    /** Email address of the inviter */
    inviterEmail: string;
    /** PGP fingerprint of the inviter's public key */
    fingerprint: string;
    /** Invite number for correlating the handshake */
    inviteNumber: string;
    /** Auth token for verifying the handshake */
    auth: string;
    /** Display name of the inviter (if provided) */
    name?: string;
    /** Group description (for channels) */
    description?: string;
    /** Member emails (including self) */
    members?: string[]; // Made optional as it might not always be present in URI
    /** 'group' or 'broadcast' */
    type?: 'group' | 'broadcast'; // Made optional as it might not always be present in URI
    /** Shared secret for broadcast channels (random string) */
    broadcastSecret?: string;
    /** Whether it's a broadcast channel */
    isBroadcast?: boolean;
    /** Group name (for group invites, from `g=` param) */
    groupName?: string;
    /** Group ID (from `x=` param, present for both group and broadcast invites) */
    groupId?: string;
    /** Broadcast channel name (from `b=` param, present for broadcast invites) */
    broadcastName?: string;
}

/**
 * Result of a completed SecureJoin handshake.
 */
export interface SecureJoinResult {
    /** Email address of the peer we joined */
    peerEmail: string;
    /** `true` if the peer's key was fully verified */
    verified: boolean;
}

// ─── WebSocket Protocol ─────────────────────────────────────────────────────────

/**
 * WebSocket request sent from client to server.
 * Part of the bidirectional WebSocket JSON protocol.
 *
 * @example
 * ```ts
 * // Sent automatically by sdk.wsRequest()
 * { req_id: "1", action: "list_mailboxes", data: {} }
 * ```
 */
export interface WSRequest {
    /** Unique request ID for response correlation */
    req_id: string;
    /** Action to perform on the server */
    action: WSAction;
    /** Action-specific payload */
    data: Record<string, any>;
}

/**
 * Available WebSocket actions for the bidirectional protocol.
 *
 * | Action | Description |
 * |--------|-------------|
 * | `send` | Send an email via the relay |
 * | `fetch` | Fetch a single message by UID |
 * | `list_mailboxes` | List all mailboxes with message counts |
 * | `list_messages` | List message summaries in a mailbox |
 * | `flags` | Add/remove/set IMAP flags on a message |
 * | `delete` | Delete a message by UID |
 * | `move` | Move a message to another mailbox |
 * | `copy` | Copy a message to another mailbox |
 * | `search` | Search messages by envelope fields |
 * | `create_mailbox` | Create a new IMAP mailbox |
 * | `delete_mailbox` | Delete an IMAP mailbox |
 * | `rename_mailbox` | Rename an IMAP mailbox |
 */
export type WSAction =
    | 'send'
    | 'fetch'
    | 'list_mailboxes'
    | 'list_messages'
    | 'flags'
    | 'delete'
    | 'move'
    | 'copy'
    | 'search'
    | 'create_mailbox'
    | 'delete_mailbox'
    | 'rename_mailbox';

/** Exhaustive list of relay WebSocket actions (keep in sync with `WSAction`) */
export const ALL_WS_ACTIONS: readonly WSAction[] = [
    'send',
    'fetch',
    'list_mailboxes',
    'list_messages',
    'flags',
    'delete',
    'move',
    'copy',
    'search',
    'create_mailbox',
    'delete_mailbox',
    'rename_mailbox',
] as const;

/**
 * Mailbox information returned by `list_mailboxes`.
 */
export interface MailboxInfo {
    /** Mailbox name (e.g. `INBOX`, `Sent`, `Archive`) */
    name: string;
    /** Total number of messages */
    messages: number;
    /** Number of unseen messages */
    unseen: number;
}

/**
 * Message summary returned by `list_messages` (without full body).
 */
export interface MessageSummary {
    /** IMAP UID */
    uid: number;
    /** IMAP envelope data */
    envelope: any;
    /** IMAP flags (e.g. `['\\Seen', '\\Flagged']`) */
    flags: string[];
}

/**
 * Full message detail returned by `fetch`.
 */
export interface MessageDetail {
    /** IMAP UID */
    uid: number;
    /** Raw RFC 5322 message body */
    body: string;
    /** IMAP envelope data */
    envelope: any;
}

// ─── Flag Operations ────────────────────────────────────────────────────────────

/**
 * IMAP flag operation type for the `flags` WS action.
 *
 * - `add`: Add flags without removing existing ones
 * - `remove`: Remove specific flags
 * - `set`: Replace all flags with the specified set
 */
export type FlagOperation = 'add' | 'remove' | 'set';

// ─── Admin Resources ──────────────────────────────────────────────────────────

export interface AdminPushStatus {
  enabled: boolean;
  mode?: string;
  successful_notifications?: number;
  failed_notifications?: number;
  last_error?: string | null;
  [key: string]: any;
}

export interface AdminStatusResponse {
  imap_sessions?: Array<any> | number;
  push?: AdminPushStatus;
  [key: string]: any;
}

export interface AdminOverviewResponse {
  disk?: {
    used_bytes?: number;
    total_bytes?: number;
    free_bytes?: number;
    [key: string]: any;
  };
  registration_tokens?: Array<any>;
  settings?: Record<string, any>;
  [key: string]: any;
}
