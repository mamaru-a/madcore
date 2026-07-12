import { describe, it, expect } from 'bun:test';
import { buildInnerText, buildPgpMimeEnvelope } from '../../lib/mime-build';
import { dispositionNotificationHeader, buildMdnMime } from '../../lib/messaging';
import { detectReadReceipt } from '../../lib/mime';
import { checkQr, createQrSvg, parseSecureJoinURI } from '../../lib/securejoin';
import type { SDKContext } from '../../lib/context';

function mockCtx(): SDKContext {
    return {
        serverUrl: 'https://relay.example',
        credentials: { email: 'alice@relay.example', password: 'x' },
        privateKey: null,
        publicKey: null,
        fingerprint: 'ABCD',
        autocryptKeydata: 'K',
        displayName: 'Alice',
        knownKeys: new Map(),
        peerAvatars: new Map(),
        profilePhotoB64: '',
        profilePhotoMime: '',
        profilePhotoChanged: false,
        sentAvatarTo: new Set(),
        generateMsgId: () => '<id@x>',
        buildAutocryptHeader: () => 'Autocrypt: x',
        encryptRaw: async () => 'ARM',
        encrypt: async () => 'ARM',
        sendRaw: async () => {},
        sendMessage: async () => '<id>',
        foldBase64: (b) => b,
        waitForMessage: async () => { throw new Error('n/a'); },
    } as SDKContext;
}

describe('read receipts wire format', () => {
    it('disposition notification header points at self', () => {
        expect(dispositionNotificationHeader(mockCtx())).toBe(
            'Chat-Disposition-Notification-To: alice@relay.example',
        );
    });

    it('read receipt is core-compatible multipart/report MDN', () => {
        const original = '<msg1@relay.example>';
        const inner = buildMdnMime({
            fromHeader: 'From: <bob@relay.example>',
            toEmail: 'alice@relay.example',
            selfEmail: 'bob@relay.example',
            originalMsgId: original,
            boundary: 'mdn-test',
        });
        expect(inner).toContain('multipart/report');
        expect(inner).toContain('report-type=disposition-notification');
        expect(inner).toContain('message/disposition-notification');
        expect(inner).toContain('Disposition: manual-action/MDN-sent-automatically; displayed');
        expect(inner).toContain(`Original-Message-ID: ${original}`);
        expect(inner).toContain('Chat-Disposition: display');
        expect(inner).toContain('This is a receipt notification.');
    });

    it('detectReadReceipt recognizes Chat-Disposition dual headers', () => {
        const r = detectReadReceipt({
            headers: {
                'chat-disposition': 'display',
                'original-message-id': '<out1@x>',
            },
            innerHeaders: {},
            outerSource: '',
        });
        expect(r.isReadReceipt).toBe(true);
        expect(r.readReceiptFor).toBe('<out1@x>');
    });

    it('detectReadReceipt recognizes RFC 6522 report body', () => {
        const body = [
            'From: <bob@x>',
            'To: <alice@x>',
            'Content-Type: multipart/report; report-type=disposition-notification; boundary="SNIPP"',
            '',
            '--SNIPP',
            'Content-Type: text/plain',
            '',
            'This is a receipt notification.',
            '',
            '--SNIPP',
            'Content-Type: message/disposition-notification',
            '',
            'Original-Message-ID: <out1@x>',
            'Disposition: manual-action/MDN-sent-automatically; displayed',
            '',
            '--SNIPP--',
        ].join('\r\n');
        const r = detectReadReceipt({
            headers: {
                'content-type':
                    'multipart/report; report-type=disposition-notification; boundary="SNIPP"',
            },
            innerHeaders: {},
            outerSource: body,
            text: 'This is a receipt notification.',
        });
        expect(r.isReadReceipt).toBe(true);
        expect(r.readReceiptFor).toBe('<out1@x>');
    });

    it('envelope can carry disposition request header', () => {
        const raw = buildPgpMimeEnvelope({
            fromHeader: 'From: <alice@relay.example>',
            toHeader: '<bob@relay.example>',
            msgId: '<m@x>',
            outerHeaders: ['Chat-Disposition-Notification-To: alice@relay.example'],
            autocryptHeader: 'Autocrypt: x',
            armored: 'ARM',
        });
        expect(raw).toContain('Chat-Disposition-Notification-To: alice@relay.example');
    });
});

describe('checkQr', () => {
    it('classifies SecureJoin invite URI', () => {
        const uri = 'https://i.delta.chat/#FINGERPRINT123&i=inv123&s=auth456&a=alice%40relay.example&n=Alice';
        const r = checkQr(uri);
        expect(r.kind).toBe('securejoin');
        expect(r.secureJoin?.inviterEmail).toBe('alice@relay.example');
        expect(r.secureJoin?.inviteNumber).toBe('inv123');
    });

    it('classifies group SecureJoin', () => {
        const uri = 'https://i.delta.chat/#FP&i=i1&s=s1&a=a%40b.c&g=MyGroup&x=grpid1';
        const r = checkQr(uri);
        expect(r.kind).toBe('securejoin_group');
        expect(r.secureJoin?.groupName).toBe('MyGroup');
    });

    it('classifies email and url and text', () => {
        expect(checkQr('bob@example.com').kind).toBe('email');
        expect(checkQr('mailto:bob@example.com').email).toBe('bob@example.com');
        expect(checkQr('https://delta.chat').kind).toBe('url');
        expect(checkQr('hello world').kind).toBe('text');
        expect(checkQr('').kind).toBe('error');
    });

    it('classifies backup schemes', () => {
        expect(checkQr('dcbackup:abc').kind).toBe('backup');
        expect(checkQr('dcaccount:https://example/token').kind).toBe('backup');
    });

    it('createQrSvg returns SVG markup', () => {
        const svg = createQrSvg('test-payload');
        expect(svg).toContain('<svg');
        expect(svg).toContain('test-payload');
    });

    it('parseSecureJoinURI still works for classic invites', () => {
        const uri = 'https://i.delta.chat/#ABCD&i=ii&s=ss&a=a%40b.c&n=N';
        const p = parseSecureJoinURI(uri);
        expect(p.fingerprint).toBe('ABCD');
        expect(p.auth).toBe('ss');
    });
});
