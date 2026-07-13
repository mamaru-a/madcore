/**
 * Persistence round-trip tests (MemoryStore — same IDeltaChatStore API as IndexedDB).
 */
import { describe, it, expect } from 'bun:test';
import { DeltaChatAccount, DeltaChatSDK, MemoryStore } from '../../sdk';

describe('account persistence', () => {
    it('saveToStore / loadFromStore restores keys, profile, groups, config', async () => {
        const store = new MemoryStore();
        const a = new DeltaChatAccount(store, 'acc1', 'alice@relay.test', 'pw', 'https://relay.test');
        await a.generateKeys('Alice');
        a.setDisplayName('Alice A');
        a.setProfilePhotoB64('aGVsbG8=', 'image/png');
        await a.setConfig('theme', 'dark');

        // Simulate a group registry entry
        (a as any).groups.set('grp1', {
            grpId: 'grp1',
            name: 'Team',
            members: ['alice@relay.test', 'bob@relay.test'],
            type: 'group',
        });
        (a as any).lastSeenUid = 42;
        await a.flushPersist();

        const b = new DeltaChatAccount(store);
        const ok = await b.loadFromStore();
        expect(ok).toBe(true);
        expect(b.getCredentials().email).toBe('alice@relay.test');
        expect(b.getDisplayName()).toBe('Alice A');
        expect(b.getFingerprint().length).toBeGreaterThan(8);
        expect(b.getPublicKeyArmored()).toContain('BEGIN PGP PUBLIC KEY');
        expect(await b.getConfig('theme')).toBe('dark');

        const g = b.getGroup('grp1');
        expect(g?.name).toBe('Team');
        expect(g?.members).toContain('bob@relay.test');

        // profile photo restored
        expect((b as any).profilePhotoB64).toBe('aGVsbG8=');
        expect((b as any).lastSeenUid).toBe(42);
    });

    it('persists contacts and messages independently of account snapshot', async () => {
        const store = new MemoryStore();
        const a = new DeltaChatAccount(store, 'acc2', 'carol@relay.test', 'pw', 'https://relay.test');
        await a.generateKeys('Carol');
        await a.flushPersist();

        const bobKey = a.getPublicKeyArmored()!; // use own key for test contact
        const contact = await a.createContact({
            email: 'dave@relay.test',
            name: 'Dave',
            key: bobKey,
        });
        expect(contact.id).toBeTruthy();

        await a.store.saveChat({
            id: 'dave@relay.test',
            name: 'Dave',
            peerEmail: 'dave@relay.test',
            isGroup: false,
            unreadCount: 1,
            archived: false,
            pinned: false,
            muted: false,
            lastMessage: 'hi',
        });
        await a.store.saveMessage({
            id: '<m1@relay.test>',
            chatId: 'dave@relay.test',
            from: 'dave@relay.test',
            to: 'carol@relay.test',
            text: 'hi',
            timestamp: Date.now(),
            encrypted: true,
            direction: 'incoming',
            type: 'text',
            state: 'sent',
        });

        const b = new DeltaChatAccount(store);
        await b.loadFromStore();
        const chats = await b.getChatList();
        expect(chats.some(c => c.id === 'dave@relay.test')).toBe(true);
        const msgs = await b.getChatMessages('dave@relay.test');
        expect(msgs).toHaveLength(1);
        expect(msgs[0].text).toBe('hi');
        expect(b.findContactByEmail('dave@relay.test')?.name).toBe('Dave');
    });

    it('saveAccount normalizes email key for lookup', async () => {
        const store = new MemoryStore();
        await store.saveAccount({
            email: 'MixedCase@Relay.Test',
            password: 'x',
            serverUrl: 'https://relay.test',
            displayName: '',
            fingerprint: '',
            privateKeyArmored: '',
            publicKeyArmored: '',
            autocryptKeydata: '',
        });
        const got = await store.getAccountByEmail('mixedcase@relay.test');
        expect(got?.email).toBe('mixedcase@relay.test');
    });

    it('DeltaChatSDK with MemoryStore listPersistedAccounts is empty', async () => {
        const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'none' });
        expect(await dc.listPersistedAccounts()).toEqual([]);
    });

    it('exportBackup exports the active account in a shared MemoryStore', async () => {
        const store = new MemoryStore();
        const a = new DeltaChatAccount(store, 'a1', 'alice@relay.test', 'pw', 'https://relay.test');
        const b = new DeltaChatAccount(store, 'b1', 'bob@relay.test', 'pw2', 'https://relay.test');
        await a.generateKeys('Alice');
        await b.generateKeys('Bob');
        await a.setConfig('e2e_owner', 'alice');
        const blob = await a.exportBackup();
        const parsed = JSON.parse(blob);
        expect(parsed.account.email).toBe('alice@relay.test');
        expect(parsed.config?.e2e_owner).toBe('alice');
    });

    it('exportBackup / importBackup round-trip restores config', async () => {
        const store = new MemoryStore();
        const a = new DeltaChatAccount(store, 'bk1', 'backup@relay.test', 'pw', 'https://relay.test');
        await a.generateKeys('Backup');
        await a.setConfig('e2e_marker', 'roundtrip-ok');
        const blob = await a.exportBackup();
        const b = new DeltaChatAccount(store, 'bk2', 'other@relay.test', 'pw2', 'https://relay.test');
        await b.importBackup(blob);
        expect(await b.getConfig('e2e_marker')).toBe('roundtrip-ok');
        expect(b.getCredentials().email).toBe('backup@relay.test');
    });

    it('schedulePersist + flushPersist writes without explicit saveToStore', async () => {
        const store = new MemoryStore();
        const a = new DeltaChatAccount(store, 'acc3', 'eve@relay.test', 'pw', 'https://relay.test');
        await a.generateKeys('Eve');
        a.setDisplayName('Eve E');
        // generateKeys / setDisplayName schedule; flush forces write
        await a.flushPersist();

        const b = new DeltaChatAccount(store);
        expect(await b.loadFromStore()).toBe(true);
        expect(b.getDisplayName()).toBe('Eve E');
        expect(b.getFingerprint().length).toBeGreaterThan(8);
    });
});
