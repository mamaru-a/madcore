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

export function requireLiveEnv(): { server: string; joinUri: string; joinTimeoutMs: number } {
    const server = process.env.SERVER_URL;
    const joinUri = process.env.JOIN_URI;
    if (!server || !joinUri) {
        console.error('SERVER_URL and JOIN_URI are required');
        process.exit(2);
    }
    return {
        server,
        joinUri,
        joinTimeoutMs: Number(process.env.JOIN_TIMEOUT_MS || 90_000),
    };
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
