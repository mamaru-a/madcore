/**
 * Live suite: bidirectional message delivery assertions (send + receive).
 */
import { tryMethod, waitForIncomingMsg, sleep, type LiveAccount } from './harness';

export async function runDeliverySuite(
    alice: LiveAccount,
    bob: LiveAccount,
    aliceEmail: string,
    bobEmail: string,
) {
    const markerBtoA = `e2e-b2a-${Date.now()}`;
    const markerAtoB = `e2e-a2b-${Date.now()}`;

    const recvOnAlice = waitForIncomingMsg(alice, {
        fromEmail: bobEmail,
        textIncludes: markerBtoA,
        timeoutMs: 90_000,
    });

    await tryMethod('delivery/Bob→Alice send', async () => {
        const { msgId } = await bob.sendMessage(aliceEmail, `Hello Alice ${markerBtoA}`);
        return msgId;
    });

    await tryMethod('delivery/Bob→Alice receive', async () => {
        const msg = await recvOnAlice;
        if (!msg?.text?.includes(markerBtoA)) throw new Error('text mismatch on Alice');
        return msg.text.slice(0, 40);
    });

    await sleep(1500);

    const recvOnBob = waitForIncomingMsg(bob, {
        fromEmail: aliceEmail,
        textIncludes: markerAtoB,
        timeoutMs: 90_000,
    });

    await tryMethod('delivery/Alice→Bob send', async () => {
        if (!alice.getKnownKeys().has(bobEmail.toLowerCase())) {
            throw new Error('Alice missing Bob key');
        }
        const { msgId } = await alice.sendMessage(bobEmail, `Hello Bob ${markerAtoB}`);
        return msgId;
    });

    await tryMethod('delivery/Alice→Bob receive', async () => {
        const msg = await recvOnBob;
        if (!msg?.text?.includes(markerAtoB)) throw new Error('text mismatch on Bob');
        return msg.text.slice(0, 40);
    });

    await tryMethod('delivery/reaction-delivered', async () => {
        const { msgId } = await bob.sendMessage(aliceEmail, `react-target ${Date.now()}`);
        await sleep(2000);
        const reactionEvt = new Promise<any>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('reaction timeout')), 60_000);
            const h = (e: any) => {
                if (e.msg?.text?.includes('👍')) {
                    clearTimeout(t);
                    alice.off('DC_EVENT_INCOMING_REACTION', h);
                    resolve(e);
                }
            };
            alice.on('DC_EVENT_INCOMING_REACTION', h);
        });
        await bob.sendReaction(aliceEmail, { targetMessage: msgId, reaction: '👍' });
        await reactionEvt;
        return '👍';
    });
}