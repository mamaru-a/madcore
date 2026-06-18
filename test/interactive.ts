#!/usr/bin/env bun
// ═══════════════════════════════════════════════════════════════════════════════
// Delta Chat Web SDK — Interactive Real-Device Test
//
// Joins a real Delta Chat desktop/phone user's SecureJoin URI and walks through
// each SDK feature step-by-step.
//
// Controls:
//   Enter  →  run next test step
//   x      →  exit immediately
//
// Usage:
//   bun run test/interactive.ts
//   bun run test/interactive.ts "https://i.delta.chat/#..."
//   bun run test/interactive.ts "https://i.delta.chat/#..." https://your.server
// ═══════════════════════════════════════════════════════════════════════════════

import { DeltaChatSDK, type ParsedMessage } from '../sdk';
import { MemoryStore } from '../store';
import * as readline from 'readline';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// Look for an argument that is NOT the script name and NOT starting with the delta.chat prefix
const argServer = process.argv.slice(2).find(a => !a.startsWith('https://i.delta.chat/') && a.startsWith('http'));
const SERVER = argServer || process.env.SERVER_URL || '';
if (!SERVER) { console.error('❌ Set SERVER_URL in .env or pass as CLI argument.'); process.exit(1); }

// ─── Interactive Input ──────────────────────────────────────────────────────────

/** Prompt the user for a line of text (e.g. paste a URI) */
function askLine(prompt: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(prompt, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

/** Wait for Enter (continue) or x (exit). Uses raw mode for instant keypress. */
function waitForKey(prompt: string): Promise<'continue' | 'exit'> {
    return new Promise((resolve) => {
        process.stdout.write(`\n  ${prompt}  [Enter = next, x = exit] `);

        // Enable raw mode for single-keypress detection
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (key: string) => {
            process.stdin.removeListener('data', onData);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(false);
            }
            process.stdin.pause();

            // Handle Ctrl+C
            if (key === '\u0003') {
                console.log('\n  Bye!');
                process.exit(0);
            }

            // 'x' or 'X' = exit
            if (key.toLowerCase() === 'x') {
                console.log('  → exit');
                resolve('exit');
                return;
            }

            // Enter or any other key = continue
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
    console.log('║   Delta Chat Web SDK — Interactive Real-Device Test     ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log(`  Server: ${SERVER}`);
    console.log(`  Time:   ${new Date().toLocaleTimeString()}\n`);

    // Get the invite URI — from CLI arg or ask interactively
    let INVITE_URI = process.argv.find(a => a.startsWith('https://i.delta.chat/'));
    if (!INVITE_URI) {
        INVITE_URI = await askLine('  📎 Paste SecureJoin URI: ');
        if (!INVITE_URI || !INVITE_URI.includes('delta.chat')) {
            console.error('  ❌ Invalid or empty URI. Exiting.');
            process.exit(1);
        }
    }
    console.log(`  🔗 URI: ${INVITE_URI.substring(0, 60)}...\n`);

    // ── Step 0: Register + Keys ──────────────────────────────────────────
    console.log('━━━ STEP 0: Setup ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const dc = DeltaChatSDK();
    const { account: sdk, email: email } = await dc.register(SERVER);
    const creds = { email };
    console.log(`  📬 Registered: ${creds.email}`);

    await sdk.generateKeys('SDK Interactive Test');
    console.log(`  🔑 Fingerprint: ${sdk.getFingerprint().substring(0, 20)}...`);

    await sdk.connectWebSocket();
    console.log(`  🔌 WebSocket connected`);

    // Listen for incoming messages
    const received: ParsedMessage[] = [];
    sdk.on('DC_EVENT_INCOMING_MSG', (e) => {
        if (e.msg) {
            received.push(e.msg);
            const chat = e.msg.groupName ? `[${e.msg.groupName}]` : '[1:1]';
            console.log(`\n  📩 ${chat} from ${e.msg.from}: ${e.msg.text.substring(0, 80)}`);
            if (e.msg.attachments.length > 0) {
                console.log(`     📎 ${e.msg.attachments.length} attachment(s): ${e.msg.attachments.map(a => `${a.filename} (${a.mimeType})`).join(', ')}`);
            }
        }
    });
    sdk.on('DC_EVENT_INCOMING_REACTION', (e) => {
        if (e.msg) console.log(`\n  👍 REACTION from ${e.msg.from}: ${e.msg.text}`);
    });
    sdk.on('DC_EVENT_MSG_DELETED', (e) => {
        if (e.msg) console.log(`\n  🗑️  DELETE from ${e.msg.from}: ${e.msg.text}`);
    });
    sdk.on('DC_EVENT_CONTACTS_CHANGED', (e) => {
        if (e.msg) console.log(`\n  📸 AVATAR UPDATE from ${e.msg.from}`);
    });

    console.log('\n  ✅ Setup complete. Ready to join your real device.\n');

    // ── Step 1: SecureJoin ───────────────────────────────────────────────
    console.log('━━━ STEP 1: SecureJoin to your device ━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  This will send a SecureJoin request to your Delta Chat app.');
    console.log('  You should see a contact request or verification prompt.\n');

    let action = await waitForKey('▶ Join your device?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

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
            sdk.disconnect();
            process.exit(1);
        }
    }

    await sleep(500);
    console.log(`\n  💡 Check your Delta Chat app — you should see the SDK contact.`);

    // ── Step 2: Send Text Message ────────────────────────────────────────
    console.log('\n━━━ STEP 2: Send encrypted text message ━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will send: "Hello from the Web SDK! 🚀 This is an encrypted test."');

    action = await waitForKey('▶ Send text message?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    const { msgId: msg1Id } = await sdk.sendMessage(peerEmail, 'Hello from the Web SDK! 🚀 This is an encrypted test.');
    console.log(`  ✅ Sent! ID: ${msg1Id}`);
    console.log('  💡 Check your Delta Chat app — the message should appear.');

    // ── Step 3: Send Reply ──────────────────────────────────────────────
    console.log('\n━━━ STEP 3: Send reply with quote ━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will quote the previous message and reply to it.');

    action = await waitForKey('▶ Send reply?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    const { msgId: replyId } = await sdk.sendReply(peerEmail, {
        parentMessage: msg1Id,
        text: 'This is a threaded reply! 🧵 The SDK supports In-Reply-To headers.',
        quotedText: 'Hello from the Web SDK! 🚀 This is an encrypted test.'
    });
    console.log(`  ✅ Reply sent! ID: ${replyId}`);
    console.log('  💡 Check Delta Chat — the reply should be indented / grouped.');

    // ── Step 4: Send Reaction ───────────────────────────────────────────
    console.log('\n━━━ STEP 4: Send reaction (emoji) ━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will react with 👍 to the first message.');

    action = await waitForKey('▶ Send 👍 reaction?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    await sdk.sendReaction(peerEmail, { targetMessage: msg1Id, reaction: '👍' });
    console.log('  ✅ Reaction sent!');
    console.log('  💡 Check Delta Chat — you should see a 👍 under the message.');

    // ── Step 5: Edit Message ────────────────────────────────────────────
    console.log('\n━━━ STEP 5: Edit a message ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will edit the first message to change its text.');

    action = await waitForKey('▶ Edit message?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    await sdk.sendEdit(peerEmail, { targetMessage: msg1Id, newText: 'This message was EDITED by the Web SDK! ✏️🚀' });
    console.log('  ✅ Edit sent!');
    console.log('  💡 Check Delta Chat — the first message text should change.');

    // ── Step 6: Send + Delete ───────────────────────────────────────────
    console.log('\n━━━ STEP 6: Send message then delete it ━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will send a message, wait 3 seconds, then delete it.');

    action = await waitForKey('▶ Send + delete?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    const { msgId: delMsgId } = await sdk.sendMessage(peerEmail, '💣 This message will self-destruct in 3 seconds...');
    console.log(`  ✅ Sent: ${delMsgId}`);
    console.log('  ⏳ Waiting 3 seconds before deleting...');
    await sleep(3000);
    await sdk.sendDelete(peerEmail, { targetMessage: delMsgId });
    console.log('  🗑️  Deleted!');
    console.log('  💡 Check Delta Chat — the message should disappear.');

    // ── Step 6: Send File ───────────────────────────────────────────────
    console.log('\n━━━ STEP 6: Send file attachment ━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will send a small PNG image as a file attachment.');

    action = await waitForKey('▶ Send file?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    // 1x1 red pixel PNG
    const tinyPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
    const { msgId: fileId } = await sdk.sendFile(peerEmail, {
        filename: 'test-pixel.png',
        data: tinyPngB64,
        mimeType: 'image/png',
        caption: '📸 A tiny test pixel!'
    });
    console.log(`  ✅ File sent! ID: ${fileId}`);
    console.log('  💡 Check Delta Chat — you should see an image attachment.');

    // ── Step 7: Send Image ──────────────────────────────────────────────
    console.log('\n━━━ STEP 7: Send image with caption ━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will send a tiny image with a caption.');

    action = await waitForKey('▶ Send image?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    const { msgId: imgId } = await sdk.sendImage(peerEmail, {
        filename: 'hello.png',
        data: tinyPngB64,
        mimeType: 'image/png',
        caption: 'Image from Web SDK 📷'
    });
    console.log(`  ✅ Image sent! ID: ${imgId}`);

    // ── Step 8: Send Voice Message ──────────────────────────────────────
    console.log('\n━━━ STEP 8: Send voice message ━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will send a voice note (no caption — just audio player).');

    action = await waitForKey('▶ Send voice?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    const fakeAudioB64 = Buffer.from('FAKE OGG AUDIO DATA FOR TESTING').toString('base64');
    const { msgId: voiceId } = await sdk.sendVoice(peerEmail, {
        data: fakeAudioB64,
        mimeType: 'audio/ogg',
        durationMs: 3500
    });
    console.log(`  ✅ Voice sent! ID: ${voiceId}`);
    console.log('  💡 Check Delta Chat — you should see a voice message bubble.');

    // ── Step 9: Send Audio/Music ────────────────────────────────────────
    console.log('\n━━━ STEP 9: Send audio/music file ━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will send a music file with caption "🎵 Test track".');

    action = await waitForKey('▶ Send audio?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    const fakeMp3B64 = Buffer.from('FAKE MP3 AUDIO DATA FOR TESTING').toString('base64');
    const { msgId: audioId } = await sdk.sendAudio(peerEmail, {
        filename: 'test-track.mp3',
        data: fakeMp3B64,
        mimeType: 'audio/mpeg',
        caption: '🎵 Test track',
        durationMs: 5000
    });
    console.log(`  ✅ Audio sent! ID: ${audioId}`);
    console.log('  💡 Check Delta Chat — you should see an audio player with caption.');

    // ── Step 10: Send Video ─────────────────────────────────────────────
    console.log('\n━━━ STEP 10: Send video file ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will send a video file with caption "🎬 SDK Video Test".');

    action = await waitForKey('▶ Send video?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    const fakeVideoB64 = Buffer.from('FAKE MP4 VIDEO DATA FOR TESTING').toString('base64');
    const { msgId: videoId } = await sdk.sendVideo(peerEmail, {
        filename: 'test-clip.mp4',
        data: fakeVideoB64,
        mimeType: 'video/mp4',
        caption: '🎬 SDK Video Test',
        durationMs: 8000
    });
    console.log(`  ✅ Video sent! ID: ${videoId}`);
    console.log('  💡 Check Delta Chat — you should see a video attachment with caption.');

    // ── Step 11: Profile Photo ──────────────────────────────────────────
    console.log('\n━━━ STEP 11: Send profile photo update ━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will set a profile photo and send it to your device.');

    action = await waitForKey('▶ Send profile photo?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    sdk.setProfilePhotoB64(tinyPngB64, 'image/png');
    await sdk.sendProfilePhoto(peerEmail, { caption: 'Updated my avatar! 📸' });
    console.log('  ✅ Profile photo sent!');
    console.log('  💡 Check Delta Chat — the SDK contact avatar should change.');

    // ── Step 12: Forward Message ────────────────────────────────────────
    console.log('\n━━━ STEP 12: Forward a message ━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will forward the original test message back to you.');

    action = await waitForKey('▶ Forward message?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    const { msgId: fwdId } = await sdk.forwardMessage(peerEmail, {
        originalMessage: 'Hello from the Web SDK! 🚀 This is an encrypted test.',
        originalFrom: creds.email
    });
    console.log(`  ✅ Forwarded! ID: ${fwdId}`);
    console.log('  💡 Check Delta Chat — you should see "Forwarded message".');

    // ── Step 13: Display Name Change ────────────────────────────────────
    console.log('\n━━━ STEP 13: Change display name ━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('  Will change the display name and send a message with it.');

    action = await waitForKey('▶ Change name + send?');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    sdk.setDisplayName('Web SDK Bot 🤖');
    const { msgId: nameMsgId } = await sdk.sendMessage(peerEmail, 'My name is now "Web SDK Bot 🤖" — check the sender!');
    console.log(`  ✅ Sent with new name! ID: ${nameMsgId}`);

    // ── Step 14: Listen for responses ───────────────────────────────────
    console.log('\n━━━ STEP 14: Listening for your responses ━━━━━━━━━━━━━━━━━\n');
    console.log('  Send messages from your Delta Chat app to test receive.');
    console.log('  The SDK will decrypt and display them here.');
    console.log(`  Received so far: ${received.length} message(s)`);

    action = await waitForKey('▶ Listen for messages? (press x when done)');
    if (action === 'exit') { sdk.disconnect(); process.exit(0); }

    console.log('\n  🎧 Listening... Send messages from Delta Chat. Press x to exit.\n');

    // Listen loop
    while (true) {
        const key = await waitForKey(`  📊 ${received.length} messages received`);
        if (key === 'exit') break;
    }

    // ── Summary ─────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════');
    console.log('            INTERACTIVE TEST COMPLETE');
    console.log('══════════════════════════════════════════════════════════\n');
    console.log(`  Account:    ${creds.email}`);
    console.log(`  Peer:       ${peerEmail}`);
    console.log(`  Messages:   ${received.length} received`);
    console.log(`  Features tested:`);
    console.log('    ✅ SecureJoin (key exchange)');
    console.log('    ✅ Send encrypted text');
    console.log('    ✅ Reply with quote (threading)');
    console.log('    ✅ Reaction (emoji)');
    console.log('    ✅ Edit message');
    console.log('    ✅ Send + Delete');
    console.log('    ✅ File attachment');
    console.log('    ✅ Image with caption');
    console.log('    ✅ Voice message');
    console.log('    ✅ Audio/Music with caption');
    console.log('    ✅ Video with caption');
    console.log('    ✅ Profile photo update');
    console.log('    ✅ Forward message');
    console.log('    ✅ Display name change');
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
