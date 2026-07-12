/**
 * Live suite: peer setup — external JOIN_URI or local Alice↔Bob on one madmail.
 */
import type { DeltaChatSDK } from '../../sdk';
import { fail, sleep, type LiveAccount, type LiveContact } from './harness';
import { setupPrimaryAccount, setupSecondaryAccount } from './account';
import { secureJoinPeer } from './securejoin';

export interface PeerSetup {
    dc: ReturnType<typeof DeltaChatSDK>;
    account: LiveAccount;
    accountB: LiveAccount | null;
    contact: LiveContact;
    contactId: string;
    peerEmail: string;
    joinUri: string;
    mode: 'external' | 'local';
}

export async function resolvePeerSetup(
    server: string,
    joinUri: string | undefined,
    joinTimeoutMs: number,
): Promise<PeerSetup | null> {
    if (joinUri) {
        const primary = await setupPrimaryAccount(server);
        if (!primary) return null;
        const joined = await secureJoinPeer(primary.account, joinUri, joinTimeoutMs);
        if (!joined) return null;
        const b = await setupSecondaryAccount(primary.dc, server);
        return {
            dc: primary.dc,
            account: primary.account,
            accountB: b,
            contact: joined.contact,
            contactId: joined.contactId,
            peerEmail: joined.peerEmail,
            joinUri,
            mode: 'external',
        };
    }

    const primary = await setupPrimaryAccount(server, 'E2E Alice');
    if (!primary) return null;

    const b = await setupSecondaryAccount(primary.dc, server, 'E2E Bob');
    if (!b) return null;

    const inviteUri = primary.account.generateSecureJoinURI();
    const joined = await secureJoinPeer(b, inviteUri, joinTimeoutMs);
    if (!joined) return null;

    await sleep(2000);

    const peerEmail = b.getCredentials().email;
    if (!primary.account.getKnownKeys().has(peerEmail.toLowerCase())) {
        fail('ABORT', 'inviter missing joiner key after SecureJoin');
        return null;
    }

    const contact = primary.account.findContactByEmail(peerEmail) || peerEmail;
    const contactId = typeof contact === 'object' && contact?.id ? contact.id : peerEmail;

    return {
        dc: primary.dc,
        account: primary.account,
        accountB: b,
        contact,
        contactId,
        peerEmail,
        joinUri: inviteUri,
        mode: 'local',
    };
}