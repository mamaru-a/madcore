#!/usr/bin/env bun
/**
 * test/channel.ts
 * 
 * Non-interactive integration test for Delta Chat Broadcast Channels.
 * Verifies:
 * 1. Channel creation (Chat-Group-Is-Broadcast, Chat-List-Id)
 * 2. Broadcast messaging (undisclosed-recipients, shared secret)
 * 3. Member management (added/removed)
 * 4. Channel description updates
 * 
 * Requirements: SERVER_URL in .env pointing to a Madmail/Chatmail server.
 */

import { DeltaChatAccount } from '../sdk';
import { MemoryStore } from '../store';
import { ParsedMessage } from '../types';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const SERVER = process.env.SERVER_URL || '';
if (!SERVER) { console.error('❌ Set SERVER_URL in .env.'); process.exit(1); }

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function test_channel() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   Delta Chat Web SDK — Broadcast Channel Test           ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`  Server: ${SERVER}\n`);

    // ─── Setup 3 Accounts ────────────────────────────────────────────────
    const owner = new DeltaChatAccount(new MemoryStore());
    const alice = new DeltaChatAccount(new MemoryStore());
    const bob = new DeltaChatAccount(new MemoryStore());

    const ownerCreds = await owner.register(SERVER);
    const aliceCreds = await alice.register(SERVER);
    const bobCreds = await bob.register(SERVER);

    await owner.generateKeys('Owner 👑');
    await alice.generateKeys('Alice 🅰️');
    await bob.generateKeys('Bob 🅱️');

    console.log(`📬 Owner: ${ownerCreds.email}`);
    console.log(`📬 Alice: ${aliceCreds.email}`);
    console.log(`📬 Bob:   ${bobCreds.email}\n`);

    // Establishment: exchange keys manually for the test
    owner.importKey(aliceCreds.email, alice.getPublicKeyArmored()!);
    owner.importKey(bobCreds.email, bob.getPublicKeyArmored()!);
    alice.importKey(ownerCreds.email, owner.getPublicKeyArmored()!);
    bob.importKey(ownerCreds.email, owner.getPublicKeyArmored()!);
    alice.importKey(bobCreds.email, bob.getPublicKeyArmored()!);
    bob.importKey(aliceCreds.email, alice.getPublicKeyArmored()!);

    await owner.connectWebSocket();
    await alice.connectWebSocket();
    await bob.connectWebSocket();

    // Track received messages for validation
    const aliceReceived: ParsedMessage[] = [];
    const bobReceived: ParsedMessage[] = [];
    alice.on('DC_EVENT_INCOMING_MSG', (e) => e.msg && aliceReceived.push(e.msg));
    bob.on('DC_EVENT_INCOMING_MSG', (e) => e.msg && bobReceived.push(e.msg));

    // ─── Step 1: Create Channel ──────────────────────────────────────────
    console.log('  1. Creating channel "Global News" with Alice and Bob...');
    const channel = await owner.createChannel('Global News', 'Verified updates only.', [aliceCreds.email]);
    console.log(`     ✅ Created. ID: ${channel.grpId}`);
    console.log(`     Broadcast Secret: ${channel.broadcastSecret?.substring(0, 10)}...`);

    // Wait for Alice to receive member-added
    await sleep(3000);
    const aliceAdded = aliceReceived.find(m => m.memberAdded === aliceCreds.email);
    if (!aliceAdded) throw new Error('Alice did not receive member-added message');
    console.log('     ✅ Alice received channel enrollment');
    if (!aliceAdded.isBroadcast) throw new Error('Alice message not marked as broadcast');
    if (!aliceAdded.broadcastSecret) throw new Error('Alice message missing broadcast secret');

    // ─── Step 2: Send Broadcast Message ─────────────────────────────────────
    console.log('  2. Sending broadcast message...');
    const broadcastText = 'Breaking news: Web SDK parity achieved! 🚀';
    await owner.sendGroupMessage(channel, broadcastText);
    
    await sleep(3000);
    const aliceMsg = aliceReceived.find(m => m.text === broadcastText);
    if (!aliceMsg) throw new Error('Alice did not receive broadcast message');
    console.log('     ✅ Alice received broadcast message');
    if (!aliceMsg.isBroadcast) throw new Error('Alice broadcast message not marked as broadcast');
    if (aliceMsg.to !== 'undisclosed-recipients:;') throw new Error(`Alice broadcast To: was ${aliceMsg.to}, expected undisclosed-recipients`);

    // ─── Step 3: Update Description ────────────────────────────────────────
    console.log('  3. Updating channel description...');
    const newDesc = 'New channel description: The future of Delta Chat is here.';
    await owner.updateGroupDescription(channel, newDesc);

    await sleep(3000);
    const aliceDescMsg = aliceReceived.find(m => m.groupDescription === newDesc);
    if (!aliceDescMsg) throw new Error('Alice did not receive description update');
    console.log('     ✅ Alice received description update header');
    if (!aliceDescMsg.isBroadcast) throw new Error('Alice desc update not marked as broadcast');

    // ─── Step 4: Add Bob (Dynamic Addition) ─────────────────────────────────
    console.log('  4. Adding Bob to active channel...');
    await owner.addGroupMember(channel, bobCreds.email);

    await sleep(3000);
    const bobAdded = bobReceived.find(m => m.memberAdded === bobCreds.email);
    if (!bobAdded) throw new Error('Bob did not receive enrollment');
    console.log('     ✅ Bob received enrollment');
    if (!bobAdded.broadcastSecret) throw new Error('Bob missing broadcast secret');

    // ─── Step 5: Broadcast to Everyone (including Bob) ──────────────────────
    console.log('  5. Sending second broadcast to original + new member...');
    const finalMsg = 'This message should reach both Alice and Bob.';
    await owner.sendGroupMessage(channel, finalMsg);

    await sleep(3000);
    const aliceFinal = aliceReceived.filter(m => m.text === finalMsg).length;
    const bobFinal = bobReceived.filter(m => m.text === finalMsg).length;

    if (aliceFinal !== 1) throw new Error(`Alice final message count: ${aliceFinal}, expected 1`);
    if (bobFinal !== 1) throw new Error(`Bob final message count: ${bobFinal}, expected 1`);
    console.log('     ✅ Both members received the final broadcast');

    // ─── Step 6: Remove Alice ─────────────────────────────────────────────
    console.log('  6. Removing Alice...');
    await owner.removeGroupMember(channel, aliceCreds.email);

    await sleep(3000);
    const aliceRemovedMsg = bobReceived.find(m => m.memberRemoved === aliceCreds.email);
    if (!aliceRemovedMsg) throw new Error('Bob did not receive member-removed for Alice');
    console.log('     ✅ Bob notified of Alice removal');

    console.log('\n🌟 ALL CHANNEL PROTOCOL TESTS PASSED! 🚀');
    process.exit(0);
}

test_channel().catch(err => {
    console.error(`\n❌ TEST FAILED: ${err.message}`);
    process.exit(1);
});
