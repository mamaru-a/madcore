import { describe, it, expect, beforeEach } from 'bun:test';
import { Transport } from '../../lib/transport';
import type { Credentials } from '../../types';

describe('Transport.register (POST /new JIT)', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    it('POSTs to /new and returns email + password', async () => {
        const mockResponse = { email: 'abc123@test.example', password: 's3cr3t' };
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            expect(url).toBe('https://relay.example/new');
            expect(init?.method).toBe('POST');
            return new Response(JSON.stringify(mockResponse), { status: 200 });
        }) as any;

        const t = new Transport();
        const creds = await t.register('https://relay.example');
        expect(creds.email).toBe('abc123@test.example');
        expect(creds.password).toBe('s3cr3t');
    });

    it('supports optional token in POST body', async () => {
        let body: any = null;
        globalThis.fetch = (async (url: string, init?: RequestInit) => {
            if (init?.body) body = JSON.parse(init.body as string);
            return new Response(JSON.stringify({ email: 't@ex', password: 'p' }), { status: 200 });
        }) as any;

        const t = new Transport();
        await t.register('https://relay.example', { token: 'invite-token-xyz' });
        expect(body).toEqual({ token: 'invite-token-xyz' });
    });

    it('handles error responses', async () => {
        globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as any;
        const t = new Transport();
        await expect(t.register('https://relay.example')).rejects.toThrow('429 rate limited');
    });

    it('includes dclogin_url when server returns it', async () => {
        globalThis.fetch = (async () => new Response(JSON.stringify({ email: 'x@y', password: 'p', dclogin_url: 'https://dclogin' }), { status: 200 })) as any;
        const t = new Transport();
        const res = await t.register('https://relay.example');
        expect(res.dclogin_url).toBe('https://dclogin');
    });
});
