# madcore-web ↔ Delta Chat core parity

This document maps core JSON-RPC surface areas to **madcore-web** APIs.
madcore-web is a **web-native chatmail client**, not a wrapper around `@deltachat/jsonrpc-client`.

| Status | Meaning |
|--------|---------|
| ✅ | Implemented |
| 🟡 | Partial / web-shaped equivalent |
| ❌ | Out of scope or not yet implemented |
| 🌐 | Web-only approach (no native core equivalent needed) |

## Accounts & IO

| Core | madcore-web | Status |
|------|-------------|--------|
| `addAccount` / `removeAccount` | `DeltaChatSDK().register` / `addAccount` / `removeAccount` | ✅ |
| `configure` / IMAP-SMTP | `register` + `connect` (WS/REST) | 🟡 |
| `startIo` / `stopIo` | `connect` / `disconnect` | 🟡 |
| `getConnectivity` | `getConnectivity` / `getConnectivityHtml` | ✅ |
| `backgroundFetch` | `backgroundFetch` / `processPushPayload` | 🟡 |
| Multi-transport | `addRelay` / `listRelays` / multi-WS | ✅ |

## Messaging

| Core | madcore-web | Status |
|------|-------------|--------|
| `miscSendTextMessage` / `sendMsg` | `send` / `sendMessage` | ✅ |
| Image/Video/Audio/Voice/File | `send({ image\|video\|audio\|voice\|file })` | ✅ |
| Sticker / Gif | `send({ sticker\|gif })` | ✅ |
| Reactions | `send({ reaction })` | ✅ |
| Edit / delete for all | `send({ edit\|delete })` | ✅ |
| Forward | `send({ forward })` | ✅ |
| Drafts | `setDraft` / `getDraft` / `removeDraft` | ✅ |
| Read receipts | `markChatRead` + wire MDN | ✅ |
| Ephemeral timer | `setChatEphemeralTimer` / `sweepEphemeralMessages` | ✅ |
| HTML messages | — | ❌ |
| Download full / blob dir | base64 in store | 🟡 |

## Groups & channels

| Core | madcore-web | Status |
|------|-------------|--------|
| `createGroupChat` | `createGroup` | ✅ |
| Broadcast / channel | `createChannel` / `sendBroadcast` | ✅ |
| Add/remove member | `addGroupMember` / `removeGroupMember` | ✅ |
| Rename / description | `renameGroup` / `updateGroupDescription` | ✅ |
| Group media + actions | `send(group, …)` reaction/edit/delete/media | ✅ |
| Group avatar | `setChatProfileImage` | ✅ |
| Unencrypted groups | — | ❌ |

## Contacts & safety

| Core | madcore-web | Status |
|------|-------------|--------|
| Contacts CRUD | `createContact` / `getContacts` / … | ✅ |
| Block / unblock | `blockContact` / `unblockContact` | ✅ |
| SecureJoin | `secureJoin` / `generateSecureJoinURI` | ✅ |
| `checkQr` | `checkQr` | ✅ |
| QR SVG | `createQrSvg` (placeholder) | 🟡 |
| vCard | — | ❌ |

## Webxdc / location / calls

| Core | madcore-web | Status |
|------|-------------|--------|
| Webxdc send / status | `sendWebxdc` / `sendWebxdcStatusUpdate` | ✅ |
| Webxdc realtime | — | ❌ |
| Location stream | `sendLocationsToChat` / `setLocation` | ✅ |
| VoIP / ICE | `placeOutgoingCall` + signaling (`lib/calls.ts`) | 🟡 |
| Native media path | inject `RTCPeerConnection` in app | 🌐 |

## Backup & multi-device

| Core | madcore-web | Status |
|------|-------------|--------|
| `exportBackup` / `importBackup` | `exportBackup` / `importBackup` | ✅ |
| Backup QR second device | partial via `checkQr` backup kinds | 🟡 |
| IMAP folder watch | `setWatchedMailboxes` / multi-mailbox fetch | 🟡 |
| IMAP METADATA config | local `setConfig` / `getConfig` | 🟡 |

## Explicitly not ported

| Core area | Reason |
|-----------|--------|
| IMAP/SMTP engine lifecycle | Replaced by chatmail WS relay |
| Blob filesystem / sticker packs FS | Browser base64 / OPFS later |
| FCM/APNs push | Web Push via `setPushToken` + SW |
| Stock strings i18n engine | App-owned |

## Capability probe

```ts
const caps = account.capabilities();
// { calls: 'webrtc'|'signaling-only', webxdc: true, location: true, multiRelay: true }
```
