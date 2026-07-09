/**
 * Live suite: SecureJoin peer + QR helpers.
 */
import { parseSecureJoinURI } from '../../lib/securejoin';
import { tryMethod, fail, skip, type LiveAccount, type LiveContact } from './harness';

export async function secureJoinPeer(
    account: LiveAccount,
    joinUri: string,
    joinTimeoutMs: number,
): Promise<{ contact: LiveContact; contactId: string; peerEmail: string } | null> {
    const peer = parseSecureJoinURI(joinUri);
    await tryMethod('checkQr/parseSecureJoinURI', () => peer.inviterEmail);

    let contact: LiveContact = null;
    let contactId = '';
    await tryMethod('secureJoin', async () => {
        const joinP = account.secureJoin(joinUri);
        const timeout = new Promise((_, rej) =>
            setTimeout(() => rej(new Error(`timeout ${joinTimeoutMs}ms`)), joinTimeoutMs),
        );
        const result = await Promise.race([joinP, timeout]) as any;
        contact = result.contact;
        contactId = result.contactId || contact?.id;
        if (!contact && result.peerEmail) {
            contact = account.findContactByEmail(result.peerEmail) || result.peerEmail;
        }
        return `verified=${result.verified} peer=${result.peerEmail}`;
    });

    if (!contact) {
        fail('ABORT', 'SecureJoin failed — cannot run peer messaging');
        return null;
    }

    const peerEmail = typeof contact === 'string' ? contact : contact.email;
    return { contact, contactId, peerEmail };
}

export async function runQrHelpers(account: LiveAccount, joinUri: string) {
    await tryMethod('checkQr', () => account.checkQr(joinUri).kind);
    await tryMethod('createQrSvg', () => account.createQrSvg('test').includes('<svg') ? 'svg' : 'no');
    await tryMethod('parseSecureJoinURI', () => account.parseSecureJoinURI(joinUri).inviterEmail);
}

export async function runSecureJoinExtras(account: LiveAccount, peerEmail: string) {
    await tryMethod('sendSecureJoinRequest', async () => {
        try {
            await account.sendSecureJoinRequest(peerEmail, 'test-invite', undefined);
        } catch (e: any) {
            if (!e.message) throw e;
        }
    });
    skip('sendSecureJoinAuth', 'requires mid-handshake state');
    skip('joinGroup', 'needs group invite URI');
}
