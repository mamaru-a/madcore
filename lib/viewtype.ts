/**
 * lib/viewtype.ts — Map between core-style Viewtype and store message types.
 */

import type { Viewtype } from '../types';

/** Store-level message type (extends media/control kinds used by StoredMessage) */
export type MessageStoreType =
    | 'text'
    | 'image'
    | 'file'
    | 'video'
    | 'audio'
    | 'voice'
    | 'gif'
    | 'sticker'
    | 'webxdc'
    | 'html'
    | 'location'
    | 'call'
    | 'reaction'
    | 'delete'
    | 'edit'
    | 'securejoin'
    | 'system';

const VIEWTYPE_TO_STORE: Record<Viewtype, MessageStoreType> = {
    Text: 'text',
    Image: 'image',
    Gif: 'gif',
    Audio: 'audio',
    Voice: 'voice',
    Video: 'video',
    File: 'file',
    Sticker: 'sticker',
    Webxdc: 'webxdc',
};

const STORE_TO_VIEWTYPE: Partial<Record<MessageStoreType, Viewtype>> = {
    text: 'Text',
    image: 'Image',
    gif: 'Gif',
    audio: 'Audio',
    voice: 'Voice',
    video: 'Video',
    file: 'File',
    sticker: 'Sticker',
    webxdc: 'Webxdc',
};

export function viewtypeToStoreType(viewtype: Viewtype): MessageStoreType {
    return VIEWTYPE_TO_STORE[viewtype];
}

/** Returns null for control/system types that have no core Viewtype. */
export function storeTypeToViewtype(storeType: MessageStoreType): Viewtype | null {
    return STORE_TO_VIEWTYPE[storeType] ?? null;
}

/** Infer store type from MIME type (best-effort for inbound attachments). */
export function storeTypeFromMime(
    mimeType: string,
    opts?: { isVoice?: boolean; isSticker?: boolean; isGif?: boolean },
): MessageStoreType {
    if (opts?.isSticker) return 'sticker';
    if (opts?.isVoice) return 'voice';
    const mt = mimeType.toLowerCase();
    if (opts?.isGif || mt === 'image/gif') return 'gif';
    if (mt.startsWith('image/')) return 'image';
    if (mt.startsWith('video/')) return 'video';
    if (mt.startsWith('audio/')) return 'audio';
    if (mt === 'application/webxdc' || mt.includes('webxdc')) return 'webxdc';
    return 'file';
}
