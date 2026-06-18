/**
 * test/interactive-channel.ts
 * 
 * Interactive test for Delta Chat Broadcast Channels.
 * Tests: create channel, join via link, descriptions, member management.
 */

import { DeltaChatSDK, DeltaChatAccount } from '../sdk';
import { MemoryStore } from '../store';
import { ParsedMessage } from '../types';

// Allow self-signed certs for test servers
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const SERVER = process.env.DELTACHAT_SERVER || process.env.SERVER_URL || '';
if (!SERVER) { console.error('❌ Set SERVER_URL or DELTACHAT_SERVER in .env.'); process.exit(1); }
let INVITE_URI = process.argv[2];

async function askQuestion(prompt: string): Promise<string> {
    const readline = await import('readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans); }));
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function waitForKey(prompt: string): Promise<'next' | 'exit'> {
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
            if (key.toLowerCase() === 'x') { resolve('exit'); return; }
            resolve('next');
        };
        process.stdin.on('data', onData);
    });
}

// ─── Test Execution ────────────────────────────────────────────────────────────

async function runTest() {
    console.log('\n╔══════════════════════════════════════════════════════════╗');
    console.log('║   Delta Chat Web SDK — Interactive CHANNEL Test         ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`  Server: ${SERVER}`);
    console.log(`  Time:   ${new Date().toLocaleTimeString()}\n`);

    if (!INVITE_URI) {
        INVITE_URI = await askQuestion('  📎 Paste SecureJoin URI (1:1 contact): ');
    }
    if (!INVITE_URI || !INVITE_URI.startsWith('https://')) {
        console.log('  ❌ Invalid URI. Exiting.');
        process.exit(1);
    }
    console.log(`  🔗 URI: ${INVITE_URI.substring(0, 50)}...`);

    const dc = DeltaChatSDK({ logLevel: 'info' });
    const { account: sdk, email: email } = await dc.register(SERVER, 'Channel Bot 🤖');
    const creds = { email };
    console.log(`📬 Main:  ${creds.email}`);
    await sdk.generateKeys('Channel Bot 🤖');
    sdk.setDisplayName('Channel Bot 🤖');

    // Extra account for "another person"
    const { account: sdkA, email: emailA } = await dc.register(SERVER, 'Alice 🅰️');
    const credsA = { email: emailA };
    console.log(`📬 Alice: ${credsA.email}`);
    await sdkA.generateKeys('Alice 🅰️');
    sdkA.setDisplayName('Alice 🅰️');

    await sdk.connect();
    await sdkA.connect();
    console.log(`  🔌 WebSockets connected`);

    const received: ParsedMessage[] = [];
    sdk.on('DC_EVENT_INCOMING_MSG', (e: { msg?: ParsedMessage }) => {
        if (e.msg) {
            received.push(e.msg);
            const chat = e.msg.groupName ? `[${e.msg.groupName}]` : '[1:1]';
            let extra = '';
            if (e.msg.memberAdded) extra += ` ➕ added: ${e.msg.memberAdded}`;
            if (e.msg.memberRemoved) extra += ` ➖ removed: ${e.msg.memberRemoved}`;
            if (e.msg.groupDescription) extra += ` 📝 desc: ${e.msg.groupDescription}`;
            console.log(`\n  📩 ${chat} from ${e.msg.from}: ${e.msg.text.substring(0, 60)}${extra}`);
            
            // Reactive tracking
            if (typeof activeChannel !== 'undefined' && e.msg.groupId === activeChannel.grpId) {
                if (e.msg.memberAdded) {
                    const addr = e.msg.memberAdded.toLowerCase();
                    if (!activeChannel.members.map((m: string) => m.toLowerCase()).includes(addr)) activeChannel.members.push(e.msg.memberAdded);
                }
                if (e.msg.memberRemoved) {
                    const addr = e.msg.memberRemoved.toLowerCase();
                    activeChannel.members = activeChannel.members.filter((m: string) => m.toLowerCase() !== addr);
                }
                if (e.msg.groupDescription) {
                    activeChannel.description = e.msg.groupDescription;
                }
            }
        }
    });

    let activeChannel: any;

    // ── Step 1: SecureJoin ───────────────────────────────────────────────
    console.log('\n━━━ STEP 1: SecureJoin to your device ━━━━━━━━━━━━━━━━━━━━\n');
    let action = await waitForKey('▶ Join your device?');
    if (action === 'exit') process.exit(0);

    const sj = await sdk.secureJoin(INVITE_URI);
    const peerEmail = sj.peerEmail;
    console.log(`  ✅ Joined! Peer: ${peerEmail}`);

    // ── Step 2: Create Channel ───────────────────────────────────────────
    console.log('\n━━━ STEP 2: Create a broadcast channel ━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`  Will create "News Flash 🗞️" with description.`);

    action = await waitForKey('▶ Create channel?');
    if (action === 'exit') process.exit(0);

    activeChannel = await sdk.createChannel({ 
        name: 'News Flash 🗞️', 
        description: 'Real-time updates from the Web SDK.', 
        initialMembers: [peerEmail] 
    });
    console.log(`  ✅ Channel created!`);
    console.log(`     ID: ${activeChannel.grpId}`);
    console.log(`     Desc: ${activeChannel.description}`);
    console.log(`     Members: ${activeChannel.members.length}`);

    // ── Step 3: Send to Channel ──────────────────────────────────────────
    console.log('\n━━━ STEP 3: Send something to the channel ━━━━━━━━━━━━━━━━━\n');

    action = await waitForKey('▶ Send broadcast?');
    if (action === 'exit') process.exit(0);

    await sdk.sendGroupMessage(activeChannel, { text: 'Welcome to the channel! 📢 This was sent from the Web SDK.' });
    console.log('  ✅ Sent broadcast!');

    // ── Step 4: Change Description ───────────────────────────────────────
    console.log('\n━━━ STEP 4: Change channel description ━━━━━━━━━━━━━━━━━━━━\n');
    
    action = await waitForKey('▶ Update description?');
    if (action === 'exit') process.exit(0);

    const newDesc = 'New description: Only verifyied news allowed! 🔒';
    await sdk.updateGroupDescription(activeChannel, { newDescription: newDesc });
    console.log(`  ✅ Updated! Now: ${activeChannel.description}`);

    // ── Step 5: Add Alice ────────────────────────────────────────────────
    console.log('\n━━━ STEP 5: Add a person (Alice) to the channel ━━━━━━━━━━━\n');
    
    action = await waitForKey('▶ Add Alice?');
    if (action === 'exit') process.exit(0);

    // Give Alice the peer's key
    const peerKey = sdk.getKnownKeys().get(peerEmail.toLowerCase());
    if (peerKey) sdkA.getKnownKeys().set(peerEmail.toLowerCase(), peerKey);
    sdk.getKnownKeys().set(credsA.email.toLowerCase(), sdkA.getPublicKeyArmored()!);
    sdkA.getKnownKeys().set(creds.email.toLowerCase(), sdk.getPublicKeyArmored()!);

    await sdk.addGroupMember(activeChannel, { email: credsA.email });
    console.log(`  ✅ Alice added! Members: ${activeChannel.members.length}`);

    // ── Step 6: Remove Alice ─────────────────────────────────────────────
    console.log('\n━━━ STEP 6: Remove Alice from channel ━━━━━━━━━━━━━━━━━━━━━\n');

    action = await waitForKey('▶ Remove Alice?');
    if (action === 'exit') process.exit(0);

    await sdk.removeGroupMember(activeChannel, { email: credsA.email });
    console.log(`  ✅ Alice removed! Members: ${activeChannel.members.length}`);

    // ── Step 7: Final Listen ─────────────────────────────────────────────
    console.log('\n━━━ STEP 7: Listening for responses ━━━━━━━━━━━━━━━━━━━━━━━\n');
    await waitForKey('▶ Listen? (press x done)');

    console.log('\n  🎧 Listening... Press Enter to exit.');
    process.stdin.once('data', () => process.exit(0));
}

runTest().catch(console.error);
