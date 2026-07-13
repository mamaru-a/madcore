/**
 * Live suite: chat list, search, drafts, archive/pin/mute, contacts, block.
 */
import { PNG, tryMethod, sleep, type LiveAccount } from './harness';

function storedMsgId(m: any): string | undefined {
    const id = m?.id || m?.rfc724mid || m?.msgId;
    return id ? String(id) : undefined;
}

async function findIncomingWithId(
    account: LiveAccount,
    chatId: string,
    textIncludes?: string,
): Promise<any | undefined> {
    const msgs = await account.getChatMessages(chatId, 100, 0);
    if (textIncludes) {
        const hit = msgs.find((m: any) =>
            m.direction === 'incoming' && storedMsgId(m) && m.text?.includes(textIncludes));
        if (hit) return hit;
    }
    return msgs.find((m: any) => m.direction === 'incoming' && storedMsgId(m));
}

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
    let incoming = await findIncomingWithId(account, chatId);
    if (!storedMsgId(incoming) && peerAccount && accountEmail) {
        const seenMarker = `seen-${Date.now()}`;
        if (typeof peerAccount.connect === 'function') {
            try { await peerAccount.connect(); } catch { /* already up */ }
        }
        await peerAccount.sendMessage(accountEmail, seenMarker);
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
            incoming = await findIncomingWithId(account, chatId, seenMarker)
                || await findIncomingWithId(account, chatId);
            if (storedMsgId(incoming)) break;
            await sleep(2000);
        }
    }
    await tryMethod('markMessageSeen', async () => {
        const msgId = storedMsgId(incoming);
        if (!msgId) throw new Error('no incoming msg for markMessageSeen');
        await account.markMessageSeen(msgId);
        return msgId.slice(0, 24);
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
