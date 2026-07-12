/**
 * lib/crypto.ts — PGP encryption, key generation, and Autocrypt
 *
 * Extracted from sdk.ts. Pure functions for:
 *   - Generating PGP keypair (Curve25519)
 *   - Encrypting MIME payloads
 *   - Building Autocrypt headers
 *   - Extracting Autocrypt keydata from armored keys
 */

import * as openpgp from 'openpgp';

/** Generate a PGP keypair for the given email/name, returns keys + metadata */
export async function generateKeys(email: string, name?: string): Promise<{
    privateKey: openpgp.PrivateKey;
    publicKey: openpgp.Key;
    fingerprint: string;
    autocryptKeydata: string;
    armoredPublicKey: string;
}> {
    // OpenPGP.js rejects bracket-wrapped IP domains — strip for key gen
    const pgpEmail = email.replace(/\[([^\]]+)\]/, '$1');
    const { privateKey, publicKey } = await openpgp.generateKey({
        type: 'ecc',
        curve: 'curve25519' as any,
        userIDs: [{ name: name || undefined, email: pgpEmail }],
        passphrase: '',
        format: 'armored',
        config: {
            // Classic v4 signatures without openpgp.js salt notations —
            // better interop with rPGP / Delta Chat core Autocrypt import.
            nonDeterministicSignaturesViaNotation: false,
            v6Keys: false,
        },
    });

    const privKey = await openpgp.readPrivateKey({ armoredKey: privateKey });
    const pubKey = await openpgp.readKey({ armoredKey: publicKey });
    const fingerprint = pubKey.getFingerprint().toUpperCase();
    const autocryptKeydata = extractAutocryptKeydata(publicKey);

    return {
        privateKey: privKey,
        publicKey: pubKey,
        fingerprint,
        autocryptKeydata,
        armoredPublicKey: publicKey,
    };
}

/**
 * Normalize addr for headers / Autocrypt so it matches key UIDs and core parsers.
 * Chatmail accounts on bare IPs are often registered as `user@[1.2.3.4]`; OpenPGP
 * key UIDs and many MUAs prefer `user@1.2.3.4`. Keep envelope `from` as registered.
 */
export function headerEmail(email: string): string {
    return (email || '')
        .trim()
        .toLowerCase()
        .replace(/@\[([^\]]+)\]/g, '@$1');
}

/** Case + domain-literal insensitive email equality (`a@[1.2.3.4]` == `a@1.2.3.4`). */
export function emailsEqual(a?: string | null, b?: string | null): boolean {
    if (!a || !b) return false;
    return headerEmail(a) === headerEmail(b);
}

/** All lookup keys for an email (bracketed + bare IP forms). */
export function emailKeyVariants(email: string): string[] {
    const raw = (email || '').trim().toLowerCase();
    const bare = headerEmail(raw);
    const out = new Set<string>();
    if (raw) out.add(raw);
    if (bare) out.add(bare);
    // Reconstruct bracketed form for pure-IPv4 hosts
    if (bare && bare.includes('@')) {
        const [local, host] = bare.split('@');
        if (host && /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
            out.add(`${local}@[${host}]`);
        }
    }
    return [...out];
}

/** Store a peer public key under every email variant (Autocrypt addr vs From:). */
export function setKnownKey(map: Map<string, string>, email: string, armoredKey: string): void {
    for (const k of emailKeyVariants(email)) {
        map.set(k, armoredKey);
    }
}

/** Look up a peer key trying bracketed and bare forms. */
export function getKnownKey(map: Map<string, string>, email: string): string | undefined {
    for (const k of emailKeyVariants(email)) {
        const v = map.get(k);
        if (v) return v;
    }
    return undefined;
}

/** Shared encrypt config for openpgp.js ↔ rPGP / Delta Chat core interop. */
const ENCRYPT_CONFIG = {
    preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed,
    nonDeterministicSignaturesViaNotation: false,
    // Prefer SEIPDv1 for maximum rPGP/core compatibility on older builds
    aeadProtect: false,
} as const;

/**
 * Public keys we encrypt to for a peer message.
 * Recipient first (required). Self second when provided (multi-device / self-read).
 * Never drop the recipient — that caused desktop `decrypt_with_keys: missing key`.
 */
async function encryptionKeyList(
    recipientArmored: string,
    selfPublicKey: openpgp.Key | null,
): Promise<openpgp.Key[]> {
    const recipientKey = await openpgp.readKey({ armoredKey: recipientArmored });
    // Prefer the encryption-capable key material openpgp will actually use
    const keys: openpgp.Key[] = [recipientKey];
    if (selfPublicKey) {
        const selfFp = selfPublicKey.getFingerprint().toUpperCase();
        const peerFp = recipientKey.getFingerprint().toUpperCase();
        if (selfFp !== peerFp) keys.push(selfPublicKey);
    }
    return keys;
}

/** Encrypt a text payload inside a simple PGP/MIME structure */
export async function encryptText(
    text: string,
    recipientArmored: string,
    selfPublicKey: openpgp.Key,
    signingKey: openpgp.PrivateKey,
    opts: { from: string; to: string; displayName?: string }
): Promise<string> {
    const date = new Date().toUTCString();
    const fromHeader = opts.displayName
        ? `From: "${opts.displayName}" <${opts.from}>`
        : `From: <${opts.from}>`;

    // Match core: binary literal data (not "text" mode with newline normalization)
    const mimePayload = [
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
        fromHeader,
        `To: <${opts.to}>`,
        `Date: ${date}`,
        '',
        text,
    ].join('\r\n');

    const encryptionKeys = await encryptionKeyList(recipientArmored, selfPublicKey);
    const encrypted = await openpgp.encrypt({
        message: await openpgp.createMessage({
            binary: new TextEncoder().encode(mimePayload),
        }),
        encryptionKeys,
        signingKeys: signingKey,
        format: 'armored',
        config: ENCRYPT_CONFIG,
    });
    return encrypted as string;
}

/** Encrypt a raw MIME payload (already constructed) */
export async function encryptRaw(
    rawMimePayload: string,
    recipientArmored: string,
    selfPublicKey: openpgp.Key,
    signingKey: openpgp.PrivateKey
): Promise<string> {
    // Binary message → Binary signature type (core encrypts MIME as bytes, not "text").
    // Uncompressed — core disables compression for SecureJoin to avoid token side-channels.
    // Disable openpgp.js salt notations for broader rPGP / older-core interop.
    const encryptionKeys = await encryptionKeyList(recipientArmored, selfPublicKey);
    const encrypted = await openpgp.encrypt({
        message: await openpgp.createMessage({
            binary: new TextEncoder().encode(rawMimePayload),
        }),
        encryptionKeys,
        signingKeys: signingKey,
        format: 'armored',
        config: ENCRYPT_CONFIG,
    });
    return encrypted as string;
}

/**
 * Extract a single armored PGP message block from a MIME body / raw dump.
 * Strips trailing multipart boundaries that break some OpenPGP parsers.
 */
export function extractArmoredPgpMessage(raw: string): string | null {
    if (!raw) return null;
    const start = raw.indexOf('-----BEGIN PGP MESSAGE-----');
    if (start < 0) return null;
    const endMarker = '-----END PGP MESSAGE-----';
    const end = raw.indexOf(endMarker, start);
    let block =
        end < 0
            ? raw.slice(start).trim()
            : raw.slice(start, end + endMarker.length).trim();
    // Normalize line endings — mixed CRLF/LF in armor can break base64 decode
    // enough to yield wrong session-key material (AES-KW "Key Data Integrity").
    block = block.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return block;
}

function decodeDecryptPayload(data: unknown): string {
    if (typeof data === 'string') return data;
    if (data instanceof Uint8Array) return new TextDecoder().decode(data);
    return String(data);
}

/**
 * Decrypt a PGP message using the private key.
 *
 * rPGP (Delta Chat desktop) and openpgp.js sometimes disagree on ECDH/AES-KW
 * webcrypto paths → "Key Data Integrity failed". We retry with a re-read key
 * and with session keys decrypted only via the encryption subkey when needed.
 */
export async function decrypt(
    armoredMessage: string,
    decryptionKey: openpgp.PrivateKey
): Promise<string> {
    const cleaned = extractArmoredPgpMessage(armoredMessage) || armoredMessage.trim();
    const message = await openpgp.readMessage({ armoredMessage: cleaned });

    const decryptOpts = {
        // Do not require signature — core also accepts unsigned encrypted mail
        config: {
            allowUnauthenticatedMessages: true,
            allowMissingKeyFlags: true,
            // Interop: some rPGP messages use AES-192; Chromium WebCrypto rejects it
            // and openpgp may mis-report as integrity failure in edge cases.
            preferredSymmetricAlgorithm: openpgp.enums.symmetric.aes256,
        },
    } as const;

    const tryDecrypt = async (key: openpgp.PrivateKey) => {
        const { data } = await openpgp.decrypt({
            message,
            decryptionKeys: key,
            ...decryptOpts,
        });
        return decodeDecryptPayload(data);
    };

    const errors: string[] = [];
    for (const attempt of [
        () => tryDecrypt(decryptionKey),
        async () => {
            const re = await openpgp.readPrivateKey({ armoredKey: decryptionKey.armor() });
            return tryDecrypt(re);
        },
    ]) {
        try {
            return await attempt();
        } catch (e: any) {
            errors.push(e?.message || String(e));
        }
    }

    try {
        const encIds = message.getEncryptionKeyIDs?.().map((id: any) => id.toHex?.() || String(id)) || [];
        const ourIds = decryptionKey.getKeys().map(k => k.getKeyID().toHex());
        logDecryptFailure(errors[errors.length - 1] || 'decrypt failed', encIds, ourIds);
    } catch {
        /* ignore diag */
    }
    throw new Error(errors[errors.length - 1] || 'decrypt failed');
}

function logDecryptFailure(msg: string, encIds: string[], ourIds: string[]): void {
    // Dynamic import avoided — use console so browser users see it next to OpenPGP debug
    console.warn(
        `[madcore decrypt] ${msg}\n  message keyIDs: ${encIds.join(', ') || '(none)'}\n  our keyIDs:     ${ourIds.join(', ') || '(none)'}`,
    );
}

/** Extract base64 keydata from an armored PGP public key (for Autocrypt header) */
export function extractAutocryptKeydata(armoredKey: string): string {
    const lines = armoredKey.split(/\r?\n/);
    let inBody = false;
    const b64Lines = [];
    for (const line of lines) {
        if (line === '') { inBody = true; continue; }
        if (!inBody) continue;
        if (line.startsWith('-----END')) break;
        if (line.startsWith('=')) continue;
        b64Lines.push(line.trim());
    }
    return b64Lines.join('');
}

/** Fold keydata for Autocrypt-style headers. */
function foldKeydata(autocryptKeydata: string): string {
    let folded = '';
    for (let i = 0; i < autocryptKeydata.length; i += 76) {
        if (i > 0) folded += '\r\n ';
        folded += autocryptKeydata.substring(i, i + 76);
    }
    return folded;
}

/**
 * Build Autocrypt header.
 *
 * Core (`mimeparser.rs`) only imports Autocrypt when `addr` matches `From:`
 * via `addr_cmp` (case-fold only — **does not** equate `user@[ip]` with
 * `user@ip`). Emitting a bare-IP twin caused:
 *   Autocrypt header address "user@ip" is not "user@[ip]"
 * and if the matching header is missing/mis-ordered, desktop never stores our
 * key — then `decrypt_with_keys: missing key` / force_encryption drops mail.
 *
 * Always set `addr` to the **exact** envelope/From address (usually
 * credentials.email including domain-literal brackets).
 */
export function buildAutocryptHeader(email: string, autocryptKeydata: string): string {
    const addr = (email || '').trim().toLowerCase();
    const folded = foldKeydata(autocryptKeydata);
    return `Autocrypt: addr=${addr}; prefer-encrypt=mutual;\r\n keydata=${folded}`;
}

/** Import an Autocrypt key from a header value, returns email + armored key or null */
export function parseAutocryptHeader(headerValue: string): { addr: string; armoredKey: string } | null {
    const addrMatch = headerValue.match(/addr=([^;]+)/i);
    const keydataMatch = headerValue.match(/keydata=(.+)/is);
    if (!addrMatch || !keydataMatch) return null;

    const addr = addrMatch[1].trim().toLowerCase();
    const keydata = keydataMatch[1].replace(/\s/g, '');
    const armoredKey = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${keydata}\n-----END PGP PUBLIC KEY BLOCK-----`;
    return { addr, armoredKey };
}
/** Parse an armored public key and return its fingerprint */
export async function getFingerprintFromArmored(armoredKey: string): Promise<string> {
    const key = await openpgp.readKey({ armoredKey });
    return key.getFingerprint().toUpperCase();
}
