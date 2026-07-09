/**
 * Browser-compatible test helpers (no Node Buffer / fs / process).
 * Safe for Bun, Chrome, Firefox, Safari (Web APIs only).
 */

/** UTF-8 string → base64 (btoa path) */
export function utf8ToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

/** Tiny 1×1 PNG as base64 (no Node Buffer) */
export const TINY_PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Build a minimal RFC822-like message for processIncomingRaw */
export function buildRawMime(opts: {
    from: string;
    to: string;
    subject?: string;
    headers?: Record<string, string>;
    body?: string;
    contentType?: string;
}): string {
    const lines = [
        `From: <${opts.from}>`,
        `To: <${opts.to}>`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}@test.local>`,
        `Subject: ${opts.subject ?? '[...]'}`,
        `Chat-Version: 1.0`,
        `MIME-Version: 1.0`,
        `Content-Type: ${opts.contentType || 'text/plain; charset=utf-8'}`,
    ];
    if (opts.headers) {
        for (const [k, v] of Object.entries(opts.headers)) {
            lines.push(`${k}: ${v}`);
        }
    }
    lines.push('', opts.body ?? '');
    return lines.join('\r\n');
}

/** Wait for the next matching event (or timeout) */
export function waitForEvent<T = any>(
    account: { on: Function; off: Function },
    event: string,
    timeoutMs = 2000,
    predicate?: (data: T) => boolean,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            account.off(event, handler);
            reject(new Error(`Timeout waiting for ${event}`));
        }, timeoutMs);
        const handler = (data: T) => {
            if (predicate && !predicate(data)) return;
            clearTimeout(timer);
            account.off(event, handler);
            resolve(data);
        };
        account.on(event, handler);
    });
}

/**
 * Minimal WebSocket mock for browser-compatible transport tests.
 * Auto-opens and answers every req_id with a canned payload per action.
 */
export class MockWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    onopen: ((ev?: any) => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: ((ev?: any) => void) | null = null;
    onclose: ((ev?: any) => void) | null = null;
    url: string;
    sent: string[] = [];

    constructor(url: string) {
        this.url = url;
        queueMicrotask(() => {
            this.readyState = MockWebSocket.OPEN;
            this.onopen?.({});
        });
    }

    send(data: string) {
        this.sent.push(data);
        let msg: any;
        try { msg = JSON.parse(data); } catch { return; }
        const response = mockWsResponse(msg.action, msg.data);
        queueMicrotask(() => {
            this.onmessage?.({
                data: JSON.stringify({
                    req_id: msg.req_id,
                    action: msg.action,
                    data: response,
                }),
            });
        });
    }

    close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.({});
    }
}

function mockWsResponse(action: string, data: any): any {
    switch (action) {
        case 'send':
            return 'OK';
        case 'fetch':
            return {
                uid: data?.uid ?? 1,
                body: buildRawMime({
                    from: 'peer@relay.example',
                    to: 'me@relay.example',
                    body: 'fetched body',
                }),
                envelope: {},
            };
        case 'list_mailboxes':
            return [{ name: 'INBOX', messages: 0, unseen: 0 }];
        case 'list_messages':
            return [];
        case 'flags':
            return 'OK';
        case 'delete':
            return 'OK';
        case 'move':
            return 'OK';
        case 'copy':
            return 'OK';
        case 'search':
            return [];
        case 'create_mailbox':
            return 'OK';
        case 'delete_mailbox':
            return 'OK';
        case 'rename_mailbox':
            return 'OK';
        default:
            return { ok: true, action };
    }
}

/** Install MockWebSocket as globalThis.WebSocket; returns restore fn */
export function installMockWebSocket(): () => void {
    const prev = globalThis.WebSocket;
    (globalThis as any).WebSocket = MockWebSocket;
    return () => { (globalThis as any).WebSocket = prev; };
}
