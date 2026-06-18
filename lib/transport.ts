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

import type { Credentials, IncomingMessage } from '../types';
import { log } from './logger';

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

    /** Send a raw email. Transparent WS→REST fallback. */
    async send(from: string, to: string[], body: string): Promise<void> {
        if (this.isConnected) {
            await this.wsRequest('send', { from, to, body });
            return;
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
            throw new Error(`Send failed (${res.status}): ${errText}`);
        }
    }

    // ─── Fetch Messages ─────────────────────────────────────────────────

    /** List messages since a UID. WS preferred, REST fallback. */
    async fetchMessages(sinceUID = 0): Promise<IncomingMessage[]> {
        if (this.isConnected) {
            return this.wsRequest('list_messages', { mailbox: 'INBOX', since_uid: sinceUID });
        }
        const res = await fetch(
            `${this.serverUrl}/webimap/messages?mailbox=INBOX&since_uid=${sinceUID}`,
            { headers: this.authHeaders(), ...this.fetchOpts() }
        );
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        return res.json();
    }

    /** Fetch a single message by UID. WS preferred, REST fallback. */
    async fetchMessage(uid: number): Promise<IncomingMessage> {
        if (this.isConnected) {
            return this.wsRequest('fetch', { mailbox: 'INBOX', uid });
        }
        const res = await fetch(
            `${this.serverUrl}/webimap/message/${uid}?mailbox=INBOX`,
            { headers: this.authHeaders(), ...this.fetchOpts() }
        );
        if (!res.ok) throw new Error(`Fetch message ${uid} failed: ${res.status}`);
        return res.json();
    }

    // ─── Generic WS Request ─────────────────────────────────────────────

    /** Send a bidirectional WS request and wait for the correlated response */
    wsRequest(action: string, data: Record<string, any> = {}): Promise<any> {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                return reject(new Error('WebSocket not connected'));
            }
            const req_id = String(++this.reqCounter);
            this.pendingRequests.set(req_id, { resolve, reject });
            this.ws.send(JSON.stringify({ req_id, action, data }));
        });
    }

    // ─── WebSocket Lifecycle ────────────────────────────────────────────

    /** Connect the WebSocket for real-time message push */
    connect(sinceUID = 0): Promise<void> {
        if (this.isConnected) return Promise.resolve();
        if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return Promise.resolve();
        
        // Disconnect if we have a stale instance
        if (this.ws) this.ws.close();

        return new Promise((resolve, reject) => {
            let url: string;
            if (this.serverUrl) {
                const wsProto = this.serverUrl.startsWith('https') ? 'wss' : 'ws';
                const host = this.serverUrl.replace(/^https?:\/\//, '');
                url = `${wsProto}://${host}/webimap/ws?email=${encodeURIComponent(this.credentials.email)}&password=${encodeURIComponent(this.credentials.password)}&mailbox=INBOX&since_uid=${sinceUID}`;
            } else {
                // Proxy mode: use current page host (Vite dev proxy)
                const loc = globalThis.location || { protocol: 'http:', host: 'localhost' };
                const wsProto = loc.protocol === 'https:' ? 'wss' : 'ws';
                url = `${wsProto}://${loc.host}/webimap/ws?email=${encodeURIComponent(this.credentials.email)}&password=${encodeURIComponent(this.credentials.password)}&mailbox=INBOX&since_uid=${sinceUID}`;
            }

            this.ws = new WebSocket(url);

            this.ws!.onopen = () => {
                log.info('transport', 'WebSocket connected');
                resolve();
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
                reject(e);
            };

            this.ws!.onclose = () => {
                log.info('transport', 'WebSocket disconnected');
                for (const [, p] of this.pendingRequests) {
                    p.reject(new Error('WebSocket closed'));
                }
                this.pendingRequests.clear();
            };
        });
    }

    /** Disconnect WebSocket */
    disconnect() {
        this.ws?.close();
        this.ws = null;
        for (const [, p] of this.pendingRequests) {
            p.reject(new Error('Disconnected'));
        }
        this.pendingRequests.clear();
    }

    // ─── Account Registration (REST only) ───────────────────────────────

    /** Register a new account on the server */
    async register(serverUrl: string): Promise<Credentials> {
        this.serverUrl = serverUrl;
        const res = await fetch(`${serverUrl}/new`, {
            method: 'POST',
            ...this.fetchOpts(),
        });
        if (!res.ok) {
            throw new Error(`Registration failed: ${res.status} ${await res.text()}`);
        }
        const data = await res.json();
        this.credentials = { email: data.email, password: data.password };
        return this.credentials;
    }
}
