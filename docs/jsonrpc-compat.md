# JSON-RPC compatibility layer

Madcore is a **web-native** chatmail client. Desktop / web UIs talk to **Delta Chat core** through JSON-RPC (`@deltachat/jsonrpc-client`).

This package exposes a **compatibility facade** so the same method names, parameter order, and (as far as possible) return shapes work on madcore.

## Location

```
madcore/jsonrpc/
  methods.ts   # ALL_JSONRPC_METHODS (178 wire names from core)
  compat.ts    # DeltaChatJsonRpc — handleRpc(method, params[])
  id-map.ts    # string keys ↔ numeric u32 ids
  types.ts     # connectivity / message state constants
  errors.ts    # RpcNotImplemented, RpcError
  index.ts     # public exports
```

Import:

```ts
import { DeltaChatSDK, createJsonRpcCompat, methodCoverage } from 'madcore';
// or
import { DeltaChatJsonRpc } from 'madcore/jsonrpc';
```

## Usage

```ts
const sdk = DeltaChatSDK({ logLevel: 'info' });
const rpc = createJsonRpcCompat(sdk, {
  defaultServerUrl: 'https://relay.example',
  onEvent: (accountId, event) => {
    // Desktop DcEvent shape: { kind: 'IncomingMsg', chatId, msgId, ... }
  },
  softStubs: true, // default: unimplemented → null/[] instead of throw
});

const accountId = await rpc.handleRpc('add_account', []);
await rpc.handleRpc('add_transport_from_qr', [
  accountId,
  'dcaccount:https://relay.example',
]);
await rpc.handleRpc('start_io', [accountId]);
const chats = await rpc.handleRpc('get_chatlist_entries', [accountId, 0, null, null]);
```

Wire names are **snake_case** (same as Rust `#[rpc]` / `request('send_msg', …)`).

## Source of truth for the method list

| Source | Path |
|--------|------|
| Core Rust API | `context/core/deltachat-jsonrpc/src/api.rs` (`#[rpc]`) |
| Published TS client | `@deltachat/jsonrpc-client` `generated/client` |

Union ≈ **178** methods (helpers like `get_context` excluded).

## Coverage

```ts
methodCoverage();
// { total: 178, implemented: ~144, stub: ~34 }
```

| Bucket | Meaning |
|--------|---------|
| **implemented** | Dispatches to madcore (accounts, chats, messages, drafts, QR/SecureJoin, basic webxdc/location/calls, …) |
| **stub** | Present for API surface; returns `null` / `[]` / `0` / `false` when `softStubs: true` |

Strict mode:

```ts
createJsonRpcCompat(sdk, { softStubs: false });
// throws RpcNotImplemented for stubs
```

### Stub examples (not fully backed yet)

`configure` (legacy IMAP form), `migrate_account`, vcard parse/import/make, multi-device backup QR, many webxdc realtime RPCs, `get_push_state`, `get_provider_info`, `wait_next_msgs`, …

See also project docs: `docs/madcore-missing.md`.

## Design notes

1. **IDs** — Core uses `u32`; madcore uses emails / Message-IDs. `IdMap` assigns stable-per-session numbers.
2. **Events** — Core event loop uses `get_next_event_batch` (blocked forever here). Hosts should use `onEvent` push style (same as madweb).
3. **Bodies** — Prefer madcore APIs (`account.send`, `secureJoin`, IndexedDB store). Do not reimplement crypto in the facade.
4. **Return shapes** — Match core enough for UI (e.g. `get_messages` → `MessageLoadResult` with `kind: 'message'`; `get_chat_securejoin_qr_code_svg` → `[qr, svg]`).

## Regenerating the method list

When core gains RPCs:

1. Pull latest `context/core`.
2. Re-extract methods from `api.rs` + published client.
3. Update `jsonrpc/methods.ts`.
4. Implement or leave as stub in `compat.ts` `dispatch()`.
5. Update this doc + coverage counts.
6. **Also update madweb `docs/madcore-missing.md`** (stub table + “last inventory” line) — that is the human-facing gap list for the monorepo.

## Relation to madweb

Madweb’s `src/madcore-backend.ts` is an app-level bridge. Prefer migrating it to:

```ts
import { createJsonRpcCompat } from 'madcore/jsonrpc';
```

so one compatibility layer lives in madcore (this package).
