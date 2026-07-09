# Madcore Web — Fundamentals & Core Messaging (Levels 1 & 2)

Welcome to **Madcore Web** (`madcore-web`)! This is a high-level library for building Delta Chat-compatible messengers in web environments. It runs on the Delta Chat Relay protocol (JSON-RPC over WebSocket) and provides a multi-account, PGP-first messaging experience with zero backend required.

---

## 📚 Documentation Levels

- **[Level 1: SDK Fundamentals (This Page)](#quick-start)**
- **[Level 2: Core Messaging & Management (This Page)](#unified-messaging-send)**
- **[Level 3: Security & Advanced Features](./security.md)**
- **[Level 4: Architecture & Protocol Internals](./architecture.md)**

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

The package exports three entry points:

| Import | Purpose |
|--------|---------|
| `madcore-web` | `DeltaChatSDK`, `DeltaChatAccount`, crypto helpers |
| `madcore-web/store` | `MemoryStore`, `IndexedDBStore`, `createStore()` |
| `madcore-web/types` | TypeScript type definitions |

---

## Table of Contents

### Level 1: SDK Fundamentals
- [Quick Start](#quick-start)
- [Multi-Account Manager](#multi-account-manager)
- [Standalone Account](#standalone-account)
- [The Factory Pattern](#the-factory-pattern)

### Level 2: Core Messaging & Management
- [Unified Messaging (`.send()`)](#unified-messaging-send)
- [Account Lifecycle](#account-lifecycle)
- [Receiving Messages & Events](#receiving-messages--events)
- [Contacts & Groups](#contacts--groups)
- [Broadcast Channels](#broadcast-channels)
- [Profile & Avatars](#profile--avatars)
- [Persistent Storage](#persistent-storage)
- [Chat Management](#chat-management)


---

## Quick Start

```ts
import { DeltaChatSDK } from 'madcore-web';

const SERVER = 'https://relay.example';

// 1. Create the SDK manager
const dc = DeltaChatSDK({ logLevel: 'debug' });

// 2. Register two accounts
const { account: alice } = await dc.register(SERVER, 'Alice');
const { account: bob }   = await dc.register(SERVER, 'Bob');

// 3. Connect both
await alice.connect();
await bob.connect();

// 4. SecureJoin to establish verified contact
const uri = alice.generateSecureJoinURI();
const { contactId, contact } = await bob.secureJoin(uri);

// 5. Send a message — unified send() accepts any target + payload
await bob.send(contact, { text: 'Hello Alice!' });
await bob.send(contactId, { text: 'Works with IDs too!' });
await bob.send(contact, { image: { data: base64, caption: 'Check this!' } });

// 6. Check status
console.log(bob.status());
```

> **Note:** The default store is `MemoryStore` (in-memory, non-persistent).
> For browser persistence, pass `store: new IndexedDBStore('my-app')` to `DeltaChatSDK()`.
> The default IndexedDB database name is `madcore-web`.

---

## Unified Messaging (send)

The `send()` method is the single entry point for all messaging.
It accepts **any target** (contact, contactId, group, groupId, channel)
and a **message descriptor** `{...}`.

### Text

```ts
await acc.send(bob, { text: 'Hello!' });
await acc.send(bobContactId, { text: 'By ID!' });
```

### Image

```ts
const { msgId, message } = await acc.send(bob, {
    image: { data: base64Data, filename: 'sunset.jpg', caption: 'Beautiful!' },
});
```

### File / Video / Audio / Voice

```ts
await acc.send(bob, { file: { data: b64, filename: 'doc.pdf', mimeType: 'application/pdf' } });
await acc.send(bob, { video: { data: b64, filename: 'clip.mp4', durationMs: 15000 } });
await acc.send(bob, { audio: { data: b64, filename: 'song.mp3', durationMs: 240000 } });
await acc.send(bob, { voice: { data: b64, durationMs: 5000 } });
```

### Reply

`replyTo` works with any message type — text, image, video, etc.

```ts
// Text reply
await acc.send(bob, {
    text: 'I agree!',
    replyTo: originalMessage,      // StoredMessage or message ID
    quotedText: 'What do you think?',
});

// Reply with an image
await acc.send(bob, {
    image: { data: base64, filename: 'proof.jpg' },
    replyTo: originalMessage,
});

// Reply with a video
await acc.send(bob, {
    video: { data: b64, filename: 'demo.mp4' },
    replyTo: msg,
});
```

### Reaction / Edit / Delete

```ts
await acc.send(bob, { reaction: { targetMessage: msg, reaction: '👍' } });
await acc.send(bob, { edit: { targetMessage: msg, newText: 'Fixed typo' } });
await acc.send(bob, { delete: { targetMessage: msg } });
```

### Forward

```ts
await acc.send(bob, {
    forward: { originalMessage: msg, originalFrom: 'alice@relay.example' },
});
```

### Group / Channel Targets

```ts
// Group object or group ID
await acc.send(group, { text: 'Hello group!' });
await acc.send(group.grpId, { text: 'By group ID!' });
await acc.send(group, { image: { data: b64, caption: 'Group photo' } });

// Channel (broadcast)
await acc.send(channel, { text: 'Breaking news!' });
await acc.send(channel.grpId, { text: 'By channel ID' });
```

---

## Account Status

Every account exposes a `.status()` method that returns the full state:

```ts
const s = acc.status();

console.log(s.id);            // 'a1b2c3d4e5f6'
console.log(s.email);         // primary relay email
console.log(s.displayName);   // 'Alice'
console.log(s.fingerprint);   // '89EDF8188BA275C5...'
console.log(s.hasKeys);       // true
console.log(s.knownContacts); // 3
console.log(s.isConnected);   // true (any relay connected)

// Per-relay breakdown
for (const r of s.relays) {
    console.log(`${r.id}: ${r.email} @ ${r.serverUrl} → ${r.state}`);
    // → 'r1a2b3c4d5e6: alice@relay1.example @ https://relay1.example → connected'
    // → 'r6e5d4c3b2a1: alice2@relay2.example @ https://relay2.example → disconnected'
}
```

---

## Multi-Account Manager

The `DeltaChatSDK()` factory returns an account manager. Each account
is identified by a **random ID** (not its email).

```ts
import { DeltaChatSDK } from 'madcore-web';

const dc = DeltaChatSDK({ logLevel: 'info' });

// Register two accounts — each gets a unique random ID + account handle
const { account: alice } = await dc.register(SERVER, 'Alice');
const { account: bob }   = await dc.register(SERVER, 'Bob');

// Connect both
await alice.connect();
await bob.connect();

// List managed accounts
console.log(dc.listAccounts());
// → [{ id: 'a1b2c3d4e5f6', email: 'alice@relay.example' },
//    { id: 'f6e5d4c3b2a1', email: 'bob@relay.example' }]

// Find account by email (useful for incoming message routing)
const found = dc.findAccountByEmail('alice@relay.example');
console.log(found?.id);

// You can also retrieve by ID later
const aliceAgain = dc.getAccount(alice.id);

// Remove an account by ID (disconnects + removes from manager)
dc.removeAccount(bob.id);
```

### Import an Existing Account

```ts
// If you already have credentials:
const acc = dc.addAccount('user@relay.example', 'password123', 'https://relay.example');
console.log(acc.id); // random ID was assigned
await acc.generateKeys('My Name');
await acc.connect();
```

---

## The Factory Pattern

The `DeltaChatSDK()` function is a factory that returns a multi-account manager. This is the recommended way to use the SDK in most applications.

```ts
const dc = DeltaChatSDK({
    logLevel: 'debug',
    store: new IndexedDBStore('my-app'), // optional persistence
});
```

---

## Standalone Account

For simpler use-cases (single account, no manager):

```ts
import { DeltaChatAccount } from 'madcore-web';
import { MemoryStore } from 'madcore-web/store';

const acc = new DeltaChatAccount(new MemoryStore());
console.log(acc.id); // auto-generated random ID
await acc.register('https://relay.example');
await acc.generateKeys('Alice');
await acc.connect();
const bob = await acc.createContact({
    email: 'bob@relay.example',
    name: 'Bob',
    key: bobPublicKey,
});
await acc.sendMessage(bob, 'Hello!');
```

---

## Multi-Relay

Accounts can hold multiple chatmail identities and keep several WebSocket
transports open. Relays are persisted via `saveToStore` / `loadFromStore`.

```ts
// Register on a second server
const relay2 = await alice.addRelay('https://relay2.example');

// Or add with existing credentials
const relay3 = await alice.addRelay('https://relay3.example', {
    email: 'alice@relay3.example',
    password: 'secret',
});

// Connect specific relays
await alice.connect('https://relay2.example');

// Manage
alice.listRelays();              // → RelayInfo[]
alice.getRelay(relay2.id);       // → RelayInfo | undefined
alice.removeRelay(relay2.id);    // disconnects + removes
```

## Drafts, ephemeral, avatars

```ts
await acc.setDraft(chatId, { text: 'unsent…' });
await acc.getDraft(chatId);
await acc.removeDraft(chatId);

await acc.setChatEphemeralTimer(chatId, 60); // seconds; 0 = off
await acc.sweepEphemeralMessages();          // call periodically

await acc.setChatProfileImage(groupId, { data: b64, mimeType: 'image/jpeg' });
await acc.removeChatProfileImage(groupId);
```

## Webxdc, location, calls

```ts
await acc.sendWebxdc(bob, { data: xdcBase64, name: 'Chess' });
await acc.sendWebxdcStatusUpdate(bob, instanceMsgId, { payload: { move: 'e2e4' } });

await acc.sendLocationsToChat(bob.email, { durationSec: 600 });
await acc.setLocation({ lat: 52.5, lon: 13.4 });
await acc.stopSendingLocations(bob.email);

const call = await acc.placeOutgoingCall(bob, { video: true, sdpOffer });
await acc.acceptIncomingCall(call.callId, { sdpAnswer });
await acc.endCall(call.callId);
acc.setIceServers([{ urls: 'stun:stun.l.google.com:19302' }]);
```

## Backup & config

```ts
const json = await acc.exportBackup({ passphrase: 'optional' });
await other.importBackup(json, { passphrase: 'optional' });

await acc.setConfig('watched_mailboxes', 'INBOX,Sent');
acc.setWatchedMailboxes(['INBOX', 'DeltaChat']);
await acc.backgroundFetch(0);
```

---

## Account Lifecycle

Manage the entire lifecycle of an account—from registration to connection and multi-relay management.

### Register or Login
```ts
// Register a new temporary account
const { account } = await dc.register(SERVER, 'Alice');

// Or add an existing account
const acc = dc.addAccount('user@relay.example', 'pass', SERVER);
```

### Connection Management
```ts
await acc.connect();
console.log(acc.status().isConnected);
await acc.disconnect();
```

---

## Contacts & Groups

Contacts are created via SecureJoin (recommended) or manually.
All messaging uses **contact IDs**, not raw emails.

### Create Contact via SecureJoin (Recommended)

```ts
// Alice generates invite URI
const uri = alice.generateSecureJoinURI();

// Bob scans → creates a verified contact for Alice
const { contact, contactId, verified } = await bob.secureJoin(uri);
console.log(contact.name);   // 'Alice'
console.log(contact.email);  // 'alice@relay.example'
console.log(verified);       // true

// Now Bob can message Alice (pass contact object or contactId)
await bob.sendMessage(contact, 'Hello!');
```

### Create Contact Manually

If you already have someone's public key, you can create a contact
without SecureJoin. The key is required for encrypted messaging.

```ts
const bob = await acc.createContact({
    email: 'bob@relay.example',
    name: 'Bob',
    key: bobArmoredPublicKey,       // required — PGP armored key
    avatar: base64AvatarData,       // optional
});

// bob is a StoredContact — pass directly to sendMessage
await acc.sendMessage(bob, 'Hello Bob!');
```

> **Note:** If you don't have the peer's key, use `secureJoin()` to
> establish a verified, encrypted channel.

### Contact Lookup

```ts
// Get contact by ID
const c = acc.getContact(contactId);
console.log(c?.email);      // 'bob@relay.example'
console.log(c?.name);       // 'Bob'
console.log(c?.verified);   // true

// Find contact by email
const found = acc.findContactByEmail('bob@relay.example');
console.log(found?.id);     // 'f3a7b2c1d9e8'

// List all contacts
for (const c of acc.listContacts()) {
    console.log(`${c.id}: ${c.name} (${c.email}) verified=${c.verified}`);
}

// Delete a contact
await acc.deleteContact(contactId);
```

---

## Sending Messages

All messaging methods accept a **contact ID or contact object**
and return `{ msgId, message }`. Messages are **auto-persisted** to the store.

### Plain Text

```ts
const { msgId, message } = await acc.sendMessage(contactId, 'Hello Bob!');
console.log(msgId);               // '<a1b2c3d4@relay.example>'
console.log(message.state);       // 'sent'
console.log(message.direction);   // 'outgoing'

// Also works with contact object
const { msgId: id2 } = await acc.sendMessage(contact, 'Hi!');
```

### With Inline Image

```ts
const { msgId } = await acc.sendMessage(contactId, 'Check this out!', base64ImageData);
```

### Forward a Message

```ts
const { msgId } = await acc.forwardMessage(contact, {
    originalMessage: someMessage,         // StoredMessage or text string
    originalFrom: 'alice@relay.example',
});
```

---

## Media Messages

All media methods take a contact + opts object.

### Image

```ts
const { msgId, message } = await acc.sendImage(contact, {
    filename: 'photo.jpg',
    data: base64Data,          // raw base64 (no data URI prefix)
    mimeType: 'image/jpeg',   // optional, defaults to 'image/jpeg'
    caption: 'Sunset',        // optional
});
```

### File

```ts
const { msgId } = await acc.sendFile(contact, {
    filename: 'report.pdf',
    data: base64Data,
    mimeType: 'application/pdf',
    caption: 'Q3 Report',
});
```

### Video

```ts
const { msgId } = await acc.sendVideo(contact, {
    filename: 'clip.mp4',
    data: base64Data,
    mimeType: 'video/mp4',      // optional
    caption: 'Check this out',  // optional
    durationMs: 15000,          // optional
});
```

### Audio

```ts
const { msgId } = await acc.sendAudio(contact, {
    filename: 'song.mp3',
    data: base64Data,
    mimeType: 'audio/mpeg',     // optional
    caption: 'Great song',      // optional
    durationMs: 240_000,        // optional
});
```

### Voice Message

```ts
const { msgId } = await acc.sendVoice(contact, {
    data: base64OggData,
    durationMs: 5000,           // optional
    mimeType: 'audio/ogg',     // optional
});
```

---

## Replies, Reactions, Edits & Deletes

All these methods accept message objects or message IDs.

### Reply to a Message

```ts
// Reply using the original message object
const { msgId } = await acc.sendReply(contact, {
    parentMessage: originalMessage,   // StoredMessage or string ID
    text: 'I agree!',
    quotedText: 'What do you think?', // optional
});

// Or reply by message ID
const { msgId: r2 } = await acc.sendReply(contactId, {
    parentMessage: '<original-msg-id@relay.example>',
    text: 'Also works with IDs',
});
```

### React with Emoji

```ts
await acc.sendReaction(contact, {
    targetMessage: message,   // StoredMessage or string ID
    reaction: '👍',
});

// Remove reaction (empty string)
await acc.sendReaction(contact, { targetMessage: message, reaction: '' });
```

### Edit a Sent Message

```ts
await acc.sendEdit(contact, {
    targetMessage: message,           // or '<msg-id@relay.example>'
    newText: 'Updated text (fixed typo)',
});
```

### Delete a Message

```ts
await acc.sendDelete(contact, {
    targetMessage: message,           // or '<msg-id@relay.example>'
});
```

---

## Receiving Messages & Events

### Event-Based (Recommended)

```ts
// Incoming messages (decrypted + parsed)
acc.on('DC_EVENT_INCOMING_MSG', (e) => {
    const msg = e.msg!;
    console.log(`From: ${msg.from}`);
    console.log(`Text: ${msg.text}`);
    console.log(`Encrypted: ${msg.encrypted}`);
    console.log(`Attachments: ${msg.attachments.length}`);

    if (msg.groupId) {
        console.log(`Group: ${msg.groupName} (${msg.groupId})`);
    }
});

// Reactions
acc.on('DC_EVENT_INCOMING_REACTION', (e) => {
    console.log(`${e.msg!.from} reacted with ${e.msg!.reaction} to ${e.msgId}`);
});

// Delete requests
acc.on('DC_EVENT_MSG_DELETED', (e) => {
    console.log(`Message ${e.msgId} was deleted`);
});

// Contact changes (avatar updates, etc.)
acc.on('DC_EVENT_CONTACTS_CHANGED', (e) => {
    console.log(`Contact ${e.contactId} updated`);
});

// SecureJoin progress
acc.on('DC_EVENT_SECUREJOIN_JOINER_PROGRESS', (e) => {
    console.log(`SecureJoin step: ${e.data1}`);
});
```

### Wait for a Specific Message

```ts
// Block until a message matching the predicate arrives (with timeout)
const reply = await acc.waitForMessage(
    (msg) => msg.from === 'bob@relay.example' && msg.text.includes('accept'),
    30_000  // 30 second timeout
);
console.log(`Bob replied: ${reply.text}`);
```

### Unsubscribe

```ts
const handler = (e) => console.log(e.msg!.text);
acc.on('DC_EVENT_INCOMING_MSG', handler);

// Later:
acc.off('DC_EVENT_INCOMING_MSG', handler);
```

---

## Groups & Channels

The SDK treats Groups and Channels as specialized "chats" with multiple members.

### Create a Group

```ts
import type { GroupInfo } from 'madcore-web';

const group = await acc.createGroup(
    'Weekend Plans',
    [bobContact, carolContactId]   // contacts: string | StoredContact
);

console.log(group.grpId);    // unique group ID
console.log(group.name);     // 'Weekend Plans'
console.log(group.members);  // ['alice@...', 'bob@...', 'carol@...']
```

### Send to Group

```ts
// By group object
const msgId = await acc.sendGroupMessage(group, 'Hey everyone!');

// By group ID
const msgId2 = await acc.sendGroupMessage(group.grpId, 'Also works!');
```

### Manage Members

```ts
// Add member (group + member can be ID or object)
await acc.addGroupMember(group, daveContact);
await acc.addGroupMember(group.grpId, daveContactId);

// Remove member
await acc.removeGroupMember(group.grpId, carolContactId);
```

### Rename & Describe

```ts
await acc.renameGroup(group.grpId, 'New Group Name');
await acc.updateGroupDescription(group, 'A group for weekend activities');
```

### Leave Group

```ts
await acc.leaveGroup(group.grpId);
```

### Lookup Groups

```ts
// Get by ID
const g = acc.getGroup(group.grpId);

// List all known groups
for (const g of acc.listGroups()) {
    console.log(`${g.grpId}: ${g.name} (${g.members.length} members)`);
}
```

### Join Group via Invite URI

```ts
const result = await acc.joinGroup('https://i.delta.chat/#...');
console.log(result.groupInfo?.name);  // auto-registered in local registry
```

---

## Broadcast Channels

Broadcast channels are one-to-many: only the owner can send.
All channel methods accept a **channel ID string** or **GroupInfo object**.

### Create a Channel

```ts
const channel = await acc.createChannel(
    'Breaking News',
    'Latest updates from our team',
    [bobContactId, carolContact]
);
```

### Broadcast to All Subscribers

```ts
const msgId = await acc.sendBroadcast(channel, '🚨 Important update!');
// or by ID
const msgId2 = await acc.sendBroadcast(channel.grpId, 'Also by ID');
```

### Or Use `sendGroupMessage`

```ts
const msgId = await acc.sendGroupMessage(channel.grpId, 'Another update');
```

---

## SecureJoin (Verified Contacts)

SecureJoin establishes end-to-end verified contacts via a QR-code
handshake. Both peers must be online simultaneously.

### Inviter Side (Generate QR)

```ts
// Generate invite URI (displayed as QR code)
const uri = alice.generateSecureJoinURI();
console.log(uri);
// → https://i.delta.chat/#89EDF8...&a=alice@relay.example&n=Alice&i=...&s=...

// Alice stays online — the SDK auto-responds to the joiner
```

### Joiner Side (Scan QR)

```ts
// Bob scans Alice's QR code / pastes the URI
const { contactId, peerEmail, verified } = await bob.secureJoin(uri);

console.log(contactId);     // 'f3a7b2c1d9e8' (random contact ID)
console.log(contact.email); // 'alice@relay.example'
console.log(contact.name);  // 'Alice'
console.log(verified);      // true

// Message using contact ID or the contact object directly
await bob.sendMessage(contactId, 'Hello Alice!');
await bob.sendMessage(contact, 'Contact object works too!');
```

### Parse a SecureJoin URI (without joining)

```ts
const parsed = acc.parseSecureJoinURI(uri);
console.log(parsed.inviterEmail);  // 'alice@relay.example'
console.log(parsed.fingerprint);   // PGP fingerprint
console.log(parsed.name);          // 'Alice'
console.log(parsed.groupName);     // group name (if group invite)
```

---

## Profile & Avatars

### Display Name

```ts
acc.setDisplayName('Alice Wonderland');
console.log(acc.getDisplayName()); // 'Alice Wonderland'
```

### Profile Photo

```ts
// From base64
acc.setProfilePhotoB64(base64Data, 'image/jpeg');

// From file (Node.js only)
await acc.setProfilePhoto('/path/to/avatar.jpg');

// Send to a specific contact (by email — profile photos use email internally)
await acc.sendProfilePhoto('bob@relay.example');

// Broadcast to all known contacts
await acc.broadcastProfilePhoto();
```

### Get Peer Avatar

```ts
const contact = acc.getContact(contactId);
const avatar = contact?.avatar;
if (avatar) {
    // avatar is a base64 data URI
    document.getElementById('avatar').src = avatar;
}
```

---

## Persistent Storage

The SDK automatically persists account state, contacts, chats, and
messages via the injected store.

### Save & Restore

```ts
// Save current state (keys, contacts, known peers)
await acc.saveToStore();

// On next launch, restore:
const acc = await DeltaChatAccount.fromStore(store);
if (acc) {
    console.log(`Restored: ${acc.getCredentials().email} (ID: ${acc.id})`);
    await acc.connect();
} else {
    console.log('No saved account, register new');
}
```

### Direct Store Access

```ts
// All contacts
const contacts = await acc.getContacts();

// Search contacts
const results = await acc.searchContacts('bob');

// All chats
const chats = await acc.getChatList();

// Search chats
const found = await acc.searchChats('weekend');

// Chat messages (paginated)
const msgs = await acc.getChatMessages('bob@relay.example', 50, 0);

// Search messages globally
const hits = await acc.searchMessages('important');

// Search within a specific chat
const chatHits = await acc.searchMessages('meeting', 'bob@relay.example');
```

---

## Chat Management

### Create or Get Chat

```ts
const chat = await acc.getOrCreateChat('bob@relay.example');
```

### Archive / Pin / Mute

```ts
await acc.archiveChat('bob@relay.example', true);   // archive
await acc.archiveChat('bob@relay.example', false);   // unarchive

await acc.pinChat('bob@relay.example', true);

await acc.muteChat('bob@relay.example', true);
```

### Mark as Read

```ts
await acc.markChatRead('bob@relay.example');
```

### Delete Chat

```ts
await acc.deleteChat('bob@relay.example');
```

### Delete Single Message (Local)

```ts
await acc.deleteLocalMessage('<msg-id@relay.example>');
```

### Unread Count

```ts
const total = await acc.getUnreadCount();
console.log(`${total} unread messages`);
```

---

## WebSocket Protocol (Low-Level)

The SDK exposes the raw bidirectional WebSocket protocol for
advanced IMAP operations.

### List Mailboxes

```ts
const mailboxes = await acc.wsRequest('list_mailboxes');
// → [{ name: 'INBOX', messages: 42, unseen: 3 }, ...]
```

### List Messages in a Mailbox

```ts
const summaries = await acc.wsRequest('list_messages', {
    mailbox: 'INBOX',
    limit: 20,
    offset: 0
});
```

### Fetch a Single Message

```ts
const detail = await acc.wsRequest('fetch', { uid: 123 });
console.log(detail.body);     // raw RFC 5322
console.log(detail.envelope); // IMAP envelope
```

### Flag Operations

```ts
// Mark as read
await acc.wsRequest('flags', {
    uid: 123,
    operation: 'add',
    flags: ['\\Seen']
});

// Star a message
await acc.wsRequest('flags', {
    uid: 123,
    operation: 'add',
    flags: ['\\Flagged']
});
```

### Move / Copy / Delete

```ts
await acc.wsRequest('move', { uid: 123, destination: 'Archive' });
await acc.wsRequest('copy', { uid: 123, destination: 'Important' });
await acc.wsRequest('delete', { uid: 123 });
```

### Search

```ts
const results = await acc.wsRequest('search', {
    mailbox: 'INBOX',
    from: 'alice@relay.example'
});
```

### Mailbox Management

```ts
await acc.wsRequest('create_mailbox', { name: 'Projects' });
await acc.wsRequest('rename_mailbox', { name: 'Projects', newName: 'Work' });
await acc.wsRequest('delete_mailbox', { name: 'Work' });
```

---

## Browser (IndexedDB)

In browser environments, use `IndexedDBStore` for persistent storage:

```ts
import { DeltaChatAccount } from 'madcore-web';
import { IndexedDBStore } from 'madcore-web/store';

const store = new IndexedDBStore('my-app');
const acc = new DeltaChatAccount(store);

// Try restoring a previous session
const loaded = await acc.loadFromStore();
if (!loaded) {
    await acc.register('https://relay.example');
    await acc.generateKeys('Alice');
    await acc.saveToStore();
}

await acc.connect();
```

### Multi-Account in Browser

```ts
import { DeltaChatSDK } from 'madcore-web';
import { IndexedDBStore } from 'madcore-web/store';

const dc = DeltaChatSDK({
    logLevel: 'debug',
    store: new IndexedDBStore('my-app'),
});

// Each account gets a random ID and an isolated IndexedDB database
const work     = await dc.register(SERVER, 'Work Account');
const personal = await dc.register(SERVER, 'Personal');

const workAcc     = dc.getAccount(work.id);
const personalAcc = dc.getAccount(personal.id);

await Promise.all([workAcc.connect(), personalAcc.connect()]);

// Connect work account to a second relay
await workAcc.connect('https://backup-relay.example');
```

---

## Crypto Utilities

### Get PGP Fingerprint from Armored Key

```ts
import { getFingerprintFromArmored } from 'madcore-web';

const fp = await getFingerprintFromArmored(armoredPublicKey);
console.log(fp); // '89EDF8188BA275C5...'
```

### Get Own Fingerprint

```ts
const fp = acc.getFingerprint();
console.log(`My fingerprint: ${fp}`);
```

### Import a Contact's Public Key

```ts
const bob = await acc.createContact({
    email: 'bob@relay.example',
    name: 'Bob',
    key: armoredPublicKey,
});
await acc.send(bob, { text: 'Encrypted with imported key' });
```

### Get Known Keys

```ts
const keys = acc.getKnownKeys();
for (const [email, armoredKey] of keys) {
    console.log(`${email}: ${armoredKey.substring(0, 40)}...`);
}
```

### Get Own Public Key (Armored)

```ts
const pubKey = acc.getPublicKeyArmored();
```

---

## Related Documentation

- [Security & Advanced Features](./security.md) — PGP, Autocrypt, SecureJoin, media handling
- [Architecture & Protocol Internals](./architecture.md) — WebSocket protocol, UID system, module layout
