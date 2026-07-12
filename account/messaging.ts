/**
 * AccountMessaging — 1:1 outbound messages (text, media, reactions, …).
 */
import type { StoredMessage, StoredContact } from '../store.js';
import * as messagingLib from '../lib/messaging.js';
import * as groupLib from '../lib/group.js';
import { AccountContacts } from './contacts.js';

export abstract class AccountMessaging extends AccountContacts {
    /** Build and persist an outgoing message, returning the result */
    protected async persistOutgoing(toEmail: string, msgId: string, text: string, opts: Partial<StoredMessage> = {}): Promise<{ msgId: string; message: StoredMessage }> {
        const chatId = toEmail.toLowerCase();
        const now = Date.now();
        await this.getOrCreateChat(toEmail);
        const chat = await this.store.getChat(chatId);
        const timerSec = chat?.ephemeralTimer || 0;
        const peerHasKey = this.knownKeys.has(toEmail.toLowerCase());
        const message: StoredMessage = {
            id: msgId,
            chatId,
            from: this.credentials.email,
            to: toEmail,
            text,
            timestamp: now,
            // Only claim encryption when we actually have a peer key (matches send path).
            encrypted: peerHasKey && !!this.privateKey && !!this.publicKey,
            direction: 'outgoing',
            type: 'text',
            state: 'sent',
            sentAt: now,
            ephemeralExpiresAt: timerSec > 0 ? now + timerSec * 1000 : undefined,
            ...opts,
        };
        // opts may override ephemeralExpiresAt; re-apply if type is system
        if (message.type === 'system' || message.type === 'securejoin') {
            delete message.ephemeralExpiresAt;
        }
        await this.store.saveMessage(message);
        // Update chat summary + clear draft
        if (chat) {
            if (chat.draft) delete chat.draft;
            const safeText = text || '';
            chat.lastMessage = safeText.substring(0, 100);
            chat.lastMessageId = msgId;
            chat.lastMessageTime = now;
            await this.store.saveChat(chat);
        }
        return { msgId, message };
    }

    async sendMessage(contact: string | StoredContact, opts: { text: string; data?: string } | string): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const text = typeof opts === 'string' ? opts : opts.text;
        const data = typeof opts === 'string' ? undefined : opts.data;

        let msgId: string;
        if (data) {
            msgId = await messagingLib.sendImage(this.ctx(), toEmail, 'image.jpg', data, 'image/jpeg', text);
        } else {
            msgId = await messagingLib.sendTextMessage(this.ctx(), toEmail, text);
        }
        return this.persistOutgoing(toEmail, msgId, text, { type: data ? 'image' : 'text' });
    }
    protected resolveMsgId(msgOrId: string | StoredMessage): string {
        if (typeof msgOrId === 'object' && msgOrId.id) return msgOrId.id;
        return msgOrId as string;
    }

    async sendReply(contact: string | StoredContact, opts: {
        parentMessage: string | StoredMessage;
        text: string;
        quotedText?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const parentMsgId = this.resolveMsgId(opts.parentMessage);
        const msgId = await messagingLib.sendReply(this.ctx(), toEmail, parentMsgId, opts.text, opts.quotedText);
        return this.persistOutgoing(toEmail, msgId, opts.text, { inReplyTo: parentMsgId, quotedText: opts.quotedText });
    }

    async sendReaction(contact: string | StoredContact, opts: {
        targetMessage: string | StoredMessage;
        reaction: string;
    }): Promise<void> {
        const targetMsgId = this.resolveMsgId(opts.targetMessage);
        const toEmail = this.resolveEmail(contact);
        await messagingLib.sendReaction(this.ctx(), toEmail, targetMsgId, opts.reaction);

        // Persist locally
        const targetMsg = await this.store.getMessage(targetMsgId);
        if (targetMsg) {
            if (!targetMsg.reactions) targetMsg.reactions = [];
            // Remove previous reaction from same sender with same emoji (toggle) or just add
            // Actually usually reactions are stored as a list.
            targetMsg.reactions.push({ reaction: opts.reaction, from: this.credentials.email, at: Date.now() });
            await this.store.saveMessage(targetMsg);
            this.emit('DC_EVENT_REACTIONS_CHANGED', {
                event: 'DC_EVENT_REACTIONS_CHANGED',
                chatId: targetMsg.chatId,
                msgId: targetMsgId,
                message: targetMsg,
            });
        }
    }

    async sendDelete(contact: string | StoredContact, opts: {
        targetMessage: string | StoredMessage;
    }): Promise<void> {
        const targetMsgId = this.resolveMsgId(opts.targetMessage);
        await messagingLib.sendDelete(this.ctx(), this.resolveEmail(contact), targetMsgId);
        await this.store.deleteMessage(targetMsgId);
    }

    async sendEdit(contact: string | StoredContact, opts: {
        targetMessage: string | StoredMessage;
        newText: string;
    }): Promise<void> {
        const targetMsgId = this.resolveMsgId(opts.targetMessage);
        await messagingLib.sendEdit(this.ctx(), this.resolveEmail(contact), targetMsgId, opts.newText);
        const existing = await this.store.getMessage(targetMsgId);
        if (existing) {
            existing.text = opts.newText;
            await this.store.saveMessage(existing);
        }
    }

    async sendFile(contact: string | StoredContact, opts: {
        filename: string;
        data: string;
        mimeType: string;
        caption?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendFile(this.ctx(), toEmail, opts.filename, opts.data, opts.mimeType, opts.caption || '');
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.filename, { type: 'file', media: { filename: opts.filename, mimeType: opts.mimeType } });
    }

    async sendImage(contact: string | StoredContact, opts: {
        filename: string;
        data: string;
        mimeType?: string;
        caption?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const mime = opts.mimeType || 'image/jpeg';
        if (mime.toLowerCase() === 'image/gif') {
            return this.sendGif(contact, { data: opts.data, filename: opts.filename, caption: opts.caption });
        }
        const msgId = await messagingLib.sendImage(this.ctx(), toEmail, opts.filename, opts.data, mime, opts.caption || '');
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.filename, { type: 'image', media: { filename: opts.filename, mimeType: mime } });
    }

    async sendSticker(contact: string | StoredContact, opts: {
        data: string;
        mimeType?: string;
        filename?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const mimeType = opts.mimeType || 'image/webp';
        const filename = opts.filename || 'sticker.webp';
        const msgId = await messagingLib.sendSticker(this.ctx(), toEmail, opts.data, mimeType, filename);
        return this.persistOutgoing(toEmail, msgId, '', {
            type: 'sticker',
            media: { filename, mimeType, data: opts.data },
        });
    }

    async sendGif(contact: string | StoredContact, opts: {
        data: string;
        filename?: string;
        caption?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const filename = opts.filename || 'image.gif';
        const msgId = await messagingLib.sendGif(this.ctx(), toEmail, opts.data, filename, opts.caption || '');
        return this.persistOutgoing(toEmail, msgId, opts.caption || filename, {
            type: 'gif',
            media: { filename, mimeType: 'image/gif', data: opts.data },
        });
    }

    async sendVideo(contact: string | StoredContact, opts: {
        filename: string;
        data: string;
        mimeType?: string;
        caption?: string;
        durationMs?: number;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendVideo(this.ctx(), toEmail, opts.filename, opts.data, opts.mimeType || 'video/mp4', opts.caption || '', opts.durationMs || 0);
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.filename, { type: 'video', media: { filename: opts.filename, mimeType: opts.mimeType || 'video/mp4', durationMs: opts.durationMs } });
    }

    async sendAudio(contact: string | StoredContact, opts: {
        filename: string;
        data: string;
        mimeType?: string;
        caption?: string;
        durationMs?: number;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendAudio(this.ctx(), toEmail, opts.filename, opts.data, opts.mimeType || 'audio/mpeg', opts.caption || '', opts.durationMs || 0);
        return this.persistOutgoing(toEmail, msgId, opts.caption || opts.filename, { type: 'audio', media: { filename: opts.filename, mimeType: opts.mimeType || 'audio/mpeg', durationMs: opts.durationMs } });
    }

    async sendVoice(contact: string | StoredContact, opts: {
        data: string;
        durationMs?: number;
        mimeType?: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const msgId = await messagingLib.sendVoice(this.ctx(), toEmail, opts.data, opts.durationMs || 0, opts.mimeType || 'audio/ogg');
        return this.persistOutgoing(toEmail, msgId, '[voice message]', { type: 'voice', media: { mimeType: opts.mimeType || 'audio/ogg', durationMs: opts.durationMs } });
    }

    async forwardMessage(contact: string | StoredContact, opts: {
        originalMessage: string | StoredMessage;
        originalFrom: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const originalText = typeof opts.originalMessage === 'object' ? opts.originalMessage.text : opts.originalMessage;
        const msgId = await messagingLib.forwardMessage(this.ctx(), toEmail, originalText, opts.originalFrom);
        return this.persistOutgoing(toEmail, msgId, originalText);
    }

    async resendMessage(contact: string | StoredContact, opts: {
        originalMessage: string | StoredMessage;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const toEmail = this.resolveEmail(contact);
        const originalText = typeof opts.originalMessage === 'object' ? opts.originalMessage.text : opts.originalMessage;
        const msgId = await groupLib.resendMessage(this.ctx(), toEmail, originalText);
        return this.persistOutgoing(toEmail, msgId, originalText);
    }

    // ═══════════════════════════════════════════════════════════════════════
}
