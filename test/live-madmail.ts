/**
 * Live verification against a madmail / chatmail instance.
 *
 * Requires env vars (no secrets in the repo):
 *
 *   SERVER_URL=https://your-madmail.example \
 *   JOIN_URI='https://i.delta.chat/#…' \
 *   bun run test:live
 *
 * Optional:
 *   JOIN_TIMEOUT_MS=90000
 */
import { DeltaChatSDK } from '../sdk';
import { MemoryStore } from '../store';
import { checkQr, parseSecureJoinURI } from '../lib/securejoin';

const SERVER = process.env.SERVER_URL;
const JOIN_URI = process.env.JOIN_URI;
const JOIN_TIMEOUT_MS = Number(process.env.JOIN_TIMEOUT_MS || 90_000);

const results: { name: string; ok: boolean; detail?: string }[] = [];

function pass(name: string, detail?: string) {
    results.push({ name, ok: true, detail });
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name: string, detail?: string) {
    results.push({ name, ok: false, detail });
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
    if (!SERVER) {
        console.error('SERVER_URL is required (e.g. https://madmail.example)');
        process.exit(2);
    }
    if (!JOIN_URI) {
        console.error('JOIN_URI is required (a SecureJoin invite URL from the peer)');
        process.exit(2);
    }

    console.log(`\n🔬 Live madmail verification`);
    console.log(`   Server: ${SERVER}`);
    console.log(`   Join:   ${JOIN_URI.slice(0, 48)}…\n`);

    // ── QR parse ──
    let peerEmailHint = '';
    try {
        const qr = checkQr(JOIN_URI);
        if (qr.kind !== 'securejoin' && qr.kind !== 'securejoin_group') {
            throw new Error(`kind=${qr.kind}`);
        }
        const p = parseSecureJoinURI(JOIN_URI);
        peerEmailHint = p.inviterEmail || '';
        pass('checkQr / parseSecureJoinURI', `peer=${p.inviterEmail} fp=${p.fingerprint.slice(0, 12)}…`);
    } catch (e: any) {
        fail('checkQr / parseSecureJoinURI', e.message);
    }

    // ── Capability matrix (offline methods) ──
    try {
        const dc0 = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'error' });
        const a0 = dc0.addAccount('x@y.z', 'p', SERVER);
        const methods = [
            'send', 'sendSticker', 'sendGif', 'blockContact', 'checkQr',
            'setDraft', 'setChatEphemeralTimer', 'sendWebxdc', 'exportBackup',
            'placeOutgoingCall', 'sendLocationsToChat', 'getConnectivity',
            'addDeviceMessage', 'capabilities',
        ];
        const missing = methods.filter(m => typeof (a0 as any)[m] !== 'function');
        if (missing.length) throw new Error(`missing: ${missing.join(',')}`);
        pass('capability matrix (method surface)', `${methods.length} methods present`);
        pass('capabilities()', JSON.stringify(a0.capabilities()));
    } catch (e: any) {
        fail('capability matrix', e.message);
    }

    const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'info' });

    // ── Register ──
    let account: any;
    try {
        const reg = await dc.register(SERVER, 'Madcore Live Test');
        account = reg.account;
        pass('register (POST /new)', `email=${reg.email}`);
    } catch (e: any) {
        fail('register (POST /new)', e.message);
        summary();
        process.exit(1);
    }

    // ── Keys ──
    try {
        if (!account.getFingerprint()) await account.generateKeys('Madcore Live Test');
        pass('PGP keygen', `fp=${account.getFingerprint().slice(0, 16)}…`);
    } catch (e: any) {
        fail('PGP keygen', e.message);
        summary();
        process.exit(1);
    }

    // ── Connect WS ──
    try {
        await account.connect(SERVER);
        await new Promise(r => setTimeout(r, 500));
        const st = account.status();
        if (!st.isConnected) throw new Error(`not connected: ${JSON.stringify(st.relays)}`);
        pass('WebSocket connect', `connectivity=${account.getConnectivity()}`);
    } catch (e: any) {
        fail('WebSocket connect', e.message);
    }

    // ── Mailbox list via ws ──
    try {
        if (account.status().isConnected) {
            const mboxes = await account.wsRequest('list_mailboxes', {});
            pass('WS list_mailboxes', Array.isArray(mboxes) ? `${mboxes.length} boxes` : JSON.stringify(mboxes).slice(0, 80));
        } else {
            fail('WS list_mailboxes', 'not connected');
        }
    } catch (e: any) {
        fail('WS list_mailboxes', e.message);
    }

    // ── SecureJoin ──
    let joinOk = false;
    let contact: any;
    try {
        console.log(`\n  ⏳ SecureJoin (needs inviter online — up to ${JOIN_TIMEOUT_MS / 1000}s)…`);
        const joinPromise = account.secureJoin(JOIN_URI);
        const timeout = new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`timeout ${JOIN_TIMEOUT_MS}ms waiting for SecureJoin`)), JOIN_TIMEOUT_MS),
        );
        const result = await Promise.race([joinPromise, timeout]) as any;
        joinOk = !!result?.verified || !!result?.peerEmail;
        contact = result?.contact;
        pass('SecureJoin handshake', `peer=${result?.peerEmail} verified=${result?.verified} contactId=${result?.contactId || contact?.id}`);
    } catch (e: any) {
        fail('SecureJoin handshake', e.message);
    }

    // ── Send text ──
    if (joinOk && contact) {
        try {
            const text = `Hello from madcore-web live test 🧪 ${new Date().toISOString()}`;
            const sent = await account.send(contact, { text });
            pass('send text (encrypted)', `msgId=${sent?.msgId}`);
        } catch (e: any) {
            fail('send text (encrypted)', e.message);
        }

        try {
            // Tiny 1×1 PNG base64 (web-safe, no Node Buffer)
            const tiny =
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
            const sent = await account.send(contact, {
                sticker: { data: tiny, mimeType: 'image/png', filename: 'dot.png' },
            });
            pass('send sticker', `msgId=${sent?.msgId}`);
        } catch (e: any) {
            fail('send sticker', e.message);
        }

        try {
            const chats = await account.getChatList();
            const peerLocal = peerEmailHint.split('@')[0] || '';
            const peerChat = chats.find((c: any) =>
                (peerLocal && (c.peerEmail?.includes(peerLocal) || c.id?.includes(peerLocal)))
                || c.peerEmail === peerEmailHint,
            );
            if (peerChat) {
                const msgs = await account.getChatMessages(peerChat.id, 10, 0);
                const out = msgs.find((m: any) => m.direction === 'outgoing' && m.type === 'text');
                if (out) {
                    await account.send(contact, { reaction: { targetMessage: out, reaction: '👋' } });
                    pass('send reaction', `target=${out.id}`);
                } else {
                    fail('send reaction', 'no outgoing text msg in store');
                }
            } else {
                fail('send reaction', 'peer chat not found');
            }
        } catch (e: any) {
            fail('send reaction', e.message);
        }
    } else {
        console.log('  ⚠️  Skipping send tests (SecureJoin incomplete — inviter may be offline)');
    }

    // ── Local APIs that don't need peer ──
    try {
        await account.setDraft('local-chat', { text: 'draft test' });
        const d = await account.getDraft('local-chat');
        if (d?.text !== 'draft test') throw new Error('draft mismatch');
        await account.removeDraft('local-chat');
        pass('drafts local API');
    } catch (e: any) {
        fail('drafts local API', e.message);
    }

    try {
        await account.setChatEphemeralTimer('local-chat', 30);
        const t = await account.getChatEphemeralTimer('local-chat');
        if (t !== 30) throw new Error(`timer=${t}`);
        pass('ephemeral timer local API');
    } catch (e: any) {
        fail('ephemeral timer local API', e.message);
    }

    try {
        const json = await account.exportBackup();
        const parsed = JSON.parse(json);
        if (!parsed.account?.email) throw new Error('bad backup');
        pass('exportBackup', `email=${parsed.account.email} msgs=${parsed.messages?.length ?? 0}`);
    } catch (e: any) {
        fail('exportBackup', e.message);
    }

    try {
        const enc = await account.exportBackup({ passphrase: 'unit-test-passphrase' });
        const obj = JSON.parse(enc);
        if (!obj.enc) throw new Error('expected encrypted blob');
        pass('exportBackup (encrypted)');
    } catch (e: any) {
        fail('exportBackup (encrypted)', e.message);
    }

    try {
        const { msgId } = await account.addDeviceMessage('live', 'Live test device note');
        pass('addDeviceMessage', msgId);
    } catch (e: any) {
        fail('addDeviceMessage', e.message);
    }

    try {
        await account.blockContact('spam@example.com');
        if (!account.isBlocked('spam@example.com')) throw new Error('not blocked');
        await account.unblockContact('spam@example.com');
        pass('block / unblock');
    } catch (e: any) {
        fail('block / unblock', e.message);
    }

    try {
        account.disconnect();
        pass('disconnect');
    } catch (e: any) {
        fail('disconnect', e.message);
    }

    summary();
    const failed = results.filter(r => !r.ok).length;
    process.exit(failed > 0 ? 1 : 0);
}

function summary() {
    const ok = results.filter(r => r.ok).length;
    const bad = results.filter(r => !r.ok).length;
    console.log(`\n📊 ${ok} passed, ${bad} failed (${results.length} checks)\n`);
    if (bad) {
        console.log('Failures:');
        for (const r of results.filter(x => !x.ok)) {
            console.log(`  - ${r.name}: ${r.detail}`);
        }
        console.log('');
    }
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
