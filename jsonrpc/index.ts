/**
 * madcore JSON-RPC compatibility layer
 *
 * Mirrors Delta Chat core's JSON-RPC API surface so desktop/web UIs that call
 * `BackendRemote.rpc.*` / snake_case wire methods can sit on madcore.
 */

export {
    DeltaChatJsonRpc,
    createJsonRpcCompat,
    type JsonRpcCompatOptions,
    type AccountInfo,
    type JsonRpcEvent,
    type JsonRpcEventHandler,
} from './compat.js';

export {
    ALL_JSONRPC_METHODS,
    IMPLEMENTED_JSONRPC_METHODS,
    STUB_JSONRPC_METHODS,
    isJsonRpcMethod,
    methodCoverage,
    type JsonRpcMethodName,
} from './methods.js';

export { RpcError, RpcNotImplemented } from './errors.js';
export {
    IdMap,
    SELF_CONTACT_ID,
    DEVICE_CONTACT_ID,
    INFO_CONTACT_ID,
} from './id-map.js';
export * from './types.js';
