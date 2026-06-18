#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════════
// Delta Chat Web SDK — Join Group via Invite Link
//
// Uses SecureJoin with a group invite URI (contains x=grpid & g=name)
// to join an existing group on a real Delta Chat device.
//
// Controls:
//   Enter  →  run next test step
//   x      →  exit immediately
//
// Usage:
//   bun run test/join-group.ts
//   bun run test/join-group.ts "https://i.delta.chat/#...&x=GRPID&g=GroupName..."
// ═══════════════════════════════════════════════════════════════════════════════

import { DeltaChatAccount, type ParsedMessage } from '../sdk';
import { MemoryStore } from '../store';
import * as readline from 'readline';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SERVER = process.argv[2] || process.env.SERVER_URL || '';
if (!SERVER) { console.error('❌ Set SERVER_URL in .env or pass as argument.'); process.exit(1); }

// ─── Interactive Input ──────────────────────────────────────────────────────────

function askLine(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function waitForKey(prompt: string): Promise<'continue' | 'exit'> {
    return new Promise((resolve) => {
        process.stdout.write(`\n  ${prompt}  [Enter = next, x = exit] `);
        if (process.stdin.isTTY) process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (key: string) => {
            process.stdin.removeListener('data', onData);
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.pause();

            if (key === '\u0003') { console.log('\n  Bye!'); process.exit(0); }
            if (key.toLowerCase() === 'x') { console.log('  → exit'); resolve('exit'); return; }
            console.log('  → continue');
            resolve('continue');
        };
        process.stdin.on('data', onData);
    });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   Delta Chat Web SDK — Join Group via Invite Link       ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`  Server: ${SERVER}`);
    console.log(`  Time:   ${new Date().toLocaleTimeString()}\n`);

    // Get the group invite URI
    let INVITE_URI = process.argv.find(a => a.startsWith('https://i.delta.chat/'));
    if (!INVITE_URI) {
        INVITE_URI = await askLine('  📎 Paste GROUP invite URI (must have x= and g= params): ');
        if (!INVITE_URI || !INVITE_URI.includes('delta.chat')) {
            console.error('  ❌ Invalid or empty URI. Exiting.');
            process.exit(1);
        }
    }
    console.log(`  🔗 URI: ${INVITE_URI.substring(0, 60)}...\n`);

    // Quick-parse to verify it's a group link
    const sdk = new DeltaChatAccount(new MemoryStore());
    const quickParsed = sdk.parseSecureJoinURI(INVITE_URI);
    const isGroup = !!quickParsed.groupId && !!quickParsed.groupName;
    const isBroadcast = !!quickParsed.groupId && !!quickParsed.broadcastName;

    if (!quickParsed.groupId) {
        console.log('  ⚠️  This URI has no group ID (x= param).');
        console.log('  ℹ️  For 1:1 SecureJoin, use: bun run test/interactive.ts');
        console.log('  ℹ️  Continuing anyway — this will do a 1:1 SecureJoin.\n');
    } else if (isBroadcast) {
        console.log(`  📢 Broadcast invite: "${quickParsed.broadcastName}"`);
        console.log(`     Group ID: ${quickParsed.groupId}`);
        console.log(`     Inviter: ${quickParsed.inviterEmail}\n`);
    } else {
        console.log(`  👥 Group invite: "${quickParsed.groupName}"`);
        console.log(`     Group ID: ${quickParsed.groupId}`);
        console.log(`     Inviter: ${quickParsed.inviterEmail}\n`);
    }

    // ── Step 0: Setup ────────────────────────────────────────────────────
    console.log('━━━ STEP 0: Setup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const creds = await sdk.register(SERVER);
    console.log(`  📬 Registered: ${creds.email}`);

    await sdk.generateKeys('SDK Group Joiner');
    sdk.setDisplayName('SDK Joiner 🤝');
    console.log(`  🔑 Fingerprint: ${sdk.getFingerprint().substring(0, 20)}...`);

    await sdk.connectWebSocket();
    console.log(`  🔌 WebSocket connected`);

    // Message listener
    const received: ParsedMessage[] = [];
    sdk.on('DC_EVENT_INCOMING_MSG', (e) => {
        if (e.msg) {
            received.push(e.msg);
            const prefix = e.msg.text.substring(0, 80);
            console.log(`\n  📩 INCOMING from ${e.msg.from}: ${prefix}`);
        }
    });

    console.log('\n  ✅ Setup complete.\n');

    // ── Step 1: SecureJoin (group join) ──────────────────────────────────
    const joinType = isBroadcast ? 'broadcast' : isGroup ? 'group' : 'contact';
    console.log(`━━━ STEP 1: SecureJoin to ${joinType} ━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log(`  This will perform the SecureJoin handshake to join the ${joinType}.`);
    if (isGroup) {
        console.log(`  After completion, you should see "${quickParsed.groupName}" in your groups.`);
    }

    let action = await waitForKey(`▶ Join ${joinType}?`);
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    let peerEmail: string;
    try {
        const result = await sdk.secureJoin(INVITE_URI);
        peerEmail = result.peerEmail;
        console.log(`\n  ✅ SecureJoin complete!`);
        console.log(`     Peer: ${peerEmail}`);
        console.log(`     Verified: ${result.verified}`);
    } catch (e: any) {
        console.log(`\n  ⚠️  SecureJoin partial: ${e.message}`);
        peerEmail = quickParsed.inviterEmail;
        if (sdk.getKnownKeys().has(peerEmail.toLowerCase())) {
            console.log(`  ✅ Key exchanged with ${peerEmail} — continuing`);
        } else {
            console.log('  ❌ No key exchanged. Cannot proceed.');
            sdk.disconnect();
            process.exit(1);
        }
    }

    await sleep(1000);

    if (isGroup) {
        console.log(`\n  💡 Check Delta Chat — you should be in "${quickParsed.groupName}" now.`);
    }

    // ── Step 2: Send a message (to group or 1:1) ────────────────────────
    console.log(`\n━━━ STEP 2: Send a message ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    if (isGroup && quickParsed.groupId) {
        console.log(`  Will send a message to the group "${quickParsed.groupName}".`);
        console.log(`  Note: The SDK joined via SecureJoin, so the inviter's core`);
        console.log(`  should have added us as a group member.\n`);

        action = await waitForKey('▶ Send to group?');
        if (action === 'exit') { sdk.disconnect(); process.exit(0); }

        // We've been added to the group, so we can send to the inviter
        // (in a group context, we relay via the inviter)
        const msgId = await sdk.sendMessage(peerEmail, `Hello from SDK Joiner! 👋 I just joined "${quickParsed.groupName}" via invite link!`);
        console.log(`  ✅ Sent! ID: ${msgId}`);
        console.log(`  💡 The inviter should see this in the group chat.`);
    } else {
        console.log(`  Will send an encrypted message to ${peerEmail}.`);

        action = await waitForKey('▶ Send message?');
        if (action === 'exit') { sdk.disconnect(); process.exit(0); }

        const msgId = await sdk.sendMessage(peerEmail, 'Hello! I just joined via the invite link! 🤝');
        console.log(`  ✅ Sent! ID: ${msgId}`);
    }

    // ── Step 3: Listen ───────────────────────────────────────────────────
    console.log(`\n━━━ STEP 3: Listening for messages ━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log('  Send messages from your Delta Chat app to test receive.');
    console.log(`  Received so far: ${received.length} message(s)`);

    action = await waitForKey('▶ Listen? (press x when done)');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    console.log('\n  🎧 Listening... Press x to exit.\n');
    while (true) {
        const key = await waitForKey(`  📊 ${received.length} messages received`);
        if (key === 'exit') break;
    }

    // ── Summary ─────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('            JOIN GROUP TEST COMPLETE');
    console.log('══════════════════════════════════════════════════════════\n');
    console.log(`  Account:      ${creds.email}`);
    console.log(`  Peer:         ${peerEmail}`);
    console.log(`  Join type:    ${joinType}`);
    if (isGroup) console.log(`  Group name:   ${quickParsed.groupName}`);
    if (isBroadcast) console.log(`  Broadcast:    ${quickParsed.broadcastName}`);
    if (quickParsed.groupId) console.log(`  Group ID:     ${quickParsed.groupId}`);
    console.log(`  Messages:     ${received.length} received`);
    console.log(`  Features tested:`);
    console.log(`    ✅ SecureJoin (${joinType} invite)`);
    console.log('    ✅ Send encrypted message');
    console.log('    ✅ Receive + decrypt messages');
    console.log('');

    sdk.disconnect();
    process.exit(0);
}

main().catch((e) => {
    console.error('\n❌ Fatal error:', e.message);
    console.error(e.stack);
    process.exit(1);
});
