import { describe, it, expect, beforeEach } from 'bun:test';
import { DeltaChatSDK } from '../../sdk';
import { MemoryStore } from '../../store';
import { serializeBackup, parseBackup, encryptBackup, loadBackup, type BackupPayload } from '../../lib/backup';
import { encodeLocation, parseLocation } from '../../lib/location';
import { encodeSignal, parseSignal, generateCallId, callCapability } from '../../lib/calls';
import { parseStatusUpdate } from '../../lib/webxdc';
import { buildInnerText } from '../../lib/mime-build';

describe('drafts + ephemeral + avatar (store APIs)', () => {
    let acc: ReturnType<ReturnType<typeof DeltaChatSDK>['addAccount']>;

    beforeEach(() => {
        const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'none' });
        acc = dc.addAccount('alice@test.example', 'pass', 'https://relay.example');
    });

    it('set/get/remove draft', async () => {
        await acc.setDraft('bob@test.example', { text: 'hello draft' });
        const d = await acc.getDraft('bob@test.example');
        expect(d?.text).toBe('hello draft');
        expect(d?.updatedAt).toBeGreaterThan(0);
        await acc.removeDraft('bob@test.example');
        expect(await acc.getDraft('bob@test.example')).toBeNull();
    });

    it('setChatEphemeralTimer stores on chat', async () => {
        await acc.setChatEphemeralTimer('bob@test.example', 60);
        expect(await acc.getChatEphemeralTimer('bob@test.example')).toBe(60);
        await acc.setChatEphemeralTimer('bob@test.example', 0);
        expect(await acc.getChatEphemeralTimer('bob@test.example')).toBe(0);
    });

    it('setChatProfileImage stores avatar data URI', async () => {
        await acc.setChatProfileImage('group1', { data: 'AAAA', mimeType: 'image/png' });
        const chat = await acc.getChat('group1');
        expect(chat?.avatar).toContain('base64,AAAA');
        await acc.removeChatProfileImage('group1');
        const chat2 = await acc.getChat('group1');
        expect(chat2?.avatar).toBeUndefined();
    });

    it('sweepEphemeralMessages deletes expired', async () => {
        const store = acc['store'] as MemoryStore;
        await store.saveChat({
            id: 'c1', name: 'c', peerEmail: 'c@x', isGroup: false,
            unreadCount: 0, archived: false, pinned: false, muted: false,
        });
        await store.saveMessage({
            id: '<old@x>', chatId: 'c1', from: 'a', to: 'b', text: 'gone',
            timestamp: 1, encrypted: true, direction: 'incoming', type: 'text',
            state: 'sent', ephemeralExpiresAt: Date.now() - 1000,
        });
        await store.saveMessage({
            id: '<new@x>', chatId: 'c1', from: 'a', to: 'b', text: 'keep',
            timestamp: Date.now(), encrypted: true, direction: 'incoming', type: 'text',
            state: 'sent', ephemeralExpiresAt: Date.now() + 60_000,
        });
        const n = await acc.sweepEphemeralMessages();
        expect(n).toBe(1);
        expect(await store.getMessage('<old@x>')).toBeNull();
        expect(await store.getMessage('<new@x>')).not.toBeNull();
    });

    it('addDeviceMessage is local-only system chat', async () => {
        const { msgId, message } = await acc.addDeviceMessage('welcome', 'Hello device');
        expect(msgId).toContain('device-');
        expect(message.type).toBe('system');
        expect(message.chatId).toBe('device-chat');
        const msgs = await acc.getChatMessages('device-chat');
        expect(msgs.length).toBe(1);
    });

    it('config bag set/get', async () => {
        await acc.setConfig('displayname', 'Alice');
        expect(await acc.getConfig('displayname')).toBe('Alice');
        await acc.batchSetConfig({ a: '1', b: '2' });
        expect(await acc.getConfig('a')).toBe('1');
        expect(await acc.getConfig('b')).toBe('2');
    });

    it('capabilities reports features', () => {
        const caps = acc.capabilities();
        expect(caps.webxdc).toBe(true);
        expect(caps.location).toBe(true);
        expect(['webrtc', 'signaling-only', 'none']).toContain(caps.calls);
    });

    it('getConnectivity returns enum', () => {
        expect(acc.getConnectivity()).toBe('not_connected');
        expect(acc.getConnectivityHtml()).toContain('not_connected');
    });

    it('watched mailboxes config', () => {
        acc.setWatchedMailboxes(['INBOX', 'Sent']);
        expect(acc.getWatchedMailboxes()).toEqual(['INBOX', 'Sent']);
    });
});

describe('backup crypto', () => {
    const sample: BackupPayload = {
        v: 1,
        createdAt: Date.now(),
        account: {
            email: 'a@b.c', password: 'p', serverUrl: 'https://r',
            displayName: 'A', fingerprint: 'F', privateKeyArmored: 'PRIV',
            publicKeyArmored: 'PUB', autocryptKeydata: 'K',
        },
        contacts: [],
        chats: [],
        messages: [],
    };

    it('round-trips plain JSON', () => {
        const json = serializeBackup(sample);
        const parsed = parseBackup(json);
        expect(parsed.account.email).toBe('a@b.c');
    });

    it('encrypts and decrypts with passphrase', async () => {
        const json = serializeBackup(sample);
        const enc = await encryptBackup(json, 'secret-pass');
        expect(enc.enc).toBe(true);
        const loaded = await loadBackup(JSON.stringify(enc), 'secret-pass');
        expect(loaded.account.email).toBe('a@b.c');
    });

    it('rejects wrong passphrase', async () => {
        const json = serializeBackup(sample);
        const enc = await encryptBackup(json, 'right');
        await expect(loadBackup(JSON.stringify(enc), 'wrong')).rejects.toThrow();
    });
});

describe('location helpers', () => {
    it('encode/parse location points', () => {
        const raw = encodeLocation({ lat: 1.5, lon: 2.5, accuracy: 10, timestamp: 100 });
        const p = parseLocation(raw);
        expect(p?.lat).toBe(1.5);
        expect(p?.lon).toBe(2.5);
        expect(p?.accuracy).toBe(10);
    });
});

describe('call signaling helpers', () => {
    it('encode/parse offer signal', () => {
        const id = generateCallId();
        const raw = encodeSignal({ type: 'offer', callId: id, sdp: 'v=0', video: true });
        const s = parseSignal(raw);
        expect(s?.type).toBe('offer');
        expect(s?.callId).toBe(id);
        expect(s?.video).toBe(true);
        expect(s?.sdp).toBe('v=0');
    });

    it('callCapability is signaling-only or webrtc', () => {
        expect(['webrtc', 'signaling-only']).toContain(callCapability());
    });
});

describe('webxdc status parse', () => {
    it('parses status JSON', () => {
        const u = parseStatusUpdate(JSON.stringify({ serial: 3, payload: { score: 1 } }));
        expect(u?.serial).toBe(3);
        expect((u?.payload as any).score).toBe(1);
    });
});

describe('ephemeral + avatar MIME', () => {
    it('Chat-Ephemeral-Timer header in control body', () => {
        const inner = buildInnerText(
            ['Content-Type: text/plain', 'Chat-Ephemeral-Timer: 120'],
            'Disappearing messages set to 120s.',
        );
        expect(inner).toContain('Chat-Ephemeral-Timer: 120');
    });

    it('Chat-Group-Avatar header', () => {
        const inner = buildInnerText(
            ['Content-Type: text/plain', 'Chat-Group-Avatar: base64:AAAA'],
            'Group avatar updated.',
        );
        expect(inner).toContain('Chat-Group-Avatar: base64:AAAA');
    });
});
