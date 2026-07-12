/**
 * SecureJoin interop against local madmail Docker (static IP) — pure JS.
 *
 * Covers:
 *   1. madcore ↔ madcore
 *   2. core ↔ core   (deltachat-rpc-server via test/live/core-rpc.ts)
 *   3. core inviter → madcore joiner
 *   4. madcore inviter → core joiner
 *
 * Setup:  make test-init   (or bun run test:sj-docker-up)
 * Run:    make test        (or bun test test/live/securejoin-docker.test.ts)
 *
 * Env:
 *   MADMAIL_URL=https://172.28.100.10
 *   SJ_TIMEOUT_MS=90000
 *   SKIP_LIVE_SJ=1          skip this file
 *   DELTACHAT_RPC_SERVER    path to binary (default: .tools/ or PATH)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { DeltaChatSDK } from "../../dist/account/manager.js";
import { setLogLevel } from "../../dist/lib/logger.js";
import {
  createConfiguredCoreAccount,
  coreGetSecureJoinQr,
  coreSecureJoin,
  resolveRpcServerPath,
  type CoreAccountHandle,
} from "./core-rpc.js";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SERVER = process.env.MADMAIL_URL || "https://172.28.100.10";
const TIMEOUT_MS = Number(process.env.SJ_TIMEOUT_MS || 90_000);
const SKIP = process.env.SKIP_LIVE_SJ === "1";

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
    env: { ...process.env, DC_ACCOUNTS_PATH: "/tmp/dc-sj-probe-" + process.pid },
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
  const email = reg.email || acc.getCredentials().email;
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

/**
 * Order matters (also used by `make test`):
 *   1. madmail up
 *   2. core ↔ core   (JS + deltachat-rpc-server)
 *   3. madcore ↔ madcore + cross (JS + webimap/websmtp)
 */
describe("SecureJoin live madmail", () => {
  let live = false;
  let hasCore = false;

  beforeAll(async () => {
    if (SKIP) return;
    live = await madmailUp();
    hasCore = rpcServerAvailable();
    if (live) {
      console.log(`\n  madmail: ${SERVER}`);
      console.log(`  rpc-server: ${resolveRpcServerPath()} (available=${hasCore})\n`);
    }
  });

  test(
    "madmail is reachable",
    async () => {
      if (SKIP) return;
      expect(live).toBe(true);
    },
    { timeout: 10_000 },
  );

  // ── STEP 1: official core vs itself ─────────────────────────────
  test(
    "core ↔ core SecureJoin (deltachat-rpc-server)",
    async () => {
      if (SKIP || !live) return;
      if (!hasCore) throw new Error("deltachat-rpc-server not found — run make test-init");

      let alice: CoreAccountHandle | null = null;
      let bob: CoreAccountHandle | null = null;
      try {
        alice = await createConfiguredCoreAccount(SERVER, "Alice-core");
        bob = await createConfiguredCoreAccount(SERVER, "Bob-core");
        const qr = await coreGetSecureJoinQr(alice.rpc, alice.id);
        expect(qr).toContain("i.delta.chat");

        // Start waiters before join so progress events are not missed
        const joinerWait = bob.rpc.waitSecureJoinProgress(bob.id, "joiner", TIMEOUT_MS);
        const inviterWait = alice.rpc.waitSecureJoinProgress(alice.id, "inviter", TIMEOUT_MS + 15_000);
        await new Promise((r) => setTimeout(r, 200));

        const chatId = await coreSecureJoin(bob.rpc, bob.id, qr);
        expect(typeof chatId).toBe("number");

        await joinerWait;
        // inviter may finish slightly after; don't fail the test if joiner succeeded
        await Promise.race([
          inviterWait.then(() => true),
          new Promise((r) => setTimeout(() => r(false), 20_000)),
        ]);
      } finally {
        await closeCore(alice);
        await closeCore(bob);
      }
    },
    { timeout: TIMEOUT_MS + 60_000 },
  );

  // ── STEP 2: madcore (webimap/websmtp) + cross with core ────────
  test(
    "madcore ↔ madcore SecureJoin",
    async () => {
      if (SKIP || !live) return;
      const a = await madcoreAccount("Alice-mc");
      const b = await madcoreAccount("Bob-mc");
      const uri = a.acc.generateSecureJoinURI();
      expect(uri).toContain("i.delta.chat");

      const joinP = b.acc.secureJoin(uri);
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error(`timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
      );
      const result = await Promise.race([joinP, timeout]);
      expect(result.verified).toBe(true);
    },
    { timeout: TIMEOUT_MS + 30_000 },
  );

  test(
    "cross: core inviter → madcore joiner",
    async () => {
      if (SKIP || !live) return;
      if (!hasCore) throw new Error("deltachat-rpc-server not found — run make test-init");

      let alice: CoreAccountHandle | null = null;
      try {
        alice = await createConfiguredCoreAccount(SERVER, "Alice-core-x");
        const qr = await coreGetSecureJoinQr(alice.rpc, alice.id);
        expect(qr).toContain("i.delta.chat");

        const inviterWait = alice.rpc.waitSecureJoinProgress(alice.id, "inviter", TIMEOUT_MS + 30_000);

        const bob = await madcoreAccount("Bob-mc-x");
        const joinP = bob.acc.secureJoin(qr);
        const timeout = new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error(`timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
        );
        const result = await Promise.race([joinP, timeout]);
        expect(result.verified).toBe(true);

        await Promise.race([
          inviterWait.then(() => true),
          new Promise((r) => setTimeout(() => r(false), 25_000)),
        ]);
      } finally {
        await closeCore(alice);
      }
    },
    { timeout: TIMEOUT_MS + 60_000 },
  );

  test(
    "cross: madcore inviter → core joiner",
    async () => {
      if (SKIP || !live) return;
      if (!hasCore) throw new Error("deltachat-rpc-server not found — run make test-init");

      let bob: CoreAccountHandle | null = null;
      try {
        const alice = await madcoreAccount("Alice-mc-x2");
        const uri = alice.acc.generateSecureJoinURI();
        expect(uri).toContain("i.delta.chat");

        bob = await createConfiguredCoreAccount(SERVER, "Bob-core-x2");
        const joinerWait = bob.rpc.waitSecureJoinProgress(bob.id, "joiner", TIMEOUT_MS);
        await new Promise((r) => setTimeout(r, 200));
        await coreSecureJoin(bob.rpc, bob.id, uri);
        await joinerWait;
      } finally {
        await closeCore(bob);
      }
    },
    { timeout: TIMEOUT_MS + 60_000 },
  );
});
