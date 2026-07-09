/**
 * Strict event tests — no synthetic emit fallbacks.
 * Requires correct MIME parse + processIncomingRaw (web-compatible).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DeltaChatSDK } from '../../sdk';
import { MemoryStore } from '../../store';
import { buildRawMime, waitForEvent, TINY_PNG_B64, installMockWebSocket } from './helpers/web';
import { log } from '../../lib/logger';

describe('strict DC_EVENT paths (no fake emit)', () => {
    let account: any;
    let restore: (() => void) | null = null;

    beforeEach(() => {
        restore = installMockWebSocket();
        const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'info' });
        account = dc.addAccount('alice@relay.example', 'pass', 'https://relay.example');
    });

    afterEach(() => {
        account?.disconnect?.();
        restore?.();
    });

    it('INCOMING_MSG', async () => {
        const p = waitForEvent(account, 'DC_EVENT_INCOMING_MSG');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({ from: 'bob@relay.example', to: 'alice@relay.example', body: 'hi' }),
        });
        const e: any = await p;
        expect(e.msg.text).toContain('hi');
    });

    it('INCOMING_REACTION (unencrypted control)', async () => {
        const p = waitForEvent(account, 'DC_EVENT_INCOMING_REACTION');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: '🔥',
                headers: {
                    'Content-Disposition': 'reaction',
                    'In-Reply-To': '<t@x>',
                },
            }),
        });
        const e: any = await p;
        expect(e.event).toBe('DC_EVENT_INCOMING_REACTION');
    });

    it('MSG_DELETED (unencrypted Chat-Delete)', async () => {
        const p = waitForEvent(account, 'DC_EVENT_MSG_DELETED');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: '🚮',
                headers: { 'Chat-Delete': '<gone@x>' },
            }),
        });
        const e: any = await p;
        expect(e.msgId).toBe('<gone@x>');
    });

    it('MSG_READ (disposition notification)', async () => {
        await account.store.saveMessage({
            id: '<out1@x>',
            chatId: 'bob@relay.example',
            from: 'alice@relay.example',
            to: 'bob@relay.example',
            text: 'x',
            timestamp: Date.now(),
            encrypted: true,
            direction: 'outgoing',
            type: 'text',
            state: 'sent',
        });
        const p = waitForEvent(account, 'DC_EVENT_MSG_READ');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: '',
                headers: {
                    'Chat-Disposition': 'display',
                    'Original-Message-ID': '<out1@x>',
                },
            }),
        });
        const e: any = await p;
        expect(e.msgId).toBe('<out1@x>');
    });

    it('SECUREJOIN_JOINER_PROGRESS', async () => {
        const p = waitForEvent(account, 'DC_EVENT_SECUREJOIN_JOINER_PROGRESS');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: '',
                headers: { 'Secure-Join': 'vc-auth-required' },
            }),
        });
        const e: any = await p;
        expect(e.data1).toBe('vc-auth-required');
    });

    it('SECUREJOIN_INVITER_PROGRESS', async () => {
        // Set invite tokens without full keygen URI
        (account as any).myInviteNumber = 'invite-token-abc';
        (account as any).myAuthToken = 'auth-token-xyz';
        const p = waitForEvent(account, 'DC_EVENT_SECUREJOIN_INVITER_PROGRESS');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: '',
                headers: {
                    'Secure-Join': 'vc-request',
                    'Secure-Join-Invitenumber': 'invite-token-abc',
                },
            }),
        });
        const e: any = await p;
        expect(e.data1).toBe('vc-request');
    });

    it('SELFAVATAR_CHANGED', async () => {
        const p = waitForEvent(account, 'DC_EVENT_SELFAVATAR_CHANGED');
        // Browser-style: base64 object
        await account.setProfilePhoto({ data: TINY_PNG_B64, mimeType: 'image/png' });
        await p;
    });

    it('CONTACTS_CHANGED', async () => {
        const p = waitForEvent(account, 'DC_EVENT_CONTACTS_CHANGED');
        await account.blockContact('x@y.z');
        await p;
    });

    it('MSGS_CHANGED', async () => {
        const p = waitForEvent(account, 'DC_EVENT_MSGS_CHANGED');
        await account.setChatProfileImage('chat1', { data: TINY_PNG_B64 });
        await p;
    });

    it('LOCATION_CHANGED', async () => {
        const p = waitForEvent(account, 'DC_EVENT_LOCATION_CHANGED');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: JSON.stringify({ lat: 1, lon: 2, timestamp: Date.now() }),
                contentType: 'application/json; charset=utf-8',
                headers: { 'Chat-Content': 'location' },
            }),
        });
        const e: any = await p;
        expect(e.data1.lat).toBe(1);
    });

    it('INCOMING_CALL + CALL_ENDED (inbound end)', async () => {
        const callId = crypto.randomUUID();
        const pIn = waitForEvent(account, 'DC_EVENT_INCOMING_CALL');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: JSON.stringify({ type: 'offer', callId, sdp: 'v=0', video: true }),
                contentType: 'application/json; charset=utf-8',
                headers: { 'Chat-Content': 'call', 'Chat-Call-Type': 'offer' },
            }),
        });
        const inc: any = await pIn;
        expect(inc.data1).toBe(callId);

        const pEnd = waitForEvent(account, 'DC_EVENT_CALL_ENDED');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: JSON.stringify({ type: 'end', callId }),
                contentType: 'application/json; charset=utf-8',
                headers: { 'Chat-Content': 'call', 'Chat-Call-Type': 'end' },
            }),
        });
        const end: any = await pEnd;
        expect(end.data1).toBe(callId);
    });

    it('WEBXDC_STATUS_UPDATE', async () => {
        const p = waitForEvent(account, 'DC_EVENT_WEBXDC_STATUS_UPDATE');
        await account.processIncomingRaw({
            uid: 0,
            body: buildRawMime({
                from: 'bob@relay.example',
                to: 'alice@relay.example',
                body: JSON.stringify({ serial: 9, payload: { hp: 3 } }),
                contentType: 'application/json; charset=utf-8',
                headers: {
                    'Chat-Content': 'webxdc-status',
                    'Chat-Webxdc-Instance': '<inst@x>',
                    'In-Reply-To': '<inst@x>',
                },
            }),
        });
        const e: any = await p;
        expect(e.data1).toBe(9);
        expect(e.msgId).toBe('<inst@x>');
    });

    it('CONNECTIVITY_CHANGED', async () => {
        const p = waitForEvent(account, 'DC_EVENT_CONNECTIVITY_CHANGED');
        await account.connect('https://relay.example');
        await new Promise(r => setTimeout(r, 15));
        const e: any = await p;
        expect(e.data1).toBe('connected');
    });

    it('INFO WARNING ERROR log bridge', async () => {
        const i = waitForEvent(account, 'DC_EVENT_INFO');
        log.info('t', 'i');
        await i;
        const w = waitForEvent(account, 'DC_EVENT_WARNING');
        log.warn('t', 'w');
        await w;
        const er = waitForEvent(account, 'DC_EVENT_ERROR');
        log.error('t', 'e');
        await er;
    });

    it('REACTIONS_CHANGED via 1:1 sendReaction store path', async () => {
        // Plant peer key as self key so encrypt works; use mock WS for send
        await account.connect('https://relay.example');
        await new Promise(r => setTimeout(r, 15));
        const openpgp = await import('openpgp');
        const k = await openpgp.generateKey({
            type: 'ecc',
            curve: 'curve25519' as any,
            userIDs: [{ email: 'alice@relay.example' }],
            passphrase: '',
            format: 'armored',
        });
        account.privateKey = await openpgp.readPrivateKey({ armoredKey: k.privateKey });
        account.publicKey = await openpgp.readKey({ armoredKey: k.publicKey });
        account.knownKeys.set('bob@relay.example', account.publicKey.armor());
        await account.createContact({
            email: 'bob@relay.example',
            name: 'Bob',
            key: account.publicKey.armor(),
        });
        // Persist target message without network send
        const msgId = '<react-target@x>';
        await account.store.saveMessage({
            id: msgId,
            chatId: 'bob@relay.example',
            from: 'alice@relay.example',
            to: 'bob@relay.example',
            text: 'react me',
            timestamp: Date.now(),
            encrypted: true,
            direction: 'outgoing',
            type: 'text',
            state: 'sent',
        });
        const p = waitForEvent(account, 'DC_EVENT_REACTIONS_CHANGED', 5000);
        await account.sendReaction('bob@relay.example', { targetMessage: msgId, reaction: '❤️' });
        const e: any = await p;
        expect(e.msgId).toBe(msgId);
    });
});
