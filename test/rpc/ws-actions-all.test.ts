/**
 * Exhaustive WSAction coverage — browser-compatible MockWebSocket.
 * Every action in ALL_WS_ACTIONS is sent via account.wsRequest and must resolve.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DeltaChatSDK, ALL_WS_ACTIONS, type WSAction } from '../../sdk';
import { MemoryStore } from '../../store';
import { installMockWebSocket } from './helpers/web';

describe('ALL_WS_ACTIONS registry', () => {
    it('lists every WSAction union member', () => {
        expect(ALL_WS_ACTIONS.length).toBe(12);
        expect(new Set(ALL_WS_ACTIONS).size).toBe(12);
    });
});

describe('every WSAction via mocked WebSocket (web-compatible)', () => {
    let account: any;
    let restore: () => void;

    beforeEach(async () => {
        restore = installMockWebSocket();
        const dc = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'error' });
        account = dc.addAccount('alice@relay.example', 'pass', 'https://relay.example');
        await account.connect('https://relay.example');
        // microtask open
        await new Promise(r => setTimeout(r, 10));
        expect(account.status().isConnected).toBe(true);
    });

    afterEach(() => {
        account?.disconnect?.();
        restore?.();
    });

    const payloads: Record<WSAction, Record<string, any>> = {
        send: { from: 'alice@relay.example', to: ['bob@relay.example'], body: 'x' },
        fetch: { mailbox: 'INBOX', uid: 1 },
        list_mailboxes: {},
        list_messages: { mailbox: 'INBOX', since_uid: 0 },
        flags: { mailbox: 'INBOX', uid: 1, add: ['\\Seen'] },
        delete: { mailbox: 'INBOX', uid: 1 },
        move: { mailbox: 'INBOX', uid: 1, dest_mailbox: 'Archive' },
        copy: { mailbox: 'INBOX', uid: 1, dest_mailbox: 'Archive' },
        search: { query: 'hello' },
        create_mailbox: { name: 'TestBox' },
        delete_mailbox: { name: 'TestBox' },
        rename_mailbox: { old_name: 'A', new_name: 'B' },
    };

    for (const action of ALL_WS_ACTIONS) {
        it(`wsRequest('${action}') resolves`, async () => {
            const result = await account.wsRequest(action, payloads[action]);
            expect(result).toBeDefined();
        });
    }
});
