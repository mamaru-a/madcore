/**
 * Live suite: config, push hooks, device messages, backup, multi-relay.
 */
import { tryMethod, skip, type LiveAccount } from './harness';

export async function runConfigBackupSuite(account: LiveAccount, server: string) {
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
    skip('importBackup', 'destructive on live session; covered offline');
    skip('deleteChat', 'would wipe peer conversation UI state');

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
