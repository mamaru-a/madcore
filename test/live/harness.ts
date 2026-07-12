/**
 * Shared live-test harness — result rows, tryMethod, env, fixtures.
 * Web-compatible (no Node Buffer). No secrets.
 */

export type Row = { method: string; status: 'pass' | 'fail' | 'skip'; detail?: string };

const rows: Row[] = [];

export function getRows(): readonly Row[] {
    return rows;
}

export function pass(method: string, detail?: string) {
    rows.push({ method, status: 'pass', detail });
    console.log(`  ✅ ${method}${detail ? ` — ${detail}` : ''}`);
}

export function fail(method: string, detail?: string) {
    rows.push({ method, status: 'fail', detail });
    console.log(`  ❌ ${method}${detail ? ` — ${detail}` : ''}`);
}

export function skip(method: string, detail?: string) {
    rows.push({ method, status: 'skip', detail });
    console.log(`  ⏭  ${method}${detail ? ` — ${detail}` : ''}`);
}

export async function tryMethod(method: string, fn: () => Promise<any> | any) {
    try {
        const r = await fn();
        const detail = r === undefined || r === null
            ? undefined
            : typeof r === 'string'
                ? r.slice(0, 80)
                : typeof r === 'object' && r.msgId
                    ? `msgId=${r.msgId}`
                    : typeof r === 'object' && r.id
                        ? `id=${r.id}`
                        : JSON.stringify(r).slice(0, 80);
        pass(method, detail);
        return r;
    } catch (e: any) {
        fail(method, e?.message || String(e));
        return null;
    }
}

export function summaryAndExit() {
    const passN = rows.filter(r => r.status === 'pass').length;
    const failN = rows.filter(r => r.status === 'fail').length;
    const skipN = rows.filter(r => r.status === 'skip').length;
    console.log(`\n📊 pass=${passN} fail=${failN} skip=${skipN} total=${rows.length}\n`);
    if (failN) {
        console.log('Failures:');
        for (const r of rows.filter(x => x.status === 'fail')) {
            console.log(`  - ${r.method}: ${r.detail}`);
        }
        console.log('');
    }
    process.exit(failN > 0 ? 1 : 0);
}

export function parseLiveEnv(): { server: string; joinUri?: string; joinTimeoutMs: number } {
    const server = process.env.SERVER_URL || process.argv[2];
    if (!server) {
        console.error('SERVER_URL is required');
        process.exit(2);
    }
    return {
        server,
        joinUri: process.env.JOIN_URI,
        joinTimeoutMs: Number(process.env.JOIN_TIMEOUT_MS || 90_000),
    };
}

/** @deprecated Use parseLiveEnv — JOIN_URI is optional (local two-party mode). */
export function requireLiveEnv(): { server: string; joinUri: string; joinTimeoutMs: number } {
    const env = parseLiveEnv();
    if (!env.joinUri) {
        console.error('JOIN_URI is required for this entrypoint');
        process.exit(2);
    }
    return { server: env.server, joinUri: env.joinUri, joinTimeoutMs: env.joinTimeoutMs };
}

export function resetHarness() {
    rows.length = 0;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export { sleep };

/** Wait for any DC event with optional predicate. */
export function waitForEvent(
    account: LiveAccount,
    event: string,
    opts: { timeoutMs?: number; predicate?: (e: any) => boolean } = {},
): Promise<any> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            account.off(event, handler);
            reject(new Error(`Timeout waiting for ${event} (${timeoutMs}ms)`));
        }, timeoutMs);
        const handler = (e: any) => {
            if (opts.predicate && !opts.predicate(e)) return;
            clearTimeout(timer);
            account.off(event, handler);
            resolve(e);
        };
        account.on(event, handler);
    });
}

/** Wait for DC_EVENT_INCOMING_MSG with optional sender/text/type filters. */
export function waitForIncomingMsg(
    account: LiveAccount,
    opts: {
        fromEmail?: string;
        textIncludes?: string;
        type?: string;
        timeoutMs?: number;
    } = {},
): Promise<any> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            account.off('DC_EVENT_INCOMING_MSG', handler);
            reject(new Error(`Timeout waiting for incoming msg (${timeoutMs}ms)`));
        }, timeoutMs);
        const handler = (e: any) => {
            const msg = e.msg;
            if (!msg) return;
            if (opts.fromEmail && msg.from?.toLowerCase() !== opts.fromEmail.toLowerCase()) return;
            if (opts.type && msg.type !== opts.type) return;
            if (opts.textIncludes && !msg.text?.includes(opts.textIncludes)) return;
            clearTimeout(timer);
            account.off('DC_EVENT_INCOMING_MSG', handler);
            resolve(msg);
        };
        account.on('DC_EVENT_INCOMING_MSG', handler);
    });
}

/** Tiny 1×1 PNG base64 (web-safe) */
export const PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Minimal audio/video-ish bytes as base64 */
export const AUDIO_B64 = btoa('fake-ogg-bytes-for-test');

export type LiveAccount = any;
export type LiveContact = any;

export interface LiveContext {
    server: string;
    joinUri: string;
    joinTimeoutMs: number;
    dc: any;
    account: LiveAccount;
    /** Secondary account for multi-party group tests (optional) */
    accountB?: LiveAccount;
    contact: LiveContact;
    contactId: string;
    peerEmail: string;
}
