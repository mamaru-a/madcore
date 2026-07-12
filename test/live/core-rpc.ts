/**
 * Pure JS client for `deltachat-rpc-server` (JSON-RPC 2.0 over stdio).
 * Used by SecureJoin interop tests — no Python dependency.
 *
 * Protocol: one JSON object per line on stdin/stdout (same as Python
 * deltachat-rpc-client). Events are drained via long-polling
 * `get_next_event_batch`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL("../..", import.meta.url)));

export function resolveRpcServerPath(): string {
  if (process.env.DELTACHAT_RPC_SERVER) return process.env.DELTACHAT_RPC_SERVER;
  const local = join(ROOT, ".tools", "deltachat-rpc-server");
  if (existsSync(local)) return local;
  return "deltachat-rpc-server";
}

export type CoreEvent = {
  kind: string;
  progress?: number;
  [key: string]: unknown;
};

export class JsonRpcError extends Error {
  code?: number;
  data?: unknown;
  constructor(err: { message?: string; code?: number; data?: unknown } | string) {
    if (typeof err === "string") {
      super(err);
    } else {
      super(err.message || "JSON-RPC error");
      this.code = err.code;
      this.data = err.data;
    }
    this.name = "JsonRpcError";
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

/**
 * Low-level RPC process wrapper.
 */
export class CoreRpc {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = "";
  private eventQueues = new Map<number, CoreEvent[]>();
  private eventWaiters = new Map<number, Array<(e: CoreEvent) => void>>();
  private eventLoopRunning = false;
  private closing = false;
  accountsDir: string;

  constructor(accountsDir?: string) {
    this.accountsDir =
      accountsDir || join(tmpdir(), `dc-madcore-sj-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  }

  async start(rpcServerPath = resolveRpcServerPath()): Promise<Record<string, string>> {
    mkdirSync(this.accountsDir, { recursive: true });
    this.proc = spawn(rpcServerPath, [], {
      env: {
        ...process.env,
        DC_ACCOUNTS_PATH: this.accountsDir,
      },
      stdio: ["pipe", "pipe", "pipe"],
      // Detach from parent signal group so Ctrl-C on tests does not instantly kill mid-handshake
    });

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk: string) => {
      if (process.env.CORE_RPC_LOG === "1") {
        process.stderr.write(`[rpc-server] ${chunk}`);
      }
    });
    this.proc.on("exit", (code) => {
      for (const [, p] of this.pending) {
        p.reject(new JsonRpcError(`RPC server exited (code=${code})`));
      }
      this.pending.clear();
    });

    this.eventLoopRunning = true;
    void this.eventsLoop();

    const info = (await this.call("get_system_info")) as Record<string, string>;
    return info;
  }

  private onStdout(chunk: string) {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: { id?: number; result?: unknown; error?: { message?: string; code?: number; data?: unknown } };
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id == null) continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new JsonRpcError(msg.error));
      else p.resolve(msg.result);
    }
  }

  call(method: string, ...params: unknown[]): Promise<unknown> {
    if (!this.proc) return Promise.reject(new JsonRpcError("RPC not started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const req = JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n";
      this.proc!.stdin.write(req, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private enqueueEvent(accountId: number, event: CoreEvent) {
    const waiters = this.eventWaiters.get(accountId);
    if (waiters && waiters.length) {
      const w = waiters.shift()!;
      w(event);
      return;
    }
    let q = this.eventQueues.get(accountId);
    if (!q) {
      q = [];
      this.eventQueues.set(accountId, q);
    }
    q.push(event);
  }

  private async eventsLoop() {
    while (this.eventLoopRunning && !this.closing) {
      try {
        const batch = (await this.call("get_next_event_batch")) as Array<{
          contextId: number;
          event: CoreEvent;
        }>;
        if (!batch || !batch.length) continue;
        for (const item of batch) {
          this.enqueueEvent(item.contextId, item.event);
        }
        if (this.closing) break;
      } catch {
        if (this.closing || !this.eventLoopRunning) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  /** Take the next queued event, or wait until one arrives. */
  nextEvent(accountId: number, timeoutMs = 90_000): Promise<CoreEvent> {
    return new Promise((resolve, reject) => {
      const q = this.eventQueues.get(accountId);
      if (q && q.length) {
        resolve(q.shift()!);
        return;
      }
      const timer = setTimeout(() => {
        const waiters = this.eventWaiters.get(accountId) || [];
        this.eventWaiters.set(
          accountId,
          waiters.filter((w) => w !== onEvent),
        );
        reject(new Error("nextEvent timeout"));
      }, timeoutMs);
      const onEvent = (ev: CoreEvent) => {
        clearTimeout(timer);
        resolve(ev);
      };
      let waiters = this.eventWaiters.get(accountId);
      if (!waiters) {
        waiters = [];
        this.eventWaiters.set(accountId, waiters);
      }
      waiters.push(onEvent);
    });
  }

  /** Wait for next event on account (optionally matching kind; skips others). */
  async waitForEvent(accountId: number, kind?: string, timeoutMs = 90_000): Promise<CoreEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ev = await this.nextEvent(accountId, deadline - Date.now());
      if (!kind || ev.kind === kind) return ev;
    }
    throw new Error(`waitForEvent timeout kind=${kind ?? "*"}`);
  }

  /** Wait until SecureJoin progress reaches 1000 on joiner or inviter. */
  async waitSecureJoinProgress(
    accountId: number,
    side: "joiner" | "inviter",
    timeoutMs = 90_000,
  ): Promise<void> {
    const want = side === "joiner" ? "SecurejoinJoinerProgress" : "SecurejoinInviterProgress";
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ev = await this.nextEvent(accountId, Math.max(1, deadline - Date.now()));
      if (ev.kind === want && ev.progress === 1000) return;
    }
    throw new Error(`SecureJoin ${side} progress 1000 timeout`);
  }

  async close() {
    this.closing = true;
    this.eventLoopRunning = false;
    try {
      await this.call("stop_io_for_all_accounts");
    } catch {
      /* ignore */
    }
    if (this.proc) {
      try {
        this.proc.stdin.end();
      } catch {
        /* */
      }
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
  }

  /** Remove accounts dir (best-effort). */
  cleanupDir() {
    try {
      rmSync(this.accountsDir, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
}

export type CoreAccountHandle = {
  rpc: CoreRpc;
  id: number;
  email: string;
  dcloginUrl: string;
};

/**
 * Register a fresh chatmail account via madmail HTTPS `/new`, configure core
 * transport from the DCLOGIN QR, start IO, wait until configured.
 */
export async function createConfiguredCoreAccount(
  madmailUrl: string,
  label: string,
  opts: { timeoutMs?: number; rpcServerPath?: string } = {},
): Promise<CoreAccountHandle> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

  const regRes = await fetch(`${madmailUrl.replace(/\/$/, "")}/new`, { method: "POST" });
  if (!regRes.ok) throw new Error(`register failed status=${regRes.status}`);
  const info = (await regRes.json()) as { email: string; dclogin_url: string; password?: string };

  const rpc = new CoreRpc();
  await rpc.start(opts.rpcServerPath);
  const id = (await rpc.call("add_account")) as number;
  await rpc.call("add_transport_from_qr", id, info.dclogin_url);
  try {
    // Accept self-signed certs (IP relay)
    await rpc.call("set_config", id, "imap_certificate_checks", "3");
    await rpc.call("set_config", id, "smtp_certificate_checks", "3");
  } catch {
    /* older cores may use different keys */
  }
  try {
    await rpc.call("set_config", id, "displayname", label);
  } catch {
    /* */
  }

  await rpc.call("start_io", id);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const configured = (await rpc.call("is_configured", id)) as boolean;
    if (configured) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!(await rpc.call("is_configured", id))) {
    await rpc.close();
    throw new Error(`${label} not configured within ${timeoutMs}ms`);
  }

  return { rpc, id, email: info.email, dcloginUrl: info.dclogin_url };
}

export async function coreGetSecureJoinQr(rpc: CoreRpc, accountId: number): Promise<string> {
  return (await rpc.call("get_chat_securejoin_qr_code", accountId, null)) as string;
}

export async function coreSecureJoin(rpc: CoreRpc, accountId: number, qr: string): Promise<number> {
  return (await rpc.call("secure_join", accountId, qr)) as number;
}
