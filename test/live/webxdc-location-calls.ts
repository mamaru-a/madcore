/**
 * Live suite: webxdc, location streaming, call signaling.
 */
import { tryMethod, skip, type LiveAccount, type LiveContact } from './harness';

export async function runWebxdcSuite(
    account: LiveAccount,
    contact: LiveContact,
    peerEmail: string,
) {
    await tryMethod('sendWebxdc', () =>
        account.sendWebxdc(contact, {
            data: btoa('PK\x03\x04fake-xdc'),
            name: 'E2E App',
            filename: 'app.xdc',
        }));

    const chatsAfter = await account.getChatList();
    const peerChat = chatsAfter.find((c: any) =>
        c.peerEmail?.toLowerCase() === peerEmail.toLowerCase()
        || c.id?.toLowerCase() === peerEmail.toLowerCase(),
    );
    if (peerChat) {
        const msgs = await account.getChatMessages(peerChat.id, 20, 0);
        const wx = msgs.find((m: any) => m.type === 'webxdc');
        if (wx) {
            await tryMethod('sendWebxdcStatusUpdate', () =>
                account.sendWebxdcStatusUpdate(contact, wx.id, { payload: { hello: 1 }, serial: 1 }));
            await tryMethod('getWebxdcStatusUpdates', () =>
                account.getWebxdcStatusUpdates(wx.id, 0));
        } else {
            skip('sendWebxdcStatusUpdate', 'no webxdc msg in store');
            skip('getWebxdcStatusUpdates', 'no webxdc msg in store');
        }
    }
}

export async function runLocationSuite(account: LiveAccount, peerEmail: string) {
    await tryMethod('sendLocationsToChat', () =>
        account.sendLocationsToChat(peerEmail, { durationSec: 120 }));
    await tryMethod('setLocation', () =>
        account.setLocation({ lat: 35.7, lon: 51.4, accuracy: 10 }));
    await tryMethod('getLocations', () =>
        account.getLocations(peerEmail).then((p: any[]) => `n=${p.length}`));
    await tryMethod('stopSendingLocations', () => account.stopSendingLocations(peerEmail));
}

export async function runCallsSuite(account: LiveAccount, contact: LiveContact) {
    await tryMethod('setIceServers', () => {
        account.setIceServers([{ urls: 'stun:stun.l.google.com:19302' }]);
    });
    await tryMethod('getIceServers', () => `${account.getIceServers().length} servers`);
    const call = await tryMethod('placeOutgoingCall', () =>
        account.placeOutgoingCall(contact, { video: false }));
    if (call?.callId) {
        await tryMethod('getCall', () => account.getCall(call.callId)?.state);
        await tryMethod('endCall', () => account.endCall(call.callId));
    } else {
        skip('getCall/endCall', 'no call session');
    }
    skip('acceptIncomingCall', 'requires inbound call from peer');
}
