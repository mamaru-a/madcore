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

/** Encrypt a text payload inside a simple PGP/MIME structure */
export async function encryptText(
    text: string,
    recipientArmored: string,
    selfPublicKey: openpgp.Key,
    signingKey: openpgp.PrivateKey,
    opts: { from: string; to: string; displayName?: string }
): Promise<string> {
    const recipientKey = await openpgp.readKey({ armoredKey: recipientArmored });
    const date = new Date().toUTCString();
    const fromHeader = opts.displayName
        ? `From: "${opts.displayName}" <${opts.from}>`
        : `From: <${opts.from}>`;

    const mimePayload = [
        `Content-Type: text/plain; charset="utf-8"; protected-headers="v1"`,
        fromHeader,
        `To: <${opts.to}>`,
        `Date: ${date}`,
        '',
        text
    ].join('\r\n');

    const encrypted = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: mimePayload }),
        encryptionKeys: [selfPublicKey, recipientKey],
        signingKeys: signingKey,
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
    const recipientKey = await openpgp.readKey({ armoredKey: recipientArmored });
    const encrypted = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: rawMimePayload }),
        encryptionKeys: [selfPublicKey, recipientKey],
        signingKeys: signingKey,
    });
    return encrypted as string;
}

/** Decrypt a PGP message using the private key */
export async function decrypt(
    armoredMessage: string,
    decryptionKey: openpgp.PrivateKey
): Promise<string> {
    const message = await openpgp.readMessage({ armoredMessage });
    const { data } = await openpgp.decrypt({
        message,
        decryptionKeys: decryptionKey,
    });
    return data as string;
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

/** Normalize email for Autocrypt/map keys (keep IP-literal brackets). */
export function normalizeEmailAddr(email: string): string {
    return email.trim().toLowerCase();
}

/** Build the Autocrypt header string (folded at 76 chars) */
export function buildAutocryptHeader(email: string, autocryptKeydata: string): string {
    let folded = '';
    for (let i = 0; i < autocryptKeydata.length; i += 76) {
        if (i > 0) folded += '\r\n ';
        folded += autocryptKeydata.substring(i, i + 76);
    }
    // Use the live account address as-is (including user@[ip] form)
    return `Autocrypt: addr=${normalizeEmailAddr(email)}; prefer-encrypt=mutual;\r\n keydata=${folded}`;
}

/** Import an Autocrypt key from a header value, returns email + armored key or null */
export function parseAutocryptHeader(headerValue: string): { addr: string; armoredKey: string } | null {
    const addrMatch = headerValue.match(/addr=([^;]+)/i);
    const keydataMatch = headerValue.match(/keydata=(.+)/is);
    if (!addrMatch || !keydataMatch) return null;

    const addr = normalizeEmailAddr(addrMatch[1]);
    const keydata = keydataMatch[1].replace(/\s/g, '');
    const armoredKey = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${keydata}\n-----END PGP PUBLIC KEY BLOCK-----`;
    return { addr, armoredKey };
}

/** Store a peer key under primary + common IP-literal alias forms. */
export function rememberPeerKey(knownKeys: Map<string, string>, addr: string, armoredKey: string): void {
    const primary = normalizeEmailAddr(addr);
    knownKeys.set(primary, armoredKey);
    // Alias: user@1.2.3.4 ↔ user@[1.2.3.4]
    const m = primary.match(/^([^@]+)@\[([^\]]+)\]$/);
    if (m) {
        knownKeys.set(`${m[1]}@${m[2]}`, armoredKey);
        return;
    }
    const m2 = primary.match(/^([^@]+)@(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (m2) {
        knownKeys.set(`${m2[1]}@[${m2[2]}]`, armoredKey);
    }
}
/** Parse an armored public key and return its fingerprint */
export async function getFingerprintFromArmored(armoredKey: string): Promise<string> {
    const key = await openpgp.readKey({ armoredKey });
    return key.getFingerprint().toUpperCase();
}
