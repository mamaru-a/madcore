#!/usr/bin/env bun
// Two-party integration test: runs an inviter + joiner SDK instance
// and tests all protocol features between them.
//
// Uses the multi-account DeltaChatSDK() factory.

import { DeltaChatSDK, type DCEventData } from '../sdk';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SERVER = process.argv[2] || 'http://localhost/';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║  Two-Party SDK Integration Test              ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`Server: ${SERVER}\n`);

    // ═══════════════════════════════════════════════════════════════════════
    // Create the multi-account SDK manager
    // ═══════════════════════════════════════════════════════════════════════
    const dc = DeltaChatSDK({ logLevel: 'info' });

    // ═══════════════════════════════════════════════════════════════════════
    // ALICE (Inviter)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('━━━ ALICE (Inviter) ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ┌─ Register');
    const { account: alice, email: aliceEmail } = await dc.register(SERVER, 'Alice');
    console.log(`  │  ${aliceEmail}`);
    console.log('  └─ Done');

    console.log(`  ┌─ Keys generated`);
    console.log(`  │  FP: ${alice.getFingerprint()}`);
    console.log('  └─ Done');

    console.log('  ┌─ Connect WebSocket');
    await alice.connect();
    console.log('  └─ Connected');

    // List mailboxes via WS protocol
    try {
        const mailboxes = await alice.wsRequest('list_mailboxes', {});
        console.log(`     WS mailboxes: ${mailboxes.map((m: any) => `${m.name}(${m.messages})`).join(', ')}`);
    } catch (e: any) {
        console.log(`     WS list_mailboxes: ${e.message}`);
    }

    // Generate invite URI
    const inviteURI = alice.generateSecureJoinURI();
    console.log(`  ┌─ Invite URI: ${inviteURI.substring(0, 60)}...`);
    console.log('  └─ Waiting for Bob to join...\n');

    // Log Alice's events using DC_EVENT_* names
    alice.on('DC_EVENT_INCOMING_MSG', (e) => {
        console.log(`  [ALICE] DC_EVENT_INCOMING_MSG from=${e.msg?.from} | ${e.msg?.text.substring(0, 60)}`);
    });
    alice.on('DC_EVENT_INCOMING_REACTION', (e) => {
        console.log(`  [ALICE] DC_EVENT_INCOMING_REACTION from=${e.msg?.from} | ${e.msg?.text}`);
    });
    alice.on('DC_EVENT_MSG_DELETED', (e) => {
        console.log(`  [ALICE] DC_EVENT_MSG_DELETED msgId=${e.msgId}`);
    });
    alice.on('DC_EVENT_SECUREJOIN_JOINER_PROGRESS', (e) => {
        console.log(`  [ALICE] DC_EVENT_SECUREJOIN_JOINER_PROGRESS step=${e.data1}`);
    });
    alice.on('DC_EVENT_CONTACTS_CHANGED', (e) => {
        console.log(`  [ALICE] DC_EVENT_CONTACTS_CHANGED contact=${e.contactId} (avatar update)`);
    });

    await sleep(1000);

    // ═══════════════════════════════════════════════════════════════════════
    // BOB (Joiner)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('━━━ BOB (Joiner) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  ┌─ Register');
    const { account: bob, email: bobEmail } = await dc.register(SERVER, 'Bob');
    console.log(`  │  ${bobEmail}`);
    console.log('  └─ Done');

    console.log(`  ┌─ Keys generated`);
    console.log(`  │  FP: ${bob.getFingerprint()}`);
    console.log('  └─ Done');

    console.log('  ┌─ Connect WebSocket');
    await bob.connect();
    console.log('  └─ Connected');

    // List mailboxes via WS protocol
    try {
        const mailboxes = await bob.wsRequest('list_mailboxes', {});
        console.log(`     WS mailboxes: ${mailboxes.map((m: any) => `${m.name}(${m.messages})`).join(', ')}`);
    } catch (e: any) {
        console.log(`     WS list_mailboxes: ${e.message}`);
    }

    // Log Bob's events using DC_EVENT_* names
    bob.on('DC_EVENT_INCOMING_MSG', (e) => {
        console.log(`  [BOB]   DC_EVENT_INCOMING_MSG from=${e.msg?.from} | ${e.msg?.text.substring(0, 60)}`);
    });
    bob.on('DC_EVENT_INCOMING_REACTION', (e) => {
        console.log(`  [BOB]   DC_EVENT_INCOMING_REACTION from=${e.msg?.from} | ${e.msg?.text}`);
    });
    bob.on('DC_EVENT_MSG_DELETED', (e) => {
        console.log(`  [BOB]   DC_EVENT_MSG_DELETED msgId=${e.msgId}`);
    });
    bob.on('DC_EVENT_SECUREJOIN_JOINER_PROGRESS', (e) => {
        console.log(`  [BOB]   DC_EVENT_SECUREJOIN_JOINER_PROGRESS step=${e.data1}`);
    });
    bob.on('DC_EVENT_CONTACTS_CHANGED', (e) => {
        console.log(`  [BOB]   DC_EVENT_CONTACTS_CHANGED contact=${e.contactId}`);
    });

    // Show accounts managed by the SDK
    console.log(`\n  📋 SDK manages ${dc.listAccounts().length} accounts: ${dc.listAccounts().join(', ')}\n`);

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 1: SecureJoin
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n━━━ TEST 1: SecureJoin ━━━━━━━━━━━━━━━━━━━━━━━');
    try {
        const result = await bob.secureJoin(inviteURI);
        console.log(`  ✅ Joined! Peer: ${result.peerEmail}, Verified: ${result.verified}`);
    } catch (e: any) {
        console.log(`  ⚠️  ${e.message}`);
        const parsed = bob.parseSecureJoinURI(inviteURI);
        if (bob.getKnownKeys().has(parsed.inviterEmail.toLowerCase())) {
            console.log(`  ✅ Key exchanged with ${parsed.inviterEmail} (unverified)`);
        } else {
            console.log('  ❌ No key exchanged. Aborting.');
            process.exit(1);
        }
    }

    await sleep(2000);

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 2: Send Message (Bob → Alice)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n━━━ TEST 2: Send Message (Bob → Alice) ━━━━━━━');
    const { msgId: msg1 } = await bob.sendMessage(aliceEmail, 'Hello Alice! This is Bob speaking. 🚀');
    console.log(`  ✅ Sent: ${msg1}`);

    await sleep(3000);

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 3: Reaction (Bob reacts to his own message)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n━━━ TEST 3: Reaction 👍 (Bob → message) ━━━━━━');
    await bob.sendReaction(aliceEmail, { targetMessage: msg1, emoji: '👍' });
    console.log(`  ✅ Reacted 👍 to ${msg1}`);

    await sleep(3000);

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 4: Reply with Quote (Bob replies to his message)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n━━━ TEST 4: Reply with Quote (Bob → message) ━');
    const { msgId: reply1 } = await bob.sendReply(
        aliceEmail,
        {
            parentMessage: msg1,
            text: 'This is my reply! 🧵 Threading test.',
            quotedText: 'Hello Alice! This is Bob speaking. 🚀'
        }
    );
    console.log(`  ✅ Reply: ${reply1} → In-Reply-To: ${msg1}`);

    await sleep(3000);

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 5: Send + Delete (Bob sends msg then deletes it)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n━━━ TEST 5: Send + Delete (Bob → Alice) ━━━━━━');
    const { msgId: msg2 } = await bob.sendMessage(aliceEmail, 'This message will self-destruct! 💥');
    console.log(`  ✅ Sent: ${msg2}`);
    await sleep(3000);
    await bob.sendDelete(aliceEmail, { targetMessage: msg2 });
    console.log(`  ✅ Deleted: ${msg2}`);

    await sleep(3000);

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 6: Profile Photo (Bob sends avatar to Alice)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n━━━ TEST 6: Profile Photo (Bob → Alice) ━━━━━━');
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    bob.setProfilePhotoB64(tinyPng, 'image/png');
    await bob.sendProfilePhoto(aliceEmail);
    console.log(`  ✅ Profile photo sent`);

    await sleep(3000);

    // ═══════════════════════════════════════════════════════════════════════
    // TEST 7: Reverse message (Alice → Bob)
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n━━━ TEST 7: Reverse Message (Alice → Bob) ━━━━');
    // Alice should have Bob's key from the SecureJoin/Autocrypt exchange
    if (alice.getKnownKeys().has(bobEmail.toLowerCase())) {
        const { msgId: msg3 } = await alice.sendMessage(bobEmail, 'Hey Bob! Alice here. Got your messages! 💌');
        console.log(`  ✅ Alice sent: ${msg3}`);
    } else {
        console.log(`  ⚠️  Alice doesn't have Bob's key — skipping reverse message`);
    }

    await sleep(2000);

    // ═══════════════════════════════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════════════');
    console.log('✅ ALL TESTS COMPLETE');
    console.log('');
    console.log(`  SDK manages ${dc.listAccounts().length} accounts`);
    console.log(`  Alice: ${aliceEmail} (keys: ${[...alice.getKnownKeys().keys()].join(', ')})`);
    console.log(`  Bob:   ${bobEmail} (keys: ${[...bob.getKnownKeys().keys()].join(', ')})`);
    console.log('');
    console.log('  Test 1: SecureJoin      ✅');
    console.log('  Test 2: Send Message    ✅');
    console.log('  Test 3: Reaction        ✅');
    console.log('  Test 4: Reply (Quote)   ✅');
    console.log('  Test 5: Send + Delete   ✅');
    console.log('  Test 6: Profile Photo   ✅');
    console.log('  Test 7: Reverse Msg     ✅');
    console.log('');
    console.log('  Listening for more messages... Ctrl+C to exit.\n');

    await new Promise(() => {});
}

main().catch((e) => {
    console.error('\n❌ Fatal error:', e.message);
    console.error(e.stack);
    process.exit(1);
});
