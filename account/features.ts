/**
 * AccountFeatures — webxdc, backup, config, location, calls, connectivity.
 */
import * as openpgp from 'openpgp';
import type { StoredMessage, StoredContact } from '../store.js';
import * as cryptoLib from '../lib/crypto.js';
import * as webxdcLib from '../lib/webxdc.js';
import * as backupLib from '../lib/backup.js';
import * as locationLib from '../lib/location.js';
import * as callsLib from '../lib/calls.js';
import type { Connectivity } from '../types.js';
import { log } from '../lib/logger.js';
import { AccountInbox } from './inbox.js';

export abstract class AccountFeatures extends AccountInbox {
    // WEBXDC
    // ═══════════════════════════════════════════════════════════════════════

    async sendWebxdc(
        contact: string | StoredContact,
        opts: { data: string; filename?: string; name?: string; caption?: string },
    ): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        if (this.isBlocked(toEmail)) throw new Error(`Cannot send to blocked contact ${toEmail}`);
        const msgId = await webxdcLib.sendWebxdc(this.ctx(), toEmail, opts);
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.name || 'Webxdc', {
            type: 'webxdc',
            media: {
                filename: opts.filename || 'app.xdc',
                mimeType: 'application/webxdc',
                data: opts.data,
            },
        });
    }

    async sendWebxdcStatusUpdate(
        contact: string | StoredContact,
        instanceMsgId: string,
        update: { payload: unknown; info?: string; summary?: string; document?: string; serial?: number },
    ): Promise<void> {
        const toEmail = this.resolveEmail(contact);
        const serial = update.serial ?? Date.now();
        await webxdcLib.sendWebxdcStatusUpdate(this.ctx(), toEmail, instanceMsgId, { ...update, serial });
        const list = this.webxdcUpdates.get(instanceMsgId) || [];
        list.push({ serial, payload: update.payload, info: update.info, summary: update.summary, document: update.document });
        this.webxdcUpdates.set(instanceMsgId, list);
        this.emit('DC_EVENT_WEBXDC_STATUS_UPDATE', {
            event: 'DC_EVENT_WEBXDC_STATUS_UPDATE',
            msgId: instanceMsgId,
            data1: serial,
            data2: update.payload,
        });
    }

    async getWebxdcStatusUpdates(instanceMsgId: string, lastSerial = 0): Promise<webxdcLib.WebxdcStatusUpdate[]> {
        const list = this.webxdcUpdates.get(instanceMsgId) || [];
        return list.filter(u => u.serial > lastSerial);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BACKUP + CONFIG + MULTI-FOLDER
    // ═══════════════════════════════════════════════════════════════════════

    async exportBackup(opts?: { passphrase?: string }): Promise<string> {
        await this.saveToStore();
        const account = await this.store.getAccount();
        if (!account) throw new Error('No account to export');
        const payload: backupLib.BackupPayload = {
            v: backupLib.BACKUP_VERSION,
            createdAt: Date.now(),
            account: {
                ...account,
                config: Object.fromEntries(this.configBag),
                // One relay per serverUrl — never re-export bloated clones
                relays: this.listRelays().map(r => ({
                    id: r.id,
                    serverUrl: r.serverUrl,
                    email: r.email,
                    password: r.password,
                })),
            },
            contacts: await this.store.getAllContacts(),
            chats: await this.store.getAllChats(),
            messages: [],
            config: Object.fromEntries(this.configBag),
            knownKeys: Object.fromEntries(this.knownKeys),
        };
        // Collect messages for all chats (capped)
        for (const chat of payload.chats) {
            const msgs = await this.store.getChatMessages(chat.id, 5000, 0);
            payload.messages.push(...msgs);
        }
        const json = backupLib.serializeBackup(payload);
        if (opts?.passphrase) {
            const enc = await backupLib.encryptBackup(json, opts.passphrase);
            return JSON.stringify(enc);
        }
        return json;
    }

    async importBackup(blob: string, opts?: { passphrase?: string }): Promise<void> {
        const payload = await backupLib.loadBackup(blob, opts?.passphrase);
        await this.store.saveAccount(payload.account);
        for (const c of payload.contacts) await this.store.saveContact(c);
        for (const ch of payload.chats) await this.store.saveChat(ch);
        for (const m of payload.messages) await this.store.saveMessage(m);
        if (payload.knownKeys) {
            for (const [email, key] of Object.entries(payload.knownKeys)) {
                this.knownKeys.set(email.toLowerCase(), key);
            }
        }
        if (payload.config) {
            for (const [k, v] of Object.entries(payload.config)) this.configBag.set(k, v);
        }
        // Restore credentials + keys. Do NOT bulk-insert payload.relays here —
        // that recreated 30+ duplicate primaries. loadFromStore dedupes.
        this.setCredentials(payload.account.email, payload.account.password, payload.account.serverUrl);
        if (payload.account.privateKeyArmored) {
            this.privateKey = await openpgp.readPrivateKey({ armoredKey: payload.account.privateKeyArmored });
        }
        if (payload.account.publicKeyArmored) {
            this.publicKey = await openpgp.readKey({ armoredKey: payload.account.publicKeyArmored });
            this.fingerprint = this.publicKey.getFingerprint().toUpperCase();
            this.autocryptKeydata = cryptoLib.extractAutocryptKeydata(payload.account.publicKeyArmored);
        }
        this.displayName = payload.account.displayName || '';
        await this.loadFromStore();
        // Pin backup password again after load (snapshot may have been empty/stale)
        this.setCredentials(
            payload.account.email,
            payload.account.password,
            payload.account.serverUrl,
        );
        await this.flushPersist();
        log.info('sdk', `Imported backup for ${payload.account.email}`);
    }

    async setConfig(key: string, value: string): Promise<void> {
        this.configBag.set(key, value);
        if (key === 'watched_mailboxes') {
            this.watchedMailboxes = value.split(',').map(s => s.trim()).filter(Boolean);
            if (this.watchedMailboxes.length === 0) this.watchedMailboxes = ['INBOX'];
        }
        this.schedulePersist();
    }

    async getConfig(key: string): Promise<string | null> {
        return this.configBag.get(key) ?? null;
    }

    async batchSetConfig(values: Record<string, string>): Promise<void> {
        for (const [k, v] of Object.entries(values)) {
            await this.setConfig(k, v);
        }
    }

    setWatchedMailboxes(mailboxes: string[]): void {
        this.watchedMailboxes = mailboxes.length ? [...mailboxes] : ['INBOX'];
        this.configBag.set('watched_mailboxes', this.watchedMailboxes.join(','));
    }

    getWatchedMailboxes(): string[] {
        return [...this.watchedMailboxes];
    }

    /**
     * Fetch new messages from all watched mailboxes and process them into the store.
     * list_messages only returns summaries — we must fetch bodies and run processIncomingRaw.
     */
    async backgroundFetch(sinceUID = 0): Promise<number> {
        let total = 0;
        const since = sinceUID > 0 ? sinceUID : this.lastSeenUid;
        for (const mailbox of this.watchedMailboxes) {
            try {
                const listed = await this.transport.fetchMessages(since, mailbox);
                const items = Array.isArray(listed) ? listed : [];
                for (const item of items) {
                    const uid =
                        item && typeof item === 'object' && 'uid' in item
                            ? Number((item as { uid: number }).uid)
                            : NaN;
                    if (!Number.isFinite(uid) || uid <= 0) continue;
                    if (this.seenUIDs.has(uid)) continue;
                    try {
                        let body =
                            item && typeof item === 'object' && 'body' in item
                                ? String((item as { body?: string }).body || '')
                                : '';
                        let envelope =
                            item && typeof item === 'object' && 'envelope' in item
                                ? (item as { envelope?: unknown }).envelope
                                : undefined;
                        if (!body) {
                            const detail = await this.transport.fetchMessage(uid, mailbox);
                            body = detail?.body || '';
                            envelope = detail?.envelope ?? envelope;
                        }
                        if (!body) {
                            log.warn('sdk', `backgroundFetch uid ${uid}: empty body`);
                            continue;
                        }
                        const parsed = await this.processIncomingRaw({ uid, body, envelope });
                        if (parsed) total += 1;
                    } catch (e: any) {
                        log.warn('sdk', `backgroundFetch process uid ${uid}: ${e.message}`);
                    }
                }
            } catch (e: any) {
                this.lastTransportError = e.message;
                log.warn('sdk', `backgroundFetch ${mailbox}: ${e.message}`);
            }
        }
        if (total > 0) {
            this.schedulePersist();
            log.info('sdk', `backgroundFetch processed ${total} message(s)`);
        }
        return total;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // LOCATION
    // ═══════════════════════════════════════════════════════════════════════

    async sendLocationsToChat(chatId: string, opts: { durationSec: number }): Promise<void> {
        const until = Date.now() + Math.max(0, opts.durationSec) * 1000;
        const peerEmail = chatId.includes('@') ? chatId : undefined;
        this.locationStreams.set(chatId, { chatId, until, peerEmail });
        if (peerEmail && this.knownKeys.has(peerEmail.toLowerCase())) {
            await locationLib.sendLocationStreamStart(this.ctx(), peerEmail, opts.durationSec);
        }
        this.emit('DC_EVENT_LOCATION_CHANGED', { event: 'DC_EVENT_LOCATION_CHANGED', chatId, data1: 'stream-start', data2: opts.durationSec });
    }

    async setLocation(point: { lat: number; lon: number; accuracy?: number; timestamp?: number }): Promise<void> {
        const now = Date.now();
        const loc: locationLib.LocationPoint = {
            lat: point.lat,
            lon: point.lon,
            accuracy: point.accuracy,
            timestamp: point.timestamp || now,
        };
        this.locationPoints.push(loc);
        // Fan out to active streams
        for (const [chatId, stream] of this.locationStreams) {
            if (stream.until < now) {
                this.locationStreams.delete(chatId);
                continue;
            }
            if (stream.peerEmail && this.knownKeys.has(stream.peerEmail.toLowerCase())) {
                await locationLib.sendLocation(this.ctx(), stream.peerEmail, { ...loc, chatId });
            }
            this.emit('DC_EVENT_LOCATION_CHANGED', {
                event: 'DC_EVENT_LOCATION_CHANGED',
                chatId,
                data1: loc,
            });
        }
    }

    async stopSendingLocations(chatId: string): Promise<void> {
        const stream = this.locationStreams.get(chatId);
        this.locationStreams.delete(chatId);
        if (stream?.peerEmail && this.knownKeys.has(stream.peerEmail.toLowerCase())) {
            await locationLib.sendLocationStreamStop(this.ctx(), stream.peerEmail);
        }
        this.emit('DC_EVENT_LOCATION_CHANGED', { event: 'DC_EVENT_LOCATION_CHANGED', chatId, data1: 'stream-stop' });
    }

    async getLocations(
        chatId: string,
        opts?: { from?: number; to?: number },
    ): Promise<locationLib.LocationPoint[]> {
        const from = opts?.from ?? 0;
        const to = opts?.to ?? Date.now();
        return this.locationPoints.filter(
            p => p.timestamp >= from && p.timestamp <= to && (!p.chatId || p.chatId === chatId),
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CALLS (signaling)
    // ═══════════════════════════════════════════════════════════════════════

    setIceServers(servers: callsLib.IceServer[]): void {
        this.iceServers = [...servers];
    }

    getIceServers(): callsLib.IceServer[] {
        return [...this.iceServers];
    }

    capabilities(): {
        calls: ReturnType<typeof callsLib.callCapability>;
        webxdc: boolean;
        location: boolean;
        multiRelay: boolean;
    } {
        return {
            calls: callsLib.callCapability(),
            webxdc: true,
            location: true,
            multiRelay: this.relays.size > 0 || true,
        };
    }

    async placeOutgoingCall(
        contact: string | StoredContact,
        opts?: { video?: boolean; sdpOffer?: string },
    ): Promise<callsLib.CallSession> {
        const peerEmail = this.resolveEmail(contact);
        const callId = callsLib.generateCallId();
        const session: callsLib.CallSession = {
            callId,
            peerEmail,
            state: 'outgoing',
            video: !!opts?.video,
            createdAt: Date.now(),
            direction: 'outgoing',
        };
        this.calls.set(callId, session);
        await callsLib.sendCallSignal(this.ctx(), peerEmail, {
            type: opts?.sdpOffer ? 'offer' : 'ring',
            callId,
            sdp: opts?.sdpOffer,
            video: session.video,
        });
        return session;
    }

    async acceptIncomingCall(callId: string, opts?: { sdpAnswer?: string }): Promise<void> {
        const session = this.calls.get(callId);
        if (!session) throw new Error(`Unknown call ${callId}`);
        session.state = 'active';
        if (opts?.sdpAnswer) {
            await callsLib.sendCallSignal(this.ctx(), session.peerEmail, {
                type: 'answer',
                callId,
                sdp: opts.sdpAnswer,
                video: session.video,
            });
        }
    }

    async endCall(callId: string): Promise<void> {
        const session = this.calls.get(callId);
        if (!session) return;
        session.state = 'ended';
        await callsLib.sendCallSignal(this.ctx(), session.peerEmail, {
            type: 'end',
            callId,
        });
        this.calls.delete(callId);
        this.emit('DC_EVENT_CALL_ENDED', { event: 'DC_EVENT_CALL_ENDED', data1: callId, contactId: session.peerEmail });
    }

    getCall(callId: string): callsLib.CallSession | undefined {
        return this.calls.get(callId);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // CONNECTIVITY + DEVICE MESSAGES + PUSH HOOK
    // ═══════════════════════════════════════════════════════════════════════

    getConnectivity(): Connectivity {
        const transports = [...this.transports.values()];
        if (transports.some(t => t.isConnected)) return 'connected';
        if (transports.some(t => t.state === 'connecting')) return 'connecting';
        return 'not_connected';
    }

    getConnectivityHtml(): string {
        const state = this.getConnectivity();
        const relays = this.listRelays().map(r =>
            `<li>${r.email} @ ${r.serverUrl}: ${r.state}</li>`,
        ).join('');
        const err = this.lastTransportError ? `<p>Last error: ${this.lastTransportError}</p>` : '';
        return `<div class="dc-connectivity"><h3>${state}</h3><ul>${relays}</ul>${err}</div>`;
    }

    /**
     * Local-only device message (system chat). Not sent over the network.
     */
    async addDeviceMessage(label: string, text: string): Promise<{ msgId: string; message: StoredMessage }> {
        const chatId = 'device-chat';
        let chat = await this.store.getChat(chatId);
        if (!chat) {
            chat = {
                id: chatId,
                name: 'Device messages',
                peerEmail: '',
                isGroup: false,
                unreadCount: 0,
                archived: false,
                pinned: false,
                muted: false,
            };
            await this.store.saveChat(chat);
        }
        const msgId = `<device-${label}-${Date.now()}@local>`;
        const now = Date.now();
        const message: StoredMessage = {
            id: msgId,
            chatId,
            from: 'device',
            to: this.credentials.email,
            text,
            timestamp: now,
            encrypted: false,
            direction: 'incoming',
            type: 'system',
            state: 'seen',
            sentAt: now,
            seenAt: now,
        };
        await this.store.saveMessage(message);
        chat.lastMessage = text.substring(0, 100);
        chat.lastMessageId = msgId;
        chat.lastMessageTime = now;
        await this.store.saveChat(chat);
        this.emit('DC_EVENT_INCOMING_MSG', { event: 'DC_EVENT_INCOMING_MSG', chatId, msgId, message });
        return { msgId, message };
    }

    /**
     * App-provided push payload hook (Service Worker / Web Push).
     * Triggers background UID sync; does not implement FCM/APNs.
     */
    async processPushPayload(_payload: unknown): Promise<void> {
        try {
            await this.backgroundFetch(0);
            this.emit('DC_EVENT_CONNECTIVITY_CHANGED', { event: 'DC_EVENT_CONNECTIVITY_CHANGED', data1: 'push' });
        } catch (e: any) {
            this.lastTransportError = e.message;
        }
    }

    async setPushToken(_token: { type: 'webpush'; endpoint: string; keys?: Record<string, string> }): Promise<void> {
        // Store for future relay push registration; no server protocol yet
        await this.setConfig('push_endpoint', _token.endpoint);
        if (_token.keys) {
            await this.setConfig('push_keys', JSON.stringify(_token.keys));
        }
        log.info('sdk', 'Push token stored (relay registration not yet available)');
    }
}
