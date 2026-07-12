/**
 * Live messaging interop against madmail — pure JS.
 *
 * After SecureJoin, send plaintext on the wire (PGP/MIME) and assert that
 * each side stores the **decrypted** text:
 *   - core:  SQLite via get_message().text  (+ showPadlock for E2E)
 *   - madcore: MemoryStore/IndexedDB via getChatMessages().text
 *
 * Covers:
 *   1. core  → core
 *   2. madcore → madcore
 *   3. core  → madcore  and  madcore → core
 *
 * Setup:  make test-init  /  make test-init-ci
 * Run:    make test-sj    (or bun test test/live/messaging-docker.test.ts)
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { DeltaChatSDK } from "../../dist/account/manager.js";
import { setLogLevel } from "../../dist/lib/logger.js";
import {
  createConfiguredCoreAccount,
  coreGetSecureJoinQr,
  coreSecureJoin,
  coreSendText,
  coreGetMessage,
  coreWaitForTextMessage,
  coreChatIdForEmail,
  resolveRpcServerPath,
  type CoreAccountHandle,
} from "./core-rpc.js";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERVER = process.env.MADMAIL_URL || "https://172.28.100.10";
const TIMEOUT_MS = Number(process.env.SJ_TIMEOUT_MS || 90_000);
const MSG_TIMEOUT_MS = Number(process.env.MSG_TIMEOUT_MS || 45_000);
const SKIP = process.env.SKIP_LIVE_SJ === "1" || process.env.SKIP_LIVE_MSG === "1";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
setLogLevel(process.env.LOG_LEVEL || "warn");

async function madmailUp(): Promise<boolean> {
  try {
    const r = await fetch(SERVER + "/", { signal: AbortSignal.timeout(5000) });
    return r.ok || r.status === 200 || r.status === 404 || r.status === 301;
  } catch {
    return false;
  }
}

function rpcServerAvailable(): boolean {
  const path = resolveRpcServerPath();
  if (path.includes("/") && existsSync(path)) return true;
  const r = spawnSync(path, [], {
    env: { ...process.env, DC_ACCOUNTS_PATH: "/tmp/dc-msg-probe-" + process.pid },
    input: '{"jsonrpc":"2.0","method":"get_system_info","params":[],"id":1}\n',
    encoding: "utf8",
    timeout: 5000,
  });
  return (r.stdout || "").includes("deltachat_core_version") || r.status === 0;
}

async function madcoreAccount(name: string) {
  const dc = new DeltaChatSDK({ logLevel: "warn" });
  const reg = await dc.register(SERVER, name);
  const acc = reg.account || dc.getAccount(reg.id);
  if (!acc.getFingerprint()) await acc.generateKeys(name);
  await acc.connect();
  await new Promise((r) => setTimeout(r, 800));
  const email = (reg.email || acc.getCredentials().email).toLowerCase();
  return { dc, acc, email };
}

async function closeCore(h: CoreAccountHandle | null) {
  if (!h) return;
  try {
    await h.rpc.close();
  } catch {
    /* */
  }
  h.rpc.cleanupDir();
}

/** Poll madcore store until a chat message with matching plaintext appears. */
async function madcoreWaitForText(
  acc: {
    getChatMessages: (chatId: string, limit?: number, offset?: number) => Promise<
      Array<{ text?: string; encrypted?: boolean; direction?: string; from?: string }>
    >;
  },
  chatId: string,
  wantText: string,
  timeoutMs = MSG_TIMEOUT_MS,
): Promise<{ text: string; encrypted?: boolean; direction?: string; from?: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msgs = await acc.getChatMessages(chatId, 200, 0);
    const hit = msgs.find((m) => (m.text || "").includes(wantText));
    if (hit) return hit as { text: string; encrypted?: boolean; direction?: string; from?: string };
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`madcoreWaitForText timeout (${timeoutMs}ms) chat=${chatId} want=${wantText}`);
}

function uniqueText(tag: string): string {
  return `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

describe("Messaging live madmail", () => {
  let live = false;
  let hasCore = false;

  beforeAll(async () => {
    if (SKIP) return;
    live = await madmailUp();
    hasCore = rpcServerAvailable();
    if (live) {
      console.log(`\n  messaging madmail: ${SERVER}`);
      console.log(`  rpc-server: ${resolveRpcServerPath()} (available=${hasCore})\n`);
    }
  });

  test(
    "madmail is reachable (messaging)",
    async () => {
      if (SKIP) return;
      expect(live).toBe(true);
    },
    { timeout: 10_000 },
  );

  // ── core ↔ core: send + receive decrypted text ─────────────────────
  test(
    "core ↔ core send/receive decrypted text",
    async () => {
      if (SKIP || !live) return;
      if (!hasCore) throw new Error("deltachat-rpc-server not found — run make test-init");

      let alice: CoreAccountHandle | null = null;
      let bob: CoreAccountHandle | null = null;
      try {
        alice = await createConfiguredCoreAccount(SERVER, "Alice-core-msg");
        bob = await createConfiguredCoreAccount(SERVER, "Bob-core-msg");

        const qr = await coreGetSecureJoinQr(alice.rpc, alice.id);
        const joinerWait = bob.rpc.waitSecureJoinProgress(bob.id, "joiner", TIMEOUT_MS);
        const inviterWait = alice.rpc.waitSecureJoinProgress(alice.id, "inviter", TIMEOUT_MS + 15_000);
        await new Promise((r) => setTimeout(r, 200));
        const bobChatId = await coreSecureJoin(bob.rpc, bob.id, qr);
        await joinerWait;
        await Promise.race([
          inviterWait.then(() => true),
          new Promise((r) => setTimeout(() => r(false), 20_000)),
        ]);

        // Bob → Alice
        const textBA = uniqueText("core-bob-to-alice");
        const outId = await coreSendText(bob.rpc, bob.id, bobChatId, textBA);
        const outMsg = await coreGetMessage(bob.rpc, bob.id, outId);
        expect(outMsg.text).toBe(textBA);
        // Outgoing is stored decrypted locally
        expect(outMsg.showPadlock).toBe(true);

        const inAlice = await coreWaitForTextMessage(alice.rpc, alice.id, textBA, MSG_TIMEOUT_MS);
        expect(inAlice.text).toBe(textBA);
        expect(inAlice.showPadlock).toBe(true);
        expect(inAlice.isInfo).not.toBe(true);

        // Alice → Bob (chat id on inviter side)
        const aliceChatId = await coreChatIdForEmail(alice.rpc, alice.id, bob.email);
        const textAB = uniqueText("core-alice-to-bob");
        const outId2 = await coreSendText(alice.rpc, alice.id, aliceChatId, textAB);
        const outMsg2 = await coreGetMessage(alice.rpc, alice.id, outId2);
        expect(outMsg2.text).toBe(textAB);
        expect(outMsg2.showPadlock).toBe(true);

        const inBob = await coreWaitForTextMessage(bob.rpc, bob.id, textAB, MSG_TIMEOUT_MS);
        expect(inBob.text).toBe(textAB);
        expect(inBob.showPadlock).toBe(true);
      } finally {
        await closeCore(alice);
        await closeCore(bob);
      }
    },
    { timeout: TIMEOUT_MS + MSG_TIMEOUT_MS * 2 + 60_000 },
  );

  // ── madcore ↔ madcore: send + store plaintext ──────────────────────
  test(
    "madcore ↔ madcore send/receive decrypted text in store",
    async () => {
      if (SKIP || !live) return;

      const a = await madcoreAccount("Alice-mc-msg");
      const b = await madcoreAccount("Bob-mc-msg");
      const uri = a.acc.generateSecureJoinURI();
      const join = await Promise.race([
        b.acc.secureJoin(uri),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`SJ timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
        ),
      ]);
      expect(join.verified).toBe(true);

      // Give inviter a moment to process contact-confirm + open chat
      await new Promise((r) => setTimeout(r, 1000));

      const textBA = uniqueText("mc-bob-to-alice");
      await b.acc.sendMessage(a.email, textBA);
      // Outgoing is persisted decrypted in MemoryStore / IndexedDB
      const bOut = await b.acc.getChatMessages(a.email, 50, 0);
      expect(bOut.some((m) => m.text === textBA && m.direction === "outgoing")).toBe(true);

      const aIn = await madcoreWaitForText(a.acc, b.email, textBA);
      expect(aIn.text).toContain(textBA);
      // Incoming stored as plaintext after decrypt
      expect(aIn.direction).toBe("incoming");

      const textAB = uniqueText("mc-alice-to-bob");
      await a.acc.sendMessage(b.email, textAB);
      const aOut = await a.acc.getChatMessages(b.email, 50, 0);
      expect(aOut.some((m) => m.text === textAB && m.direction === "outgoing")).toBe(true);

      const bIn = await madcoreWaitForText(b.acc, a.email, textAB);
      expect(bIn.text).toContain(textAB);
      expect(bIn.direction).toBe("incoming");
    },
    { timeout: TIMEOUT_MS + MSG_TIMEOUT_MS * 2 + 60_000 },
  );

  // ── cross: core inviter ↔ madcore joiner ───────────────────────────
  test(
    "cross messaging: core ↔ madcore decrypted both ways",
    async () => {
      if (SKIP || !live) return;
      if (!hasCore) throw new Error("deltachat-rpc-server not found — run make test-init");

      let alice: CoreAccountHandle | null = null;
      try {
        alice = await createConfiguredCoreAccount(SERVER, "Alice-core-xmsg");
        const qr = await coreGetSecureJoinQr(alice.rpc, alice.id);
        const inviterWait = alice.rpc.waitSecureJoinProgress(
          alice.id,
          "inviter",
          TIMEOUT_MS + 30_000,
        );

        const bob = await madcoreAccount("Bob-mc-xmsg");
        const result = await Promise.race([
          bob.acc.secureJoin(qr),
          new Promise<never>((_, rej) =>
            setTimeout(() => rej(new Error(`SJ timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
          ),
        ]);
        expect(result.verified).toBe(true);
        await Promise.race([
          inviterWait.then(() => true),
          new Promise((r) => setTimeout(() => r(false), 25_000)),
        ]);
        // Inviter contact/chat rows can lag a moment after progress=1000
        await new Promise((r) => setTimeout(r, 1200));

        const aliceChatId = await coreChatIdForEmail(alice.rpc, alice.id, bob.email, {
          timeoutMs: 20_000,
        });

        // core → madcore
        const textCM = uniqueText("core-to-madcore");
        const outId = await coreSendText(alice.rpc, alice.id, aliceChatId, textCM);
        const outCore = await coreGetMessage(alice.rpc, alice.id, outId);
        expect(outCore.text).toBe(textCM);
        expect(outCore.showPadlock).toBe(true);

        const inMc = await madcoreWaitForText(bob.acc, alice.email, textCM);
        expect(inMc.text).toContain(textCM);
        expect(inMc.direction).toBe("incoming");

        // madcore → core
        const textMC = uniqueText("madcore-to-core");
        await bob.acc.sendMessage(alice.email, textMC);
        const bobOut = await bob.acc.getChatMessages(alice.email, 50, 0);
        expect(bobOut.some((m) => m.text === textMC && m.direction === "outgoing")).toBe(true);

        const inCore = await coreWaitForTextMessage(
          alice.rpc,
          alice.id,
          textMC,
          MSG_TIMEOUT_MS,
        );
        expect(inCore.text).toBe(textMC);
        // Core stores decrypted body; padlock means E2E on the wire
        expect(inCore.showPadlock).toBe(true);
      } finally {
        await closeCore(alice);
      }
    },
    { timeout: TIMEOUT_MS + MSG_TIMEOUT_MS * 2 + 90_000 },
  );

  // ── cross: madcore inviter ↔ core joiner ───────────────────────────
  test(
    "cross messaging: madcore inviter ↔ core joiner decrypted both ways",
    async () => {
      if (SKIP || !live) return;
      if (!hasCore) throw new Error("deltachat-rpc-server not found — run make test-init");

      let bob: CoreAccountHandle | null = null;
      try {
        const alice = await madcoreAccount("Alice-mc-xmsg2");
        const uri = alice.acc.generateSecureJoinURI();

        bob = await createConfiguredCoreAccount(SERVER, "Bob-core-xmsg2");
        const joinerWait = bob.rpc.waitSecureJoinProgress(bob.id, "joiner", TIMEOUT_MS);
        await new Promise((r) => setTimeout(r, 200));
        const bobChatId = await coreSecureJoin(bob.rpc, bob.id, uri);
        await joinerWait;
        await new Promise((r) => setTimeout(r, 800));

        // core (joiner) → madcore (inviter)
        const textCM = uniqueText("core-joiner-to-mc");
        const outId = await coreSendText(bob.rpc, bob.id, bobChatId, textCM);
        const outCore = await coreGetMessage(bob.rpc, bob.id, outId);
        expect(outCore.text).toBe(textCM);
        expect(outCore.showPadlock).toBe(true);

        const inMc = await madcoreWaitForText(alice.acc, bob.email, textCM);
        expect(inMc.text).toContain(textCM);

        // madcore → core
        const textMC = uniqueText("mc-inviter-to-core");
        await alice.acc.sendMessage(bob.email, textMC);
        const inCore = await coreWaitForTextMessage(bob.rpc, bob.id, textMC, MSG_TIMEOUT_MS);
        expect(inCore.text).toBe(textMC);
        expect(inCore.showPadlock).toBe(true);
      } finally {
        await closeCore(bob);
      }
    },
    { timeout: TIMEOUT_MS + MSG_TIMEOUT_MS * 2 + 90_000 },
  );
});
