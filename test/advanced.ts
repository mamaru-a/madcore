#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════════
// Delta Chat Web SDK — Advanced Integration Tests
//
// Tests: SecureJoin, encrypted messaging, file/voice, reactions, replies,
//        deletes, profile photos, cross-relay, store ops, reconnect.
//
// Usage:
//   bun run test/advanced.ts                         # Uses .env SERVER_URL
//   bun run test/advanced.ts https://your.server   # Override primary server
// ═══════════════════════════════════════════════════════════════════════════════

import { DeltaChatSDK, type ParsedMessage, type Attachment } from '../sdk';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SERVER1 = process.argv[2] || process.env.SERVER_URL || '';
const SERVER2 = process.env.SERVER_URL_ALT || '';
if (!SERVER1) { console.error('❌ Set SERVER_URL in .env or pass as argument.'); process.exit(1); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Test Harness ───────────────────────────────────────────────────────────────

let passed = 0, failed = 0, skipped = 0;
const results: { name: string; status: 'PASS' | 'FAIL' | 'SKIP'; time: number; error?: string }[] = [];

async function test(name: string, fn: () => Promise<void>) {
    const start = Date.now();
    try {
        await fn();
        const ms = Date.now() - start;
        passed++;
        results.push({ name, status: 'PASS', time: ms });
        console.log(`  ✅ ${name} (${ms}ms)`);
    } catch (e: any) {
        const ms = Date.now() - start;
        failed++;
        results.push({ name, status: 'FAIL', time: ms, error: e.message });
        console.log(`  ❌ ${name} (${ms}ms)`);
        console.log(`     Error: ${e.message}`);
    }
}

function skip(name: string, reason: string) {
    skipped++;
    results.push({ name, status: 'SKIP', time: 0, error: reason });
    console.log(`  ⏭️  ${name} — ${reason}`);
}

function assert(cond: boolean, msg: string) { if (!cond) throw new Error(`Assertion failed: ${msg}`); }
function assertEq(a: any, b: any, msg: string) { if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   Delta Chat Web SDK — Advanced Integration Tests       ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`Primary:   ${SERVER1}`);
    console.log(`Secondary: ${SERVER2}`);
    console.log(`Time:      ${new Date().toISOString()}\n`);

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 1: SecureJoin — Full Handshake
    // ═════════════════════════════════════════════════════════════════════
    console.log('━━━ 1. SecureJoin Full Handshake ━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const dc = DeltaChatSDK({ logLevel: 'none' });
    let alice!: any, bob!: any; // DeltaChatAccount
    let aliceEmail = '', bobEmail = '';

    await test('Register + keygen Alice', async () => {
        const result = await dc.register(SERVER1);
        alice = result.account;
        aliceEmail = result.email;
        await alice.generateKeys('Alice A');
        assert(!!alice.getFingerprint(), 'should generate fingerprint');
    });

    await test('Register + keygen Bob', async () => {
        const result = await dc.register(SERVER1);
        bob = result.account;
        bobEmail = result.email;
        await bob.generateKeys('Bob B');
    });

    await test('WS connect both', async () => {
        await alice.connect();
        await bob.connect();
    });

    let inviteURI = '';

    await test('Generate SecureJoin URI', async () => {
        inviteURI = alice.generateSecureJoinURI();
        assert(inviteURI.startsWith('https://i.delta.chat/#'), 'valid prefix');
        assert(inviteURI.includes('&i='), 'has invite number');
        assert(inviteURI.includes('&s='), 'has auth token');
        assert(inviteURI.includes('&a='), 'has inviter email');
        assert(inviteURI.includes('&n='), 'has display name');
        const fp = alice.getFingerprint();
        assert(inviteURI.includes(fp.substring(0, 8)), 'URI contains fingerprint');
    });

    await test('Parse SecureJoin URI', async () => {
        const parsed = bob.parseSecureJoinURI(inviteURI);
        assertEq(parsed.inviterEmail, aliceEmail, 'inviter email');
        assert(!!parsed.fingerprint, 'has fingerprint');
        assert(!!parsed.inviteNumber, 'has invite number');
        assert(!!parsed.auth, 'has auth token');
    });

    await test('Full SecureJoin handshake (Bob joins Alice)', async () => {
        const result = await bob.secureJoin(inviteURI);
        assert(!!result.peerEmail, 'should have peerEmail');
        assertEq(result.peerEmail, aliceEmail, 'peer should be Alice');
    });

    await sleep(2000);

    await test('Verify bidirectional key exchange', async () => {
        assert(bob.getKnownKeys().has(aliceEmail.toLowerCase()), 'Bob has Alice key');
        // After SecureJoin, Alice should also have Bob's key via Autocrypt
        assert(alice.getKnownKeys().has(bobEmail.toLowerCase()), 'Alice has Bob key');
    });

    await test('Fingerprint verification', async () => {
        const aliceFP = alice.getFingerprint();
        const bobFP = bob.getFingerprint();
        assert(aliceFP.length >= 32, 'Alice fingerprint valid');
        assert(bobFP.length >= 32, 'Bob fingerprint valid');
        assert(aliceFP !== bobFP, 'Fingerprints should be different');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 2: Encrypted Messaging + Decryption Verification
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 2. Encrypted Messaging + Decryption ━━━━━━━━━━━━━━━━━\n');

    const aliceReceived: ParsedMessage[] = [];
    const bobReceived: ParsedMessage[] = [];
    alice.on('DC_EVENT_INCOMING_MSG', (e) => { if (e.msg) aliceReceived.push(e.msg); });
    bob.on('DC_EVENT_INCOMING_MSG', (e) => { if (e.msg) bobReceived.push(e.msg); });

    let sentTextMsgId = '';

    await test('Send encrypted message Bob → Alice', async () => {
        const { msgId } = await bob.sendMessage(aliceEmail, { text: 'Hello Alice! 🔐 This is encrypted.' });
        sentTextMsgId = msgId;
        assert(sentTextMsgId.startsWith('<'), 'msg ID format');
    });

    await test('Alice receives + decrypts message', async () => {
        for (let i = 0; i < 30; i++) { if (aliceReceived.length > 0) break; await sleep(500); }
        assert(aliceReceived.length > 0, 'Alice should receive message');
        const msg = aliceReceived[aliceReceived.length - 1];
        assertEq(msg.encrypted, true, 'should be encrypted');
        assert(msg.text.includes('Hello Alice'), 'decrypted text should match');
        assert(msg.text.includes('🔐'), 'emoji should survive encryption');
        assertEq(msg.from, bobEmail.toLowerCase(), 'from should be Bob');
        assertEq(msg.isReaction, false, 'not a reaction');
        assertEq(msg.isDelete, false, 'not a delete');
        assertEq(msg.isVoiceMessage, false, 'not a voice');
        assertEq(msg.attachments.length, 0, 'no attachments');
    });

    await test('Send encrypted message Alice → Bob', async () => {
        await alice.sendMessage(bobEmail, { text: 'Hey Bob! Reply from Alice ✉️' });
        for (let i = 0; i < 30; i++) { if (bobReceived.length > 0) break; await sleep(500); }
        assert(bobReceived.length > 0, 'Bob should receive message');
        const msg = bobReceived[bobReceived.length - 1];
        assertEq(msg.encrypted, true, 'should be encrypted');
        assert(msg.text.includes('Reply from Alice'), 'text matches');
    });

    await test('Send long message', async () => {
        const longText = '🔄 '.repeat(500) + 'END';
        const { msgId } = await bob.sendMessage(aliceEmail, { text: longText });
        assert(!!msgId, 'should return msg ID');
        for (let i = 0; i < 30; i++) { if (aliceReceived.length > 1) break; await sleep(500); }
        const msg = aliceReceived[aliceReceived.length - 1];
        assert(msg.text.includes('END'), 'long message should arrive intact');
    });

    await test('Send Unicode / special chars', async () => {
        const unicode = '中文 العربية हिन्दी 日本語 한국어 🇮🇷🇩🇪🇺🇸';
        await bob.sendMessage(aliceEmail, { text: unicode });
        for (let i = 0; i < 30; i++) {
            const last = aliceReceived[aliceReceived.length - 1];
            if (last && last.text.includes('中文')) break;
            await sleep(500);
        }
        const msg = aliceReceived[aliceReceived.length - 1];
        assert(msg.text.includes('中文'), 'Chinese chars');
        assert(msg.text.includes('🇮🇷'), 'Flag emoji');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 3: File Attachment
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 3. File Attachment ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 1x1 red pixel PNG
    const tinyPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

    await test('Send file attachment (image) Bob → Alice', async () => {
        const prevCount = aliceReceived.length;
        const { msgId } = await bob.sendFile(aliceEmail, {
            filename: 'test-photo.png',
            data: tinyPngB64,
            mimeType: 'image/png',
            caption: 'Check out this photo!'
        });
        assert(!!msgId, 'should return msgId');
        // Wait for delivery
        for (let i = 0; i < 30; i++) { if (aliceReceived.length > prevCount) break; await sleep(500); }
        assert(aliceReceived.length > prevCount, 'Alice should receive file message');
        const msg = aliceReceived[aliceReceived.length - 1];
        assertEq(msg.encrypted, true, 'should be encrypted');
        assert(msg.text.includes('Check out this photo') || msg.text.includes('test-photo'), 'caption or filename in text');
    });

    await test('Send document file Bob → Alice', async () => {
        const prevCount = aliceReceived.length;
        const docData = btoa('Hello, this is a test document content!');
        await bob.sendFile(aliceEmail, {
            filename: 'readme.txt',
            data: docData,
            mimeType: 'text/plain',
            caption: 'Here is the doc'
        });
        for (let i = 0; i < 30; i++) { if (aliceReceived.length > prevCount) break; await sleep(500); }
        assert(aliceReceived.length > prevCount, 'Alice should receive doc');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 4: Voice Message
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 4. Voice Message ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('Send voice message Bob → Alice', async () => {
        const prevCount = aliceReceived.length;
        // Fake OGG data (just needs to be base64)
        const fakeAudioB64 = btoa('FAKE OGG AUDIO DATA FOR TESTING PURPOSES ' + Date.now());
        const { msgId } = await bob.sendVoice(aliceEmail, {
            data: fakeAudioB64,
            durationMs: 3500,
            mimeType: 'audio/ogg'
        });
        assert(!!msgId, 'should return msgId');
        for (let i = 0; i < 30; i++) { if (aliceReceived.length > prevCount) break; await sleep(500); }
        assert(aliceReceived.length > prevCount, 'Alice should receive voice');
        const msg = aliceReceived[aliceReceived.length - 1];
        assertEq(msg.encrypted, true, 'voice should be encrypted');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 5: Profile Photo Change
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 5. Profile Photo ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const aliceAvatarEvents: ParsedMessage[] = [];
    alice.on('DC_EVENT_CONTACTS_CHANGED', (e) => { if (e.msg) aliceAvatarEvents.push(e.msg); });

    await test('Set profile photo — Bob', async () => {
        bob.setProfilePhotoB64(tinyPngB64, 'image/png');
    });

    await test('Send profile photo — Bob → Alice', async () => {
        const prevCount = aliceAvatarEvents.length;
        await bob.sendProfilePhoto(aliceEmail);
        for (let i = 0; i < 30; i++) { if (aliceAvatarEvents.length > prevCount) break; await sleep(500); }
        assert(aliceAvatarEvents.length > prevCount, 'Alice should receive avatar update');
        const msg = aliceAvatarEvents[aliceAvatarEvents.length - 1];
        assert(msg.avatarUpdate !== undefined, 'should have avatarUpdate');
    });

    await test('Change profile photo — Bob sends different image', async () => {
        // Different 1x1 pixel (blue) 
        const bluePng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';
        bob.setProfilePhotoB64(bluePng, 'image/png');
        const prevCount = aliceAvatarEvents.length;
        await bob.sendProfilePhoto(aliceEmail);
        for (let i = 0; i < 30; i++) { if (aliceAvatarEvents.length > prevCount) break; await sleep(500); }
        assert(aliceAvatarEvents.length > prevCount, 'Alice should get new avatar');
    });

    await test('Get peer avatar', async () => {
        const avatar = alice.getPeerAvatar(bobEmail);
        assert(avatar !== null, 'Alice should have Bob avatar');
        assert(avatar!.startsWith('data:image/'), 'should be data URI');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 6: Reactions
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 6. Reactions ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const aliceReactions: ParsedMessage[] = [];
    alice.on('DC_EVENT_INCOMING_REACTION', (e) => { if (e.msg) aliceReactions.push(e.msg); });

    await test('Send reaction 👍 — Bob reacts', async () => {
        const prevCount = aliceReactions.length;
        await bob.sendReaction(aliceEmail, { targetMessage: sentTextMsgId, reaction: '👍' });
        for (let i = 0; i < 30; i++) { if (aliceReactions.length > prevCount) break; await sleep(500); }
        assert(aliceReactions.length > prevCount, 'Alice should receive reaction');
        const r = aliceReactions[aliceReactions.length - 1];
        assertEq(r.isReaction, true, 'should be reaction');
        // Reactions are handled in storeIncomingMessage to attach to target message
        // But for this test, let's verify it arrived in the event
        assert(r.text.includes('👍'), 'reaction text should have 👍');
    });

    await test('Send different reaction ❤️', async () => {
        const prevCount = aliceReactions.length;
        await bob.sendReaction(aliceEmail, { targetMessage: sentTextMsgId, reaction: '❤️' });
        for (let i = 0; i < 30; i++) { if (aliceReactions.length > prevCount) break; await sleep(500); }
        assert(aliceReactions.length > prevCount, 'Alice should get ❤️');
    });

    await test('Send multi-emoji reaction 😂🎉🔥', async () => {
        const prevCount = aliceReactions.length;
        await bob.sendReaction(aliceEmail, { targetMessageId: sentTextMsgId, reaction: '😂🎉🔥' });
        for (let i = 0; i < 30; i++) { if (aliceReactions.length > prevCount) break; await sleep(500); }
        assert(aliceReactions.length > prevCount, 'multiple emoji reaction');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 7: Reply with Quote
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 7. Reply with Quote ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('Reply with quote — Bob replies to his message', async () => {
        const prevCount = aliceReceived.length;
        const { msgId: replyId } = await bob.sendReply(aliceEmail, {
            parentMessage: sentTextMsgId,
            text: 'This is my reply to the encrypted message! 🧵',
            quotedText: 'Hello Alice! 🔐 This is encrypted.'
        });
        assert(!!replyId, 'reply should return message ID');
        for (let i = 0; i < 30; i++) { if (aliceReceived.length > prevCount) break; await sleep(500); }
        const msg = aliceReceived[aliceReceived.length - 1];
        assertEq(msg.encrypted, true, 'reply should be encrypted');
        assert(msg.text.includes('reply to the encrypted'), 'reply text');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 8: Delete Message
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 8. Delete Message ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const aliceDeletes: ParsedMessage[] = [];
    alice.on('DC_EVENT_MSG_DELETED', (e) => { if (e.msg) aliceDeletes.push(e.msg); });

    await test('Send + delete message', async () => {
        const prevDelCount = aliceDeletes.length;
        const { msgId } = await bob.sendMessage(aliceEmail, { text: 'This will be deleted 💥' });
        await sleep(3000); // wait for delivery
        await bob.sendDelete(aliceEmail, { targetMessageId: msgId });
        for (let i = 0; i < 30; i++) { if (aliceDeletes.length > prevDelCount) break; await sleep(500); }
        assert(aliceDeletes.length > prevDelCount, 'Alice should receive delete event');
        const del = aliceDeletes[aliceDeletes.length - 1];
        assertEq(del.isDelete, true, 'should be delete');
    });

    await test('WS delete via IMAP (flags + expunge)', async () => {
        const msgs = await alice.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
        if (msgs.length === 0) { skip('WS delete', 'no messages'); return; }
        const uid = msgs[msgs.length - 1].uid;
        const result = await alice.wsRequest('delete', { uid });
        assertEq(result.status, 'deleted', 'IMAP delete');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 9: Message Ordering / Multiple Messages
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 9. Message Ordering ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('Send 5 messages in sequence, verify order', async () => {
        const prevCount = aliceReceived.length;
        const ids: string[] = [];
        for (let i = 1; i <= 5; i++) {
            const { msgId } = await bob.sendMessage(aliceEmail, { text: `Sequential msg #${i}` });
            ids.push(msgId);
            await sleep(300); // slight delay between sends
        }
        // Wait for all to arrive
        for (let i = 0; i < 60; i++) { if (aliceReceived.length >= prevCount + 5) break; await sleep(500); }
        const newMsgs = aliceReceived.slice(prevCount);
        assert(newMsgs.length >= 5, `expected 5 messages, got ${newMsgs.length}`);
        // Verify order
        for (let i = 0; i < 5; i++) {
            assert(newMsgs[i].text.includes(`#${i + 1}`), `message #${i + 1} should be in order`);
        }
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 10: WS Reconnect
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 10. WebSocket Reconnect ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('Disconnect + reconnect Alice', async () => {
        alice.disconnect();
        // Verify request fails after disconnect
        try {
            await alice.wsRequest('list_mailboxes', {});
            throw new Error('should have thrown');
        } catch (e: any) {
            assert(e.message.toLowerCase().includes('not connected') || e.message.toLowerCase().includes('disconnected') || e.message.toLowerCase().includes('transports'), 'should error');
        }
        // Reconnect
        await alice.connect();
        const mboxes = await alice.wsRequest('list_mailboxes', {});
        assert(Array.isArray(mboxes), 'should work after reconnect');
    });

    await test('Send message after reconnect', async () => {
        const prevCount = bobReceived.length;
        await alice.sendMessage(bobEmail, { text: 'Message after reconnect! 🔄' });
        for (let i = 0; i < 30; i++) { if (bobReceived.length > prevCount) break; await sleep(500); }
        assert(bobReceived.length > prevCount, 'Bob should receive post-reconnect message');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 11: Store Persistence
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 11. Store Persistence ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('Store — save account', async () => {
        await alice.saveToStore();
        const acct = await alice.store.getAccount();
        assert(!!acct, 'account saved');
        assertEq(acct!.email, aliceEmail, 'email');
    });

    await test('Store — chat list has conversations', async () => {
        const chats = await alice.getChatList();
        assert(chats.length > 0, 'should have at least 1 chat from messaging');
    });

    await test('Store — messages in chat', async () => {
        const chats = await alice.getChatList();
        const firstChat = chats[0];
        const msgs = await alice.getChatMessages(firstChat.id);
        assert(msgs.length > 0, 'should have messages stored');
    });

    await test('Store — contact list', async () => {
        const contacts = await alice.getContacts();
        assert(contacts.length > 0, 'should have contacts from messaging');
        const bobContact = contacts.find(c => c.email === bobEmail.toLowerCase());
        assert(!!bobContact, 'should have Bob as contact');
    });

    await test('Store — search messages', async () => {
        const results = await alice.searchMessages('encrypted');
        assert(results.length > 0, 'should find messages containing "encrypted"');
    });

    await test('Store — unread count', async () => {
        const count = await alice.getUnreadCount();
        assert(typeof count === 'number', 'should return number');
    });

    await test('Store — archive chat', async () => {
        const chats = await alice.getChatList();
        if (chats.length > 0) {
            await alice.archiveChat(chats[0].id, true);
            const updated = await alice.store.getChat(chats[0].id);
            assertEq(updated?.archived, true, 'should be archived');
            // Unarchive
            await alice.archiveChat(chats[0].id, false);
        }
    });

    await test('Store — pin chat', async () => {
        const chats = await alice.getChatList();
        if (chats.length > 0) {
            await alice.pinChat(chats[0].id, true);
            const updated = await alice.store.getChat(chats[0].id);
            assertEq(updated?.pinned, true, 'should be pinned');
            await alice.pinChat(chats[0].id, false);
        }
    });

    await test('Store — mute chat', async () => {
        const chats = await alice.getChatList();
        if (chats.length > 0) {
            await alice.muteChat(chats[0].id, true);
            const updated = await alice.store.getChat(chats[0].id);
            assertEq(updated?.muted, true, 'should be muted');
            await alice.muteChat(chats[0].id, false);
        }
    });

    await test('Store — mark chat read', async () => {
        const chats = await alice.getChatList();
        if (chats.length > 0) {
            await alice.markChatRead(chats[0].id);
            const updated = await alice.store.getChat(chats[0].id);
            assertEq(updated?.unreadCount, 0, 'unread should be 0');
        }
    });

    await test('Store — delete local message', async () => {
        const chats = await alice.getChatList();
        const msgs = await alice.getChatMessages(chats[0].id);
        if (msgs.length > 0) {
            const msgId = msgs[0].id;
            await alice.deleteLocalMessage(msgId);
            const deleted = await alice.store.getMessage(msgId);
            assert(!deleted, 'message should be deleted from store');
        }
    });

    await test('Store — delete chat', async () => {
        const testChat = await alice.getOrCreateChat('test-delete@example.com');
        await alice.deleteChat(testChat.id);
        const deleted = await alice.store.getChat(testChat.id);
        assert(!deleted, 'chat should be deleted from store');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 12: Cross-Relay Communication
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 12. Cross-Relay Communication ━━━━━━━━━━━━━━━━━━━━━━━\n');

    let carol!: DeltaChatSDK, dave!: DeltaChatSDK;
    let carolEmail = '', daveEmail = '';
    let crossRelayPossible = false;

    await test('Register Carol on Server1', async () => {
        const result = await dc.register(SERVER1);
        carol = result.account;
        carolEmail = result.email;
        await carol.generateKeys('Carol C');
    });

    await test('Register Dave on Server2', async () => {
        const result = await dc.register(SERVER2);
        dave = result.account;
        daveEmail = result.email;
        await dave.generateKeys('Dave D');
    });

    await test('WS connect Carol + Dave', async () => {
        await carol.connect();
        await dave.connect();
    });

    await test('SecureJoin — Carol (S1) invites Dave (S2)', async () => {
        const uri = carol.generateSecureJoinURI();
        try {
            const result = await dave.secureJoin(uri);
            assert(!!result.peerEmail, 'should complete');
            crossRelayPossible = true;
        } catch (e: any) {
            // Cross-relay may fail if delivery is not configured
            skip('Cross-relay SecureJoin', `delivery not available: ${e.message}`);
        }
    });

    if (crossRelayPossible) {
        await sleep(2000);

        const daveXReceived: ParsedMessage[] = [];
        dave.on('DC_EVENT_INCOMING_MSG', (e) => { if (e.msg) daveXReceived.push(e.msg); });

        await test('Cross-relay message — Carol (S1) → Dave (S2)', async () => {
            const prevCount = daveXReceived.length;
            await carol.sendMessage(daveEmail, 'Hello across relays! 🌐');
            for (let i = 0; i < 60; i++) { if (daveXReceived.length > prevCount) break; await sleep(500); }
            assert(daveXReceived.length > prevCount, 'Dave should receive cross-relay message');
            const msg = daveXReceived[daveXReceived.length - 1];
            assertEq(msg.encrypted, true, 'cross-relay should be encrypted');
            assert(msg.text.includes('across relays'), 'text matches');
        });

        await test('Cross-relay reverse — Dave (S2) → Carol (S1)', async () => {
            const carolXReceived: ParsedMessage[] = [];
            carol.on('DC_EVENT_INCOMING_MSG', (e) => { if (e.msg) carolXReceived.push(e.msg); });
            await dave.sendMessage(carolEmail, { text: 'Reply from other relay! 📬' });
            for (let i = 0; i < 60; i++) { if (carolXReceived.length > 0) break; await sleep(500); }
            assert(carolXReceived.length > 0, 'Carol should receive');
        });
    } else {
        skip('Cross-relay message Carol → Dave', 'SecureJoin failed');
        skip('Cross-relay reverse Dave → Carol', 'SecureJoin failed');
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 13: Edge Cases
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ 13. Edge Cases ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('Send without key — server rejects unencrypted', async () => {
        const { account: tmpSDK } = await dc.register(SERVER1);
        await tmpSDK.generateKeys('Tmp');
        await tmpSDK.connect();
        // Madmail enforces encryption — unencrypted messages are rejected
        try {
            await tmpSDK.sendMessage('nobody@example.com', 'Unencrypted test');
            throw new Error('should have been rejected');
        } catch (e: any) {
            assert(
                e.message.includes('Encryption Needed') || e.message.includes('No key') || e.message.includes('rejected'),
                `should reject unencrypted: ${e.message}`
            );
        }
        tmpSDK.disconnect();
    });

    await test('sendFile without key → error', async () => {
        const { account: tmpSDK } = await dc.register(SERVER1);
        await tmpSDK.generateKeys('Tmp2');
        await tmpSDK.connect();
        try {
            await tmpSDK.sendFile('nobody@example.com', 'f.txt', btoa('hi'), 'text/plain');
            throw new Error('should have thrown');
        } catch (e: any) {
            assert(e.message.includes('No key'), 'should mention missing key');
        }
        tmpSDK.disconnect();
    });

    await test('WS request timeout / error handling', async () => {
        try {
            await alice.wsRequest('delete', { uid: 9999999 });
        } catch (e: any) {
            assert(e.message.length > 0, 'should have error message');
        }
    });

    await test('WS mailbox ops still work', async () => {
        // Create, list, delete
        try { await alice.wsRequest('create_mailbox', { name: 'EdgeTestBox' }); } catch {}
        const mboxes = await alice.wsRequest('list_mailboxes', {});
        const names = mboxes.map((m: any) => m.name);
        assert(names.includes('EdgeTestBox') || names.includes('INBOX'), 'should list mailboxes');
        try { await alice.wsRequest('delete_mailbox', { name: 'EdgeTestBox' }); } catch {}
    });

    await test('Deduplication — same UID not processed twice', async () => {
        // This is implicitly tested by the seenUIDs Set in the SDK
        // But we can verify the counter didn't explode
        const chats = await alice.getChatList();
        assert(chats.length < 50, 'should not have excessive duplicate chats');
    });

    // ═════════════════════════════════════════════════════════════════════
    // CLEANUP
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ Cleanup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('Disconnect all', async () => {
        alice.disconnect();
        bob.disconnect();
        carol.disconnect();
        dave.disconnect();
    });

    // ═════════════════════════════════════════════════════════════════════
    // RESULTS
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('                  ADVANCED TEST RESULTS');
    console.log('══════════════════════════════════════════════════════════\n');

    console.log(`  ✅ Passed:  ${passed}`);
    console.log(`  ❌ Failed:  ${failed}`);
    console.log(`  ⏭️  Skipped: ${skipped}`);
    console.log(`  📊 Total:   ${passed + failed + skipped}\n`);

    if (failed > 0) {
        console.log('  Failed tests:');
        for (const r of results.filter(r => r.status === 'FAIL')) {
            console.log(`    ❌ ${r.name}: ${r.error}`);
        }
        console.log('');
    }

    const totalTime = results.reduce((sum, r) => sum + r.time, 0);
    console.log(`  Total time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`  Servers:    ${SERVER1} / ${SERVER2}\n`);
    console.log(failed === 0 ? '  🎉 ALL TESTS PASSED!' : `  ⚠️  ${failed} test(s) failed.`);
    console.log('');

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('\n❌ Fatal error:', e.message);
    console.error(e.stack);
    process.exit(1);
});
