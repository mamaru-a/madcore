/**
 * lib/backup.ts — Export / import account backup as encrypted JSON.
 *
 * Format (version 1):
 *   { v: 1, createdAt, account, contacts, chats, messages, config? }
 * Optional passphrase: AES-GCM via Web Crypto (raw base64 envelope).
 */

import type { StoredAccount, StoredChat, StoredContact, StoredMessage } from '../store';

export const BACKUP_VERSION = 1;

export interface BackupPayload {
    v: number;
    createdAt: number;
    account: StoredAccount;
    contacts: StoredContact[];
    chats: StoredChat[];
    messages: StoredMessage[];
    config?: Record<string, string>;
    /** Known peer keys: email → armored public key */
    knownKeys?: Record<string, string>;
}

export interface EncryptedBackupBlob {
    v: number;
    enc: true;
    salt: string;   // base64
    iv: string;     // base64
    data: string;   // base64 ciphertext
}

function b64encode(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function b64decode(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder();
    const baseKey = await crypto.subtle.importKey(
        'raw',
        enc.encode(passphrase),
        'PBKDF2',
        false,
        ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: salt as BufferSource, iterations: 100_000, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/** Serialize backup as plain JSON string */
export function serializeBackup(payload: BackupPayload): string {
    return JSON.stringify({ ...payload, v: BACKUP_VERSION });
}

/** Parse plain JSON backup */
export function parseBackup(json: string): BackupPayload {
    const obj = JSON.parse(json);
    if (!obj || obj.v !== BACKUP_VERSION) {
        throw new Error(`Unsupported backup version: ${obj?.v}`);
    }
    if (!obj.account?.email) {
        throw new Error('Invalid backup: missing account');
    }
    return obj as BackupPayload;
}

/** Encrypt backup JSON with passphrase (AES-GCM) */
export async function encryptBackup(json: string, passphrase: string): Promise<EncryptedBackupBlob> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        new TextEncoder().encode(json),
    );
    return {
        v: BACKUP_VERSION,
        enc: true,
        salt: b64encode(salt),
        iv: b64encode(iv),
        data: b64encode(ct),
    };
}

/** Decrypt passphrase-protected backup blob → JSON string */
export async function decryptBackup(blob: EncryptedBackupBlob, passphrase: string): Promise<string> {
    if (!blob.enc) throw new Error('Not an encrypted backup');
    const salt = b64decode(blob.salt);
    const iv = b64decode(blob.iv);
    const key = await deriveKey(passphrase, salt);
    const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        b64decode(blob.data) as BufferSource,
    );
    return new TextDecoder().decode(pt);
}

/**
 * Accept either plain JSON string, parsed BackupPayload, or EncryptedBackupBlob.
 * Returns BackupPayload.
 */
export async function loadBackup(
    input: string | BackupPayload | EncryptedBackupBlob,
    passphrase?: string,
): Promise<BackupPayload> {
    if (typeof input === 'object' && input !== null && 'account' in input && 'v' in input && !('enc' in input)) {
        return input as BackupPayload;
    }

    let json: string;
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (trimmed.startsWith('{')) {
            const obj = JSON.parse(trimmed);
            if (obj.enc === true) {
                if (!passphrase) throw new Error('Passphrase required for encrypted backup');
                json = await decryptBackup(obj as EncryptedBackupBlob, passphrase);
            } else {
                json = trimmed;
            }
        } else {
            throw new Error('Backup must be JSON');
        }
    } else if (typeof input === 'object' && (input as EncryptedBackupBlob).enc) {
        if (!passphrase) throw new Error('Passphrase required for encrypted backup');
        json = await decryptBackup(input as EncryptedBackupBlob, passphrase);
    } else {
        throw new Error('Invalid backup input');
    }

    return parseBackup(json);
}
