# Madcore Web

**Madcore Web** (`madcore-web`) is a high-level library for building Delta Chat-compatible messengers in web environments. It runs on the Delta Chat Relay protocol (JSON-RPC over WebSocket) and provides a multi-account, PGP-first messaging experience with zero backend required.

---

## Installation

```bash
npm install madcore-web
# or
bun add madcore-web
```

From source:

```bash
bun install
bun run build
```

### Package entry points

| Import | Purpose |
|--------|---------|
| `madcore-web` | `DeltaChatSDK`, `DeltaChatAccount`, crypto helpers |
| `madcore-web/store` | `MemoryStore`, `IndexedDBStore`, `createStore()` |
| `madcore-web/types` | TypeScript type definitions |

---

## Quick Start

```ts
import { DeltaChatSDK } from 'madcore-web';

const SERVER = 'https://relay.example';

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

For browser persistence, pass `store: new IndexedDBStore('my-app')` to `DeltaChatSDK()`. The default IndexedDB database name is `madcore-web`.

See [docs/examples.md](./docs/examples.md#quick-start) for the full guide.

---

## Documentation

Choose your entry point based on your needs:

### Level 1: SDK Fundamentals
*New developers and evaluators.*
- **[Introduction & Quick Start](./docs/examples.md#quick-start)** — Register, connect, and send your first message.
- **[The Factory Pattern](./docs/examples.md#the-factory-pattern)** — Managing multiple `DeltaChatAccount` instances.
- **[Standalone Account](./docs/examples.md#standalone-account)** — Single-account usage without the manager.

### Level 2: Core Messaging & Management
*Application developers building messenger features.*
- **[Account Lifecycle](./docs/examples.md#account-lifecycle)** — Registration, connection, and persistence with `IndexedDBStore`.
- **[Unified Messaging (`.send()`)](./docs/examples.md#unified-messaging-send)** — Text, images, video, reactions, edits, and deletes.
- **[Real-time Events](./docs/examples.md#receiving-messages--events)** — Incoming messages and connection state changes.
- **[Contacts & Groups](./docs/examples.md#contacts--groups)** — Contact lists, groups, and broadcast channels.

### Level 3: Security & Advanced Features
*Security-conscious developers and advanced users.*
- **[PGP & Autocrypt](./docs/security.md#pgp--autocrypt)** — Key generation, fingerprints, and opportunistic encryption.
- **[SecureJoin Handshake](./docs/security.md#securejoin-handshake)** — QR-code / URI verification protocol.
- **[Multi-Device Sync](./docs/security.md#multi-device-synchronization)** — State consistency across devices.
- **[Media Processing](./docs/security.md#media-processing)** — Base64 handling, MIME parsing, and attachments.
- **[Core parity map](./docs/parity.md)** — madcore-web API vs Delta Chat core RPC.

### Level 4: Architecture & Protocol Internals
*Core contributors and protocol researchers.*
- **[WebSocket Protocol](./docs/architecture.md#the-websocket-protocol)** — JSON-RPC message structure and actions.
- **[UID System](./docs/architecture.md#the-uid-system)** — Message tracking and synchronization.
- **[Module Layout](./docs/architecture.md#package-layout)** — `lib/transport.ts`, `lib/mime-build.ts`, `lib/webxdc.ts`, and more.
- **[Developing Extensions](./docs/architecture.md#developing-extensions)** — Webxdc, calls, location, custom storage.

---

## Development

```bash
bun run dev          # watch mode (tsc)
bun run test         # full integration test suite
bun run test:interactive
```

Integration tests expect a relay URL in `.env`:

```bash
SERVER_URL=https://relay.example
```

---

## License

Madcore Web is licensed under the [GNU Lesser General Public License v3.0 (LGPLv3)](./LICENSE).

You may download the full license text from the [LICENSE](./LICENSE) file in this repository.