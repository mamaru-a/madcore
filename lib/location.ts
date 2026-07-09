/**
 * lib/location.ts — Location streaming over encrypted chat messages.
 *
 * Wire: Chat-Content: location + application/json body with lat/lon/accuracy/timestamp.
 * Streaming is app-driven: call setLocation() while a chat is in "streaming" state.
 */

import type { SDKContext } from './context';
import {
    buildFromHeader,
    buildInnerText,
    bracketEmail,
    sendEncryptedMime,
} from './mime-build';
import { log } from './logger';

export interface LocationPoint {
    lat: number;
    lon: number;
    accuracy?: number;
    timestamp: number;
    from?: string;
    chatId?: string;
}

export interface LocationStreamState {
    chatId: string;
    /** Absolute ms when streaming ends */
    until: number;
    /** Peer email for 1:1, or empty for group fan-out handled by caller */
    peerEmail?: string;
}

/** Encode a location point as JSON body */
export function encodeLocation(point: LocationPoint): string {
    return JSON.stringify({
        lat: point.lat,
        lon: point.lon,
        accuracy: point.accuracy,
        timestamp: point.timestamp,
    });
}

/** Parse location JSON from message text */
export function parseLocation(text: string): LocationPoint | null {
    try {
        const o = JSON.parse(text);
        if (typeof o?.lat === 'number' && typeof o?.lon === 'number') {
            return {
                lat: o.lat,
                lon: o.lon,
                accuracy: typeof o.accuracy === 'number' ? o.accuracy : undefined,
                timestamp: typeof o.timestamp === 'number' ? o.timestamp : Date.now(),
            };
        }
    } catch { /* ignore */ }
    return null;
}

/** Send a single location point to a peer */
export async function sendLocation(
    ctx: SDKContext,
    toEmail: string,
    point: LocationPoint,
): Promise<string> {
    const fromHeader = buildFromHeader(ctx);
    const body = encodeLocation(point);
    const innerMime = buildInnerText(
        [
            `Content-Type: application/json; charset="utf-8"; protected-headers="v1"`,
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `Chat-Version: 1.0`,
            `Chat-Content: location`,
        ],
        body,
    );
    const msgId = await sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: ['Chat-Content: location'],
        innerMime,
        fromHeader,
    });
    log.info('location', `Sent location to ${toEmail} [${msgId}]`);
    return msgId;
}

/** Start-stream announcement (duration in seconds) */
export async function sendLocationStreamStart(
    ctx: SDKContext,
    toEmail: string,
    durationSec: number,
): Promise<string> {
    const fromHeader = buildFromHeader(ctx);
    const body = JSON.stringify({ action: 'stream-start', durationSec });
    const innerMime = buildInnerText(
        [
            `Content-Type: application/json; charset="utf-8"; protected-headers="v1"`,
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `Chat-Version: 1.0`,
            `Chat-Content: location-stream`,
            `Chat-Location-Duration: ${durationSec}`,
        ],
        body,
    );
    return sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: [
            `Chat-Content: location-stream`,
            `Chat-Location-Duration: ${durationSec}`,
        ],
        innerMime,
        fromHeader,
    });
}

export async function sendLocationStreamStop(
    ctx: SDKContext,
    toEmail: string,
): Promise<string> {
    const fromHeader = buildFromHeader(ctx);
    const body = JSON.stringify({ action: 'stream-stop' });
    const innerMime = buildInnerText(
        [
            `Content-Type: application/json; charset="utf-8"; protected-headers="v1"`,
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `Chat-Version: 1.0`,
            `Chat-Content: location-stream`,
        ],
        body,
    );
    return sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: ['Chat-Content: location-stream'],
        innerMime,
        fromHeader,
    });
}
