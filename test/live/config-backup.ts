/**
 * Live suite: config, push hooks, device messages, backup, multi-relay.
 */
import { DeltaChatSDK, DeltaChatAccount } from '../../sdk';
import { MemoryStore } from '../../store';
import { tryMethod, sleep, type LiveAccount } from './harness';

export async function runImportBackupSuite(
    _dc: ReturnType<typeof DeltaChatSDK>,
    server: string,
) {
    const marker = `import-${Date.now()}`;
    const iso = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'warn' });
    const srcReg = await tryMethod('importBackup/setup src', () => iso.register(server, 'E2E BackupSrc'));
    if (!srcReg?.account) return;
    const src = srcReg.account as LiveAccount;
    await tryMethod('importBackup/src keys', () => src.generateKeys('BackupSrc'));
    await tryMethod('importBackup/src connect', async () => {
        await src.connect(server);
        await sleep(300);
    });
    await tryMethod('importBackup/src seed config', () => src.setConfig('e2e_import_marker', marker));
    const srcEmail = src.getCredentials().email;
    const srcId = src.id;
    const blob = await tryMethod('importBackup/export', () => src.exportBackup());
    if (!blob) return;
    src.disconnect();

    const dst = new DeltaChatAccount(new MemoryStore()) as LiveAccount;
    await tryMethod('importBackup/live import', async () => {
        await dst.importBackup(blob);
        const v = await dst.getConfig('e2e_import_marker');
        if (v !== marker) throw new Error(`marker mismatch: ${v}`);
        if (dst.getCredentials().email !== srcEmail) {
            throw new Error('email not restored from backup');
        }
        return v;
    });
    dst.disconnect();
    await tryMethod('importBackup/cleanup', () => {
        iso.removeAccount(srcId);
    });
}

export async function runDeleteChatSuite(account: LiveAccount) {
    const tag = Date.now().toString(36);
    const email = `deletechat-${tag}@e2e.local`;
    await tryMethod('deleteChat/setup contact', () =>
        account.createContact({
            email,
            name: 'DeleteMe',
            key: account.getPublicKeyArmored(),
        }));
    const chatId = email.toLowerCase();
    await tryMethod('deleteChat/seed chat', async () => {
        await account.getOrCreateChat(email);
        await account.addDeviceMessage(`del-${tag}`, 'chat to delete');
        return chatId;
    });
    await tryMethod('deleteChat', async () => {
        await account.deleteChat(chatId);
        const gone = await account.getChat(chatId);
        if (gone) throw new Error('chat still in store');
        return 'deleted';
    });
}

export async function runConfigBackupSuite(
    account: LiveAccount,
    server: string,
    dc?: ReturnType<typeof DeltaChatSDK>,
) {
    await tryMethod('setConfig', () => account.setConfig('e2e_flag', '1'));
    await tryMethod('getConfig', () => account.getConfig('e2e_flag'));
    await tryMethod('batchSetConfig', () => account.batchSetConfig({ e2e_a: '1', e2e_b: '2' }));
    await tryMethod('setWatchedMailboxes', () => { account.setWatchedMailboxes(['INBOX']); });
    await tryMethod('getWatchedMailboxes', () => account.getWatchedMailboxes().join(','));
    await tryMethod('backgroundFetch', () => account.backgroundFetch(0));
    await tryMethod('setPushToken', () =>
        account.setPushToken({ type: 'webpush', endpoint: 'https://example.com/push/e2e' }));
    await tryMethod('processPushPayload', () => account.processPushPayload({ test: true }));
    await tryMethod('addDeviceMessage', () =>
        account.addDeviceMessage('e2e', 'Device note from full e2e'));

    await tryMethod('saveToStore', () => account.saveToStore());
    await tryMethod('exportBackup', async () => {
        const j = await account.exportBackup();
        return `bytes=${j.length}`;
    });
    await tryMethod('exportBackup(encrypted)', async () => {
        const j = await account.exportBackup({ passphrase: 'e2e-temp-pass' });
        return JSON.parse(j).enc ? 'enc' : 'plain';
    });

    if (dc) {
        await runImportBackupSuite(dc, server);
    }
    await runDeleteChatSuite(account);

    await tryMethod('addRelay', async () => {
        const r = await account.addRelay(server);
        return r.email;
    });
    await tryMethod('removeRelay', () => {
        const relays = account.listRelays();
        if (relays.length > 1) account.removeRelay(relays[relays.length - 1].id);
        else throw new Error('only primary relay');
    });

    await tryMethod('on/off', () => {
        const h = () => {};
        account.on('DC_EVENT_INFO', h);
        account.off('DC_EVENT_INFO', h);
    });
    await tryMethod('getKnownKeys', () => `n=${account.getKnownKeys().size}`);
    await tryMethod('importKey', () => {
        account.importKey('self-import@test', account.getPublicKeyArmored());
    });

    await tryMethod('connectWebSocket', async () => {
        await account.connectWebSocket(0);
    });
    await tryMethod('processIncomingRaw', async () => {
        await account.processIncomingRaw({
            uid: 0,
            body: [
                'From: <self@test>',
                'To: <alice@test>',
                'Subject: x',
                'Chat-Version: 1.0',
                'Content-Type: text/plain',
                '',
                'noop',
            ].join('\r\n'),
        });
    });
}