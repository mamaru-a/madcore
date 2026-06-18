/**
 * SDKContext — shared state interface passed to all lib modules.
 * This allows extracted functions to access SDK internals without
 * being coupled to the SDK class itself.
 */
import * as openpgp from 'openpgp';
import type { Credentials, IncomingMessage, ParsedMessage } from '../types';

export interface SDKContext {
    serverUrl: string;
    credentials: Credentials;
    privateKey: openpgp.PrivateKey | null;
    publicKey: openpgp.Key | null;
    fingerprint: string;
    autocryptKeydata: string;
    displayName: string;
    knownKeys: Map<string, string>;        // email → armored public key
    peerAvatars: Map<string, string>;      // email → data URI

    // Profile photo state
    profilePhotoB64: string;
    profilePhotoMime: string;
    profilePhotoChanged: boolean;
    sentAvatarTo: Set<string>;

    // Methods from SDK that helpers need
    generateMsgId(): string;
    buildAutocryptHeader(): string;
    encryptRaw(rawMimePayload: string, recipientArmored: string): Promise<string>;
    encrypt(text: string, recipientArmored: string, opts: { from: string; to: string }): Promise<string>;
    sendRaw(from: string, to: string[], body: string): Promise<void>;
    sendMessage(toEmail: string, text: string): Promise<string>;
    foldBase64(b64: string): string;
    waitForMessage(predicate: (msg: ParsedMessage) => boolean, timeoutMs: number): Promise<ParsedMessage>;
}
