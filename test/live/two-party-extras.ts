/**
 * Live suite: joinGroup + acceptIncomingCall (needs Alice + Bob).
 */
import { tryMethod, waitForEvent, sleep, type LiveAccount, type LiveContact } from './harness';

function groupInviteUri(inviter: LiveAccount, grpId: string, name: string): string {
    const base = inviter.generateSecureJoinURI();
    return `${base}&x=${encodeURIComponent(grpId)}&g=${encodeURIComponent(name)}`;
}

export async function runJoinGroupSuite(alice: LiveAccount, bob: LiveAccount) {
    const group = await tryMethod('createGroup(invite)', () =>
        alice.createGroup({ name: 'E2E Join Group', members: [] }));
    if (!group?.grpId) return;

    const uri = groupInviteUri(alice, group.grpId, group.name);
    await tryMethod('checkQr(group)', () => {
        const qr = alice.checkQr(uri);
        if (qr.kind !== 'securejoin_group' && qr.kind !== 'securejoin') {
            throw new Error(`expected group qr, got ${qr.kind}`);
        }
        return qr.kind;
    });

    await tryMethod('joinGroup(B)', async () => {
        const r = await bob.joinGroup(uri);
        return `verified=${r.verified} peer=${r.peerEmail?.slice(0, 20)}`;
    });

    await sleep(2000);

    await tryMethod('sendGroupMessage after join', () =>
        alice.sendGroupMessage(group, { text: `joined group e2e ${Date.now()}` }));
}

export async function runIncomingCallSuite(
    caller: LiveAccount,
    callee: LiveAccount,
    contactOnCaller: LiveContact,
) {
    const incoming = waitForEvent(callee, 'DC_EVENT_INCOMING_CALL', { timeoutMs: 90_000 });

    const call = await tryMethod('placeOutgoingCall', () =>
        caller.placeOutgoingCall(contactOnCaller, { video: false }));

    await tryMethod('acceptIncomingCall', async () => {
        const evt = await incoming;
        const callId = evt.data1 || evt.callId || call?.callId;
        if (!callId) throw new Error('no call id on incoming event');
        await callee.acceptIncomingCall(callId);
        return String(callId).slice(0, 12);
    });

    if (call?.callId) {
        await tryMethod('endCall', () => caller.endCall(call.callId));
    }
}