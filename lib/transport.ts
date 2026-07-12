/**
 * lib/transport.ts — Transport abstraction layer
 *
 * Handles all communication with the server. Two transports:
 *   1. WebSocket (preferred) — bidirectional, real-time push
 *   2. REST API (fallback) — stateless HTTP calls
 *
 * The SDK and all lib modules only call Transport methods.
 * They never import WebSocket or call fetch directly.
 */

import type { Credentials, IncomingMessage } from '../types.js';
import { log } from './logger.js';

export type TransportState = 'disconnected' | 'connecting' | 'connected';

/** Callback when a push message arrives over WebSocket */
export type OnPushMessage = (data: any) => void;

export class Transport {
    private serverUrl = '';
    private credentials: Credentials = { email: '', password: '' };

    // WebSocket state
    private ws: WebSocket | null = null;
    private reqCounter = 0;
    private pendingRequests: Map<string, {
        resolve: (data: any) => void;
        reject: (err: Error) => void;
    }> = new Map();
    /** When true, onclose will not schedule reconnect (user called disconnect). */
    private intentionalClose = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempt = 0;
    private lastSinceUID = 0;

    // Push handler — set by SDK to dispatch incoming messages
    private onPush: OnPushMessage | null = null;

    get state(): TransportState {
        if (!this.ws) return 'disconnected';
        if (this.ws.readyState === WebSocket.CONNECTING) return 'connecting';
        if (this.ws.readyState === WebSocket.OPEN) return 'connected';
        return 'disconnected';
    }

    get isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    // ─── Configuration ──────────────────────────────────────────────────

    configure(serverUrl: string, credentials: Credentials) {
        this.serverUrl = serverUrl;
        this.credentials = credentials;
    }

    /** Register a callback for server-push messages (only one handler) */
    setPushHandler(handler: OnPushMessage) {
        this.onPush = handler;
    }

    // ─── REST helpers ───────────────────────────────────────────────────

    private fetchOpts(): RequestInit {
        return {
            // @ts-ignore - Bun-specific TLS option for self-signed certs
            tls: { rejectUnauthorized: false },
        } as any;
    }

    private authHeaders(): Record<string, string> {
        return {
            'X-Email': this.credentials.email,
            'X-Password': this.credentials.password,
        };
    }

    // ─── Send (WS preferred, REST fallback) ─────────────────────────────

    /**
     * True when a WS error is a connection drop (safe to retry via REST).
     * Protocol / auth / encryption rejections must not be masked by a REST 401.
     */
    private isTransportLevelError(err: unknown): boolean {
        const msg = err instanceof Error ? err.message : String(err ?? '');
        return /websocket|not connected|closed|timeout|network|failed to fetch|ECONN|socket/i.test(
            msg,
        );
    }

    /** Send a raw email. WS preferred; REST only on transport failure. */
    async send(from: string, to: string[], body: string): Promise<void> {
        if (!this.credentials.email || !this.credentials.password) {
            throw new Error(
                'Send failed: missing account credentials on transport. ' +
                'Call setCredentials / reconnect before sending.',
            );
        }

        if (this.isConnected) {
            try {
                await this.wsRequest('send', { from, to, body });
                return;
            } catch (e: any) {
                if (!this.isTransportLevelError(e)) {
                    // e.g. encryption-needed, invalid payload — surface as-is
                    throw e instanceof Error ? e : new Error(String(e));
                }
                log.warn('transport', `WS send failed, trying REST: ${e?.message || e}`);
            }
        }
        if (!this.serverUrl) {
            throw new Error(
                'Not connected: WebSocket is down and no server URL for REST send. ' +
                'Reconnect or use a chatmail host with WebIMAP enabled.',
            );
        }
        const res = await fetch(`${this.serverUrl}/webimap/send`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...this.authHeaders(),
            },
            body: JSON.stringify({ from, to, body }),
            ...this.fetchOpts(),
        });
        if (!res.ok) {
            const errText = await res.text();
            if (res.status === 404) {
                throw new Error(
                    'Send failed: this server has no WebIMAP /webimap/send (HTTP 404). ' +
                    'Use a madmail host with webimap (and websmtp) enabled.',
                );
            }
            if (res.status === 401 || res.status === 403) {
                throw new Error(
                    `Send failed (${res.status}): invalid credentials for ${this.credentials.email}. ` +
                    'Password rejected by the relay — re-login or re-register.',
                );
            }
            throw new Error(`Send failed (${res.status}): ${errText}`);
        }
    }

    // ─── Fetch Messages ─────────────────────────────────────────────────

    /** List messages since a UID. WS preferred, REST fallback. */
    async fetchMessages(sinceUID = 0, mailbox = 'INBOX'): Promise<IncomingMessage[]> {
        if (this.isConnected) {
            return this.wsRequest('list_messages', { mailbox, since_uid: sinceUID });
        }
        const res = await fetch(
            `${this.serverUrl}/webimap/messages?mailbox=${encodeURIComponent(mailbox)}&since_uid=${sinceUID}`,
            { headers: this.authHeaders(), ...this.fetchOpts() }
        );
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        return res.json();
    }

    /** Fetch a single message by UID. WS preferred, REST fallback. */
    async fetchMessage(uid: number, mailbox = 'INBOX'): Promise<IncomingMessage> {
        if (this.isConnected) {
            return this.wsRequest('fetch', { mailbox, uid });
        }
        const res = await fetch(
            `${this.serverUrl}/webimap/message/${uid}?mailbox=${encodeURIComponent(mailbox)}`,
            { headers: this.authHeaders(), ...this.fetchOpts() }
        );
        if (!res.ok) throw new Error(`Fetch message ${uid} failed: ${res.status}`);
        return res.json();
    }

    // ─── Generic WS Request ─────────────────────────────────────────────

    /** Send a bidirectional WS request and wait for the correlated response */
    wsRequest(action: string, data: Record<string, any> = {}, timeoutMs = 20_000): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('WebSocket not connected'));
            }
            const req_id = String(++this.reqCounter);
            const timer = setTimeout(() => {
                this.pendingRequests.delete(req_id);
                reject(new Error(`WebSocket request timed out: ${action}`));
            }, timeoutMs);
            this.pendingRequests.set(req_id, {
                resolve: (v) => {
                    clearTimeout(timer);
                    resolve(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    reject(e);
                },
            });
            try {
                this.ws.send(JSON.stringify({ req_id, action, data }));
            } catch (e: any) {
                clearTimeout(timer);
                this.pendingRequests.delete(req_id);
                reject(e instanceof Error ? e : new Error(String(e)));
            }
        });
    }

    // ─── WebSocket Lifecycle ────────────────────────────────────────────

    /** Connect the WebSocket for real-time message push */
    connect(sinceUID = 0): Promise<void> {
        if (this.isConnected) return Promise.resolve();
        if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return Promise.resolve();

        this.intentionalClose = false;
        this.lastSinceUID = sinceUID || this.lastSinceUID;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        // Disconnect if we have a stale instance
        if (this.ws) {
            try {
                this.ws.onclose = null;
                this.ws.close();
            } catch {
                /* ignore */
            }
            this.ws = null;
        }

        return new Promise((resolve, reject) => {
            let url: string;
            if (this.serverUrl) {
                const wsProto = this.serverUrl.startsWith('https') ? 'wss' : 'ws';
                const host = this.serverUrl.replace(/^https?:\/\//, '');
                url = `${wsProto}://${host}/webimap/ws?email=${encodeURIComponent(this.credentials.email)}&password=${encodeURIComponent(this.credentials.password)}&mailbox=INBOX&since_uid=${this.lastSinceUID}`;
            } else {
                // Proxy mode: use current page host (Vite dev proxy)
                const loc = globalThis.location || { protocol: 'http:', host: 'localhost' };
                const wsProto = loc.protocol === 'https:' ? 'wss' : 'ws';
                url = `${wsProto}://${loc.host}/webimap/ws?email=${encodeURIComponent(this.credentials.email)}&password=${encodeURIComponent(this.credentials.password)}&mailbox=INBOX&since_uid=${this.lastSinceUID}`;
            }

            this.ws = new WebSocket(url);
            let settled = false;

            this.ws!.onopen = () => {
                log.info('transport', 'WebSocket connected');
                this.reconnectAttempt = 0;
                if (!settled) {
                    settled = true;
                    resolve();
                }
            };

            this.ws!.onmessage = (event: any) => {
                try {
                    const dataStr = typeof event.data === 'string' ? event.data : event.data.toString();
                    const msg = JSON.parse(dataStr);

                    // Response to a client request (has req_id)
                    if (msg.req_id) {
                        const pending = this.pendingRequests.get(msg.req_id);
                        if (pending) {
                            this.pendingRequests.delete(msg.req_id);
                            if (msg.action === 'error') {
                                pending.reject(new Error(typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data)));
                            } else {
                                pending.resolve(msg.data);
                            }
                        }
                        return;
                    }

                    // Push notification → delegate to SDK
                    if (this.onPush) {
                        this.onPush(msg);
                    }
                } catch (e: any) {
                    log.error('transport', 'WS parse error:', e.message);
                }
            };

            this.ws!.onerror = (e: any) => {
                log.error('transport', 'WS error:', e.message || e);
                if (!settled) {
                    settled = true;
                    reject(e instanceof Error ? e : new Error('WebSocket error'));
                }
            };

            this.ws!.onclose = () => {
                log.info('transport', 'WebSocket disconnected');
                this.ws = null;
                for (const [, p] of this.pendingRequests) {
                    p.reject(new Error('WebSocket closed'));
                }
                this.pendingRequests.clear();
                if (!this.intentionalClose && this.credentials.email) {
                    this.scheduleReconnect();
                }
            };
        });
    }

    private scheduleReconnect() {
        if (this.reconnectTimer || this.intentionalClose) return;
        // 1s, 2s, 4s … cap 30s
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt, 5));
        this.reconnectAttempt += 1;
        log.info('transport', `WS reconnect in ${delay}ms (attempt ${this.reconnectAttempt})`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect(this.lastSinceUID).catch((e) => {
                log.warn('transport', `WS reconnect failed: ${e?.message || e}`);
                this.scheduleReconnect();
            });
        }, delay);
    }

    /** Disconnect WebSocket */
    disconnect() {
        this.intentionalClose = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.ws?.close();
        this.ws = null;
        for (const [, p] of this.pendingRequests) {
            p.reject(new Error('Disconnected'));
        }
        this.pendingRequests.clear();
    }

    // ─── Account Registration (REST only) ───────────────────────────────

    /** Register a new account on the server. Supports optional {token} per madmail POST /new. */
    async register(serverUrl: string, options: { token?: string } = {}): Promise<Credentials & { dclogin_url?: string }> {
        this.serverUrl = serverUrl;
        const res = await fetch(`${serverUrl}/new`, {
            method: 'POST',
            ...(options.token ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: options.token }) } : {}),
            ...this.fetchOpts(),
        });
        if (!res.ok) {
            throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        this.credentials = { email: data.email, password: data.password };
        return { email: data.email, password: data.password, dclogin_url: data.dclogin_url };
    }
}
