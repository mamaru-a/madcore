import { describe, it, expect } from 'bun:test';
import {
    buildFromHeader,
    buildInnerText,
    buildInnerMultipart,
    buildPgpMimeEnvelope,
    bracketEmail,
} from '../../lib/mime-build';
import {
    viewtypeToStoreType,
    storeTypeToViewtype,
    storeTypeFromMime,
} from '../../lib/viewtype';
import type { SDKContext } from '../../lib/context';

function mockCtx(overrides: Partial<SDKContext> = {}): SDKContext {
    return {
        serverUrl: 'https://relay.example',
        credentials: { email: 'alice@relay.example', password: 'x' },
        privateKey: null,
        publicKey: null,
        fingerprint: '',
        autocryptKeydata: 'KEYDATA',
        displayName: 'Alice',
        knownKeys: new Map(),
        peerAvatars: new Map(),
        profilePhotoB64: '',
        profilePhotoMime: '',
        profilePhotoChanged: false,
        sentAvatarTo: new Set(),
        generateMsgId: () => '<test@relay.example>',
        buildAutocryptHeader: () => 'Autocrypt: addr=alice@relay.example; keydata=KEYDATA',
        encryptRaw: async () => 'ARMORED',
        encrypt: async () => 'ARMORED',
        sendRaw: async () => {},
        sendMessage: async () => '<id>',
        foldBase64: (b64) => b64,
        waitForMessage: async () => { throw new Error('n/a'); },
        ...overrides,
    } as SDKContext;
}

describe('mime-build', () => {
    it('buildFromHeader includes display name', () => {
        const h = buildFromHeader(mockCtx());
        expect(h).toBe('From: "Alice" <alice@relay.example>');
    });

    it('buildFromHeader without display name', () => {
        const h = buildFromHeader(mockCtx({ displayName: '' }));
        expect(h).toBe('From: <alice@relay.example>');
    });

    it('bracketEmail wraps address', () => {
        expect(bracketEmail('bob@x')).toBe('<bob@x>');
    });

    it('buildInnerText joins headers and body with CRLF', () => {
        const inner = buildInnerText(
            ['Content-Type: text/plain', 'Chat-Version: 1.0'],
            'hello',
        );
        expect(inner).toContain('Content-Type: text/plain\r\n');
        expect(inner).toContain('Chat-Version: 1.0\r\n\r\nhello');
    });

    it('buildInnerMultipart includes text + attachment parts', () => {
        const inner = buildInnerMultipart({
            headers: ['Chat-Version: 1.0', 'From: <a@b>'],
            text: 'caption',
            parts: [{
                mimeType: 'image/png',
                filename: 'pic.png',
                base64: 'AAAA',
                disposition: 'attachment',
            }],
            boundary: 'testbound',
        });
        expect(inner).toContain('multipart/mixed; boundary="testbound"');
        expect(inner).toContain('Content-Type: text/plain');
        expect(inner).toContain('caption');
        expect(inner).toContain('image/png; name="pic.png"');
        expect(inner).toContain('filename="pic.png"');
        expect(inner).toContain('AAAA');
        expect(inner).toContain('--testbound--');
    });

    it('buildPgpMimeEnvelope wraps armored payload', () => {
        const raw = buildPgpMimeEnvelope({
            fromHeader: 'From: <alice@relay.example>',
            toHeader: '<bob@relay.example>',
            msgId: '<m1@relay.example>',
            date: 'Mon, 1 Jan 2024 00:00:00 GMT',
            subject: 'hi',
            outerHeaders: ['In-Reply-To: <parent@x>'],
            autocryptHeader: 'Autocrypt: addr=alice@relay.example; keydata=K',
            armored: '-----BEGIN PGP MESSAGE-----\nxyz\n-----END PGP MESSAGE-----',
        });
        expect(raw).toContain('From: <alice@relay.example>');
        expect(raw).toContain('To: <bob@relay.example>');
        expect(raw).toContain('Message-ID: <m1@relay.example>');
        expect(raw).toContain('Subject: hi');
        expect(raw).toContain('Chat-Version: 1.0');
        expect(raw).toContain('In-Reply-To: <parent@x>');
        expect(raw).toContain('multipart/encrypted');
        expect(raw).toContain('application/pgp-encrypted');
        expect(raw).toContain('-----BEGIN PGP MESSAGE-----');
        expect(raw).toContain('Autocrypt: addr=alice@relay.example');
    });

    it('buildPgpMimeEnvelope does not duplicate Chat-Version', () => {
        const raw = buildPgpMimeEnvelope({
            fromHeader: 'From: <a@b>',
            toHeader: '<c@d>',
            msgId: '<id>',
            outerHeaders: ['Chat-Version: 1.0', 'Chat-Group-ID: g1'],
            autocryptHeader: 'Autocrypt: x',
            armored: 'ARM',
        });
        const matches = raw.match(/Chat-Version: 1\.0/g) || [];
        expect(matches.length).toBe(1);
        expect(raw).toContain('Chat-Group-ID: g1');
    });
});

describe('viewtype mapping', () => {
    it('maps Viewtype ↔ store type', () => {
        expect(viewtypeToStoreType('Text')).toBe('text');
        expect(viewtypeToStoreType('Sticker')).toBe('sticker');
        expect(viewtypeToStoreType('Gif')).toBe('gif');
        expect(storeTypeToViewtype('video')).toBe('Video');
        expect(storeTypeToViewtype('webxdc')).toBe('Webxdc');
        expect(storeTypeToViewtype('reaction')).toBeNull();
        expect(storeTypeToViewtype('call')).toBeNull();
    });

    it('infers store type from MIME', () => {
        expect(storeTypeFromMime('image/png')).toBe('image');
        expect(storeTypeFromMime('image/gif')).toBe('gif');
        expect(storeTypeFromMime('video/mp4')).toBe('video');
        expect(storeTypeFromMime('audio/ogg', { isVoice: true })).toBe('voice');
        expect(storeTypeFromMime('image/webp', { isSticker: true })).toBe('sticker');
        expect(storeTypeFromMime('application/pdf')).toBe('file');
        expect(storeTypeFromMime('application/webxdc')).toBe('webxdc');
    });
});

describe('sticker/gif MIME builders', () => {
    it('sticker multipart includes Chat-Content: sticker', () => {
        const { buildInnerMultipart } = require('../../lib/mime-build') as typeof import('../../lib/mime-build');
        const inner = buildInnerMultipart({
            headers: [
                'From: <a@b>',
                'To: <c@d>',
                'Chat-Version: 1.0',
                'Chat-Content: sticker',
            ],
            text: '',
            parts: [{
                mimeType: 'image/webp',
                filename: 'sticker.webp',
                base64: 'AAAA',
                disposition: 'attachment',
            }],
            boundary: 'stk',
        });
        expect(inner).toContain('Chat-Content: sticker');
        expect(inner).toContain('image/webp');
        expect(inner).toContain('sticker.webp');
    });

    it('gif multipart includes Chat-Content: gif', () => {
        const { buildInnerMultipart } = require('../../lib/mime-build') as typeof import('../../lib/mime-build');
        const inner = buildInnerMultipart({
            headers: [
                'From: <a@b>',
                'To: <c@d>',
                'Chat-Version: 1.0',
                'Chat-Content: gif',
            ],
            text: 'funny',
            parts: [{
                mimeType: 'image/gif',
                filename: 'image.gif',
                base64: 'BBBB',
                disposition: 'attachment',
            }],
            boundary: 'gif',
        });
        expect(inner).toContain('Chat-Content: gif');
        expect(inner).toContain('image/gif');
    });
});
