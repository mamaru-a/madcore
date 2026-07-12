/**
 * Live suite: assert peer actually receives messages (not just send OK).
 */
import { PNG, tryMethod, waitForIncomingMsg, waitForEvent, sleep, type LiveAccount, type LiveContact } from './harness';

export async function runMessagingReceiveSuite(
    sender: LiveAccount,
    receiver: LiveAccount,
    senderEmail: string,
    receiverEmail: string,
    contactOnSender: LiveContact,
) {
    const imgMarker = `img-recv-${Date.now()}`;
    const editMarker = `edit-recv-${Date.now()}`;
    const delMarker = `del-recv-${Date.now()}`;

    const imgWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        textIncludes: imgMarker,
        type: 'image',
        timeoutMs: 90_000,
    });

    await tryMethod('recv/image send', async () => {
        await sender.sendImage(contactOnSender, {
            filename: 'dot.png',
            data: PNG,
            mimeType: 'image/png',
            caption: imgMarker,
        });
    });

    await tryMethod('recv/image receive', async () => {
        const msg = await imgWait;
        if (!msg?.text?.includes(imgMarker)) throw new Error('caption missing on image');
        return msg.type;
    });

    await sleep(1500);

    const editWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        textIncludes: editMarker,
        timeoutMs: 90_000,
    });

    const { msgId: parentId } = await sender.sendMessage(contactOnSender, `before edit ${editMarker}`);
    await sleep(2000);
    await tryMethod('recv/edit send', async () => {
        await sender.sendEdit(contactOnSender, {
            targetMessage: parentId,
            newText: `after edit ${editMarker}`,
        });
        return parentId;
    });

    await tryMethod('recv/edit receive', async () => {
        const msg = await editWait;
        if (!msg?.text?.includes(editMarker)) throw new Error('edited text not received');
        return msg.text.slice(0, 40);
    });

    await sleep(1500);

    const delWait = waitForEvent(receiver, 'DC_EVENT_MSG_DELETED', {
        timeoutMs: 90_000,
        predicate: (e) => !!e.msgId || !!e.msg?.id,
    });

    const { msgId: delId } = await sender.sendMessage(contactOnSender, `delete me ${delMarker}`);
    await sleep(2000);
    await tryMethod('recv/delete send', async () => {
        await sender.sendDelete(contactOnSender, { targetMessage: delId });
        return delId;
    });

    await tryMethod('recv/delete receive', async () => {
        await delWait;
        return 'deleted event';
    });

    const replyMarker = `reply-recv-${Date.now()}`;
    const replyWait = waitForIncomingMsg(receiver, {
        fromEmail: senderEmail,
        textIncludes: replyMarker,
        timeoutMs: 90_000,
    });

    const { msgId: threadId } = await sender.sendMessage(contactOnSender, `thread parent ${replyMarker}`);
    await sleep(1500);
    await tryMethod('recv/reply send', async () => {
        await sender.sendReply(contactOnSender, {
            parentMessage: threadId,
            text: `thread child ${replyMarker}`,
            quotedText: `thread parent ${replyMarker}`,
        });
    });

    await tryMethod('recv/reply receive', async () => {
        const msg = await replyWait;
        if (!msg?.text?.includes(replyMarker)) throw new Error('reply not received');
        return 'reply ok';
    });
}