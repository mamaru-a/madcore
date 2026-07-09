/**
 * Live suite: 1:1 messaging — text, media, forward, delete, reactions.
 */
import { PNG, AUDIO_B64, tryMethod, skip, type LiveAccount, type LiveContact } from './harness';

export async function runMessagingSuite(
    account: LiveAccount,
    contact: LiveContact,
) {
    let lastMsg: any = null;
    lastMsg = await tryMethod('send(text)', () =>
        account.send(contact, { text: `E2E text ${new Date().toISOString()}` }));

    await tryMethod('sendMessage', () => account.sendMessage(contact, 'E2E sendMessage'));

    const replyParent = lastMsg?.message || lastMsg;
    if (replyParent) {
        await tryMethod('sendReply', () =>
            account.sendReply(contact, {
                parentMessage: replyParent,
                text: 'E2E reply',
                quotedText: 'quoted',
            }));
        await tryMethod('send(reaction)', () =>
            account.send(contact, { reaction: { targetMessage: replyParent, reaction: '👋' } }));
        await tryMethod('sendReaction', () =>
            account.sendReaction(contact, { targetMessage: replyParent, reaction: '🎉' }));
        await tryMethod('sendEdit', () =>
            account.sendEdit(contact, { targetMessage: replyParent, newText: 'E2E edited text' }));
    } else {
        skip('sendReply/reaction/edit', 'no parent message');
    }

    await tryMethod('sendImage', () =>
        account.sendImage(contact, {
            filename: 'dot.png', data: PNG, mimeType: 'image/png', caption: 'E2E image',
        }));
    await tryMethod('send({ image })', () =>
        account.send(contact, { image: { data: PNG, filename: 'dot2.png', caption: 'unified image' } }));
    await tryMethod('sendSticker', () =>
        account.sendSticker(contact, { data: PNG, mimeType: 'image/png', filename: 'sticker.png' }));
    await tryMethod('send({ sticker })', () =>
        account.send(contact, { sticker: { data: PNG, mimeType: 'image/png' } }));
    await tryMethod('sendGif', () =>
        account.sendGif(contact, { data: PNG, filename: 'x.gif', caption: 'gif-as-png' }));
    await tryMethod('sendFile', () =>
        account.sendFile(contact, {
            filename: 'note.txt',
            data: btoa('hello e2e file'),
            mimeType: 'text/plain',
            caption: 'E2E file',
        }));
    await tryMethod('sendVideo', () =>
        account.sendVideo(contact, {
            filename: 'clip.bin',
            data: AUDIO_B64,
            mimeType: 'video/mp4',
            caption: 'E2E video bytes',
            durationMs: 1000,
        }));
    await tryMethod('sendAudio', () =>
        account.sendAudio(contact, {
            filename: 'a.bin',
            data: AUDIO_B64,
            mimeType: 'audio/ogg',
            durationMs: 500,
        }));
    await tryMethod('sendVoice', () =>
        account.sendVoice(contact, { data: AUDIO_B64, durationMs: 400, mimeType: 'audio/ogg' }));
    await tryMethod('send({ voice })', () =>
        account.send(contact, { voice: { data: AUDIO_B64, durationMs: 300 } }));

    if (lastMsg?.message || lastMsg?.msgId) {
        const orig = lastMsg.message || { id: lastMsg.msgId, text: 'E2E text' };
        await tryMethod('forwardMessage', () =>
            account.forwardMessage(contact, {
                originalMessage: orig,
                originalFrom: account.getCredentials().email,
            }));
        await tryMethod('send({ forward })', () =>
            account.send(contact, {
                forward: {
                    originalMessage: orig,
                    originalFrom: account.getCredentials().email,
                },
            }));
        await tryMethod('resendMessage', () =>
            account.resendMessage(contact, { originalMessage: orig }));
    }

    const disposable = await tryMethod('send(disposable for delete)', () =>
        account.send(contact, { text: 'delete me e2e' }));
    if (disposable?.message || disposable?.msgId) {
        const t = disposable.message || disposable.msgId;
        await tryMethod('sendDelete', () => account.sendDelete(contact, { targetMessage: t }));
        await tryMethod('send({ delete })', async () => {
            const d2 = await account.send(contact, { text: 'delete me too' });
            await account.send(contact, { delete: { targetMessage: d2.message || d2.msgId } });
        });
    }
}
