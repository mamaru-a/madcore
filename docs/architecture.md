# Madcore Web — Architecture & Protocol Internals (Level 4)

This document provides a technical deep dive into the internal design of **Madcore Web** (`madcore-web`), its communication protocols, and its modular architecture.

**Documentation levels:** [Fundamentals & Messaging](./examples.md) · [Security](./security.md) · **Architecture (this page)**

---

## Package Layout

```
madcore-web/
├── sdk.ts          # DeltaChatSDK factory, DeltaChatAccount class
├── store.ts        # MemoryStore, IndexedDBStore, IDeltaChatStore
├── types.ts        # Public type definitions
└── lib/
    ├── index.ts       # Internal module re-exports
    ├── transport.ts   # WebSocket / REST network layer
    ├── crypto.ts      # OpenPGP key management
    ├── mime.ts        # RFC 2822 parsing & construction
    ├── messaging.ts   # send() target resolution & payloads
    ├── securejoin.ts  # QR / URI handshake state machine
    ├── group.ts       # Groups & broadcast channels
    ├── profile.ts     # Display name & avatar handling
    ├── context.ts     # Per-account runtime context
    └── logger.ts      # Configurable log levels
```

## The WebSocket Protocol

The SDK communicates with the Delta Chat Relay using a **bidirectional JSON-RPC over WebSocket** protocol.

### JSON-RPC Message Structure
Every client-initiated request has a unique `req_id` used for correlating reactions.

```json
{
  "req_id": "1",
  "action": "send",
  "data": {
    "from": "user@relay.example",
    "to": ["bob@relay.example"],
    "body": "Raw MIME Message"
  }
}
```

### Server Responses
The server responds with the same `req_id`:

```json
{
  "req_id": "1",
  "action": "send",
  "data": "OK"
}
```

### Push Notifications
When a new message arrives, the server "pushes" an event without a `req_id`:

```json
{
  "action": "push",
  "data": {
    "uid": 1234,
    "body": "Full RFC 2822 Message..."
  }
}
```

---

## The UID System

The Delta Chat Relay uses an **Incremental UID** system to track messages.

1. **UIDs:** Each message in a mailbox is assigned a unique, incrementing integer `UID`.
2. **Synchronization:** When connecting via WebSocket, the SDK sends its highest known UID. The server then pushes all messages with a higher UID that arrived while the SDK was offline.
3. **Optimistic Sync:** This ensures that no messages are missed during network interruptions.

---

## SDK Internal Modularization

The SDK is divided into several focused modules to maximize maintainability and testability.

### `lib/transport.ts` (Network Layer)
- This is the **only** module that interacts with the network.
- It provides high-level `send` and `fetch` methods.
- It manages the WebSocket lifecycle (connect, disconnect, automatic reconnect).
- It abstracts away the choice between WebSocket (binary, real-time) and REST (fallback, stateless).

### `lib/crypto.ts` (Security Layer)
- Wraps `OpenPGP.js`.
- Pure functions for PGP key generation, encryption, and decryption.
- Implements Autocrypt header building and parsing.

### `lib/mime.ts` (Parsing Layer)
- Handles the complex world of RFC 2822 MIME.
- Extracts `From`, `To`, `Subject`, and `Message-ID`.
- Handles `multipart/mixed` and `multipart/encrypted`.
- Decodes attachments and base64-encoded body parts.
- Strips signatures and email preambles (matches core library logic).

### `lib/messaging.ts` (Logic Layer)
- High-level methods for sending text, images, videos, and replies.
- Implements unified `send()` logic (target resolution + payload construction).

### `lib/securejoin.ts` (Handshake Layer)
- State machine for the 4-phase SecureJoin protocol.
- URI generation and parsing.

---

## Storage & Multi-Account Manager

### `DeltaChatSDK()` (The Factory)
The root export of `madcore-web` is a factory that returns a **Multi-Account Manager**. This manager:
- Keeps a registry of all active accounts.
- Routes incoming server-push events to the correct account instance based on the `X-Email` header.
- Manages global settings and logging.

### `IDeltaChatStore`
The SDK is store-agnostic. Any object implementing the `IDeltaChatStore` interface can be used for persistence.
- **`MemoryStore`:** Default, in-memory, non-persistent.
- **`IndexedDBStore`:** Persistent, for use in browser environments.

---

## Developing Extensions

### Webxdc Support
Webxdc ("Apps in Chat") allows developers to build full-blown web applications that live inside any Delta Chat conversation.

- **The SDK and Webxdc:** The SDK provides a low-level API for sending and receiving Webxdc-specific payloads.
- **Exposing the API:** Future versions of the SDK will include a dedicated `WebxdcManager` to simplify sending game/app state updates across a group chat.

### Custom Transports
While Madcore Web defaults to the Delta Chat WebSocket Relay, it can be extended with custom `Transport` implementations (e.g., to bridge into other messaging protocols).

---

## Related Documentation

- [Fundamentals & Core Messaging](./examples.md) — Quick start, `send()`, groups, storage
- [Security & Advanced Features](./security.md) — PGP, Autocrypt, SecureJoin, media handling
