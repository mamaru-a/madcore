/**
 * lib/calls.ts — WebRTC call signaling over encrypted chat messages.
 *
 * Pure signaling state machine. Media requires the host to inject RTCPeerConnection
 * (browser-only). Chatmail does not provide TURN.
 *
 * Wire: Chat-Content: call + JSON body:
 *   { type: 'offer'|'answer'|'ice'|'end', callId, sdp?, candidate?, video? }
 */

import type { SDKContext } from './context';
import {
    buildFromHeader,
    buildInnerText,
    bracketEmail,
    sendEncryptedMime,
} from './mime-build';
import { log } from './logger';

export type CallSignalType = 'offer' | 'answer' | 'ice' | 'end' | 'ring';

export interface CallSignal {
    type: CallSignalType;
    callId: string;
    sdp?: string;
    candidate?: RTCIceCandidateInit | null;
    video?: boolean;
    from?: string;
}

export type CallState = 'idle' | 'ringing' | 'outgoing' | 'active' | 'ended';

export interface CallSession {
    callId: string;
    peerEmail: string;
    state: CallState;
    video: boolean;
    createdAt: number;
    direction: 'incoming' | 'outgoing';
}

export type IceServer = RTCIceServer;

export function generateCallId(): string {
    return crypto.randomUUID();
}

export function encodeSignal(signal: CallSignal): string {
    return JSON.stringify({
        type: signal.type,
        callId: signal.callId,
        sdp: signal.sdp,
        candidate: signal.candidate,
        video: signal.video,
    });
}

export function parseSignal(text: string): CallSignal | null {
    try {
        const o = JSON.parse(text);
        if (o && typeof o.callId === 'string' && typeof o.type === 'string') {
            return {
                type: o.type,
                callId: o.callId,
                sdp: o.sdp,
                candidate: o.candidate,
                video: !!o.video,
            };
        }
    } catch { /* ignore */ }
    return null;
}

export async function sendCallSignal(
    ctx: SDKContext,
    toEmail: string,
    signal: CallSignal,
): Promise<string> {
    const fromHeader = buildFromHeader(ctx);
    const body = encodeSignal(signal);
    const innerMime = buildInnerText(
        [
            `Content-Type: application/json; charset="utf-8"; protected-headers="v1"`,
            fromHeader,
            `To: ${bracketEmail(toEmail)}`,
            `Chat-Version: 1.0`,
            `Chat-Content: call`,
            `Chat-Call-Id: ${signal.callId}`,
            `Chat-Call-Type: ${signal.type}`,
        ],
        body,
    );
    const msgId = await sendEncryptedMime(ctx, {
        toEmail,
        outerHeaders: [
            `Chat-Content: call`,
            `Chat-Call-Id: ${signal.callId}`,
            `Chat-Call-Type: ${signal.type}`,
        ],
        innerMime,
        fromHeader,
    });
    log.info('calls', `Sent call ${signal.type} ${signal.callId} → ${toEmail}`);
    return msgId;
}

/** Capability detection for the current environment */
export function callCapability(): 'webrtc' | 'signaling-only' | 'none' {
    if (typeof globalThis.RTCPeerConnection === 'function') return 'webrtc';
    return 'signaling-only';
}
