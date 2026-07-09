/**
 * lib/group.ts — Group chat and broadcast channel support
 *
 * Implements the Delta Chat group protocol headers:
 *   - Chat-Group-ID: unique group identifier
 *   - Chat-Group-Name: display name of the group
 *   - Chat-Group-Member-Added: email of added member
 *   - Chat-Group-Member-Removed: email of removed member
 *   - Chat-Group-Name-Changed: old name (for rename)
 *   - Chat-Group-Avatar: "0" for avatar removal
 *
 * Groups: encrypted multipart messages sent to all members
 * Broadcasts: one-way channels where only the creator can send
 */

import type { SDKContext } from './context';
import * as cryptoLib from './crypto';
import * as openpgp from 'openpgp';
import * as sj from './securejoin';
import { log } from './logger';
import {
    buildFromHeader,
    buildInnerMultipart,
    buildInnerText,
    buildPgpMimeEnvelope,
} from './mime-build';

const crypto = globalThis.crypto;

function generateId(): string {
    const bytes = new Uint8Array(18);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateBroadcastSecret(): string {
    const bytes = new Uint8Array(33);
    crypto.getRandomValues(bytes);
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '').substring(0, 43);
}

// ─── Types ──────────────────────────────────────────────────────────────────────

export interface GroupInfo {
    /** Unique group ID (random string) */
    grpId: string;
    /** Display name */
    name: string;
    /** Group description (for channels) */
    description?: string;
    /** Member emails (including self) */
    members: string[];
    /** 'group' or 'broadcast' */
    type: 'group' | 'broadcast';
    /** Shared secret for broadcast channels (random string) */
    broadcastSecret?: string;
}

// ─── Create Group ───────────────────────────────────────────────────────────────

/** Create a new group chat and send the initial member-added messages */
export async function createGroup(
    ctx: SDKContext,
    name: string,
    memberEmails: string[],
    type: 'group' | 'broadcast' = 'group'
): Promise<GroupInfo> {
    const grpId = generateId();
    const allMembers = [ctx.credentials.email.toLowerCase(), ...memberEmails.map(m => m.toLowerCase()).filter(
        e => e !== ctx.credentials.email.toLowerCase()
    )];

    const group: GroupInfo = { grpId, name, members: allMembers, type };
    if (type === 'broadcast') {
        group.broadcastSecret = generateBroadcastSecret();
    }

    // Send a member-added message for each member
    for (const member of memberEmails) {
        await sendGroupMemberAdded(ctx, group, member);
    }

    return group;
}

/** Create a new broadcast channel with a description */
export async function createChannel(
    ctx: SDKContext,
    name: string,
    description?: string,
    initialMembers: string[] = []
): Promise<GroupInfo> {
    const group = await createGroup(ctx, name, initialMembers, 'broadcast');
    if (description) {
        group.description = description;
        await updateGroupDescription(ctx, group, description);
    }
    return group;
}

// ─── Group fan-out ──────────────────────────────────────────────────────────────

export interface GroupSendContext {
    recipient: string;
    toList: string;
    listId: string;
    fromHeader: string;
    gossipHeaders: string[];
    isBroadcast: boolean;
    group: GroupInfo;
}

export interface SendToGroupMembersOptions {
    /** Pre-generated Message-ID (shared across all recipients) */
    msgId?: string;
    subject?: string;
    /** Extra outer headers beyond standard group headers */
    outerHeaders?: string[];
    /**
     * Build protected inner MIME for one recipient.
     * Must include group headers, From/To, gossip, and body.
     */
    buildInner: (args: GroupSendContext) => string;
}

/**
 * Encrypt and send the same logical message to every group member (except self).
 * Returns the shared Message-ID. Skips members without keys (logs a warning).
 */
export async function sendToGroupMembers(
    ctx: SDKContext,
    group: GroupInfo,
    opts: SendToGroupMembersOptions,
): Promise<string> {
    const msgId = opts.msgId || ctx.generateMsgId();
    const now = new Date().toUTCString();
    const fromHeader = buildFromHeader(ctx);

    const recipients = group.members.filter(
        e => e.toLowerCase() !== ctx.credentials.email.toLowerCase()
    );

    if (recipients.length === 0) {
        throw new Error('No recipients in group');
    }

    const domain = ctx.credentials.email.split('@')[1];
    const listId = `${group.grpId}@${domain}`;
    const isBroadcast = group.type === 'broadcast';
    const toList = isBroadcast ? 'undisclosed-recipients:;' : buildToList(group.members);

    const groupOuterHeaders = [
        `Chat-Group-ID: ${group.grpId}`,
        `Chat-List-Id: ${listId}`,
        `Chat-Group-Name: ${group.name}`,
        ...(isBroadcast ? [`Chat-Group-Is-Broadcast: 1`] : []),
        ...(opts.outerHeaders || []),
    ];

    let sent = 0;
    for (const recipient of recipients) {
        const peerKey = ctx.knownKeys.get(recipient.toLowerCase());
        if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
            log.warn('group', `No key for ${recipient}, skipping`);
            continue;
        }

        const gossipHeaders = isBroadcast ? [] : buildGossipHeaders(ctx, group.members, recipient);
        const innerMime = opts.buildInner({
            recipient,
            toList,
            listId,
            fromHeader,
            gossipHeaders,
            isBroadcast,
            group,
        });

        const armored = await ctx.encryptRaw(innerMime, peerKey);
        const rawEmail = buildPgpMimeEnvelope({
            fromHeader,
            toHeader: toList,
            msgId,
            date: now,
            subject: opts.subject ?? group.name,
            outerHeaders: groupOuterHeaders,
            autocryptHeader: ctx.buildAutocryptHeader(),
            armored,
        });

        await ctx.sendRaw(ctx.credentials.email, [recipient], rawEmail);
        sent++;
    }

    log.info('group', `Fan-out to "${group.name}" (${sent}/${recipients.length} members) [${msgId}]`);
    return msgId;
}

/** Standard protected group headers for an inner MIME payload */
export function groupInnerHeaders(args: GroupSendContext, extra: string[] = []): string[] {
    return [
        `Chat-Version: 1.0`,
        `Chat-Group-ID: ${args.group.grpId}`,
        `Chat-List-Id: ${args.listId}`,
        `Chat-Group-Name: ${args.group.name}`,
        ...(args.isBroadcast ? [`Chat-Group-Is-Broadcast: 1`] : []),
        args.fromHeader,
        `To: ${args.toList}`,
        ...args.gossipHeaders,
        ...extra,
    ];
}

// ─── Send Group Message ─────────────────────────────────────────────────────────

export interface GroupMediaOptions {
    mimeType?: string;
    filename?: string;
    disposition?: 'attachment' | 'inline';
    /** Extra inner headers (e.g. Chat-Duration, Chat-Voice-Message) */
    extraHeaders?: string[];
}

/** Send an encrypted text (or media) message to all members of a group */
export async function sendGroupMessage(
    ctx: SDKContext,
    group: GroupInfo,
    text: string,
    base64Data?: string,
    media?: GroupMediaOptions,
): Promise<string> {
    const mimeType = media?.mimeType || 'image/jpeg';
    const filename = media?.filename || 'image.jpg';
    const disposition = media?.disposition || 'inline';
    const extraInner = media?.extraHeaders || [];

    const msgId = await sendToGroupMembers(ctx, group, {
        buildInner: (args) => {
            if (base64Data) {
                return buildInnerMultipart({
                    headers: groupInnerHeaders(args, extraInner),
                    text,
                    parts: [{
                        mimeType,
                        filename,
                        base64: base64Data,
                        disposition,
                        foldBase64: true,
                    }],
                    foldBase64: (b64) => ctx.foldBase64(b64),
                });
            }
            return buildInnerText(
                [
                    `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                    ...groupInnerHeaders(args, extraInner),
                ],
                text,
            );
        },
    });

    log.info('group', `Sent group message to "${group.name}" [${msgId}]`);
    return msgId;
}

// ─── Group message actions ──────────────────────────────────────────────────────

/** Send a reaction to all group members (RFC 9078 + group headers) */
export async function sendGroupReaction(
    ctx: SDKContext,
    group: GroupInfo,
    targetMsgId: string,
    emoji: string,
): Promise<string> {
    const msgId = await sendToGroupMembers(ctx, group, {
        outerHeaders: [`In-Reply-To: ${targetMsgId}`],
        buildInner: (args) => buildInnerText(
            [
                `Content-Disposition: reaction`,
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                ...groupInnerHeaders(args, [`In-Reply-To: ${targetMsgId}`]),
            ],
            emoji,
        ),
    });
    log.info('group', `Sent reaction ${emoji} in "${group.name}" → ${targetMsgId}`);
    return msgId;
}

/** Send delete-for-everyone to all group members */
export async function sendGroupDelete(
    ctx: SDKContext,
    group: GroupInfo,
    targetMsgId: string,
): Promise<string> {
    const msgId = await sendToGroupMembers(ctx, group, {
        buildInner: (args) => buildInnerText(
            [
                `Chat-Delete: ${targetMsgId}`,
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                ...groupInnerHeaders(args),
            ],
            '🚮',
        ),
    });
    log.info('group', `Sent delete for ${targetMsgId} in "${group.name}"`);
    return msgId;
}

/** Send edit request to all group members */
export async function sendGroupEdit(
    ctx: SDKContext,
    group: GroupInfo,
    targetMsgId: string,
    newText: string,
): Promise<string> {
    const msgId = await sendToGroupMembers(ctx, group, {
        outerHeaders: [`Chat-Edit: ${targetMsgId}`],
        buildInner: (args) => buildInnerText(
            [
                `Chat-Edit: ${targetMsgId}`,
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                ...groupInnerHeaders(args),
            ],
            newText,
        ),
    });
    log.info('group', `Sent edit for ${targetMsgId} in "${group.name}"`);
    return msgId;
}

/** Forward text into a group (same prefix as core forward_msgs) */
export async function sendGroupForward(
    ctx: SDKContext,
    group: GroupInfo,
    originalText: string,
    originalFrom: string,
): Promise<string> {
    const fwdText = `---------- Forwarded message ----------\r\nFrom: ${originalFrom}\r\n\r\n${originalText}`;
    return sendGroupMessage(ctx, group, fwdText);
}

/**
 * Set or clear group/channel avatar for all members.
 * Wire: Chat-Group-Avatar: base64:…  or  Chat-Group-Avatar: 0  (remove)
 */
export async function sendGroupAvatar(
    ctx: SDKContext,
    group: GroupInfo,
    opts: { data?: string; mimeType?: string; remove?: boolean },
): Promise<string> {
    const avatarHeader = opts.remove || !opts.data
        ? 'Chat-Group-Avatar: 0'
        : `Chat-Group-Avatar: base64:${opts.data.replace(/\s/g, '')}`;

    const msgId = await sendToGroupMembers(ctx, group, {
        outerHeaders: [avatarHeader],
        buildInner: (args) => buildInnerText(
            [
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                ...groupInnerHeaders(args, [avatarHeader]),
            ],
            opts.remove || !opts.data ? 'Group avatar removed.' : 'Group avatar updated.',
        ),
    });
    log.info('group', `Sent group avatar update for "${group.name}"`);
    return msgId;
}

/**
 * Propagate ephemeral timer (seconds) to all group members.
 * Wire: Chat-Ephemeral-Timer: <seconds>  (0 = off)
 */
export async function sendGroupEphemeralTimer(
    ctx: SDKContext,
    group: GroupInfo,
    seconds: number,
): Promise<string> {
    const header = `Chat-Ephemeral-Timer: ${Math.max(0, Math.floor(seconds))}`;
    const msgId = await sendToGroupMembers(ctx, group, {
        outerHeaders: [header],
        buildInner: (args) => buildInnerText(
            [
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                ...groupInnerHeaders(args, [header]),
            ],
            seconds > 0
                ? `Disappearing messages set to ${seconds}s.`
                : 'Disappearing messages off.',
        ),
    });
    log.info('group', `Sent ephemeral timer ${seconds}s for "${group.name}"`);
    return msgId;
}

/** Extract a fingerprint from an armored PGP public key string */
async function getKeyFingerprint(armoredKey: string): Promise<string> {
    const key = await openpgp.readKey({ armoredKey });
    return key.getFingerprint().toUpperCase();
}

// ─── Add Member ─────────────────────────────────────────────────────────────────

/** Send a Chat-Group-Member-Added message to all group members */
export async function sendGroupMemberAdded(
    ctx: SDKContext,
    group: GroupInfo,
    addedEmail: string
): Promise<void> {
    // Add to local members list if not already there
    if (!group.members.map(m => m.toLowerCase()).includes(addedEmail.toLowerCase())) {
        group.members.push(addedEmail);
    }

    const recipients = group.members.filter(
        e => e.toLowerCase() !== ctx.credentials.email.toLowerCase()
    );


    for (const recipient of recipients) {
        const peerKey = ctx.knownKeys.get(recipient.toLowerCase());
        if (!peerKey || !ctx.privateKey || !ctx.publicKey) continue;

        // Extract fingerprint of the added member for Chat-Group-Member-Added-Fpr
        let fprHeader = '';
        const addedKey = ctx.knownKeys.get(addedEmail.toLowerCase());
        if (addedKey) {
            const fpr = await getKeyFingerprint(addedKey);
            fprHeader = `Chat-Group-Member-Added-Fpr: ${fpr}`;
        }

        const msgId = ctx.generateMsgId();

        const now = new Date().toUTCString();
        const fromHeader = ctx.displayName
            ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
            : `From: <${ctx.credentials.email}>`;

        const domain = ctx.credentials.email.split('@')[1];
        const listId = `${group.grpId}@${domain}`;
        const isBroadcast = group.type === 'broadcast';
        const toList = isBroadcast ? 'undisclosed-recipients:;' : buildToList(group.members);
        const gossipHeaders = isBroadcast ? [] : buildGossipHeaders(ctx, group.members, recipient);
        const broadcastSecretHeader = isBroadcast && group.broadcastSecret ? [`Chat-Broadcast-Secret: ${group.broadcastSecret}`] : [];


        const innerMime = [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            `Chat-Version: 1.0`,
            `Chat-Group-ID: ${group.grpId}`,
            `Chat-List-Id: ${listId}`,
            `Chat-Group-Name: ${group.name}`,
            `Chat-Group-Member-Added: ${addedEmail}`,
            ...(group.type === 'broadcast' ? [`Chat-Group-Is-Broadcast: 1`] : []),
            ...broadcastSecretHeader,
            ...(fprHeader ? [fprHeader] : []),
            fromHeader,
            `To: ${toList}`,
            ...gossipHeaders,
            '',
            `Member ${addedEmail} was added.`
        ].join('\r\n');

        const armored = await ctx.encryptRaw(innerMime, peerKey);
        const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

        const rawEmail = [
            fromHeader,
            `To: ${toList}`,
            `Date: ${now}`,
            `Message-ID: ${msgId}`,
            `Subject: ${group.name}`,
            `Chat-Version: 1.0`,
            `Chat-Group-ID: ${group.grpId}`,
            `Chat-List-Id: ${listId}`,
            `Chat-Group-Name: ${group.name}`,
            `Chat-Group-Member-Added: ${addedEmail}`,
            ...(group.type === 'broadcast' ? [`Chat-Group-Is-Broadcast: 1`] : []),
            ...(fprHeader ? [fprHeader] : []),
            ctx.buildAutocryptHeader(),
            `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${encBoundary}"`,
            `MIME-Version: 1.0`,
            '',
            `--${encBoundary}`,
            `Content-Type: application/pgp-encrypted`,
            `Content-Description: PGP/MIME version identification`,
            '',
            `Version: 1`,
            '',
            `--${encBoundary}`,
            `Content-Type: application/octet-stream; name="encrypted.asc"`,
            `Content-Description: OpenPGP encrypted message`,
            `Content-Disposition: inline; filename="encrypted.asc"`,
            '',
            armored,
            '',
            `--${encBoundary}--`
        ].join('\r\n');

        await ctx.sendRaw(ctx.credentials.email, [recipient], rawEmail);
    }

    log.info('group', `Sent member-added (${addedEmail}) to group "${group.name}"`);
}

// ─── Remove Member ──────────────────────────────────────────────────────────────

/** Send a Chat-Group-Member-Removed message to all group members */
export async function sendGroupMemberRemoved(
    ctx: SDKContext,
    group: GroupInfo,
    removedEmail: string
): Promise<void> {
    const recipients = group.members.filter(
        e => e.toLowerCase() !== ctx.credentials.email.toLowerCase()
    );

    for (const recipient of recipients) {
        const peerKey = ctx.knownKeys.get(recipient.toLowerCase());
        if (!peerKey || !ctx.privateKey || !ctx.publicKey) continue;


        // Extract fingerprint of the removed member for Chat-Group-Member-Removed-Fpr
        let fprHeader = '';
        const removedKey = ctx.knownKeys.get(removedEmail.toLowerCase());
        if (removedKey) {
            const fpr = await getKeyFingerprint(removedKey);
            fprHeader = `Chat-Group-Member-Removed-Fpr: ${fpr}`;
        }

        const msgId = ctx.generateMsgId();
        const now = new Date().toUTCString();
        const fromHeader = ctx.displayName
            ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
            : `From: <${ctx.credentials.email}>`;

        const domain = ctx.credentials.email.split('@')[1];
        const listId = `${group.grpId}@${domain}`;
        const isBroadcast = group.type === 'broadcast';
        const toList = isBroadcast ? 'undisclosed-recipients:;' : buildToList(group.members);
        const gossipHeaders = isBroadcast ? [] : buildGossipHeaders(ctx, group.members, recipient);

        const innerMime = [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            `Chat-Version: 1.0`,
            `Chat-Group-ID: ${group.grpId}`,
            `Chat-List-Id: ${listId}`,
            `Chat-Group-Name: ${group.name}`,
            `Chat-Group-Member-Removed: ${removedEmail}`,
            ...(isBroadcast ? [`Chat-Group-Is-Broadcast: 1`] : []),
            ...(fprHeader ? [fprHeader] : []),
            fromHeader,
            `To: ${toList}`,
            ...gossipHeaders,
            '',
            `Member ${removedEmail} was removed.`
        ].join('\r\n');

        const armored = await ctx.encryptRaw(innerMime, peerKey);
        const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

        const rawEmail = [
            fromHeader,
            `To: ${toList}`,
            `Date: ${now}`,
            `Message-ID: ${msgId}`,
            `Subject: ${group.name}`,
            `Chat-Version: 1.0`,
            `Chat-Group-ID: ${group.grpId}`,
            `Chat-List-Id: ${listId}`,
            `Chat-Group-Name: ${group.name}`,
            `Chat-Group-Member-Removed: ${removedEmail}`,
            ...(isBroadcast ? [`Chat-Group-Is-Broadcast: 1`] : []),
            ...(fprHeader ? [fprHeader] : []),
            ctx.buildAutocryptHeader(),
            `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${encBoundary}"`,
            `MIME-Version: 1.0`,
            '',
            `--${encBoundary}`,
            `Content-Type: application/pgp-encrypted`,
            `Content-Description: PGP/MIME version identification`,
            '',
            `Version: 1`,
            '',
            `--${encBoundary}`,
            `Content-Type: application/octet-stream; name="encrypted.asc"`,
            `Content-Description: OpenPGP encrypted message`,
            `Content-Disposition: inline; filename="encrypted.asc"`,
            '',
            armored,
            '',
            `--${encBoundary}--`
        ].join('\r\n');

        await ctx.sendRaw(ctx.credentials.email, [recipient], rawEmail);
    }

    // Remove from local members list
    group.members = group.members.filter(
        e => e.toLowerCase() !== removedEmail.toLowerCase()
    );

    log.info('group', `Sent member-removed (${removedEmail}) from group "${group.name}"`);
}

// ─── Rename Group ───────────────────────────────────────────────────────────────

/** Send a Chat-Group-Name-Changed message to all group members */
export async function renameGroup(
    ctx: SDKContext,
    group: GroupInfo,
    newName: string
): Promise<void> {
    const oldName = group.name;
    group.name = newName;

    const recipients = group.members.filter(
        e => e.toLowerCase() !== ctx.credentials.email.toLowerCase()
    );

    for (const recipient of recipients) {
        const peerKey = ctx.knownKeys.get(recipient.toLowerCase());
        if (!peerKey || !ctx.privateKey || !ctx.publicKey) continue;


        const msgId = ctx.generateMsgId();
        const now = new Date().toUTCString();
        const fromHeader = ctx.displayName
            ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
            : `From: <${ctx.credentials.email}>`;

        const domain = ctx.credentials.email.split('@')[1];
        const listId = `${group.grpId}@${domain}`;
        const isBroadcast = group.type === 'broadcast';
        const toList = isBroadcast ? 'undisclosed-recipients:;' : buildToList(group.members);
        const gossipHeaders = isBroadcast ? [] : buildGossipHeaders(ctx, group.members, recipient);

        const innerMime = [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            `Chat-Version: 1.0`,
            `Chat-Group-ID: ${group.grpId}`,
            `Chat-List-Id: ${listId}`,
            `Chat-Group-Name: ${newName}`,
            `Chat-Group-Name-Changed: ${oldName}`,
            ...(isBroadcast ? [`Chat-Group-Is-Broadcast: 1`] : []),
            fromHeader,
            `To: ${toList}`,
            ...gossipHeaders,
            '',
            `Chat name changed.`
        ].join('\r\n');

        const armored = await ctx.encryptRaw(innerMime, peerKey);
        const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

        const rawEmail = [
            fromHeader,
            `To: ${toList}`,
            `Date: ${now}`,
            `Message-ID: ${msgId}`,
            `Subject: ${newName}`,
            `Chat-Version: 1.0`,
            `Chat-Group-ID: ${group.grpId}`,
            `Chat-List-Id: ${listId}`,
            `Chat-Group-Name: ${newName}`,
            `Chat-Group-Name-Changed: ${oldName}`,
            ...(isBroadcast ? [`Chat-Group-Is-Broadcast: 1`] : []),
            ctx.buildAutocryptHeader(),
            `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${encBoundary}"`,
            `MIME-Version: 1.0`,
            '',
            `--${encBoundary}`,
            `Content-Type: application/pgp-encrypted`,
            `Content-Description: PGP/MIME version identification`,
            '',
            `Version: 1`,
            '',
            `--${encBoundary}`,
            `Content-Type: application/octet-stream; name="encrypted.asc"`,
            `Content-Description: OpenPGP encrypted message`,
            `Content-Disposition: inline; filename="encrypted.asc"`,
            '',
            armored,
            '',
            `--${encBoundary}--`
        ].join('\r\n');

        await ctx.sendRaw(ctx.credentials.email, [recipient], rawEmail);
    }

    log.info('group', `Renamed group "${oldName}" → "${newName}"`);
}

// ─── Group Description ──────────────────────────────────────────────────────────

/** Update the description of a group or channel */
export async function updateGroupDescription(
    ctx: SDKContext,
    group: GroupInfo,
    newDescription: string
): Promise<void> {
    const oldDescription = group.description;
    group.description = newDescription;

    const recipients = group.members.filter(
        e => e.toLowerCase() !== ctx.credentials.email.toLowerCase()
    );

    for (const recipient of recipients) {
        const peerKey = ctx.knownKeys.get(recipient.toLowerCase());
        if (!peerKey || !ctx.privateKey || !ctx.publicKey) continue;


        const msgId = ctx.generateMsgId();
        const now = new Date().toUTCString();
        const fromHeader = ctx.displayName
            ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
            : `From: <${ctx.credentials.email}>`;

        const domain = ctx.credentials.email.split('@')[1];
        const listId = `${group.grpId}@${domain}`;
        const isBroadcast = group.type === 'broadcast';
        const toList = isBroadcast ? 'undisclosed-recipients:;' : buildToList(group.members);
        const gossipHeaders = isBroadcast ? [] : buildGossipHeaders(ctx, group.members, recipient);

        const innerMime = [
            `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
            `Chat-Version: 1.0`,
            `Chat-Group-ID: ${group.grpId}`,
            `Chat-List-Id: ${listId}`,
            `Chat-Group-Name: ${group.name}`,
            `Chat-Group-Description: ${newDescription}`,
            ...(oldDescription ? [`Chat-Group-Description-Changed: ${oldDescription}`] : []),
            ...(isBroadcast ? [`Chat-Group-Is-Broadcast: 1`] : []),
            fromHeader,
            `To: ${toList}`,
            ...gossipHeaders,
            '',
            `Group description changed.`
        ].join('\r\n');

        const armored = await ctx.encryptRaw(innerMime, peerKey);
        const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

        const rawEmail = [
            fromHeader,
            `To: ${toList}`,
            `Date: ${now}`,
            `Message-ID: ${msgId}`,
            `Subject: ${group.name}`,
            `Chat-Version: 1.0`,
            `Chat-Group-ID: ${group.grpId}`,
            `Chat-List-Id: ${listId}`,
            `Chat-Group-Name: ${group.name}`,
            `Chat-Group-Description: ${newDescription}`,
            ...(oldDescription ? [`Chat-Group-Description-Changed: ${oldDescription}`] : []),
            ...(isBroadcast ? [`Chat-Group-Is-Broadcast: 1`] : []),
            ctx.buildAutocryptHeader(),
            `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${encBoundary}"`,
            `MIME-Version: 1.0`,
            '',
            `--${encBoundary}`,
            `Content-Type: application/pgp-encrypted`,
            `Content-Description: PGP/MIME version identification`,
            '',
            `Version: 1`,
            '',
            `--${encBoundary}`,
            `Content-Type: application/octet-stream; name="encrypted.asc"`,
            `Content-Description: OpenPGP encrypted message`,
            `Content-Disposition: inline; filename="encrypted.asc"`,
            '',
            armored,
            '',
            `--${encBoundary}--`
        ].join('\r\n');

        await ctx.sendRaw(ctx.credentials.email, [recipient], rawEmail);
    }

    log.info('group', `Updated description for "${group.name}"`);
}

// ─── Join Group ─────────────────────────────────────────────────────────────────

/** Join a group or channel via invitation URI (standard securejoin) */
export async function joinGroup(
    ctx: SDKContext,
    uri: string
): Promise<{ peerEmail: string; verified: boolean; groupInfo?: Partial<GroupInfo> }> {
    // secureJoin already handles the complex multi-step protocol
    // For channels, once securejoin is done, the owner will add us.
    const sjResult = await sj.secureJoin(ctx, uri);
    
    // Parse the URI to see if there's group info right away
    const parsed = sj.parseSecureJoinURI(uri);
    const groupInfo: Partial<GroupInfo> = {
        grpId: parsed.groupId,
        name: parsed.groupName || parsed.broadcastName,
        type: parsed.broadcastName ? 'broadcast' : 'group'
    };

    log.info('group', `Joined ${groupInfo.name || 'group'} via invitation`);
    return { ...sjResult, groupInfo };
}

// ─── Leave Group ────────────────────────────────────────────────────────────────

/** Leave a group (sends member-removed for self) */
export async function leaveGroup(
    ctx: SDKContext,
    group: GroupInfo
): Promise<void> {
    await sendGroupMemberRemoved(ctx, group, ctx.credentials.email);
    log.info('group', `Left group "${group.name}"`);
}

// ─── Send Broadcast ─────────────────────────────────────────────────────────────

/** Send a broadcast message (one-way channel, only creator can send) */
export async function sendBroadcast(
    ctx: SDKContext,
    group: GroupInfo,
    text: string
): Promise<string> {
    if (group.type !== 'broadcast') {
        throw new Error('sendBroadcast requires a broadcast-type group');
    }
    // Broadcasts use the same wire format as groups
    return sendGroupMessage(ctx, group, text);
}

// ─── Resend ─────────────────────────────────────────────────────────────────────

/** Resend a message (re-send an existing message to the same recipient) */
export async function resendMessage(
    ctx: SDKContext,
    toEmail: string,
    originalText: string
): Promise<string> {
    // Resend is just sending the same text again with a new Message-ID
    const peerKey = ctx.knownKeys.get(toEmail.toLowerCase());
    if (!peerKey || !ctx.privateKey || !ctx.publicKey) {
        throw new Error(`No key for ${toEmail} — cannot resend`);
    }

    const msgId = ctx.generateMsgId();
    const now = new Date().toUTCString();
    const fromHeader = ctx.displayName
        ? `From: "${ctx.displayName}" <${ctx.credentials.email}>`
        : `From: <${ctx.credentials.email}>`;

    const armored = await ctx.encrypt(originalText, peerKey, {
        from: ctx.credentials.email,
        to: toEmail,
    });
    const encBoundary = `encrypted-${crypto.randomUUID().slice(0, 8)}`;

    const rawEmail = [
        fromHeader,
        `To: <${toEmail}>`,
        `Date: ${now}`,
        `Message-ID: ${msgId}`,
        `Subject: [...]`,
        `Chat-Version: 1.0`,
        ctx.buildAutocryptHeader(),
        `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${encBoundary}"`,
        `MIME-Version: 1.0`,
        '',
        `--${encBoundary}`,
        `Content-Type: application/pgp-encrypted`,
        `Content-Description: PGP/MIME version identification`,
        '',
        `Version: 1`,
        '',
        `--${encBoundary}`,
        `Content-Type: application/octet-stream; name="encrypted.asc"`,
        `Content-Description: OpenPGP encrypted message`,
        `Content-Disposition: inline; filename="encrypted.asc"`,
        '',
        armored,
        '',
        `--${encBoundary}--`
    ].join('\r\n');

    await ctx.sendRaw(ctx.credentials.email, [toEmail], rawEmail);
    log.info('group', `Resent message to ${toEmail} [${msgId}]`);
    return msgId;
}

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Build a comma-separated list of bracketed emails for To: header */
function buildToList(members: string[]): string {
    return members.map(e => `<${e}>`).join(', ');
}

/** Build Autocrypt-Gossip headers for all group members except the recipient */
function buildGossipHeaders(ctx: SDKContext, allMembers: string[], currentRecipient: string): string[] {
    const headers: string[] = [];
    for (const member of allMembers) {
        if (member.toLowerCase() === currentRecipient.toLowerCase()) continue;
        const key = ctx.knownKeys.get(member.toLowerCase());
        if (!key) continue;
        
        const keydata = cryptoLib.extractAutocryptKeydata(key);
        headers.push(`Autocrypt-Gossip: addr=${member.toLowerCase()}; keydata=${keydata}`);
    }
    // Also gossip our own key
    if (ctx.autocryptKeydata) {
        headers.push(`Autocrypt-Gossip: addr=${ctx.credentials.email.toLowerCase()}; keydata=${ctx.autocryptKeydata}`);
    }
    return headers;
}
