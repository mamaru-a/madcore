/**
 * Live suite: chat list, search, drafts, archive/pin/mute, contacts, block.
 */
import { PNG, tryMethod, waitForIncomingMsg, sleep, type LiveAccount } from './harness';

export async function runStoreChatSuite(
    account: LiveAccount,
    peerEmail: string,
    contactId: string,
    peerAccount?: LiveAccount | null,
    accountEmail?: string,
) {
    const chatId = peerEmail.toLowerCase();

    await tryMethod('getChatList', () => account.getChatList().then((c: any[]) => `n=${c.length}`));
    await tryMethod('getChat', () => account.getChat(chatId).then((c: any) => c?.name || 'null'));
    await tryMethod('getChatMessages', () =>
        account.getChatMessages(chatId, 50, 0).then((m: any[]) => `n=${m.length}`));
    await tryMethod('getOrCreateChat', () => account.getOrCreateChat(peerEmail));
    await tryMethod('searchChats', () => account.searchChats('E2E').then((c: any[]) => `n=${c.length}`));
    await tryMethod('searchMessages', () =>
        account.searchMessages('E2E').then((m: any[]) => `n=${m.length}`));
    await tryMethod('searchContacts', () =>
        account.searchContacts(peerEmail.slice(0, 4)).then((c: any[]) => `n=${c.length}`));
    await tryMethod('getContacts', () => account.getContacts().then((c: any[]) => `n=${c.length}`));
    await tryMethod('getContact', () => contactId ? account.getContact(contactId)?.email : 'no id');
    await tryMethod('findContactByEmail', () => account.findContactByEmail(peerEmail)?.email);
    await tryMethod('getUnreadCount', () => account.getUnreadCount());
    await tryMethod('markChatRead', () => account.markChatRead(chatId));
    let msgsForSeen = await account.getChatMessages(chatId, 50, 0);
    let incoming = msgsForSeen.find((m: any) => m.direction === 'incoming');
    if (!incoming?.id && peerAccount && accountEmail) {
        const seenMarker = `seen-${Date.now()}`;
        const seenWait = waitForIncomingMsg(account, {
            fromEmail: peerEmail,
            textIncludes: seenMarker,
            timeoutMs: 90_000,
        });
        await peerAccount.sendMessage(accountEmail, seenMarker);
        const seenMsg = await seenWait;
        await sleep(500);
        incoming = seenMsg;
        if (!incoming?.id) {
            msgsForSeen = await account.getChatMessages(chatId, 50, 0);
            incoming = msgsForSeen.find((m: any) => m.direction === 'incoming' && m.text?.includes(seenMarker))
                || msgsForSeen.find((m: any) => m.direction === 'incoming');
        }
    }
    await tryMethod('markMessageSeen', async () => {
        if (!incoming?.id) throw new Error('no incoming msg for markMessageSeen');
        await account.markMessageSeen(incoming.id);
        return incoming.id.slice(0, 24);
    });
    await tryMethod('archiveChat', () => account.archiveChat(chatId, true));
    await tryMethod('archiveChat(un)', () => account.archiveChat(chatId, false));
    await tryMethod('pinChat', () => account.pinChat(chatId, true));
    await tryMethod('pinChat(un)', () => account.pinChat(chatId, false));
    await tryMethod('muteChat', () => account.muteChat(chatId, true));
    await tryMethod('muteChat(un)', () => account.muteChat(chatId, false));

    await tryMethod('setDraft', () => account.setDraft(chatId, { text: 'draft e2e' }));
    await tryMethod('getDraft', () => account.getDraft(chatId).then((d: any) => d?.text));
    await tryMethod('removeDraft', () => account.removeDraft(chatId));
    await tryMethod('setChatEphemeralTimer', () => account.setChatEphemeralTimer(chatId, 0));
    await tryMethod('getChatEphemeralTimer', () => account.getChatEphemeralTimer(chatId));
    await tryMethod('sweepEphemeralMessages', () => account.sweepEphemeralMessages());
    await tryMethod('setChatProfileImage(1:1)', () =>
        account.setChatProfileImage(chatId, { data: PNG }));
    await tryMethod('removeChatProfileImage(1:1)', () =>
        account.removeChatProfileImage(chatId));

    await tryMethod('createContact', () =>
        account.createContact({
            email: 'dummy@example.com',
            name: 'Dummy',
            key: account.getPublicKeyArmored(),
        }));
    await tryMethod('deleteContact', async () => {
        const c = account.findContactByEmail('dummy@example.com');
        if (c) await account.deleteContact(c.id);
    });

    await tryMethod('blockContact', () => account.blockContact('spam-e2e@example.com'));
    await tryMethod('isBlocked', () => String(account.isBlocked('spam-e2e@example.com')));
    await tryMethod('getBlockedContacts', () =>
        account.getBlockedContacts().then((c: any[]) => `n=${c.length}`));
    await tryMethod('unblockContact', () => account.unblockContact('spam-e2e@example.com'));

    await tryMethod('deleteLocalMessage', async () => {
        const msgs = await account.getChatMessages(chatId, 5, 0);
        const mine = msgs.find((m: any) => m.direction === 'outgoing');
        if (mine) await account.deleteLocalMessage(mine.id);
        else throw new Error('no local outgoing');
    });
}
