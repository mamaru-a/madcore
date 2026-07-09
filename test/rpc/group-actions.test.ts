import { describe, it, expect } from 'bun:test';
import {
    groupInnerHeaders,
    type GroupInfo,
    type GroupSendContext,
} from '../../lib/group';
import { buildInnerText, buildInnerMultipart } from '../../lib/mime-build';

const group: GroupInfo = {
    grpId: 'g1abc',
    name: 'Test Group',
    members: ['alice@x', 'bob@x', 'carol@x'],
    type: 'group',
};

function ctx(overrides: Partial<GroupSendContext> = {}): GroupSendContext {
    return {
        recipient: 'bob@x',
        toList: '<alice@x>, <bob@x>, <carol@x>',
        listId: 'g1abc@x',
        fromHeader: 'From: "Alice" <alice@x>',
        gossipHeaders: ['Autocrypt-Gossip: addr=carol@x; keydata=KK'],
        isBroadcast: false,
        group,
        ...overrides,
    };
}

describe('group action MIME builders', () => {
    it('groupInnerHeaders includes group identity + gossip', () => {
        const headers = groupInnerHeaders(ctx());
        expect(headers).toContain('Chat-Version: 1.0');
        expect(headers).toContain('Chat-Group-ID: g1abc');
        expect(headers).toContain('Chat-List-Id: g1abc@x');
        expect(headers).toContain('Chat-Group-Name: Test Group');
        expect(headers).toContain('From: "Alice" <alice@x>');
        expect(headers.some(h => h.startsWith('Autocrypt-Gossip:'))).toBe(true);
        expect(headers.some(h => h.includes('Chat-Group-Is-Broadcast'))).toBe(false);
    });

    it('broadcast includes Chat-Group-Is-Broadcast', () => {
        const headers = groupInnerHeaders(ctx({
            isBroadcast: true,
            group: { ...group, type: 'broadcast', broadcastSecret: 'sec' },
            gossipHeaders: [],
        }));
        expect(headers).toContain('Chat-Group-Is-Broadcast: 1');
    });

    it('reaction inner MIME has Content-Disposition + group headers', () => {
        const target = '<orig@x>';
        const inner = buildInnerText(
            [
                `Content-Disposition: reaction`,
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                ...groupInnerHeaders(ctx(), [`In-Reply-To: ${target}`]),
            ],
            '👍',
        );
        expect(inner).toContain('Content-Disposition: reaction');
        expect(inner).toContain('Chat-Group-ID: g1abc');
        expect(inner).toContain(`In-Reply-To: ${target}`);
        expect(inner.endsWith('👍')).toBe(true);
    });

    it('delete inner MIME has Chat-Delete', () => {
        const target = '<del@x>';
        const inner = buildInnerText(
            [
                `Chat-Delete: ${target}`,
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                ...groupInnerHeaders(ctx()),
            ],
            '🚮',
        );
        expect(inner).toContain(`Chat-Delete: ${target}`);
        expect(inner).toContain('Chat-Group-ID: g1abc');
    });

    it('edit inner MIME has Chat-Edit + new text', () => {
        const target = '<edit@x>';
        const inner = buildInnerText(
            [
                `Chat-Edit: ${target}`,
                `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
                ...groupInnerHeaders(ctx()),
            ],
            'fixed text',
        );
        expect(inner).toContain(`Chat-Edit: ${target}`);
        expect(inner).toContain('fixed text');
    });

    it('group media multipart uses real MIME type not forced jpeg', () => {
        const inner = buildInnerMultipart({
            headers: groupInnerHeaders(ctx(), ['Chat-Duration: 1500']),
            text: 'clip',
            parts: [{
                mimeType: 'video/mp4',
                filename: 'clip.mp4',
                base64: 'AAAA',
                disposition: 'attachment',
            }],
            boundary: 'gmedia',
        });
        expect(inner).toContain('video/mp4; name="clip.mp4"');
        expect(inner).toContain('Chat-Duration: 1500');
        expect(inner).toContain('Chat-Group-ID: g1abc');
        expect(inner).not.toContain('image/jpeg');
    });
});
