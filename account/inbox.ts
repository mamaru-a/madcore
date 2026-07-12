/**
 * AccountInbox — inbound message pipeline and chat/store management.
 */
import type { StoredChat, StoredMessage, StoredContact, ChatDraft } from '../store.js';
import * as mimeLib from '../lib/mime.js';
import * as messagingLib from '../lib/messaging.js';
import * as groupLib from '../lib/group.js';
import * as webxdcLib from '../lib/webxdc.js';
import * as locationLib from '../lib/location.js';
import * as callsLib from '../lib/calls.js';
import { emailsEqual } from '../lib/crypto.js';
import { viewtypeToStoreType } from '../lib/viewtype.js';
import type { IncomingMessage, ParsedMessage } from '../types.js';
import { log } from '../lib/logger.js';
import { dumpSecureJoinMessage } from '../lib/securejoin.js';
import { AccountProfile } from './profile.js';

/** Legacy chat rows that look like SecureJoin control text (pre-fix store). */
function isLegacySecureJoinBubble(m: StoredMessage): boolean {
    if (m.type === 'securejoin') return true;
    const t = (m.text || '').trim();
    return /^secure-join:\s*v[cg]-/i.test(t);
}

export abstract class AccountInbox extends AccountProfile {
    /**
     * Process a raw inbound MIME message (parse, events, store).
     * Used by the WebSocket push path and by browser tests / custom transports.
     * Web-compatible — no Node APIs.
     */
    async processIncomingRaw(raw: IncomingMessage): Promise<ParsedMessage | null> {
        if (raw.uid != null && this.seenUIDs.has(raw.uid)) {
            // allow re-process with uid=0 for tests
            if (raw.uid !== 0) return null;
        }
        if (raw.uid != null && raw.uid !== 0) {
            this.seenUIDs.add(raw.uid);
            if (raw.uid > this.lastSeenUid) {
                this.lastSeenUid = raw.uid;
                this.schedulePersist();
            }
        }

        for (const h of this.rawHandlers) h(raw);

        const parsed = await mimeLib.parseIncoming(raw, {
            email: this.credentials.email,
            privateKey: this.privateKey,
            knownKeys: this.knownKeys,
            peerAvatars: this.peerAvatars,
        });

        if (parsed) {
            // Drop messages from blocked senders (except our own echoes)
            if (
                parsed.from &&
                parsed.from.toLowerCase() !== this.credentials.email.toLowerCase() &&
                this.isBlocked(parsed.from)
            ) {
                log.info('sdk', `Dropping message from blocked contact ${parsed.from}`);
                return null;
            }

            // ── SecureJoin control plane (mirrors core receive_imf + HandshakeMessage) ──
            // Handshake mails must NEVER become chat bubbles. Core returns Done/Ignore
            // and does not file them for the user. We:
            //  1) wake waiters (joiner waitForMessage)
            //  2) auto-answer as inviter when we hold invite tokens
            //  3) return without store / IncomingMsg
            if (parsed.isSecureJoin) {
                log.info(
                    'sdk',
                    `SecureJoin inbound step=${parsed.secureJoinStep || '?'} from=${parsed.from}`,
                );
                dumpSecureJoinMessage(
                    'IN',
                    {
                        step: parsed.secureJoinStep,
                        from: parsed.from,
                        to: parsed.to,
                        note: 'parsed inbound handshake',
                    },
                    raw.body || '',
                    {
                        uid: parsed.uid,
                        inviteNumber: parsed.secureJoinInviteNumber,
                        auth: parsed.secureJoinAuth,
                        encrypted: parsed.encrypted,
                        text: parsed.text,
                        headers: parsed.headers,
                        innerHeaders: parsed.innerHeaders,
                    },
                );
                for (const h of this.messageHandlers) h(parsed);
                try {
                    await this.handleIncomingSecureJoin(parsed);
                } catch (e: any) {
                    log.warn('sdk', `SecureJoin handle failed: ${e?.message || e}`);
                }
                return parsed;
            }

            // Call signaling (before generic store)
            if (parsed.isCall) {
                const signal = callsLib.parseSignal(parsed.text);
                if (signal) {
                    signal.from = parsed.from;
                    if (signal.type === 'ring' || signal.type === 'offer') {
                        this.calls.set(signal.callId, {
                            callId: signal.callId,
                            peerEmail: parsed.from,
                            state: 'ringing',
                            video: !!signal.video,
                            createdAt: Date.now(),
                            direction: 'incoming',
                        });
                        this.emit('DC_EVENT_INCOMING_CALL', {
                            event: 'DC_EVENT_INCOMING_CALL',
                            contactId: parsed.from,
                            data1: signal.callId,
                            data2: signal,
                        });
                    } else if (signal.type === 'end') {
                        this.calls.delete(signal.callId);
                        this.emit('DC_EVENT_CALL_ENDED', {
                            event: 'DC_EVENT_CALL_ENDED',
                            contactId: parsed.from,
                            data1: signal.callId,
                        });
                    } else if (signal.type === 'answer' || signal.type === 'ice') {
                        const s = this.calls.get(signal.callId);
                        if (s && signal.type === 'answer') s.state = 'active';
                        this.emit('DC_EVENT_MSGS_CHANGED', {
                            event: 'DC_EVENT_MSGS_CHANGED',
                            data1: signal,
                        });
                    }
                    return parsed; // do not store as chat bubble
                }
            }

            // Webxdc status updates
            if (parsed.isWebxdcStatus) {
                const instanceId = parsed.innerHeaders['chat-webxdc-instance']
                    || parsed.headers['chat-webxdc-instance']
                    || parsed.innerHeaders['in-reply-to']
                    || parsed.headers['in-reply-to']
                    || '';
                const upd = webxdcLib.parseStatusUpdate(parsed.text);
                if (upd && instanceId) {
                    const list = this.webxdcUpdates.get(instanceId) || [];
                    list.push(upd);
                    this.webxdcUpdates.set(instanceId, list);
                    this.emit('DC_EVENT_WEBXDC_STATUS_UPDATE', {
                        event: 'DC_EVENT_WEBXDC_STATUS_UPDATE',
                        msgId: instanceId,
                        data1: upd.serial,
                        data2: upd.payload,
                        contactId: parsed.from,
                    });
                }
                return parsed;
            }

            // Location points
            if (parsed.isLocation) {
                const pt = locationLib.parseLocation(parsed.text);
                if (pt) {
                    pt.from = parsed.from;
                    pt.chatId = parsed.groupId || parsed.from;
                    this.locationPoints.push(pt);
                    this.emit('DC_EVENT_LOCATION_CHANGED', {
                        event: 'DC_EVENT_LOCATION_CHANGED',
                        chatId: pt.chatId,
                        contactId: parsed.from,
                        data1: pt,
                    });
                }
                // stream control without lat/lon still emits
                if (!pt) {
                    this.emit('DC_EVENT_LOCATION_CHANGED', {
                        event: 'DC_EVENT_LOCATION_CHANGED',
                        contactId: parsed.from,
                        data1: parsed.text,
                    });
                }
                return parsed;
            }

            // Emit DC_EVENT_* events (SecureJoin already returned above)
            if (parsed.isReadReceipt) {
                // Handled in storeIncomingMessage → DC_EVENT_MSG_READ
            } else if (parsed.isReaction) {
                this.emit('DC_EVENT_INCOMING_REACTION', { event: 'DC_EVENT_INCOMING_REACTION', msg: parsed, msgId: parsed.rfc724mid || undefined });
            } else if (parsed.isDelete) {
                this.emit('DC_EVENT_MSG_DELETED', { event: 'DC_EVENT_MSG_DELETED', msg: parsed, msgId: parsed.text });
            } else if (parsed.avatarUpdate !== undefined) {
                this.emit('DC_EVENT_CONTACTS_CHANGED', { event: 'DC_EVENT_CONTACTS_CHANGED', msg: parsed, contactId: parsed.from });
                this.emit('DC_EVENT_INCOMING_MSG', { event: 'DC_EVENT_INCOMING_MSG', msg: parsed, msgId: parsed.rfc724mid || undefined });
            } else {
                this.emit('DC_EVENT_INCOMING_MSG', { event: 'DC_EVENT_INCOMING_MSG', msg: parsed, msgId: parsed.rfc724mid || undefined });
            }

            // Skip messageHandlers for control messages that aren't chat bubbles
            if (!parsed.isReadReceipt) {
                for (const h of this.messageHandlers) h(parsed);
            }
            await this.storeIncomingMessage(parsed);
        }
        return parsed;
    }

    // ═══════════════════════════════════════════════════════════════════════

    // CHAT & MESSAGE MANAGEMENT (store delegation)
    // ═══════════════════════════════════════════════════════════════════════

    async getChatList(): Promise<StoredChat[]> { return this.store.getAllChats(); }
    async searchChats(query: string): Promise<StoredChat[]> { return this.store.searchChats(query); }
    async getChat(chatId: string): Promise<StoredChat | null> { return this.store.getChat(chatId); }
    async getChatMessages(chatId: string, limit = 100, offset = 0): Promise<StoredMessage[]> {
        const msgs = await this.store.getChatMessages(chatId, limit, offset);
        // Hide any legacy handshake rows that were stored before SJ control-plane fix
        return msgs.filter(m => !isLegacySecureJoinBubble(m));
    }

    async deleteChat(chatId: string): Promise<void> {
        await this.store.deleteChat(chatId);
        const msgs = await this.store.getChatMessages(chatId);
        for (const m of msgs) await this.store.deleteMessage(m.id);
    }

    async deleteLocalMessage(msgId: string): Promise<void> {
        const msg = await this.store.getMessage?.(msgId);
        await this.store.deleteMessage(msgId);
        if (msg) {
            const chat = await this.store.getChat(msg.chatId);
            if (chat && chat.lastMessageId === msgId) {
                // oldest→newest; last element is the new preview
                const msgs = await this.store.getChatMessages(msg.chatId, 500, 0);
                if (msgs.length > 0) {
                    const last = msgs[msgs.length - 1];
                    chat.lastMessage = (last.text || '').substring(0, 100);
                    chat.lastMessageId = last.id;
                    chat.lastMessageTime = last.timestamp > 1e12 ? last.timestamp : last.timestamp * 1000;
                } else {
                    chat.lastMessage = undefined;
                    chat.lastMessageId = undefined;
                    chat.lastMessageTime = undefined;
                }
                await this.store.saveChat(chat);
            }
        }
    }

    async archiveChat(chatId: string, archive: boolean): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (chat) { chat.archived = archive; await this.store.saveChat(chat); }
    }

    async pinChat(chatId: string, pin: boolean): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (chat) { chat.pinned = pin; await this.store.saveChat(chat); }
    }

    async muteChat(chatId: string, mute: boolean): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (chat) { chat.muted = mute; await this.store.saveChat(chat); }
    }

    // ── Drafts (local only) ─────────────────────────────────────────────────

    async setDraft(chatId: string, draft: { text?: string; file?: ChatDraft['file'] }): Promise<void> {
        let chat = await this.store.getChat(chatId);
        if (!chat) {
            chat = {
                id: chatId,
                name: chatId.split('@')[0] || chatId,
                peerEmail: chatId.includes('@') ? chatId : '',
                isGroup: !chatId.includes('@'),
                unreadCount: 0,
                archived: false,
                pinned: false,
                muted: false,
            };
        }
        chat.draft = {
            text: draft.text,
            file: draft.file,
            updatedAt: Date.now(),
        };
        await this.store.saveChat(chat);
    }

    async getDraft(chatId: string): Promise<ChatDraft | null> {
        const chat = await this.store.getChat(chatId);
        return chat?.draft || null;
    }

    async removeDraft(chatId: string): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (!chat?.draft) return;
        delete chat.draft;
        await this.store.saveChat(chat);
    }

    // ── Ephemeral timer ─────────────────────────────────────────────────────

    /**
     * Set disappearing-message timer for a chat (seconds; 0 = off).
     * Propagates over the wire for 1:1 and groups.
     */
    async setChatEphemeralTimer(chatId: string, seconds: number): Promise<void> {
        const secs = Math.max(0, Math.floor(seconds));
        let chat = await this.store.getChat(chatId);
        if (!chat) {
            chat = {
                id: chatId,
                name: chatId.split('@')[0] || chatId,
                peerEmail: chatId.includes('@') ? chatId : '',
                isGroup: this.groups.has(chatId),
                unreadCount: 0,
                archived: false,
                pinned: false,
                muted: false,
            };
        }
        chat.ephemeralTimer = secs;
        await this.store.saveChat(chat);

        if (this.groups.has(chatId)) {
            await groupLib.sendGroupEphemeralTimer(this.ctx(), this.resolveGroup(chatId), secs);
        } else if (chatId.includes('@') && this.knownKeys.has(chatId.toLowerCase())) {
            await messagingLib.sendEphemeralTimer(this.ctx(), chatId, secs);
        }

        this.emit('DC_EVENT_MSGS_CHANGED', { event: 'DC_EVENT_MSGS_CHANGED', chatId });
    }

    async getChatEphemeralTimer(chatId: string): Promise<number> {
        const chat = await this.store.getChat(chatId);
        return chat?.ephemeralTimer || 0;
    }

    /** Delete locally expired ephemeral messages. Call periodically or on connect. */
    async sweepEphemeralMessages(): Promise<number> {
        const now = Date.now();
        const chats = await this.store.getAllChats();
        let deleted = 0;
        for (const chat of chats) {
            const msgs = await this.store.getChatMessages(chat.id, 5000, 0);
            for (const msg of msgs) {
                if (msg.ephemeralExpiresAt && msg.ephemeralExpiresAt <= now) {
                    await this.store.deleteMessage(msg.id);
                    deleted++;
                }
            }
        }
        if (deleted > 0) {
            this.emit('DC_EVENT_MSGS_CHANGED', { event: 'DC_EVENT_MSGS_CHANGED', data1: deleted });
        }
        return deleted;
    }

    // ── Chat / group profile image ──────────────────────────────────────────

    async setChatProfileImage(chatId: string, opts: { data: string; mimeType?: string }): Promise<void> {
        const dataUri = opts.data.startsWith('data:')
            ? opts.data
            : `data:${opts.mimeType || 'image/jpeg'};base64,${opts.data}`;
        let chat = await this.store.getChat(chatId);
        if (!chat) {
            chat = {
                id: chatId,
                name: chatId.split('@')[0] || chatId,
                peerEmail: chatId.includes('@') ? chatId : '',
                isGroup: this.groups.has(chatId),
                unreadCount: 0,
                archived: false,
                pinned: false,
                muted: false,
            };
        }
        chat.avatar = dataUri;
        await this.store.saveChat(chat);

        if (this.groups.has(chatId)) {
            const b64 = opts.data.startsWith('data:')
                ? opts.data.replace(/^data:[^;]+;base64,/, '')
                : opts.data;
            await groupLib.sendGroupAvatar(this.ctx(), this.resolveGroup(chatId), {
                data: b64,
                mimeType: opts.mimeType,
            });
        }
        this.emit('DC_EVENT_MSGS_CHANGED', { event: 'DC_EVENT_MSGS_CHANGED', chatId });
    }

    async removeChatProfileImage(chatId: string): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (chat) {
            delete chat.avatar;
            await this.store.saveChat(chat);
        }
        if (this.groups.has(chatId)) {
            await groupLib.sendGroupAvatar(this.ctx(), this.resolveGroup(chatId), { remove: true });
        }
        this.emit('DC_EVENT_MSGS_CHANGED', { event: 'DC_EVENT_MSGS_CHANGED', chatId });
    }

    async getUnreadCount(): Promise<number> {
        const chats = await this.store.getAllChats();
        return chats.reduce((sum, c) => sum + c.unreadCount, 0);
    }

    async getContacts(): Promise<StoredContact[]> { return this.store.getAllContacts(); }

    async searchContacts(query: string): Promise<StoredContact[]> {
        const all = await this.store.getAllContacts();
        const q = query.toLowerCase();
        return all.filter(c => c.email.toLowerCase().includes(q) || c.name.toLowerCase().includes(q));
    }

    async searchMessages(query: string, chatId?: string): Promise<StoredMessage[]> {
        return this.store.searchMessages(query, chatId);
    }

    protected async storeIncomingMessage(parsed: ParsedMessage): Promise<void> {
        const peerEmail = parsed.from.toLowerCase();
        const chat = await this.getOrCreateChat(peerEmail);

        // Read receipts: update original message, never create a chat bubble
        if (parsed.isReadReceipt) {
            if (parsed.readReceiptFor) {
                await this.applyReadReceipt(parsed.readReceiptFor, parsed.from, parsed.timestamp);
            } else {
                log.debug('sdk', 'MDN without Original-Message-ID — dropped (no bubble)');
            }
            return;
        }

        // SecureJoin handshake control traffic — no chat bubbles (inviter/joiner
        // already handled protocol in processIncomingRaw).
        if (parsed.isSecureJoin) {
            return;
        }

        // Ephemeral timer control message
        if (parsed.ephemeralTimer !== undefined && !parsed.isReaction && !parsed.isDelete) {
            const chatKey = parsed.groupId || peerEmail;
            let c = await this.store.getChat(chatKey);
            if (!c) {
                c = {
                    id: chatKey,
                    name: parsed.groupName || peerEmail.split('@')[0],
                    peerEmail: parsed.groupId ? '' : peerEmail,
                    isGroup: !!parsed.groupId,
                    unreadCount: 0,
                    archived: false,
                    pinned: false,
                    muted: false,
                };
            }
            c.ephemeralTimer = parsed.ephemeralTimer;
            await this.store.saveChat(c);
            // Fall through to store as system-ish text so UI can show the change
        }

        // Group avatar update
        if (parsed.groupAvatarUpdate !== undefined && parsed.groupId) {
            let c = await this.store.getChat(parsed.groupId);
            if (!c) {
                c = {
                    id: parsed.groupId,
                    name: parsed.groupName || parsed.groupId,
                    peerEmail: '',
                    isGroup: true,
                    unreadCount: 0,
                    archived: false,
                    pinned: false,
                    muted: false,
                };
            }
            c.avatar = parsed.groupAvatarUpdate || undefined;
            await this.store.saveChat(c);
        }

        if (parsed.isDelete) {
            await this.store.deleteMessage(parsed.text);
            // oldest→newest; last element is the new preview (limit=1 would return the oldest)
            const msgs = await this.store.getChatMessages(peerEmail, 500, 0);
            if (msgs.length > 0) {
                const l = msgs[msgs.length - 1];
                chat.lastMessage = (l.text || '').substring(0, 100);
                chat.lastMessageId = l.id;
                chat.lastMessageTime = l.timestamp > 1e12 ? l.timestamp : l.timestamp * 1000;
            } else {
                chat.lastMessage = undefined;
                chat.lastMessageId = undefined;
                chat.lastMessageTime = undefined;
            }
            await this.store.saveChat(chat);
            return;
        }

        if (parsed.isReaction) {
            // Attach reaction to the target message instead of creating a separate message
            const targetMsgId = parsed.innerHeaders['in-reply-to'] || parsed.headers['in-reply-to'];
            if (targetMsgId) {
                const targetMsg = await this.store.getMessage(targetMsgId);
                if (targetMsg) {
                    if (!targetMsg.reactions) targetMsg.reactions = [];
                    targetMsg.reactions.push({ reaction: parsed.text, from: parsed.from, at: Date.now() });
                    await this.store.saveMessage(targetMsg);
                }
            }
            return;
        }

        if (parsed.avatarUpdate !== undefined) {
            chat.avatar = parsed.avatarUpdate || undefined;
            const contact = await this.store.getContact(peerEmail);
            if (contact) { contact.avatar = parsed.avatarUpdate || undefined; await this.store.saveContact(contact); }
        }

        // Deduplication
        const msgId = parsed.rfc724mid || `msg-${parsed.uid}`;
        const existing = await this.store.getMessage(msgId);
        if (existing) {
            log.debug('sdk', `Skipping duplicate message ${msgId}`);
            return;
        }

        const isSelf = emailsEqual(parsed.from, this.credentials.email);
        let targetChatId: string;
        if (parsed.groupId) {
            targetChatId = parsed.groupId;
        } else {
            // For 1:1, if it's from us, it's addressed TO the peer (targetChatId is peerEmail)
            // Prefer the peer address we already opened a chat for (preserves bracket form).
            targetChatId = isSelf
                ? (parsed.to || '').toLowerCase()
                : peerEmail;
        }

        // Map parse viewtype → store type
        let storeType: StoredMessage['type'] = 'text';
        if (parsed.isEdit) storeType = 'edit';
        else if (parsed.isSticker) storeType = 'sticker';
        else if (parsed.isGif) storeType = 'gif';
        else if (parsed.isVoiceMessage) storeType = 'voice';
        else if (parsed.viewtype) {
            storeType = viewtypeToStoreType(parsed.viewtype) as StoredMessage['type'];
        } else if (parsed.attachments?.length) {
            storeType = 'file';
        }

        const att = parsed.attachments?.[0];
        // Apply chat ephemeral timer to new non-control messages
        const chatForTimer = await this.store.getChat(targetChatId);
        const timerSec = chatForTimer?.ephemeralTimer || 0;
        const isControl = storeType === 'edit' || parsed.isReaction || parsed.isDelete
            || parsed.isReadReceipt || parsed.isSecureJoin;
        const ephemeralExpiresAt = (!isControl && timerSec > 0)
            ? (parsed.timestamp || Date.now()) + timerSec * 1000
            : undefined;

        const msg: StoredMessage = {
            id: msgId,
            chatId: targetChatId,
            from: parsed.from,
            to: isSelf ? parsed.to : this.credentials.email,
            text: parsed.text,
            timestamp: parsed.timestamp,
            encrypted: parsed.encrypted,
            direction: isSelf ? 'outgoing' : 'incoming',
            type: storeType,
            inReplyTo: parsed.innerHeaders['in-reply-to'] || parsed.headers['in-reply-to'],
            state: 'sent',
            sentAt: parsed.timestamp,
            seenAt: isSelf ? parsed.timestamp : undefined,
            ephemeralExpiresAt,
            media: att ? {
                filename: att.filename,
                mimeType: att.mimeType,
                size: att.size,
                data: att.base64Data,
                durationMs: parsed.voiceDurationMs,
            } : undefined,
        };
        await this.store.saveMessage(msg);

        // Update chat summary
        const chatObj = await this.store.getChat(targetChatId);
        if (chatObj) {
            chatObj.lastMessage = (parsed.text || '').substring(0, 100);
            chatObj.lastMessageId = msg.id;
            // Always store ms so chatlist sort matches desktop (newest first)
            chatObj.lastMessageTime = msg.timestamp > 1e12 ? msg.timestamp : msg.timestamp * 1000;
            if (!isSelf) {
                chatObj.unreadCount++;
            }
            await this.store.saveChat(chatObj);
        } else if (!parsed.groupId) {
            // Ensure 1:1 chat exists
            await this.getOrCreateChat(targetChatId);
        }
    }


    async markChatRead(chatId: string): Promise<void> {
        const chat = await this.store.getChat(chatId);
        if (!chat) return;
        chat.unreadCount = 0;
        await this.store.saveChat(chat);

        // Mark all messages in this chat as seen + send wire read receipts
        const msgs = await this.store.getChatMessages(chatId, 1000, 0);
        const now = Date.now();
        for (const msg of msgs) {
            if (msg.direction === 'incoming' && msg.state !== 'seen') {
                msg.state = 'seen';
                msg.seenAt = now;
                await this.store.saveMessage(msg);
                // Send MDN to the sender (core-compatible multipart/report)
                try {
                    if (msg.from) {
                        await messagingLib.sendReadReceipt(this.ctx(), msg.from, msg.id);
                    }
                } catch (e: any) {
                    log.debug('sdk', `Read receipt failed for ${msg.id}: ${e.message}`);
                }
            }
        }
    }

    /** Mark a specific message as seen by the current user (or a peer in group) */
    async markMessageSeen(msgId: string, byEmail?: string): Promise<void> {
        const msg = await this.store.getMessage(msgId);
        if (!msg) return;
        const wasUnseen = msg.state !== 'seen';
        const now = Date.now();
        msg.state = 'seen';
        if (!msg.seenAt) msg.seenAt = now;

        if (byEmail) {
            if (!msg.seenBy) msg.seenBy = [];
            if (!msg.seenBy.find(s => s.email === byEmail)) {
                msg.seenBy.push({ email: byEmail, at: now });
            }
        }
        await this.store.saveMessage(msg);

        // Wire read receipt when we first mark an incoming message as seen
        if (wasUnseen && msg.direction === 'incoming' && !byEmail) {
            try {
                if (msg.from) {
                    await messagingLib.sendReadReceipt(this.ctx(), msg.from, msg.id);
                }
            } catch (e: any) {
                log.debug('sdk', `Read receipt failed for ${msg.id}: ${e.message}`);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════


    /** Apply an inbound read receipt to a stored outgoing message */
    protected async applyReadReceipt(originalMsgId: string, readerEmail: string, at: number): Promise<void> {
        const candidates = [
            originalMsgId,
            originalMsgId.startsWith('<') ? originalMsgId.slice(1, -1) : `<${originalMsgId}>`,
            originalMsgId.replace(/^<|>$/g, ''),
            `<${originalMsgId.replace(/^<|>$/g, '')}>`,
        ];
        let msg: StoredMessage | null = null;
        for (const id of candidates) {
            if (!id) continue;
            msg = (await this.store.getMessage(id)) || null;
            if (msg) break;
        }
        if (!msg) {
            log.debug('sdk', `Read receipt for unknown message ${originalMsgId}`);
            return;
        }
        if (msg.direction !== 'outgoing') {
            log.debug('sdk', `Ignoring MDN for non-outgoing message ${msg.id}`);
            return;
        }

        msg.state = 'seen';
        if (!msg.seenAt) msg.seenAt = at;
        if (!msg.seenBy) msg.seenBy = [];
        if (!msg.seenBy.find(s => s.email === readerEmail.toLowerCase())) {
            msg.seenBy.push({ email: readerEmail.toLowerCase(), at });
        }
        await this.store.saveMessage(msg);
        this.emit('DC_EVENT_MSG_READ', {
            event: 'DC_EVENT_MSG_READ',
            msgId: msg.id,
            chatId: msg.chatId,
            contactId: readerEmail.toLowerCase(),
            message: msg,
            data1: at,
        });
        this.emit('DC_EVENT_MSGS_CHANGED', {
            event: 'DC_EVENT_MSGS_CHANGED',
            msgId: msg.id,
            chatId: msg.chatId,
            message: msg,
        });
    }

}
