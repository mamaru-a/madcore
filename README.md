# Madcore

**Madcore** (`madcore`) is a high-level library for building Delta Chat-compatible messengers in web environments. It runs on the Delta Chat Relay protocol (JSON-RPC over WebSocket) and provides multi-account, PGP-first messaging with browser persistence.

---

## Installation

```bash
npm install madcore
# or
bun add madcore
```

From source:

```bash
bun install
bun run build
```

### Package entry points

| Import | Purpose |
|--------|---------|
| `madcore` | `DeltaChatSDK`, `DeltaChatAccount`, store helpers, types, JSON-RPC compat |
| `madcore/store` | `MemoryStore`, `IndexedDBStore`, `createStore()` |
| `madcore/types` | TypeScript type definitions |
| `madcore/jsonrpc` | Core-compatible JSON-RPC facade (`DeltaChatJsonRpc`, `handleRpc`) |

---

## Quick Start

```ts
import { DeltaChatSDK } from 'madcore';

const SERVER = 'https://relay.example';

// In browsers this defaults to IndexedDB (createStore()).
// In Node / tests without IDB it uses MemoryStore.
const dc = DeltaChatSDK({ logLevel: 'debug' });

const { account: alice } = await dc.register(SERVER, 'Alice');
const { account: bob }   = await dc.register(SERVER, 'Bob');

await alice.connect();
await bob.connect();

const uri = alice.generateSecureJoinURI();
const { contact } = await bob.secureJoin(uri);

await bob.send(contact, { text: 'Hello Alice!' });
console.log(bob.status());
```

### Persistence (browser)

| What | When |
|------|------|
| Chats, messages, contacts | Saved immediately on each change |
| Keys, profile, groups, relays, config, mailbox UID | Debounced auto-save (`schedulePersist`) |
| Multi-account index | `{dbName}__registry` |

```ts
// Next page load — discover + restore
const saved = await dc.listPersistedAccounts();
const acc = await dc.restoreAccount(saved[0].email, password, saved[0].serverUrl);
await acc.connect(); // resumes from lastSeenUid

// Optional hard flush before unload
window.addEventListener('pagehide', () => { void acc.flushPersist(); });
```

Force in-memory storage (tests):

```ts
import { DeltaChatSDK, MemoryStore } from 'madcore';
const dc = DeltaChatSDK({ store: new MemoryStore() });
```

---

## Documentation

| Doc | Contents |
|-----|----------|
| **[Examples & API guide](./docs/examples.md)** | Messaging, groups, events, storage restore flows |
| **[Security](./docs/security.md)** | PGP, Autocrypt, SecureJoin |
| **[Architecture](./docs/architecture.md)** | Module layout, WebSocket protocol, storage internals |
| **[Core parity](./docs/parity.md)** | madcore vs Delta Chat core RPC |
| **[JSON-RPC compat](./docs/jsonrpc-compat.md)** | Full core wire API surface on madcore |

---

## Development

```bash
bun run dev            # tsc --watch
bun run build          # emit dist/
bun run test:rpc       # offline unit tests only (test/rpc)
bun run test:live-full # live E2E (needs SERVER_URL)
```

### SecureJoin + official core

**Local (Docker madmail):**

```bash
make test
# same as: bun run test
```

1. Download / link `deltachat-rpc-server` → `.tools/`
2. Start madmail Docker (static IP `172.28.100.10`) and **enable webimap + websmtp**
3. Build `dist/`
4. Offline unit tests (`test/rpc/`)
5. **core ↔ core** SecureJoin (JS stdio client + rpc-server)
6. **madcore** SecureJoin + cross with core (JS SDK over webimap/websmtp)

**CI / no Docker service (madmail binary + core binary):**

```bash
make test-ci
# same as: bun run test:ci
```

Same test matrix, but madmail is a plain process from `.tools/madmail` (extracted from the GHCR image or a GitHub release) listening on `https://127.0.0.1:8443`. GitHub Actions runs this via `.github/workflows/ci.yml`.

Pure **JS** core client: `test/live/core-rpc.ts` (no Python).  
Details: [test/live/README.md](./test/live/README.md).

```bash
SERVER_URL=https://relay.example
```
**Install from registries**

```bash
# npmjs.com
npm install madcore


# GitHub Packages (scoped as @<owner>/madcore)
npm install @themadorg/madcore --registry=https://npm.pkg.github.com
# .npmrc:
#   @themadorg:registry=https://npm.pkg.github.com
#   //npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

---

## License

[GNU Lesser General Public License v3.0 (LGPLv3)](./LICENSE).
