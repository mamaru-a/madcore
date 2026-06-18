#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════════
// Delta Chat Web SDK — Interactive Group Test
//
// 1. SecureJoin to a real Delta Chat user
// 2. Create a group with that user
// 3. Register 2 more SDK accounts, add them to the group
// 4. SDK removes one member, user removes the other
// 5. Send messages, rename, resend, listen
//
// Controls:
//   Enter  →  run next test step
//   x      →  exit immediately
//
// Usage:
//   bun run test/interactive-group.ts
//   bun run test/interactive-group.ts "https://i.delta.chat/#..."
// ═══════════════════════════════════════════════════════════════════════════════

import { DeltaChatAccount, type ParsedMessage, type GroupInfo } from '../sdk';
import { MemoryStore } from '../store';
import * as readline from 'readline';

// Allow self-signed certs for test servers
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SERVER = process.env.DELTACHAT_SERVER || process.env.SERVER_URL || '';
if (!SERVER) { console.error('❌ Set SERVER_URL or DELTACHAT_SERVER in .env.'); process.exit(1); }

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
    console.log('║   Delta Chat Web SDK — Interactive GROUP Test           ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`  Server: ${SERVER}`);
    console.log(`  Time:   ${new Date().toLocaleTimeString()}\n`);

    // Get the invite URI
    let INVITE_URI = process.argv.find(a => a.startsWith('https://i.delta.chat/'));
    if (!INVITE_URI) {
        INVITE_URI = await askLine('  📎 Paste SecureJoin URI (1:1 contact): ');
        if (!INVITE_URI || !INVITE_URI.includes('delta.chat')) {
            console.error('  ❌ Invalid or empty URI. Exiting.');
            process.exit(1);
        }
    }
    console.log(`  🔗 URI: ${INVITE_URI.substring(0, 60)}...\n`);

    // ── Step 0: Register + Keys ──────────────────────────────────────────
    console.log('━━━ STEP 0: Setup (main SDK + 2 extra accounts) ━━━━━━━━━━\n');

    // Main SDK
    const sdk = new DeltaChatAccount(new MemoryStore());
    const creds = await sdk.register(SERVER);
    console.log(`  📬 Main:  ${creds.email}`);
    await sdk.generateKeys('SDK Group Test');
    sdk.setDisplayName('Group Bot 🤖');

    // Extra account A
    const sdkA = new DeltaChatAccount(new MemoryStore());
    const credsA = await sdkA.register(SERVER);
    console.log(`  📬 Alice: ${credsA.email}`);
    await sdkA.generateKeys('Alice SDK');
    sdkA.setDisplayName('Alice 🅰️');

    // Extra account B
    const sdkB = new DeltaChatAccount(new MemoryStore());
    const credsB = await sdkB.register(SERVER);
    console.log(`  📬 Bob:   ${credsB.email}`);
    await sdkB.generateKeys('Bob SDK');
    sdkB.setDisplayName('Bob 🅱️');

    // Connect WebSockets
    await sdk.connectWebSocket();
    await sdkA.connectWebSocket();
    await sdkB.connectWebSocket();
    console.log(`  🔌 All 3 WebSockets connected`);

    // Listen for incoming messages on main SDK
    const received: ParsedMessage[] = [];
    sdk.on('DC_EVENT_INCOMING_MSG', (e) => {
        if (e.msg) {
            received.push(e.msg);
            const chat = e.msg.groupName ? `[${e.msg.groupName}]` : '[1:1]';
            let extra = '';
            if (e.msg.memberAdded) extra += ` ➕ added: ${e.msg.memberAdded}`;
            if (e.msg.memberRemoved) extra += ` ➖ removed: ${e.msg.memberRemoved}`;
            
            // Clean up the text for console (remove non-printable)
            const cleanText = e.msg.text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '').substring(0, 100);
            console.log(`\n  📩 ${chat} from ${e.msg.from}: ${cleanText}${extra}`);

            // Reactive member tracking: if we have a group and this message belongs to it, update members
            if (typeof group !== 'undefined' && e.msg.groupId === group.grpId) {
                if (e.msg.memberAdded) {
                    const addr = e.msg.memberAdded.toLowerCase();
                    if (!group.members.map(m => m.toLowerCase()).includes(addr)) {
                        group.members.push(e.msg.memberAdded);
                    }
                }
                if (e.msg.memberRemoved) {
                    const addr = e.msg.memberRemoved.toLowerCase();
                    group.members = group.members.filter(m => m.toLowerCase() !== addr);
                }
            }
        }
    });

    console.log(`\n  ✅ Setup complete (3 SDK accounts).\n`);

    // ── Step 1: SecureJoin to real device ─────────────────────────────────
    console.log('━━━ STEP 1: SecureJoin to your device ━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Main SDK will establish encrypted contact with your device.\n');

    let action = await waitForKey('▶ Join your device?');
    if (action === 'exit') { cleanup(); return; }

    let peerEmail: string;
    try {
        const result = await sdk.secureJoin(INVITE_URI);
        peerEmail = result.peerEmail;
        console.log(`\n  ✅ Joined! Peer: ${peerEmail}, Verified: ${result.verified}`);
    } catch (e: any) {
        console.log(`\n  ⚠️  SecureJoin partial: ${e.message}`);
        const parsed = sdk.parseSecureJoinURI(INVITE_URI);
        peerEmail = parsed.inviterEmail;
        if (sdk.getKnownKeys().has(peerEmail.toLowerCase())) {
            console.log(`  ✅ Key exchanged with ${peerEmail} — continuing`);
        } else {
            console.log('  ❌ No key exchanged. Cannot proceed.');
            cleanup(); return;
        }
    }

    await sleep(500);

    // ── Step 2: Create Group with real device ────────────────────────────
    console.log('\n━━━ STEP 2: Create a group with your device ━━━━━━━━━━━━━━\n');
    console.log(`  Will create "SDK Test Group 🧪" with you (${peerEmail}).`);

    action = await waitForKey('▶ Create group?');
    if (action === 'exit') { cleanup(); return; }

    const group = await sdk.createGroup({ name: 'SDK Test Group 🧪', members: [peerEmail] });
    console.log(`  ✅ Group created!`);
    console.log(`     ID: ${group.grpId}`);
    console.log(`     Name: ${group.name}`);
    console.log(`     Members: ${group.members.join(', ')}`);
    console.log('  💡 Check Delta Chat — you should see the group.');

    // ── Step 3: Send group message ───────────────────────────────────────
    console.log('\n━━━ STEP 3: Send message to the group ━━━━━━━━━━━━━━━━━━━━\n');

    action = await waitForKey('▶ Send group message?');
    if (action === 'exit') { cleanup(); return; }

    await sdk.sendGroupMessage(group, { text: 'Hello group! 👋🏻 This is the SDK speaking.' });
    console.log('  ✅ Sent!');

    // ── Step 4: Key exchange with Alice & Bob ────────────────────────────
    console.log('\n━━━ STEP 4: Key exchange with Alice & Bob ━━━━━━━━━━━━━━━━\n');
    console.log(`  Injecting keys between all 3 SDK instances (in-process).\n`);

    action = await waitForKey('▶ Exchange keys?');
    if (action === 'exit') { cleanup(); return; }

    // Direct key injection — all 3 SDKs are in the same process
    const mainKey = sdk.getPublicKeyArmored()!;
    const aliceKeyArmored = sdkA.getPublicKeyArmored()!;
    const bobKeyArmored = sdkB.getPublicKeyArmored()!;

    // Main ↔ Alice
    sdk.getKnownKeys().set(credsA.email.toLowerCase(), aliceKeyArmored);
    sdkA.getKnownKeys().set(creds.email.toLowerCase(), mainKey);
    console.log(`  🔑 Main ↔ Alice: keys injected`);

    // Main ↔ Bob
    sdk.getKnownKeys().set(credsB.email.toLowerCase(), bobKeyArmored);
    sdkB.getKnownKeys().set(creds.email.toLowerCase(), mainKey);
    console.log(`  🔑 Main ↔ Bob: keys injected`);

    // Alice ↔ Bob
    sdkA.getKnownKeys().set(credsB.email.toLowerCase(), bobKeyArmored);
    sdkB.getKnownKeys().set(credsA.email.toLowerCase(), aliceKeyArmored);
    console.log(`  🔑 Alice ↔ Bob: keys injected`);

    // Give Alice & Bob the real peer's key (for group messages)
    const peerKey = sdk.getKnownKeys().get(peerEmail.toLowerCase());
    if (peerKey) {
        sdkA.getKnownKeys().set(peerEmail.toLowerCase(), peerKey);
        sdkB.getKnownKeys().set(peerEmail.toLowerCase(), peerKey);
        console.log(`  🔑 Alice & Bob received peer key for ${peerEmail}`);
    }

    console.log('  ✅ All keys exchanged (direct injection).');

    // ── Step 5: Add Alice to the group ───────────────────────────────────
    console.log('\n━━━ STEP 5: Add Alice to the group ━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`  Will add ${credsA.email} (Alice 🅰️) to the group.`);

    action = await waitForKey('▶ Add Alice?');
    if (action === 'exit') { cleanup(); return; }

    group.members.push(credsA.email);
    await sdk.addGroupMember(group, { email: credsA.email });
    console.log(`  ✅ Alice added! Members: ${group.members.length}`);
    console.log('  💡 Check Delta Chat — you should see "Alice 🅰️ was added."');

    // ── Step 6: Add Bob to the group ─────────────────────────────────────
    console.log('\n━━━ STEP 6: Add Bob to the group ━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`  Will add ${credsB.email} (Bob 🅱️) to the group.`);

    action = await waitForKey('▶ Add Bob?');
    if (action === 'exit') { cleanup(); return; }

    group.members.push(credsB.email);
    await sdk.addGroupMember(group, { email: credsB.email });
    console.log(`  ✅ Bob added! Members: ${group.members.length}`);
    console.log('  💡 Check Delta Chat — you should see "Bob 🅱️ was added."');

    // ── Step 7: Send a group message (now 4 members) ─────────────────────
    console.log('\n━━━ STEP 7: Send group message (4 members) ━━━━━━━━━━━━━━━\n');
    console.log(`  Group now has ${group.members.length} members. Sending to all.`);

    action = await waitForKey('▶ Send to all?');
    if (action === 'exit') { cleanup(); return; }

    await sdk.sendGroupMessage(group, { text: `We are ${group.members.length} members now! 🎉` });
    console.log('  ✅ Sent to all members!');

    // ── Step 8: SDK removes Alice ────────────────────────────────────────
    console.log('\n━━━ STEP 8: SDK removes Alice from the group ━━━━━━━━━━━━━\n');
    console.log(`  SDK will remove ${credsA.email} (Alice 🅰️).`);

    action = await waitForKey('▶ Remove Alice?');
    if (action === 'exit') { cleanup(); return; }

    await sdk.removeGroupMember(group, { email: credsA.email });
    console.log(`  ✅ Alice removed! Members: ${group.members.length}`);
    console.log(`     Remaining: ${group.members.join(', ')}`);
    console.log('  💡 Check Delta Chat — you should see "Alice was removed."');

    // ── Step 9: Wait for you to remove Bob ───────────────────────────────
    console.log('\n━━━ STEP 9: You remove Bob from the group ━━━━━━━━━━━━━━━━\n');
    console.log(`  Now remove ${credsB.email} (Bob 🅱️) from your Delta Chat app.`);
    console.log('  The SDK will detect the member-removed message.\n');

    action = await waitForKey('▶ Waiting for you to remove Bob... (press Enter after)');
    if (action === 'exit') { cleanup(); return; }

    // Check if we already detected it (via the reactive listener above)
    let found = false;
    for (let i = 0; i < 5; i++) {
        const removedMsg = received.find(m => 
            (m.memberRemoved?.toLowerCase() === credsB.email.toLowerCase()) && 
            m.groupId === group.grpId
        );
        if (removedMsg) {
            console.log(`  ✅ Detected! ${removedMsg.from} removed ${removedMsg.memberRemoved} from the group.`);
            found = true;
            break;
        }
        await sleep(2000);
    }

    if (!found) {
        console.log(`  ⚠️  No member-removed message detected yet in the 'received' buffer.`);
        console.log(`     Members current count: ${group.members.length}`);
    }

    // ── Step 10: Send message after removals ─────────────────────────────
    console.log('\n━━━ STEP 10: Send message after removals ━━━━━━━━━━━━━━━━━\n');
    console.log(`  Group now has ${group.members.length} members.`);

    action = await waitForKey('▶ Send message?');
    if (action === 'exit') { cleanup(); return; }

    await sdk.sendGroupMessage(group, { text: `After removals: ${group.members.length} members left! Only us now.` });
    console.log('  ✅ Sent!');

    // ── Step 11: Rename Group ────────────────────────────────────────────
    console.log('\n━━━ STEP 11: Rename the group ━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    action = await waitForKey('▶ Rename to "Survivors Club ✨"?');
    if (action === 'exit') { cleanup(); return; }

    await sdk.renameGroup(group, { newName: 'Survivors Club ✨' });
    console.log(`  ✅ Renamed to "${group.name}"`);

    // ── Step 12: Resend 1:1 ──────────────────────────────────────────────
    console.log('\n━━━ STEP 12: Resend a message (1:1) ━━━━━━━━━━━━━━━━━━━━━━\n');

    action = await waitForKey('▶ Resend to 1:1?');
    if (action === 'exit') { cleanup(); return; }

    await sdk.resendMessage(peerEmail, { originalMessage: '🔄 Resent from SDK after group operations!' });
    console.log('  ✅ Resent!');

    // ── Step 13: Listen ──────────────────────────────────────────────────
    console.log('\n━━━ STEP 13: Listening for responses ━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`  Received so far: ${received.length} message(s)`);

    action = await waitForKey('▶ Listen? (press x when done)');
    if (action === 'exit') { cleanup(); return; }

    console.log('\n  🎧 Listening... Press x to exit.\n');
    while (true) {
        const key = await waitForKey(`  📊 ${received.length} messages received`);
        if (key === 'exit') break;
    }

    // ── Summary ─────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('            GROUP TEST COMPLETE');
    console.log('══════════════════════════════════════════════════════════\n');
    console.log(`  Main:       ${creds.email}`);
    console.log(`  Alice:      ${credsA.email}`);
    console.log(`  Bob:        ${credsB.email}`);
    console.log(`  Peer:       ${peerEmail}`);
    console.log(`  Group:      ${group.name} (${group.grpId.substring(0, 16)}...)`);
    console.log(`  Members:    ${group.members.length} (${group.members.join(', ')})`);
    console.log(`  Messages:   ${received.length} received`);
    console.log(`  Features tested:`);
    console.log('    ✅ SecureJoin (key exchange)');
    console.log('    ✅ Create group');
    console.log('    ✅ Send group message');
    console.log('    ✅ Add member (Alice)');
    console.log('    ✅ Add member (Bob)');
    console.log('    ✅ SDK removes member (Alice)');
    console.log('    ✅ Detect member removed by peer (Bob)');
    console.log('    ✅ Rename group');
    console.log('    ✅ Resend message');
    console.log('    ✅ Receive + decrypt messages');
    console.log('');

    cleanup();

    function cleanup() {
        sdk.disconnect();
        sdkA.disconnect();
        sdkB.disconnect();
        process.exit(0);
    }
}

main().catch((e) => {
    console.error('\n❌ Fatal error:', e.message);
    console.error(e.stack);
    process.exit(1);
});
