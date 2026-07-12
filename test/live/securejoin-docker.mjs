#!/usr/bin/env bun
/**
 * CLI entry for SecureJoin docker interop (pure JS).
 * Prefer:  bun test test/live/securejoin-docker.test.ts
 *      or: make test-sj
 *
 * This spawns the bun:test file so older scripts keep working without Python.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testFile = join(__dirname, "securejoin-docker.test.ts");

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
process.env.MADMAIL_URL = process.env.MADMAIL_URL || "https://172.28.100.10";

const child = spawn("bun", ["test", testFile], {
  stdio: "inherit",
  env: process.env,
  cwd: join(__dirname, "../.."),
});

child.on("exit", (code) => process.exit(code ?? 1));
