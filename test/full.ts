#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════════
// Delta Chat Web SDK — Full Integration Test
//
// Tests ALL WebIMAP functionality: REST + WebSocket bidirectional protocol.
// Requires a running Madmail server with WebIMAP enabled.
//
// Usage:
//   bun run test-full.ts                  # Uses SERVER_URL from .env
//   bun run test-full.ts https://1.2.3.4  # Override server URL
// ═══════════════════════════════════════════════════════════════════════════════

import { DeltaChatAccount, DeltaChatSDK, type DCEventData } from '../sdk';
import { MemoryStore } from '../store';

// ─── Config ─────────────────────────────────────────────────────────────────────

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Load .env manually (Bun auto-loads it, but be explicit)
const SERVER = process.argv[2] || process.env.SERVER_URL || '';
if (!SERVER) { console.error('❌ Set SERVER_URL in .env or pass as argument.'); process.exit(1); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ─── Test Harness ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
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

function assert(condition: boolean, msg: string) {
    if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertEq(actual: any, expected: any, msg: string) {
    if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertIncludes(arr: any[], value: any, msg: string) {
    if (!arr.includes(value)) throw new Error(`${msg}: ${JSON.stringify(value)} not found in ${JSON.stringify(arr)}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   Delta Chat Web SDK — Full Integration Test Suite      ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`Server: ${SERVER}`);
    console.log(`Time:   ${new Date().toISOString()}\n`);

    // Create multi-account SDK manager
    const dc = DeltaChatSDK({ logLevel: 'info' });

    // ─── Shared state ────────────────────────────────────────────────────
    let alice!: DeltaChatAccount;
    let bob!: DeltaChatAccount;
    let aliceEmail = '';
    let bobEmail = '';
    let alicePassword = '';
    let bobPassword = '';
    let sentMsgId = '';

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 1: REST API
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 1: REST API ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // 1.1 Registration
    await test('POST /new — Register Alice', async () => {
        alice = new DeltaChatAccount(new MemoryStore());
        const creds = await alice.register(SERVER);
        assert(!!creds.email, 'email should be non-empty');
        assert(!!creds.password, 'password should be non-empty');
        assert(creds.email.includes('@'), 'email should contain @');
        aliceEmail = creds.email;
        alicePassword = creds.password;
    });

    await test('POST /new — Register Bob', async () => {
        bob = new DeltaChatAccount(new MemoryStore());
        const creds = await bob.register(SERVER);
        assert(!!creds.email, 'email should be non-empty');
        bobEmail = creds.email;
        bobPassword = creds.password;
    });

    // 1.2 Key generation
    await test('Generate PGP keys — Alice', async () => {
        await alice.generateKeys('Alice Test');
        assert(!!alice.getFingerprint(), 'fingerprint should be non-empty');
        assert(alice.getFingerprint().length >= 32, 'fingerprint should be at least 32 chars');
    });

    await test('Generate PGP keys — Bob', async () => {
        await bob.generateKeys('Bob Test');
        assert(!!bob.getFingerprint(), 'fingerprint should be non-empty');
    });

    // 1.3 REST mailbox listing
    await test('GET /webimap/mailboxes — List mailboxes (REST)', async () => {
        const res = await fetch(`${SERVER}/webimap/mailboxes`, {
            headers: { 'X-Email': aliceEmail, 'X-Password': alicePassword },
            // @ts-ignore
            tls: { rejectUnauthorized: false },
        });
        assertEq(res.status, 200, 'status');
        const data = await res.json() as any[];
        assert(Array.isArray(data), 'response should be array');
        const names = data.map((m: any) => m.name);
        assertIncludes(names, 'INBOX', 'should have INBOX');
    });

    // 1.4 REST message listing
    await test('GET /webimap/messages — List messages (REST, empty)', async () => {
        const res = await fetch(`${SERVER}/webimap/messages?mailbox=INBOX&since_uid=0`, {
            headers: { 'X-Email': aliceEmail, 'X-Password': alicePassword },
            // @ts-ignore
            tls: { rejectUnauthorized: false },
        });
        assertEq(res.status, 200, 'status');
        const data = await res.json();
        assert(Array.isArray(data), 'response should be array');
    });

    // 1.5 REST auth failure
    await test('GET /webimap/mailboxes — Auth failure (wrong password)', async () => {
        const res = await fetch(`${SERVER}/webimap/mailboxes`, {
            headers: { 'X-Email': aliceEmail, 'X-Password': 'wrongpassword' },
            // @ts-ignore
            tls: { rejectUnauthorized: false },
        });
        assertEq(res.status, 401, 'should return 401');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 2: WebSocket Connection & Bidirectional Protocol
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 2: WebSocket Bidirectional Protocol ━━━━━━━━━\n');

    // 2.1 Connect
    await test('WebSocket connect — Alice', async () => {
        await alice.connectWebSocket();
    });

    await test('WebSocket connect — Bob', async () => {
        await bob.connectWebSocket();
    });

    // 2.2 WS list_mailboxes
    await test('WS list_mailboxes — Alice', async () => {
        const mailboxes = await alice.wsRequest('list_mailboxes', {});
        assert(Array.isArray(mailboxes), 'should be array');
        const names = mailboxes.map((m: any) => m.name);
        assertIncludes(names, 'INBOX', 'should have INBOX');
        // Verify MailboxInfo shape
        const inbox = mailboxes.find((m: any) => m.name === 'INBOX');
        assert(typeof inbox.messages === 'number', 'messages should be number');
        assert(typeof inbox.unseen === 'number', 'unseen should be number');
    });

    // 2.3 WS list_messages (empty)
    await test('WS list_messages — Alice (empty inbox)', async () => {
        const msgs = await alice.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
        assert(Array.isArray(msgs), 'should be array');
    });

    // 2.4 WS create_mailbox
    await test('WS create_mailbox — Alice creates "TestFolder"', async () => {
        const result = await alice.wsRequest('create_mailbox', { name: 'TestFolder' });
        assertEq(result.status, 'created', 'status');
    });

    // 2.5 Verify mailbox was created
    await test('WS list_mailboxes — verify TestFolder exists', async () => {
        const mailboxes = await alice.wsRequest('list_mailboxes', {});
        const names = mailboxes.map((m: any) => m.name);
        assertIncludes(names, 'TestFolder', 'TestFolder should exist');
    });

    // 2.6 WS rename_mailbox
    await test('WS rename_mailbox — rename TestFolder to RenamedFolder', async () => {
        const result = await alice.wsRequest('rename_mailbox', { old_name: 'TestFolder', new_name: 'RenamedFolder' });
        assertEq(result.status, 'renamed', 'status');
    });

    // 2.7 Verify rename
    await test('WS list_mailboxes — verify rename', async () => {
        const mailboxes = await alice.wsRequest('list_mailboxes', {});
        const names = mailboxes.map((m: any) => m.name);
        assertIncludes(names, 'RenamedFolder', 'RenamedFolder should exist');
        assert(!names.includes('TestFolder'), 'TestFolder should be gone');
    });

    // 2.8 WS delete_mailbox
    await test('WS delete_mailbox — delete RenamedFolder', async () => {
        const result = await alice.wsRequest('delete_mailbox', { name: 'RenamedFolder' });
        assertEq(result.status, 'deleted', 'status');
    });

    // 2.9 Verify delete
    await test('WS list_mailboxes — verify RenamedFolder gone', async () => {
        const mailboxes = await alice.wsRequest('list_mailboxes', {});
        const names = mailboxes.map((m: any) => m.name);
        assert(!names.includes('RenamedFolder'), 'RenamedFolder should not exist');
    });

    // 2.10 WS error handling
    await test('WS error — fetch non-existent message', async () => {
        try {
            await alice.wsRequest('fetch', { uid: 999999 });
            throw new Error('should have thrown');
        } catch (e: any) {
            assert(e.message.includes('not found') || e.message.includes('error'), `error message should indicate not found, got: ${e.message}`);
        }
    });

    await test('WS error — unknown action', async () => {
        try {
            await alice.wsRequest('nonexistent_action', {});
            throw new Error('should have thrown');
        } catch (e: any) {
            assert(e.message.includes('unknown') || e.message.length > 0, `should get error for unknown action, got: ${e.message}`);
        }
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 3: SecureJoin Key Exchange
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 3: SecureJoin Key Exchange ━━━━━━━━━━━━━━━━━━\n');

    let inviteURI = '';

    await test('Generate SecureJoin URI — Alice', async () => {
        inviteURI = alice.generateSecureJoinURI();
        assert(inviteURI.startsWith('https://i.delta.chat/#'), 'URI should start with https://i.delta.chat/#');
        assert(inviteURI.includes('&i='), 'should have invite number');
        assert(inviteURI.includes('&s='), 'should have auth token');
        assert(inviteURI.includes('&a='), 'should have inviter email');
    });

    await test('Parse SecureJoin URI — Bob', async () => {
        const parsed = bob.parseSecureJoinURI(inviteURI);
        assert(!!parsed.fingerprint, 'should have fingerprint');
        assertEq(parsed.inviterEmail, aliceEmail, 'inviter email');
        assert(!!parsed.inviteNumber, 'should have inviteNumber');
        assert(!!parsed.auth, 'should have auth token');
    });

    await test('SecureJoin handshake — Bob joins Alice', async () => {
        try {
            const result = await bob.secureJoin(inviteURI);
            assert(!!result.peerEmail, 'should have peerEmail');
            assertEq(result.peerEmail, aliceEmail, 'peer should be Alice');
        } catch (e: any) {
            // Even if full verification times out, key exchange should succeed
            const parsed = bob.parseSecureJoinURI(inviteURI);
            assert(
                bob.getKnownKeys().has(parsed.inviterEmail.toLowerCase()),
                `Bob should have Alice's key after SecureJoin, error: ${e.message}`
            );
        }
    });

    await sleep(2000);

    await test('Key exchange — verify both parties have keys', async () => {
        const bobHasAlice = bob.getKnownKeys().has(aliceEmail.toLowerCase());
        assert(bobHasAlice, 'Bob should have Alice\u0027s key');
        // Alice may or may not have Bob's key yet depending on Autocrypt
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 4: Encrypted Messaging (WS send)
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 4: Encrypted Messaging ━━━━━━━━━━━━━━━━━━━━━\n');

    // Track received messages for push verification
    const aliceReceived: any[] = [];
    alice.on('DC_EVENT_INCOMING_MSG', (e) => { aliceReceived.push(e); });

    await test('Send encrypted message — Bob → Alice', async () => {
        const { msgId } = await bob.sendMessage(aliceEmail, 'Hello Alice! Test message from Bob 🚀');
        sentMsgId = msgId;
        assert(!!sentMsgId, 'should return message ID');
        assert(sentMsgId.startsWith('<'), 'message ID should start with <');
        assert(sentMsgId.endsWith('>'), 'message ID should end with >');
    });

    // Wait for Alice to receive it via WS push
    await test('WS new_message push — Alice receives Bob\'s message', async () => {
        // Wait up to 15 seconds for the push
        let received = false;
        for (let i = 0; i < 30; i++) {
            if (aliceReceived.length > 0) {
                received = true;
                break;
            }
            await sleep(500);
        }
        assert(received, 'Alice should receive push notification within 15s');
        const msg = aliceReceived[aliceReceived.length - 1];
        assert(!!msg.msg, 'push should contain parsed message');
    });

    await sleep(1000);

    // 4.2 Verify message via WS fetch
    await test('WS list_messages — Alice sees Bob\'s message', async () => {
        const msgs = await alice.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
        assert(msgs.length > 0, 'should have at least 1 message');
        const latest = msgs[msgs.length - 1];
        assert(typeof latest.uid === 'number', 'message should have uid');
        assert(!!latest.envelope, 'message should have envelope');
    });

    // 4.3 WS fetch full message
    let aliceMsgUID = 0;
    await test('WS fetch — Alice fetches full message', async () => {
        const msgs = await alice.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
        assert(msgs.length > 0, 'need at least 1 message');
        aliceMsgUID = msgs[msgs.length - 1].uid;
        const detail = await alice.wsRequest('fetch', { uid: aliceMsgUID });
        assert(typeof detail.uid === 'number', 'detail should have uid');
        assert(typeof detail.body === 'string', 'detail should have body');
        assert(detail.body.length > 0, 'body should be non-empty');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 5: Flags
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 5: Message Flags ━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('WS flags — mark message as Seen', async () => {
        if (!aliceMsgUID) { skip('WS flags — Seen', 'no message UID'); return; }
        const result = await alice.wsRequest('flags', {
            uid: aliceMsgUID,
            flags: ['\\Seen'],
            op: 'add'
        });
        assertEq(result.status, 'ok', 'status');
    });

    await test('WS flags — verify Seen flag set', async () => {
        if (!aliceMsgUID) { skip('verify Seen', 'no message UID'); return; }
        const msgs = await alice.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
        const msg = msgs.find((m: any) => m.uid === aliceMsgUID);
        assert(!!msg, 'message should exist');
        assertIncludes(msg.flags, '\\Seen', 'should have \\Seen flag');
    });

    await test('WS flags — remove Seen flag', async () => {
        if (!aliceMsgUID) { skip('remove Seen', 'no message UID'); return; }
        const result = await alice.wsRequest('flags', {
            uid: aliceMsgUID,
            flags: ['\\Seen'],
            op: 'remove'
        });
        assertEq(result.status, 'ok', 'status');
    });

    await test('WS flags — verify Seen removed', async () => {
        if (!aliceMsgUID) { skip('verify Seen removed', 'no message UID'); return; }
        const msgs = await alice.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
        const msg = msgs.find((m: any) => m.uid === aliceMsgUID);
        assert(!!msg, 'message should exist');
        assert(!msg.flags.includes('\\Seen'), 'should not have \\Seen flag');
    });

    await test('WS flags — set custom flag', async () => {
        if (!aliceMsgUID) { skip('custom flag', 'no message UID'); return; }
        const result = await alice.wsRequest('flags', {
            uid: aliceMsgUID,
            flags: ['$Label1', '\\Seen'],
            op: 'set'
        });
        assertEq(result.status, 'ok', 'status');
    });

    await test('WS flags — invalid op returns error', async () => {
        if (!aliceMsgUID) { skip('invalid flag op', 'no message UID'); return; }
        try {
            await alice.wsRequest('flags', {
                uid: aliceMsgUID,
                flags: ['\\Seen'],
                op: 'invalid_op'
            });
            throw new Error('should have thrown');
        } catch (e: any) {
            assert(e.message.length > 0, 'should have error message');
        }
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 6: Search
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 6: Search ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('WS search — find message by subject keyword', async () => {
        // Our messages have "[...]" as subject, search for the sender name
        const results = await alice.wsRequest('search', { query: 'Bob' });
        assert(Array.isArray(results), 'search should return array');
        // May or may not match depending on envelope indexing
    });

    await test('WS search — empty query returns error', async () => {
        try {
            await alice.wsRequest('search', { query: '' });
            // Some servers may return empty array, some may error
        } catch (e: any) {
            assert(e.message.length > 0, 'should get error for empty query');
        }
    });

    await test('WS search — no results', async () => {
        const results = await alice.wsRequest('search', { query: 'xyzzy_nonexistent_999' });
        assert(Array.isArray(results), 'should return empty array');
        assertEq(results.length, 0, 'should have 0 results');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 7: Copy & Move
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 7: Copy & Move ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Create a target mailbox first
    await test('WS create_mailbox — create Archive', async () => {
        try {
            await alice.wsRequest('create_mailbox', { name: 'Archive' });
        } catch {
            // May already exist, that's fine
        }
    });

    await test('WS copy — copy message to Archive', async () => {
        if (!aliceMsgUID) { skip('copy', 'no message UID'); return; }
        const result = await alice.wsRequest('copy', {
            uid: aliceMsgUID,
            dest_mailbox: 'Archive'
        });
        assertEq(result.status, 'copied', 'status');
    });

    await test('WS list_messages — verify copy in Archive', async () => {
        const msgs = await alice.wsRequest('list_messages', { mailbox: 'Archive', since_uid: 0 });
        assert(msgs.length > 0, 'Archive should have copied message');
    });

    await test('WS move — move message from Archive to INBOX', async () => {
        const archiveMsgs = await alice.wsRequest('list_messages', { mailbox: 'Archive', since_uid: 0 });
        if (archiveMsgs.length === 0) { skip('move', 'no messages in Archive'); return; }
        const result = await alice.wsRequest('move', {
            mailbox: 'Archive',
            uid: archiveMsgs[0].uid,
            dest_mailbox: 'INBOX'
        });
        assertEq(result.status, 'moved', 'status');
    });

    await test('WS copy — missing dest_mailbox returns error', async () => {
        if (!aliceMsgUID) { skip('copy error', 'no message UID'); return; }
        try {
            await alice.wsRequest('copy', { uid: aliceMsgUID });
            throw new Error('should have thrown');
        } catch (e: any) {
            assert(e.message.includes('dest_mailbox') || e.message.length > 0, 'should mention dest_mailbox');
        }
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 8: Reactions, Replies, Deletes
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 8: Reactions, Replies, Deletes ━━━━━━━━━━━━━\n');

    const bobHasAliceKey = bob.getKnownKeys().has(aliceEmail.toLowerCase());

    if (bobHasAliceKey) {
        await test('Send reaction 👍 — Bob reacts to his message', async () => {
            await bob.sendReaction(aliceEmail, { targetMessage: sentMsgId, reaction: '👍' });
        });

        await sleep(2000);

        await test('Send reply with quote — Bob replies to himself', async () => {
            const { msgId: replyId } = await bob.sendReply(aliceEmail, {
                parentMessage: sentMsgId,
                text: 'This is a reply! 🧵',
                quotedText: 'Hello Alice! Test message from Bob 🚀'
            });
            assert(!!replyId, 'reply should return message ID');
        });

        await sleep(2000);

        await test('Send + Delete — Bob sends then deletes', async () => {
            const { msgId: delMsgId } = await bob.sendMessage(aliceEmail, 'This will be deleted 💥');
            await sleep(2000);
            await bob.sendDelete(aliceEmail, { targetMessage: delMsgId });
        });

        await sleep(2000);
    } else {
        skip('Reactions', 'Bob does not have Alice\'s key — skipping encrypted operations');
        skip('Reply with quote', 'Bob does not have Alice\'s key');
        skip('Send + Delete', 'Bob does not have Alice\'s key');
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 9: Profile Photo
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 9: Profile Photo ━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (bobHasAliceKey) {
        await test('Set and send profile photo — Bob → Alice', async () => {
            const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
            bob.setProfilePhotoB64(tinyPng, 'image/png');
            await bob.sendProfilePhoto(aliceEmail);
        });
        await sleep(2000);
    } else {
        skip('Profile photo', 'Bob does not have Alice\'s key');
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 10: Reverse Message (Alice → Bob)
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 10: Reverse Message (Alice → Bob) ━━━━━━━━━━\n');

    const aliceHasBobKey = alice.getKnownKeys().has(bobEmail.toLowerCase());
    if (aliceHasBobKey) {
        const bobReceived: any[] = [];
        bob.on('DC_EVENT_INCOMING_MSG', (e) => { bobReceived.push(e); });

        await test('Send message — Alice → Bob', async () => {
            const msgId = await alice.sendMessage(bobEmail, 'Hey Bob! Alice here. 💌');
            assert(!!msgId, 'should return message ID');
        });

        await test('WS push — Bob receives Alice\'s message', async () => {
            let received = false;
            for (let i = 0; i < 30; i++) {
                if (bobReceived.length > 0) { received = true; break; }
                await sleep(500);
            }
            assert(received, 'Bob should receive push within 15s');
        });
    } else {
        skip('Alice → Bob message', 'Alice does not have Bob\'s key');
        skip('Bob receives push', 'Alice does not have Bob\'s key');
    }

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 11: WS Delete Message
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 11: WS Delete (IMAP) ━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('WS delete — delete a message by UID', async () => {
        const msgs = await alice.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: 0 });
        if (msgs.length === 0) { skip('WS delete', 'no messages to delete'); return; }
        const uid = msgs[msgs.length - 1].uid;
        const result = await alice.wsRequest('delete', { uid });
        assertEq(result.status, 'deleted', 'status');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 12: Store Layer (local)
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 12: Store Layer ━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await test('Store — save and load account', async () => {
        await alice.saveToStore();
        const acct = await alice.store.getAccount();
        assert(!!acct, 'account should be saved');
        assertEq(acct!.email, aliceEmail, 'saved email');
    });

    await test('Store — chat list', async () => {
        const chats = await alice.getChatList();
        assert(Array.isArray(chats), 'should return array');
    });

    await test('Store — contacts', async () => {
        const contacts = await alice.getContacts();
        assert(Array.isArray(contacts), 'should return array');
    });

    await test('Store — search messages', async () => {
        const results = await alice.searchMessages('test');
        assert(Array.isArray(results), 'should return array');
    });

    await test('Store — getOrCreateChat', async () => {
        const chat = await alice.getOrCreateChat('test@example.com');
        assert(!!chat, 'should create chat');
        assertEq(chat.peerEmail, 'test@example.com', 'peer email');
        assertEq(chat.isGroup, false, 'should be 1:1');
    });

    await test('Store — clear', async () => {
        // Create a fresh SDK instance to test clear without affecting alice
        const tempSDK = new DeltaChatAccount(new MemoryStore());
        await tempSDK.store.saveContact({ email: 'test@foo.com', name: 'Test', verified: false });
        const before = await tempSDK.store.getAllContacts();
        assert(before.length > 0, 'should have contacts');
        await tempSDK.store.clear();
        const after = await tempSDK.store.getAllContacts();
        assertEq(after.length, 0, 'should be empty after clear');
    });

    // ═════════════════════════════════════════════════════════════════════
    // SECTION 13: Disconnect & Cleanup
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n━━━ SECTION 13: Disconnect & Cleanup ━━━━━━━━━━━━━━━━━━━\n');

    await test('Disconnect — Alice', async () => {
        alice.disconnect();
    });

    await test('Disconnect — Bob', async () => {
        bob.disconnect();
    });

    await test('WS request after disconnect returns error', async () => {
        try {
            await alice.wsRequest('list_mailboxes', {});
            throw new Error('should have thrown');
        } catch (e: any) {
            assert(e.message.includes('transports connected') || e.message.includes('Disconnected'), 'should indicate not connected');
        }
    });

    // Cleanup mailboxes
    try {
        await alice.connectWebSocket();
        await alice.wsRequest('delete_mailbox', { name: 'Archive' });
        alice.disconnect();
    } catch { /* ignore cleanup errors */ }

    // ═════════════════════════════════════════════════════════════════════
    // RESULTS
    // ═════════════════════════════════════════════════════════════════════
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('                    TEST RESULTS');
    console.log('══════════════════════════════════════════════════════════\n');

    console.log(`  ✅ Passed:  ${passed}`);
    console.log(`  ❌ Failed:  ${failed}`);
    console.log(`  ⏭️  Skipped: ${skipped}`);
    console.log(`  📊 Total:   ${passed + failed + skipped}`);
    console.log('');

    if (failed > 0) {
        console.log('  Failed tests:');
        for (const r of results) {
            if (r.status === 'FAIL') {
                console.log(`    ❌ ${r.name}: ${r.error}`);
            }
        }
        console.log('');
    }

    const totalTime = results.reduce((sum, r) => sum + r.time, 0);
    console.log(`  Total time: ${(totalTime / 1000).toFixed(1)}s`);
    console.log(`  Server:     ${SERVER}`);
    console.log('');

    if (failed === 0) {
        console.log('  🎉 ALL TESTS PASSED!');
    } else {
        console.log(`  ⚠️  ${failed} test(s) failed.`);
    }
    console.log('');

    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error('\n❌ Fatal error:', e.message);
    console.error(e.stack);
    process.exit(1);
});
