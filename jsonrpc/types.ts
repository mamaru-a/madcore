/**
 * Minimal type aliases matching Delta Chat JSON-RPC shapes.
 * Full types live in @deltachat/jsonrpc-client; this keeps madcore free of that dep.
 */

export type U32 = number;
export type I64 = number;
export type F64 = number;

/** Core connectivity levels (dc_get_connectivity) */
export const DC_CONNECTIVITY_NOT_CONNECTED = 1000;
export const DC_CONNECTIVITY_CONNECTING = 2000;
export const DC_CONNECTIVITY_WORKING = 3000;
export const DC_CONNECTIVITY_CONNECTED = 4000;

export const DC_STATE_IN_FRESH = 10;
export const DC_STATE_IN_NOTICED = 13;
export const DC_STATE_IN_SEEN = 16;
export const DC_STATE_OUT_PENDING = 20;
export const DC_STATE_OUT_FAILED = 24;
export const DC_STATE_OUT_DELIVERED = 26;
export const DC_STATE_OUT_MDN_RCVD = 28;
export const DC_STATE_OUT_DRAFT = 19;

export const DC_CHAT_ID_LAST_SPECIAL = 9;
export const DC_CHAT_ID_ARCHIVED_LINK = 6;
export const DC_GCL_ARCHIVED_ONLY = 1;
export const DC_GCL_NO_SPECIALS = 2;
export const DC_GCL_ADD_SELF = 2;
export const DC_GCL_FOR_FORWARDING = 8;

export type AccountInfo =
    | { id: U32; kind: 'Unconfigured' }
    | {
          id: U32;
          kind: 'Configured';
          addr: string | null;
          displayName: string | null;
          profileImage: string | null;
          color: string;
          privateTag: string | null;
          eventEmitterId?: U32;
          isMuted?: boolean;
          wasSeenRecently?: boolean;
      };

/** Emitted to the host when madcore produces a DC event (desktop shape). */
export type JsonRpcEvent = {
    kind: string;
    [key: string]: unknown;
};

export type JsonRpcEventHandler = (accountId: number, event: JsonRpcEvent) => void;
