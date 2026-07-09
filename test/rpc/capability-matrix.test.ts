/**
 * Capability matrix — asserts public SDK methods exist for planned features.
 * Does not require a live relay.
 */
import { describe, it, expect } from 'bun:test';
import { DeltaChatSDK } from '../../sdk';
import { MemoryStore } from '../../store';

const REQUIRED_METHODS = [
    // P0
    'send', 'sendMessage', 'sendReaction', 'sendDelete', 'sendEdit',
    'sendSticker', 'sendGif', 'sendImage', 'sendFile', 'sendVoice',
    'createGroup', 'createChannel', 'sendGroupMessage',
    'markChatRead', 'markMessageSeen',
    'blockContact', 'unblockContact', 'getBlockedContacts', 'isBlocked',
    'checkQr', 'createQrSvg',
    // P1
    'setDraft', 'getDraft', 'removeDraft',
    'setChatEphemeralTimer', 'getChatEphemeralTimer', 'sweepEphemeralMessages',
    'setChatProfileImage', 'removeChatProfileImage',
    // P2
    'sendWebxdc', 'sendWebxdcStatusUpdate', 'getWebxdcStatusUpdates',
    'exportBackup', 'importBackup',
    'setConfig', 'getConfig', 'batchSetConfig',
    'setWatchedMailboxes', 'backgroundFetch',
    'addRelay', 'listRelays',
    // P3
    'sendLocationsToChat', 'setLocation', 'stopSendingLocations', 'getLocations',
    'placeOutgoingCall', 'acceptIncomingCall', 'endCall', 'setIceServers',
    'getConnectivity', 'getConnectivityHtml',
    'addDeviceMessage', 'processPushPayload', 'setPushToken',
    'capabilities',
] as const;

describe('capability matrix', () => {
    const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'none' });
    const acc = dc.addAccount('matrix@test.example', 'pass', 'https://relay.example');

    for (const method of REQUIRED_METHODS) {
        it(`exposes ${method}`, () => {
            expect(typeof (acc as any)[method]).toBe('function');
        });
    }

    it('manager exposes multi-account APIs', () => {
        expect(typeof dc.register).toBe('function');
        expect(typeof dc.addAccount).toBe('function');
        expect(typeof dc.listAccounts).toBe('function');
        expect(typeof dc.getAccount).toBe('function');
        expect(typeof dc.removeAccount).toBe('function');
    });
});
