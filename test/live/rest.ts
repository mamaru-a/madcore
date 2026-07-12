/**
 * Live suite: REST WebIMAP surface (registration-adjacent probes).
 */
import { DeltaChatAccount } from '../../sdk';
import { MemoryStore } from '../../store';
import { tryMethod } from './harness';

export async function runRestSuite(server: string) {
    const alice = new DeltaChatAccount(new MemoryStore());
    const bob = new DeltaChatAccount(new MemoryStore());
    let aliceEmail = '';
    let alicePassword = '';
    let bobEmail = '';

    await tryMethod('REST/POST /new Alice', async () => {
        const creds = await alice.register(server);
        if (!creds.email || !creds.password) throw new Error('missing creds');
        aliceEmail = creds.email;
        alicePassword = creds.password;
        return aliceEmail;
    });

    await tryMethod('REST/POST /new Bob', async () => {
        const creds = await bob.register(server);
        bobEmail = creds.email;
        return bobEmail;
    });

    await tryMethod('REST/generateKeys Alice', async () => {
        await alice.generateKeys('REST Alice');
        return alice.getFingerprint().slice(0, 16);
    });

    await tryMethod('REST/GET mailboxes', async () => {
        const res = await fetch(`${server}/webimap/mailboxes`, {
            headers: { 'X-Email': aliceEmail, 'X-Password': alicePassword },
        });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const data = await res.json() as any[];
        const names = data.map((m: any) => m.name);
        if (!names.includes('INBOX')) throw new Error('no INBOX');
        return names.join(',');
    });

    await tryMethod('REST/GET messages (empty INBOX)', async () => {
        const res = await fetch(`${server}/webimap/messages?mailbox=INBOX&since_uid=0`, {
            headers: { 'X-Email': aliceEmail, 'X-Password': alicePassword },
        });
        if (res.status !== 200) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data)) throw new Error('not array');
        return `n=${data.length}`;
    });

    await tryMethod('REST/wrong password → 401', async () => {
        const res = await fetch(`${server}/webimap/mailboxes`, {
            headers: { 'X-Email': aliceEmail, 'X-Password': 'bad' },
        });
        if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
        return '401';
    });
}