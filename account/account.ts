/**
 * DeltaChatAccount — concrete account class (public API surface).
 *
 * Inheritance chain:
 *   AccountBase → Contacts → Messaging → Groups → SecureJoin →
 *   Profile → Inbox → Features → DeltaChatAccount
 */
import type { IDeltaChatStore } from '../store.js';
import { AccountFeatures } from './features.js';

export class DeltaChatAccount extends AccountFeatures {
    /** Static factory to load an account from a store */
    static async fromStore(store: IDeltaChatStore): Promise<DeltaChatAccount | undefined> {
        const acc = new DeltaChatAccount(store);
        const ok = await acc.loadFromStore();
        return ok ? acc : undefined;
    }
}
