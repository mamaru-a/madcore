/**
 * Numeric ID maps — core JSON-RPC uses u32 ids; madcore uses string keys.
 */

const FIRST_NORMAL_CHAT = 10; // DC_CHAT_ID_LAST_SPECIAL + 1
const FIRST_CONTACT = 10;
const FIRST_MSG = 1000;

export const SELF_CONTACT_ID = 1;
export const INFO_CONTACT_ID = 2;
export const DEVICE_CONTACT_ID = 5;

export class IdMap {
    private chatToNum = new Map<string, number>();
    private numToChat = new Map<number, string>();
    private contactToNum = new Map<string, number>();
    private numToContact = new Map<number, string>();
    private msgToNum = new Map<string, number>();
    private numToMsg = new Map<number, string>();
    private nextChat = FIRST_NORMAL_CHAT;
    private nextContact = FIRST_CONTACT;
    private nextMsg = FIRST_MSG;

    chatId(key: string): number {
        const k = key.toLowerCase();
        let n = this.chatToNum.get(k);
        if (n == null) {
            n = this.nextChat++;
            this.chatToNum.set(k, n);
            this.numToChat.set(n, key);
        }
        return n;
    }

    chatKey(id: number): string | undefined {
        return this.numToChat.get(id);
    }

    contactId(key: string): number {
        const k = key.toLowerCase();
        let n = this.contactToNum.get(k);
        if (n == null) {
            n = this.nextContact++;
            this.contactToNum.set(k, n);
            this.numToContact.set(n, key);
        }
        return n;
    }

    contactKey(id: number): string | undefined {
        return this.numToContact.get(id);
    }

    msgId(key: string): number {
        let n = this.msgToNum.get(key);
        if (n == null) {
            n = this.nextMsg++;
            this.msgToNum.set(key, n);
            this.numToMsg.set(n, key);
        }
        return n;
    }

    msgKey(id: number): string | undefined {
        return this.numToMsg.get(id);
    }
}
