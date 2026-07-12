/**
 * Shared pure helpers for the account layer.
 */

/** Generate a short random account ID */
export function generateAccountId(): string {
    return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/** Normalize relay server URL for map keys / dedupe (strip trailing slashes). */
export function normalizeServerUrl(url: string): string {
    return (url || '').trim().replace(/\/+$/, '');
}

export type RelayRecord = {
    id: string;
    serverUrl: string;
    email: string;
    password: string;
};

/**
 * One entry per serverUrl. Later rows overwrite earlier (callers should put
 * primary last so it wins). Keeps stable ids when possible.
 */
export function dedupeRelaysByServerUrl(
    relays: Iterable<RelayRecord>,
): RelayRecord[] {
    const byUrl = new Map<string, RelayRecord>();
    for (const r of relays) {
        const serverUrl = normalizeServerUrl(r.serverUrl);
        if (!serverUrl) continue;
        const prev = byUrl.get(serverUrl);
        const password =
            (r.password && r.password.length > 0
                ? r.password
                : prev?.password) || '';
        const email = r.email || prev?.email || '';
        byUrl.set(serverUrl, {
            id: prev?.id || r.id || generateAccountId(),
            serverUrl,
            email,
            password,
        });
    }
    return [...byUrl.values()];
}

/** Browser-safe base64 encode (no Node Buffer) */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}
