/**
 * AccountGroups — group/channel ops and the unified send() API.
 */
import type { StoredMessage, StoredContact } from '../store.js';
import * as groupLib from '../lib/group.js';
import { AccountMessaging } from './messaging.js';

export abstract class AccountGroups extends AccountMessaging {
    // GROUPS & BROADCASTS (delegated to lib/group.ts)
    // ═══════════════════════════════════════════════════════════════════════

    /** Resolve an array of contact IDs / objects to emails */
    protected resolveEmails(members: (string | StoredContact)[]): string[] {
        return members.map(m => this.resolveEmail(m));
    }

    /** Resolve a group ID string or GroupInfo object to a full GroupInfo */
    protected resolveGroup(groupOrId: string | groupLib.GroupInfo): groupLib.GroupInfo {
        if (typeof groupOrId === 'object' && groupOrId.grpId) return groupOrId;
        const g = this.groups.get(groupOrId as string);
        if (!g) throw new Error(`Group not found: ${groupOrId}. Create or join a group first.`);
        return g;
    }

    /** Register a group in the local registry and persist chat + account snapshot */
    protected registerGroup(group: groupLib.GroupInfo): groupLib.GroupInfo {
        this.groups.set(group.grpId, group);
        void this.persistGroupChat(group);
        this.schedulePersist();
        return group;
    }

    /** Mirror group metadata into the chat store (name, broadcast flag). */
    private async persistGroupChat(group: groupLib.GroupInfo): Promise<void> {
        let chat = await this.store.getChat(group.grpId);
        if (!chat) {
            chat = {
                id: group.grpId,
                name: group.name,
                peerEmail: '',
                isGroup: true,
                isBroadcast: group.type === 'broadcast',
                unreadCount: 0,
                archived: false,
                pinned: false,
                muted: false,
            };
        } else {
            chat.name = group.name;
            chat.isGroup = true;
            chat.isBroadcast = group.type === 'broadcast';
        }
        await this.store.saveChat(chat);
    }

    /** Get a group by ID */
    getGroup(groupId: string): groupLib.GroupInfo | undefined {
        return this.groups.get(groupId);
    }

    /** List all known groups */
    listGroups(): groupLib.GroupInfo[] {
        return [...this.groups.values()];
    }

    async createGroup(opts: {
        name: string;
        members?: (string | StoredContact)[];
        type?: 'group' | 'broadcast';
    }): Promise<groupLib.GroupInfo> {
        const group = await groupLib.createGroup(this.ctx(), opts.name, this.resolveEmails(opts.members || []), opts.type || 'group');
        return this.registerGroup(group);
    }

    async createChannel(opts: {
        name: string;
        description?: string;
        initialMembers?: (string | StoredContact)[];
    }): Promise<groupLib.GroupInfo> {
        const channel = await groupLib.createChannel(this.ctx(), opts.name, opts.description, this.resolveEmails(opts.initialMembers || []));
        return this.registerGroup(channel);
    }
    async joinGroup(uri: string): Promise<{ peerEmail: string; verified: boolean; groupInfo?: Partial<groupLib.GroupInfo> }> {
        const result = await groupLib.joinGroup(this.ctx(), uri);
        // Register group if we got full info
        if (result.groupInfo?.grpId && result.groupInfo.name && result.groupInfo.members) {
            this.registerGroup(result.groupInfo as groupLib.GroupInfo);
        }
        return result;
    }

    async sendGroupMessage(group: string | groupLib.GroupInfo, opts: {
        text: string;
        data?: string;
        mimeType?: string;
        filename?: string;
        type?: StoredMessage['type'];
        disposition?: 'attachment' | 'inline';
        extraHeaders?: string[];
        media?: StoredMessage['media'];
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const mediaOpts = opts.data ? {
            mimeType: opts.mimeType,
            filename: opts.filename,
            disposition: opts.disposition,
            extraHeaders: opts.extraHeaders,
        } : undefined;
        const msgId = await groupLib.sendGroupMessage(this.ctx(), g, opts.text, opts.data, mediaOpts);
        const type = opts.type || (opts.data ? 'image' : 'text');
        return this.persistOutgoing(g.grpId, msgId, opts.text, {
            type,
            media: opts.media || (opts.data ? {
                filename: opts.filename,
                mimeType: opts.mimeType,
                data: opts.data,
            } : undefined),
        });
    }

    async sendBroadcast(group: string | groupLib.GroupInfo, opts: {
        text: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const msgId = await groupLib.sendBroadcast(this.ctx(), g, opts.text);
        return this.persistOutgoing(g.grpId, msgId, opts.text, { type: 'text' });
    }

    async addGroupMember(group: string | groupLib.GroupInfo, opts: {
        email: string | StoredContact;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const email = this.resolveEmail(opts.email);
        const msgId = this.ctx().generateMsgId();
        await groupLib.sendGroupMemberAdded(this.ctx(), g, email);
        if (!g.members.includes(email)) g.members.push(email);
        this.schedulePersist();
        return this.persistOutgoing(g.grpId, msgId, `Member ${email} added.`, { type: 'system' });
    }
    async removeGroupMember(group: string | groupLib.GroupInfo, opts: {
        email: string | StoredContact;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const email = this.resolveEmail(opts.email);
        const msgId = this.ctx().generateMsgId();
        await groupLib.sendGroupMemberRemoved(this.ctx(), g, email);
        g.members = g.members.filter(m => m !== email);
        this.schedulePersist();
        return this.persistOutgoing(g.grpId, msgId, `Member ${email} removed.`, { type: 'system' });
    }
    async renameGroup(group: string | groupLib.GroupInfo, opts: {
        newName: string;
    }): Promise<{ msgId: string; message: StoredMessage }> {
        const g = this.resolveGroup(group);
        const msgId = this.ctx().generateMsgId();
        await groupLib.renameGroup(this.ctx(), g, opts.newName);
        g.name = opts.newName;
        void this.persistGroupChat(g);
        this.schedulePersist();
        return this.persistOutgoing(g.grpId, msgId, `Group name changed to ${opts.newName}.`, { type: 'system' });
    }
    async updateGroupDescription(group: string | groupLib.GroupInfo, opts: { newDescription: string }): Promise<void> {
        const g = this.resolveGroup(group);
        await groupLib.updateGroupDescription(this.ctx(), g, opts.newDescription);
        g.description = opts.newDescription;
        this.schedulePersist();
    }
    async leaveGroup(group: string | groupLib.GroupInfo): Promise<void> {
        const g = this.resolveGroup(group);
        await groupLib.leaveGroup(this.ctx(), g);
        this.groups.delete(g.grpId);
        this.schedulePersist();
    }


    // ═══════════════════════════════════════════════════════════════════════


    // ═══════════════════════════════════════════════════════════════════════
    // UNIFIED send() — accepts any target + message descriptor
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Universal send method.
     *
     * Target can be: contactId, StoredContact, groupId, or GroupInfo.
     *
     * The payload describes the message type. Only one of the message-type
     * fields should be set. If multiple are set, priority is:
     * delete > edit > reaction > forward > voice > audio > video > image > file > text
     *
     * @example
     * ```ts
     * // Text
     * await acc.send(bob, { text: 'Hello!' });
     *
     * // Image
     * await acc.send(bob, { image: { data: b64, filename: 'pic.jpg' } });
     *
     * // Reply to a message
     * await acc.send(bob, { text: 'I agree!', replyTo: originalMsg });
     *
     * // React
     * await acc.send(bob, { reaction: { targetMessage: msg, emoji: '👍' } });
     *
     * // Send to a group
     * await acc.send(group, { text: 'Hello group!' });
     * await acc.send(groupId, { text: 'By ID!' });
     * ```
     */
    async send(
        target: string | StoredContact | groupLib.GroupInfo,
        payload: {
            // ── Message types (pick one) ──
            text?: string;
            image?: { data: string; filename?: string; mimeType?: string; caption?: string };
            file?: { data: string; filename: string; mimeType: string; caption?: string };
            video?: { data: string; filename?: string; mimeType?: string; caption?: string; durationMs?: number };
            audio?: { data: string; filename?: string; mimeType?: string; caption?: string; durationMs?: number };
            voice?: { data: string; durationMs?: number; mimeType?: string };
            sticker?: { data: string; mimeType?: string; filename?: string };
            gif?: { data: string; filename?: string; caption?: string };
            // ── Modifiers ──
            replyTo?: string | StoredMessage;
            quotedText?: string;
            // ── Actions on existing messages ──
            reaction?: { targetMessage: string | StoredMessage; reaction: string };
            edit?: { targetMessage: string | StoredMessage; newText: string };
            delete?: { targetMessage: string | StoredMessage };
            forward?: { originalMessage: string | StoredMessage; originalFrom: string };
        },
    ): Promise<{ msgId: string; message: StoredMessage } | void> {

        // ── Detect target type ──
        const isGroup = this.isGroupTarget(target);

        // Block 1:1 sends to blocked contacts
        if (!isGroup) {
            try {
                const email = this.resolveEmail(target as string | StoredContact);
                if (this.isBlocked(email)) {
                    throw new Error(`Cannot send to blocked contact ${email}`);
                }
            } catch (e: any) {
                if (e.message?.startsWith('Cannot send to blocked')) throw e;
                // resolveEmail may fail for raw emails not in contact map — check directly
                if (typeof target === 'string' && target.includes('@') && this.isBlocked(target)) {
                    throw new Error(`Cannot send to blocked contact ${target}`);
                }
            }
        }

        // ── Helper: apply replyTo to a just-sent result ──
        const applyReplyTo = async (result: { msgId: string; message: StoredMessage }) => {
            if (payload.replyTo) {
                const parentMsgId = this.resolveMsgId(payload.replyTo);
                result.message.inReplyTo = parentMsgId;
                if (payload.quotedText) result.message.quotedText = payload.quotedText;
                await this.store.saveMessage(result.message);
            }
            return result;
        };

        // ── Actions (1:1 or group) ──
        if (payload.delete) {
            if (isGroup) {
                const group = this.resolveGroup(target as string | groupLib.GroupInfo);
                const targetMsgId = this.resolveMsgId(payload.delete.targetMessage);
                await groupLib.sendGroupDelete(this.ctx(), group, targetMsgId);
                const existing = await this.store.getMessage(targetMsgId);
                if (existing) {
                    await this.store.deleteMessage(targetMsgId);
                    this.emit('DC_EVENT_MSG_DELETED', { event: 'DC_EVENT_MSG_DELETED', chatId: group.grpId, msgId: targetMsgId });
                }
                return;
            }
            return this.sendDelete(target as string | StoredContact, payload.delete);
        }
        if (payload.edit) {
            if (isGroup) {
                const group = this.resolveGroup(target as string | groupLib.GroupInfo);
                const targetMsgId = this.resolveMsgId(payload.edit.targetMessage);
                await groupLib.sendGroupEdit(this.ctx(), group, targetMsgId, payload.edit.newText);
                const existing = await this.store.getMessage(targetMsgId);
                if (existing) {
                    existing.text = payload.edit.newText;
                    await this.store.saveMessage(existing);
                    this.emit('DC_EVENT_MSGS_CHANGED', { event: 'DC_EVENT_MSGS_CHANGED', chatId: group.grpId, msgId: targetMsgId, message: existing });
                }
                return;
            }
            return this.sendEdit(target as string | StoredContact, payload.edit);
        }
        if (payload.reaction) {
            if (isGroup) {
                const group = this.resolveGroup(target as string | groupLib.GroupInfo);
                const targetMsgId = this.resolveMsgId(payload.reaction.targetMessage);
                await groupLib.sendGroupReaction(this.ctx(), group, targetMsgId, payload.reaction.reaction);
                const targetMsg = await this.store.getMessage(targetMsgId);
                if (targetMsg) {
                    if (!targetMsg.reactions) targetMsg.reactions = [];
                    targetMsg.reactions.push({ reaction: payload.reaction.reaction, from: this.credentials.email, at: Date.now() });
                    await this.store.saveMessage(targetMsg);
                    this.emit('DC_EVENT_REACTIONS_CHANGED', { event: 'DC_EVENT_REACTIONS_CHANGED', chatId: group.grpId, msgId: targetMsgId, message: targetMsg });
                }
                return;
            }
            return this.sendReaction(target as string | StoredContact, payload.reaction);
        }
        if (payload.forward) {
            if (isGroup) {
                const group = this.resolveGroup(target as string | groupLib.GroupInfo);
                const originalText = typeof payload.forward.originalMessage === 'string'
                    ? (await this.store.getMessage(payload.forward.originalMessage))?.text || ''
                    : payload.forward.originalMessage.text;
                const fwdText = `---------- Forwarded message ----------\r\nFrom: ${payload.forward.originalFrom}\r\n\r\n${originalText}`;
                const msgId = await groupLib.sendGroupForward(
                    this.ctx(),
                    group,
                    originalText,
                    payload.forward.originalFrom,
                );
                return applyReplyTo(await this.persistOutgoing(group.grpId, msgId, fwdText, { type: 'text' }));
            }
            return this.forwardMessage(target as string | StoredContact, payload.forward);
        }

        // ── Group target → route to group messaging ──
        if (isGroup) {
            const group = this.resolveGroup(target as string | groupLib.GroupInfo);
            // Stickers / GIFs
            if (payload.sticker) {
                return applyReplyTo(await this.sendGroupMessage(group, {
                    text: '',
                    data: payload.sticker.data,
                    mimeType: payload.sticker.mimeType || 'image/webp',
                    filename: payload.sticker.filename || 'sticker.webp',
                    type: 'sticker',
                    disposition: 'attachment',
                    extraHeaders: ['Chat-Content: sticker'],
                }));
            }
            if (payload.gif) {
                return applyReplyTo(await this.sendGroupMessage(group, {
                    text: payload.gif.caption || '',
                    data: payload.gif.data,
                    mimeType: 'image/gif',
                    filename: payload.gif.filename || 'image.gif',
                    type: 'gif',
                    disposition: 'attachment',
                    extraHeaders: ['Chat-Content: gif'],
                }));
            }
            // Media support for groups (proper MIME types)
            if (payload.image) {
                const mime = payload.image.mimeType || 'image/jpeg';
                const isGifImage = mime.toLowerCase() === 'image/gif';
                return applyReplyTo(await this.sendGroupMessage(group, {
                    text: payload.image.caption || '',
                    data: payload.image.data,
                    mimeType: mime,
                    filename: payload.image.filename || (isGifImage ? 'image.gif' : 'image.jpg'),
                    type: isGifImage ? 'gif' : 'image',
                    extraHeaders: isGifImage ? ['Chat-Content: gif'] : undefined,
                }));
            }
            if (payload.video) {
                const extra: string[] = [];
                if (payload.video.durationMs) extra.push(`Chat-Duration: ${payload.video.durationMs}`);
                return applyReplyTo(await this.sendGroupMessage(group, {
                    text: payload.video.caption || '',
                    data: payload.video.data,
                    mimeType: payload.video.mimeType || 'video/mp4',
                    filename: payload.video.filename || 'video.mp4',
                    type: 'video',
                    extraHeaders: extra,
                    media: { durationMs: payload.video.durationMs },
                }));
            }
            if (payload.audio) {
                const extra: string[] = [];
                if (payload.audio.durationMs) extra.push(`Chat-Duration: ${payload.audio.durationMs}`);
                return applyReplyTo(await this.sendGroupMessage(group, {
                    text: payload.audio.caption || '',
                    data: payload.audio.data,
                    mimeType: payload.audio.mimeType || 'audio/mpeg',
                    filename: payload.audio.filename || 'audio',
                    type: 'audio',
                    extraHeaders: extra,
                    media: { durationMs: payload.audio.durationMs },
                }));
            }
            if (payload.voice) {
                const extra = ['Chat-Voice-Message: 1'];
                if (payload.voice.durationMs) extra.push(`Chat-Duration: ${payload.voice.durationMs}`);
                return applyReplyTo(await this.sendGroupMessage(group, {
                    text: 'Voice message',
                    data: payload.voice.data,
                    mimeType: payload.voice.mimeType || 'audio/ogg',
                    filename: 'voice-message.ogg',
                    type: 'voice',
                    disposition: 'attachment',
                    extraHeaders: extra,
                    media: { durationMs: payload.voice.durationMs },
                }));
            }
            if (payload.file) {
                return applyReplyTo(await this.sendGroupMessage(group, {
                    text: payload.file.caption || '',
                    data: payload.file.data,
                    mimeType: payload.file.mimeType,
                    filename: payload.file.filename,
                    type: 'file',
                    disposition: 'attachment',
                }));
            }

            // Default to text
            if (group.type === 'broadcast') {
                return applyReplyTo(await this.sendBroadcast(group, { text: payload.text || '' }));
            }
            return applyReplyTo(await this.sendGroupMessage(group, { text: payload.text || '' }));
        }

        // ── Contact target → route to contact messaging ──
        const contact = target as string | StoredContact;

        // Media types (priority order)
        if (payload.sticker) {
            return applyReplyTo(await this.sendSticker(contact, payload.sticker));
        }
        if (payload.gif) {
            return applyReplyTo(await this.sendGif(contact, payload.gif));
        }
        if (payload.voice) {
            return applyReplyTo(await this.sendVoice(contact, payload.voice));
        }
        if (payload.audio) {
            return applyReplyTo(await this.sendAudio(contact, {
                filename: payload.audio.filename || 'audio',
                data: payload.audio.data,
                mimeType: payload.audio.mimeType,
                caption: payload.audio.caption,
                durationMs: payload.audio.durationMs,
            }));
        }
        if (payload.video) {
            return applyReplyTo(await this.sendVideo(contact, {
                filename: payload.video.filename || 'video.mp4',
                data: payload.video.data,
                mimeType: payload.video.mimeType,
                caption: payload.video.caption,
                durationMs: payload.video.durationMs,
            }));
        }
        if (payload.image) {
            return applyReplyTo(await this.sendImage(contact, {
                filename: payload.image.filename || 'image.jpg',
                data: payload.image.data,
                mimeType: payload.image.mimeType,
                caption: payload.image.caption,
            }));
        }
        if (payload.file) {
            return applyReplyTo(await this.sendFile(contact, payload.file));
        }

        // Text (with optional reply)
        const text = payload.text || '';
        if (payload.replyTo) {
            return this.sendReply(contact, {
                parentMessage: payload.replyTo,
                text,
                quotedText: payload.quotedText,
            });
        }

        return this.sendMessage(contact, text);
    }

    /** Check if a target is a group (GroupInfo object or a registered group ID) */
    protected isGroupTarget(target: string | StoredContact | groupLib.GroupInfo): boolean {
        if (typeof target === 'object' && 'grpId' in target) return true;
        if (typeof target === 'string' && this.groups.has(target)) return true;
        return false;
    }

    /** Resolve a target to GroupInfo (only call if isGroupTarget returned true) */
    protected resolveGroupTarget(target: string | StoredContact | groupLib.GroupInfo): groupLib.GroupInfo {
        if (typeof target === 'object' && 'grpId' in target) return target;
        return this.groups.get(target as string)!;
    }

    /** Resolve a message ID from either a string or a StoredMessage object */

}
