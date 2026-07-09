/**
 * Live suite: groups + broadcast channels (needs second account).
 */
import { PNG, tryMethod, skip, type LiveAccount } from './harness';

export async function runGroupsSuite(
    account: LiveAccount,
    accountB: LiveAccount | null | undefined,
    peerEmail: string,
    joinTimeoutMs: number,
) {
    if (!accountB) {
        skip('createGroup/channel suite', 'no secondary account');
        return;
    }

    const uriA = await tryMethod('generateSecureJoinURI', () => account.generateSecureJoinURI());
    if (uriA) {
        await tryMethod('B.secureJoin(A)', async () => {
            const r = await Promise.race([
                accountB.secureJoin(uriA),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), joinTimeoutMs)),
            ]) as any;
            return `verified=${r.verified}`;
        });
    }

    const bEmail = accountB.getCredentials().email;
    const bContact = account.findContactByEmail(bEmail);
    if (!(bContact || account.knownKeys.has(bEmail.toLowerCase()))) {
        skip('createGroup/channel suite', 'A↔B SecureJoin incomplete');
        return;
    }

    const group = await tryMethod('createGroup', () =>
        account.createGroup({
            name: 'E2E Group',
            members: [bEmail, peerEmail],
        }));
    if (group) {
        await tryMethod('getGroup', () => account.getGroup(group.grpId)?.name);
        await tryMethod('listGroups', () => `${account.listGroups().length}`);
        await tryMethod('sendGroupMessage', () =>
            account.sendGroupMessage(group, { text: 'hello group e2e' }));
        await tryMethod('send(group text)', () =>
            account.send(group, { text: 'unified group text' }));
        await tryMethod('send(group image)', () =>
            account.send(group, { image: { data: PNG, caption: 'group pic' } }));
        await tryMethod('renameGroup', () =>
            account.renameGroup(group, { newName: 'E2E Group Renamed' }));
        await tryMethod('updateGroupDescription', () =>
            account.updateGroupDescription(group, { newDescription: 'e2e desc' }));
        await tryMethod('addGroupMember', () =>
            account.addGroupMember(group, { email: bEmail }));
        await tryMethod('removeGroupMember', () =>
            account.removeGroupMember(group, { email: bEmail }));
        await tryMethod('setChatProfileImage(group)', () =>
            account.setChatProfileImage(group.grpId, { data: PNG, mimeType: 'image/png' }));
        await tryMethod('removeChatProfileImage(group)', () =>
            account.removeChatProfileImage(group.grpId));
        await tryMethod('leaveGroup', () => account.leaveGroup(group));
    }

    const channel = await tryMethod('createChannel', () =>
        account.createChannel({
            name: 'E2E Channel',
            description: 'live e2e',
            initialMembers: [bEmail],
        }));
    if (channel) {
        await tryMethod('sendBroadcast', () =>
            account.sendBroadcast(channel, { text: 'channel news e2e' }));
        await tryMethod('send(channel)', () =>
            account.send(channel, { text: 'unified channel' }));
    }
}
