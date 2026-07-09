/**
 * Live suite: register, keys, connect, transport, status.
 */
import { DeltaChatSDK } from '../../sdk';
import { MemoryStore } from '../../store';
import { tryMethod, type LiveAccount } from './harness';

export async function setupPrimaryAccount(
    server: string,
    name = 'Madcore E2E A',
): Promise<{ dc: ReturnType<typeof DeltaChatSDK>; account: LiveAccount } | null> {
    const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'warn' });
    const reg = await tryMethod('register', () => dc.register(server, name));
    if (!reg?.account) return null;
    const account = reg.account as LiveAccount;

    await tryMethod('generateKeys', () => account.generateKeys(name));
    await tryMethod('status', () => JSON.stringify(account.status()));
    await tryMethod('getCredentials', () => account.getCredentials().email);
    await tryMethod('getFingerprint', () => account.getFingerprint().slice(0, 16));
    await tryMethod('getPublicKeyArmored', () => (account.getPublicKeyArmored() || '').slice(0, 40));
    await tryMethod('getDisplayName', () => account.getDisplayName());
    await tryMethod('setDisplayName', () => { account.setDisplayName(name); });
    await tryMethod('capabilities', () => JSON.stringify(account.capabilities()));
    await tryMethod('getConnectivity', () => account.getConnectivity());
    await tryMethod('getConnectivityHtml', () => account.getConnectivityHtml().slice(0, 40));

    await tryMethod('connect', async () => {
        await account.connect(server);
        await new Promise(r => setTimeout(r, 400));
        if (!account.status().isConnected) throw new Error('not connected');
        return account.getConnectivity();
    });

    await tryMethod('listTransports', () => account.listTransports().join(','));
    await tryMethod('getTransport', () => account.getTransport(server).isConnected ? 'ok' : 'down');
    await tryMethod('wsRequest(list_mailboxes)', async () => {
        const m = await account.wsRequest('list_mailboxes', {});
        return Array.isArray(m) ? `${m.length} boxes` : String(m);
    });
    await tryMethod('fetchMessages', async () => {
        const m = await account.fetchMessages(0);
        return `n=${Array.isArray(m) ? m.length : '?'}`;
    });
    await tryMethod('listRelays', () => `${account.listRelays().length} relays`);
    await tryMethod('getRelay', () => account.getRelay(account.listRelays()[0]?.id)?.email);

    return { dc, account };
}

export async function setupSecondaryAccount(
    dc: ReturnType<typeof DeltaChatSDK>,
    server: string,
    name = 'Madcore E2E B',
): Promise<LiveAccount | null> {
    const reg = await tryMethod('register(B)', () => dc.register(server, name));
    const b = reg?.account as LiveAccount | undefined;
    if (!b) return null;
    await tryMethod('B.generateKeys', () => b.generateKeys(name));
    await tryMethod('B.connect', async () => {
        await b.connect(server);
        await new Promise(r => setTimeout(r, 400));
    });
    return b;
}
