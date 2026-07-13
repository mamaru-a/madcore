import { describe, it, expect } from 'bun:test';
import * as openpgp from 'openpgp';
import { encryptSymmetricSecureJoinRpgp } from '../../lib/pgp-rpgp-symm';
import { generateKeys, secureJoinSharedSecret } from '../../lib/crypto';
import { buildSymmSecureJoinInnerMime } from '../../lib/mime-build';

describe('pgp-rpgp-symm', () => {
    it('produces salted S2K + signed SEIPDv2 roundtrip', async () => {
        const { privateKey, publicKey, fingerprint } = await generateKeys('alice@test.example', 'Alice');
        const auth = 'authcode99';
        const secret = secureJoinSharedSecret(fingerprint, auth);
        const inner = buildSymmSecureJoinInnerMime({
            step: 'vc-pubkey',
            auth,
            fromAddr: 'alice@test.example',
            msgId: '<vc@example.com>',
            date: 'Mon, 1 Jan 2024 00:00:00 GMT',
            autocryptHeader: 'Autocrypt: addr=alice@test.example; prefer-encrypt=mutual;\r\n keydata=KEY',
        });

        const armored = await encryptSymmetricSecureJoinRpgp(inner, secret, privateKey);
        const msg = await openpgp.readMessage({ armoredMessage: armored });
        const packets = [...msg.packets].map(p => p.constructor.name);
        expect(packets[0]).toBe('SymEncryptedSessionKeyPacket');
        expect(packets[1]).toBe('SymEncryptedIntegrityProtectedDataPacket');

        const { data, signatures } = await openpgp.decrypt({
            message: msg,
            passwords: [secret],
            verificationKeys: publicKey,
            config: {
                allowUnauthenticatedMessages: true,
                enableParsingV5Entities: true,
            },
        });
        const plain = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
        expect(plain).toContain('Secure-Join: vc-pubkey');
        expect(signatures.length).toBeGreaterThan(0);
        await expect(signatures[0]!.verified).resolves.toBe(true);

        const skesk = [...msg.packets].find(p => p.constructor.name === 'SymEncryptedSessionKeyPacket');
        expect(skesk).toBeDefined();
        expect((skesk as { version?: number }).version).toBe(4);
    });
});