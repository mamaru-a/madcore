# Madcore Web — Security & Advanced Features (Level 3)

This document provides a deep dive into the security mechanisms, encryption protocols, and advanced feature handling within **Madcore Web** (`madcore-web`).

**Documentation levels:** [Fundamentals & Messaging](./examples.md) · **Security (this page)** · [Architecture](./architecture.md)

## PGP & Autocrypt

Madcore Web is a **PGP-first** messenger library. Every account has an associated OpenPGP keypair used for end-to-end encryption.

### Key Generation
The SDK uses `OpenPGP.js` to generate **ECC (Curve25519)** keys. This provides high security with small key sizes, perfect for mobile and web environments.

```ts
// Internal call within SDK when initializing or restoring
const { privateKey, publicKey, fingerprint } = await generateKeys(email, displayName);
```

### Autocrypt Workflow
Delta Chat follows the [Autocrypt](https://autocrypt.org) standard for opportunistic encryption. Key exchange happens automatically in the headers of every outgoing email:

1. **Header Construction:** Every message sent via the SDK includes an `Autocrypt` header containing the sender's public key data.
2. **Opportunistic Import:** When the SDK receives a message, it checks for an `Autocrypt` header. If found, it automatically imports the sender's public key into the local contact registry.
3. **Encryption Level:** Once a peer's key is known, the SDK automatically switches to encrypted messaging for all subsequent communications with that peer.

### Autocrypt Gossip
To protect against surreptitious forwarding and to keep keys synchronized across multi-device setups, the SDK implements **Autocrypt-Gossip**:
- In group chats, the sender "gossips" the public keys of all other group members inside the encrypted MIME structure.
- This allows new members or secondary devices to discover peer keys securely.

---

## SecureJoin Handshake

While Autocrypt provides opportunistic encryption, **SecureJoin** provides **verified** end-to-end encryption. It uses a QR-code/URI-based handshake to ensure no Man-in-the-Middle (MITM) can intercept the key exchange.

### The 4-Phase Protocol

1. **Phase 1: `vc-request` (Joiner → Inviter)**
   - The Joiner scans a QR code/URI containing the Inviter's fingerprint, an `inviteNumber`, and a `secret`.
   - The Joiner sends an unencrypted message to the Inviter with the `Secure-Join: vc-request` header and the `inviteNumber`.

2. **Phase 2: `vc-auth-required` (Inviter → Joiner)**
   - The Inviter verifies the `inviteNumber`.
   - The Inviter responds with `Secure-Join: vc-auth-required`. This message also includes the Inviter's `Autocrypt` header, allowing the Joiner to import the Inviter's key.

3. **Phase 3: `vc-request-with-auth` (Joiner → Inviter)**
   - The Joiner now has the Inviter's key.
   - The Joiner sends a **PGP-encrypted** message to the Inviter containing the `secret` from the QR code and their own PGP fingerprint.

4. **Phase 4: `vc-contact-confirm` (Inviter → Joiner)**
   - The Inviter decrypts the message and verifies the `secret`.
   - If valid, the Inviter sends an encrypted `vc-contact-confirm`. Both parties now mark each other as **Verified**.

---

## Multi-Device Synchronization

Madcore Web is designed to work in a multi-device environment.

### Self-Sent Messages
When you send a message from one device, the relay typically places a copy in the `Sent` folder. Other devices connected to the same account can see these messages.

- **Deduplication:** The SDK uses the RFC 724 `Message-ID` to ensure that messages sent by the local device aren't processed as incoming "new" messages.
- **State Sync:** By observing your own outgoing messages (from other devices), the SDK can synchronize chat state, group memberships, and settings across all your instances.

### Shared Folders
The SDK monitors the `INBOX` for incoming messages. In future versions, it can be configured to monitor other IMAP folders or use the `IMAP METADATA` extension for cross-device configuration syncing.

---

## Media Processing

Handling large attachments in a web environment requires careful memory management.

### Base64 & Data URIs
The SDK handles attachments (Images, Videos, Voice) primarily as **Base64** strings:
- **Sending:** You provide a Base64 string to `.send()`. The SDK wraps this in a MIME structure.
- **Receiving:** The SDK parses the multipart MIME, extracts the Base64 data, and provides it in the `attachments` array of a `ParsedMessage`.

### MIME Construction
The `lib/mime.ts` module handles the complex task of building and deconstructing RFC 2822 structures:
- **Multipart/Mixed:** For messages with attachments.
- **Multipart/Encrypted:** For PGP/MIME encrypted payloads.
- **Protected Headers:** Delta Chat protects metadata (Subject, From, To) by including them inside the encrypted PGP block.

---

## Related Documentation

- [Fundamentals & Core Messaging](./examples.md) — Account lifecycle, SecureJoin usage, persistent storage
- [Architecture & Protocol Internals](./architecture.md) — WebSocket protocol, UID system, module layout
