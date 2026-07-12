/**
 * JSON-RPC compat layer — offline tests with MockWebSocket + MemoryStore.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { DeltaChatSDK } from '../../sdk';
import { MemoryStore } from '../../store';
import { createJsonRpcCompat } from '../../jsonrpc';
import {
    IMPLEMENTED_JSONRPC_METHODS,
    STUB_JSONRPC_METHODS,
    methodCoverage,
    isJsonRpcMethod,
} from '../../jsonrpc/methods';
import { RpcNotImplemented } from '../../jsonrpc/errors';
import { installMockWebSocket } from './helpers/web';

const SERVER = 'https://relay.example';

function installMockRegister(server = SERVER) {
    const prev = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href === `${server}/new` || href.endsWith('/new')) {
            return new Response(
                JSON.stringify({ email: 'rpc@relay.example', password: 'rpc-secret' }),
                { status: 200 },
            );
        }
        return prev(url as any, init);
    }) as typeof fetch;
    return () => { globalThis.fetch = prev; };
}

describe('JSON-RPC compat', () => {
    let restoreWs: () => void;
    let restoreFetch: () => void;
    let rpc: ReturnType<typeof createJsonRpcCompat>;
    let accountId: number;

    beforeEach(async () => {
        restoreWs = installMockWebSocket();
        restoreFetch = installMockRegister();
        const sdk = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'error' });
        rpc = createJsonRpcCompat(sdk, {
            defaultServerUrl: SERVER,
            softStubs: false,
        });
        accountId = (await rpc.handleRpc('add_account', [])) as number;
        await rpc.handleRpc('add_transport_from_qr', [accountId, `dcaccount:${SERVER}`]);
    });

    afterEach(() => {
        restoreWs?.();
        restoreFetch?.();
    });

    it('reports method coverage stats', () => {
        const c = methodCoverage();
        expect(c.total).toBeGreaterThan(170);
        expect(c.implemented).toBeGreaterThan(130);
        expect(c.stub).toBeGreaterThan(20);
        expect(c.implemented + c.stub).toBeLessThanOrEqual(c.total);
    });

    it('classifies known wire names', () => {
        expect(isJsonRpcMethod('send_msg')).toBe(true);
        expect(isJsonRpcMethod('not_a_real_method_xyz')).toBe(false);
        expect(IMPLEMENTED_JSONRPC_METHODS.has('send_msg')).toBe(true);
        expect(STUB_JSONRPC_METHODS.has('configure')).toBe(true);
    });

    it('add_account + get_system_info', async () => {
        const info = await rpc.handleRpc('get_system_info', []) as Record<string, string>;
        expect(info.deltachat_core_version).toContain('madcore');
        const ids = await rpc.handleRpc('get_all_account_ids', []) as number[];
        expect(ids).toContain(accountId);
        expect(await rpc.handleRpc('is_configured', [accountId])).toBe(true);
    });

    it('check_qr classifies SecureJoin invite', async () => {
        const uri = await rpc.handleRpc('get_chat_securejoin_qr_code', [accountId, null]) as string;
        expect(uri).toContain('delta.chat');
        const qr = await rpc.handleRpc('check_qr', [accountId, uri]) as { kind: string };
        expect(['securejoin', 'askVerifyContact', 'securejoin_group']).toContain(qr.kind);
    });

    it('config get/set + batch', async () => {
        await rpc.handleRpc('set_config', [accountId, 'ui.test_flag', '1']);
        expect(await rpc.handleRpc('get_config', [accountId, 'ui.test_flag'])).toBe('1');
        const batch = await rpc.handleRpc('batch_get_config', [accountId, ['ui.test_flag']]) as Record<string, string>;
        expect(batch['ui.test_flag']).toBe('1');
        await rpc.handleRpc('batch_set_config', [accountId, { 'ui.b': '2' }]);
        expect(await rpc.handleRpc('get_config', [accountId, 'ui.b'])).toBe('2');
    });

    it('contacts: create, list, block', async () => {
        const cid = await rpc.handleRpc('create_contact', [accountId, 'bob@relay.example', 'Bob']) as number;
        expect(cid).toBeGreaterThan(0);
        const contacts = await rpc.handleRpc('get_contacts', [accountId, null, null]) as Record<string, unknown>;
        expect(Object.keys(contacts).length).toBeGreaterThan(0);
        expect(contacts[String(cid)]).toBeTruthy();
        await rpc.handleRpc('block_contact', [accountId, cid]);
        const blocked = await rpc.handleRpc('get_blocked_contacts', [accountId]) as unknown[];
        expect(blocked.length).toBeGreaterThan(0);
        await rpc.handleRpc('unblock_contact', [accountId, cid]);
    });

    it('chat list + device message', async () => {
        const entries = await rpc.handleRpc('get_chatlist_entries', [accountId, 0, null, null]) as number[];
        expect(Array.isArray(entries)).toBe(true);
        await rpc.handleRpc('add_device_message', [accountId, 'rpc-test', 'hello from jsonrpc']);
        const chats = await rpc.handleRpc('get_chatlist_entries', [accountId, 0, null, null]) as number[];
        expect(chats.length).toBeGreaterThanOrEqual(0);
    });

    it('IO lifecycle', async () => {
        await rpc.handleRpc('start_io', [accountId]);
        const conn = await rpc.handleRpc('get_connectivity', [accountId]) as number;
        expect(typeof conn).toBe('number');
        await rpc.handleRpc('stop_io', [accountId]);
    });

    it('stubs throw when softStubs is false', async () => {
        const sdk = DeltaChatSDK({ store: new MemoryStore(), logLevel: 'error' });
        const strict = createJsonRpcCompat(sdk, { softStubs: false, defaultServerUrl: SERVER });
        const id = (await strict.handleRpc('add_account', [])) as number;
        await expect(strict.handleRpc('configure', [id, {}])).rejects.toBeInstanceOf(RpcNotImplemented);
    });

    it('implemented methods dispatch without RpcNotImplemented (smoke)', async () => {
        const skip = new Set([
            // Never resolves (core polling API)
            'get_next_event',
            'get_next_event_batch',
            // Needs real params / network / second account
            'send_msg',
            'send_videochat_invitation',
            'send_webxdc_realtime_data',
            'forward_messages',
            'forward_messages_to_account',
            'import_backup',
            'secure_join',
            'secure_join_with_ux_info',
            'set_chat_name',
            'create_group_chat',
            'create_group_chat_unencrypted',
            'create_broadcast',
            'create_broadcast_list',
            'send_locations_to_chat',
            'place_outgoing_call',
            'accept_incoming_call',
            'end_call',
            'send_webxdc_status_update',
            'send_edit_request',
            'send_reaction',
            'delete_messages',
            'delete_messages_for_all',
            'add_transport_from_qr',
            'add_transport',
            'add_or_update_transport',
            'remove_account',
            'set_config_from_qr',
            'start_io',
            'start_io_for_all_accounts',
            'maybe_network',
            'background_fetch',
            'misc_send_msg',
            'misc_send_draft',
            'misc_send_text_message',
        ]);
        let ok = 0;
        for (const method of IMPLEMENTED_JSONRPC_METHODS) {
            if (skip.has(method)) continue;
            try {
                await rpc.handleRpc(method, [accountId]);
                ok++;
            } catch (e: any) {
                if (e instanceof RpcNotImplemented) {
                    throw new Error(`unexpected stub: ${method}`);
                }
                // RpcError / missing params is fine for smoke
            }
        }
        expect(ok).toBeGreaterThan(80);
    });
});