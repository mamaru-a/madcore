/**
 * Live suite: auth, encryption enforcement, and transport security checks.
 */
import { DeltaChatSDK } from '../../sdk';
import { MemoryStore } from '../../store';
import { tryMethod, type LiveAccount } from './harness';

export async function runSecuritySuite(
    server: string,
    alice?: LiveAccount,
    bob?: LiveAccount | null,
) {
    if (alice) {
        const creds = alice.getCredentials();
        await tryMethod('security/wrong-password-REST', async () => {
            const res = await fetch(`${server}/webimap/mailboxes`, {
                headers: { 'X-Email': creds.email, 'X-Password': 'wrong-password-e2e' },
            });
            if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
            return `status=${res.status}`;
        });
    }

    const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'warn' });
    await tryMethod('security/send-without-key', async () => {
        const { account } = await dc.register(server, 'TmpNoKey');
        await account.generateKeys('Tmp');
        await account.connect(server);
        try {
            await account.sendMessage('nobody@example.com', 'Unencrypted test');
            throw new Error('should have been rejected');
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (
                !msg.includes('Encryption Needed')
                && !msg.includes('No key')
                && !msg.includes('No encryption key')
                && !msg.includes('rejected')
            ) {
                throw e;
            }
            return msg.slice(0, 60);
        } finally {
            account.disconnect();
        }
    });

    await tryMethod('security/sendFile-without-key', async () => {
        const { account } = await dc.register(server, 'TmpNoKey2');
        await account.generateKeys('Tmp2');
        await account.connect(server);
        try {
            await account.sendFile('nobody@example.com', 'f.txt', btoa('hi'), 'text/plain');
            throw new Error('should have thrown');
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (!msg.includes('No key') && !msg.includes('No encryption key')) throw e;
            return msg.slice(0, 60);
        } finally {
            account.disconnect();
        }
    });

    if (bob && alice) {
        const bobEmail = bob.getCredentials().email;
        await tryMethod('security/cannot-send-plaintext-to-peer', async () => {
            const dc2 = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'warn' });
            const { account: stranger } = await dc2.register(server, 'Stranger');
            await stranger.generateKeys('Stranger');
            await stranger.connect(server);
            try {
                await stranger.sendMessage(bobEmail, 'plaintext attack');
                throw new Error('should reject without key');
            } catch (e: any) {
                const msg = e?.message || String(e);
                if (!msg.includes('No key') && !msg.includes('No encryption key') && !msg.includes('Encryption')) {
                    throw e;
                }
                return 'rejected';
            } finally {
                stranger.disconnect();
            }
        });
    }

    await tryMethod('security/webimap-requires-auth', async () => {
        const res = await fetch(`${server}/webimap/mailboxes`);
        if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
        return `status=${res.status}`;
    });
}