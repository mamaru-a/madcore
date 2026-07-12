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

/**
 * Stock welcome text — `StockMessage::WelcomeMessage` fallback in core `stock_str.rs`.
 * Core inserts this once as labelled device msg `core-welcome`.
 */
export const CORE_WELCOME_MESSAGE =
    'Get in contact!\n\n' +
    '🙌 Tap "QR code" on the main screen of both devices. ' +
    'Choose "Scan QR Code" on one device, and point it at the other\n\n' +
    '🌍 If not in the same room, ' +
    'scan via video call or share an invite link from "Scan QR code"\n\n' +
    'Then: Enjoy your decentralized messenger experience. ' +
    'In contrast to other popular apps, ' +
    'without central control or tracking or selling you, ' +
    'friends, colleagues or family out to large organizations.';

/** Host-served welcome image (madweb static/); mirrors core welcome-image.jpg in the device chat. */
export const CORE_WELCOME_IMAGE_PATH = '/images/intro1.png';

export type DeviceMessageContent = {
    text?: string | null;
    type?: StoredMessage['type'];
    media?: StoredMessage['media'];
};

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
                relays: [...this.relays.values()].map(r => ({
                    id: r.id, serverUrl: r.serverUrl, email: r.email, password: r.password,
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
        // Restore credentials + keys
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
        if (payload.account.relays) {
            for (const r of payload.account.relays) {
                this.relays.set(r.id, { ...r });
            }
        }
        await this.loadFromStore();
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

    /** Fetch new messages from all watched mailboxes */
    async backgroundFetch(sinceUID = 0): Promise<number> {
        let total = 0;
        for (const mailbox of this.watchedMailboxes) {
            try {
                const msgs = await this.transport.fetchMessages(sinceUID, mailbox);
                total += Array.isArray(msgs) ? msgs.length : 0;
            } catch (e: any) {
                this.lastTransportError = e.message;
                log.warn('sdk', `backgroundFetch ${mailbox}: ${e.message}`);
            }
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
     * Local-only device message (device chat). Not sent over the network.
     *
     * Mirrors core `add_device_msg`:
     * - Each `label` is recorded once; later calls with the same label are no-ops.
     * - `text === null` / empty **without media** only registers the label (skip future content).
     * - Messages are normal chat bubbles (text/image), **not** info/system events.
     */
    async addDeviceMessage(
        label: string,
        content: string | null | DeviceMessageContent,
    ): Promise<{ msgId: string; message: StoredMessage } | null> {
        const trimmedLabel = (label || '').trim() || 'device';
        const labelsKey = 'device_msg_labels';
        const rawLabels = this.configBag.get(labelsKey) || '';
        const labels = new Set(
            rawLabels.split('\n').map(s => s.trim()).filter(Boolean),
        );
        const msgId = `<device-${trimmedLabel}@local>`;

        const rememberLabel = async () => {
            if (labels.has(trimmedLabel)) return;
            labels.add(trimmedLabel);
            this.configBag.set(labelsKey, [...labels].join('\n'));
            // Persist immediately so a quick account-switch cannot lose the label.
            await this.flushPersist();
        };

        // Already recorded → never insert again (core add_device_msg semantics).
        if (labels.has(trimmedLabel)) {
            return null;
        }

        // Already in store (stable id, or legacy Date.now ids) → mark label, no new bubble.
        const existing = await this.store.getMessage(msgId);
        if (existing) {
            await rememberLabel();
            return null;
        }
        try {
            const deviceMsgs = await this.store.getChatMessages('device-chat', 500, 0);
            // Exact stable id, or legacy ids that encode this label only
            // (must not treat `core-welcome-image` as a hit for label `core-welcome`)
            const legacy = deviceMsgs.find(m => {
                if (m.id === msgId) return true;
                // Legacy: <device-{label}-{timestamp}@local> or device-{label}-{ts}
                const exactLegacy =
                    m.id.startsWith(`<device-${trimmedLabel}-`) ||
                    m.id.startsWith(`device-${trimmedLabel}-`);
                if (!exactLegacy) return false;
                // Reject longer labels that only share a prefix (e.g. core-welcome vs core-welcome-image)
                const rest = m.id.startsWith('<')
                    ? m.id.slice(`<device-${trimmedLabel}-`.length)
                    : m.id.slice(`device-${trimmedLabel}-`.length);
                // After the label must come a digit (timestamp) or '@' / end — not more label text
                return /^[\d@]/.test(rest) || rest === '' || rest.startsWith('@');
            });
            if (legacy) {
                await rememberLabel();
                return null;
            }
        } catch {
            /* no device chat yet */
        }

        await rememberLabel();

        const opts: DeviceMessageContent =
            content == null
                ? { text: null }
                : typeof content === 'string'
                  ? { text: content, type: 'text' }
                  : content;

        const hasMedia = !!(opts.media?.data || opts.media?.filename);
        const text = opts.text == null ? '' : String(opts.text);
        // Label-only registration (core: msg=null) — no bubble.
        if (!hasMedia && (opts.text == null || text === '')) {
            return null;
        }

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
        const now = Date.now();
        // Keep sort order stable if several device msgs are inserted in the same ms
        const lastTs = chat.lastMessageTime || 0;
        const timestamp = now <= lastTs ? lastTs + 1 : now;
        const type: StoredMessage['type'] = opts.type || (hasMedia ? 'image' : 'text');
        const message: StoredMessage = {
            id: msgId,
            chatId,
            from: 'device',
            to: this.credentials.email,
            text,
            timestamp,
            encrypted: false,
            direction: 'incoming',
            // Normal message — UI treats `system` as centered info/event bubbles.
            type,
            // Core uses InFresh for new device msgs
            state: 'sent',
            sentAt: timestamp,
            media: opts.media,
        };
        await this.store.saveMessage(message);
        const preview =
            text.trim() ||
            (type === 'image' ? '🖼' : opts.media?.filename || 'Device message');
        chat.lastMessage = preview.substring(0, 100);
        chat.lastMessageId = msgId;
        chat.lastMessageTime = timestamp > 1e12 ? timestamp : timestamp * 1000;
        chat.unreadCount = (chat.unreadCount || 0) + 1;
        await this.store.saveChat(chat);
        this.emit('DC_EVENT_INCOMING_MSG', { event: 'DC_EVENT_INCOMING_MSG', chatId, msgId, message });
        this.emit('DC_EVENT_MSGS_CHANGED', { event: 'DC_EVENT_MSGS_CHANGED', chatId, msgId, message });
        return { msgId, message };
    }

    /**
     * Mirrors core `Context::update_device_chats` (called after successful configure):
     * 1. Create Saved messages (self-talk) once
     * 2. `core-welcome-image` device image
     * 3. `core-welcome` stock welcome text
     *
     * Labels make this idempotent — safe on every configure / restore.
     */
    async updateDeviceChats(): Promise<void> {
        try {
            // 1) Saved messages chat (self-talk) — once, like core `self-chat-added`
            if (this.configBag.get('self-chat-added') !== '1') {
                this.configBag.set('self-chat-added', '1');
                const selfEmail = this.credentials.email.toLowerCase();
                const selfChat = await this.getOrCreateChat(selfEmail);
                if (selfChat.name === selfEmail.split('@')[0] || !selfChat.name) {
                    selfChat.name = 'Saved messages';
                    await this.store.saveChat(selfChat);
                }
                await this.flushPersist();
            }

            // 2) Welcome image (core label `core-welcome-image`)
            // Path is served from madweb `static/images/intro1.png` (same as mock runtime).
            await this.addDeviceMessage('core-welcome-image', {
                text: '',
                type: 'image',
                media: {
                    filename: 'welcome-image.jpg',
                    mimeType: 'image/png',
                    data: CORE_WELCOME_IMAGE_PATH,
                },
            });

            // 3) Welcome text (core label `core-welcome` / StockMessage::WelcomeMessage)
            await this.addDeviceMessage('core-welcome', CORE_WELCOME_MESSAGE);
        } catch (e: any) {
            log.warn('sdk', `updateDeviceChats: ${e?.message || e}`);
        }
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
