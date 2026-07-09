/**
 * lib/webxdc.ts — Webxdc (apps-in-chat) send/receive helpers.
 *
 * Wire format (aligned with Delta Chat core):
 *   - Attachment: application/webxdc (or .xdc zip as application/octet-stream)
 *   - Chat-Content: app (optional marker)
 *   - Status updates: Chat-Content: webxdc-status + JSON body referencing instance Message-ID
 */

import type { SDKContext } from './context';
import {
    buildFromHeader,
    buildInnerMultipart,
    buildInnerText,
    bracketEmail,
    sendEncryptedMime,
} from './mime-build';
import { log } from './logger';

export interface WebxdcInfo {
    name?: string;
    icon?: string; // base64 or data URI
    document?: string;
    summary?: string;
}

export interface WebxdcStatusUpdate {
    serial: number;
    max_serial?: number;
    payload: unknown;
    info?: string;
    summary?: string;
    document?: string;
}

/** Send a .xdc app instance to a 1:1 peer */
export async function sendWebxdc(
    ctx: SDKContext,
    toEmail: string,
    opts: {
        data: string; // base64 of .xdc zip
        filename?: string;
        name?: string;
        caption?: string;
    },
): Promise<string> {
    const fromHeader = buildFromHeader(ctx);
    const filename = opts.filename || 'app.xdc';
    const caption = opts.caption || opts.name || 'Webxdc app';
    const extra = ['Chat-Content: app'];
    if (opts.name) extra.push(`Chat-Webxdc-Name: ${opts.name}`);

    const innerMime = buildInnerMultipart({
        headers: [
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `Chat-Version: 1.0`,
            ...extra,
        ],
        text: caption,
        parts: [{
            mimeType: 'application/webxdc',
            filename,
            base64: opts.data,
            disposition: 'attachment',
        }],
    });

    const msgId = await sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: extra,
        innerMime,
        fromHeader,
    });
    log.info('webxdc', `Sent webxdc "${filename}" → ${toEmail} [${msgId}]`);
    return msgId;
}

/**
 * Send a status update for an existing webxdc instance message.
 * Body is JSON: { payload, info?, summary?, document? }
 */
export async function sendWebxdcStatusUpdate(
    ctx: SDKContext,
    toEmail: string,
    instanceMsgId: string,
    update: Omit<WebxdcStatusUpdate, 'serial'> & { serial?: number },
): Promise<string> {
    const fromHeader = buildFromHeader(ctx);
    const serial = update.serial ?? Date.now();
    const body = JSON.stringify({
        serial,
        max_serial: update.max_serial ?? serial,
        payload: update.payload,
        info: update.info,
        summary: update.summary,
        document: update.document,
    });

    const innerMime = buildInnerText(
        [
            `Content-Type: application/json; charset="utf-8"; protected-headers="v1"`,
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `Chat-Version: 1.0`,
            `Chat-Content: webxdc-status`,
            `In-Reply-To: ${instanceMsgId}`,
            `Chat-Webxdc-Instance: ${instanceMsgId}`,
        ],
        body,
    );

    const msgId = await sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: [
            `Chat-Content: webxdc-status`,
            `In-Reply-To: ${instanceMsgId}`,
            `Chat-Webxdc-Instance: ${instanceMsgId}`,
        ],
        innerMime,
        fromHeader,
    });
    log.info('webxdc', `Sent status update serial=${serial} for ${instanceMsgId}`);
    return msgId;
}

/** Parse status update JSON from message text */
export function parseStatusUpdate(text: string): WebxdcStatusUpdate | null {
    try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object' && 'payload' in obj) {
            return {
                serial: Number(obj.serial) || 0,
                max_serial: obj.max_serial !== undefined ? Number(obj.max_serial) : undefined,
                payload: obj.payload,
                info: obj.info,
                summary: obj.summary,
                document: obj.document,
            };
        }
    } catch {
        /* not JSON */
    }
    return null;
}
