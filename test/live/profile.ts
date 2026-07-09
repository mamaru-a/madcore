/**
 * Live suite: profile name/photo APIs against peer.
 */
import { PNG, tryMethod, type LiveAccount, type LiveContact } from './harness';

export async function runProfileSuite(
    account: LiveAccount,
    contact: LiveContact,
    peerEmail: string,
) {
    await tryMethod('setProfilePhotoB64', () => { account.setProfilePhotoB64(PNG, 'image/png'); });
    await tryMethod('setProfilePhoto(base64 obj)', () =>
        account.setProfilePhoto({ data: PNG, mimeType: 'image/png' }));
    await tryMethod('sendProfilePhoto', () =>
        account.sendProfilePhoto(contact, { caption: 'E2E profile photo' }));
    await tryMethod('broadcastProfilePhoto', () => account.broadcastProfilePhoto());
    await tryMethod('getPeerAvatar', () => account.getPeerAvatar(peerEmail) ? 'has' : 'null');
    await tryMethod('getAvatarHeaderForContact', () =>
        account.getAvatarHeaderForContact(peerEmail).slice(0, 30));
    await tryMethod('markAvatarSent', () => { account.markAvatarSent(peerEmail); });
}
