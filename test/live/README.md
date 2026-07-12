# Live madmail E2E suites

Modular live tests against a real chatmail/madmail host. **No secrets in git** — pass env vars.

```bash
SERVER_URL=https://your-host \
JOIN_URI='https://i.delta.chat/#…' \
bun run test:live-full
```

| File | Responsibility |
|------|----------------|
| `harness.ts` | pass/fail/skip, env, PNG fixtures |
| `account.ts` | register, keys, connect, transport |
| `securejoin.ts` | SecureJoin peer + QR helpers |
| `profile.ts` | display name / profile photo |
| `messaging.ts` | text, media, forward, delete, reactions |
| `webxdc-location-calls.ts` | webxdc, location, call signaling |
| `groups.ts` | groups + broadcast channels |
| `store-chat.ts` | chats, search, drafts, block |
| `config-backup.ts` | config, backup export, multi-relay |
| `run.ts` | orchestrator (entry for `test:live-full`) |
| **`madmail-docker-up.sh`** | Local madmail Docker (static IP `172.28.100.10`) |
| **`download-rpc-server.sh`** | Fetch `deltachat-rpc-server` into `.tools/` |
| **`core-rpc.ts`** | **Pure JS** JSON-RPC client for `deltachat-rpc-server` (stdio) |
| **`securejoin-docker.test.ts`** | bun:test SecureJoin matrix (madcore + core + cross) |
| `securejoin-docker.mjs` | thin CLI wrapper → bun test |
| `securejoin_core_helper.py` | legacy Python helper (optional; not required) |

Offline unit tests stay under `test/rpc/` (browser-compatible, no network).

Live tests typically use `MemoryStore` so they do not depend on a browser IDB.

---

## SecureJoin Docker interop (madcore + core) — **JS only**

Brings up **madmail** on a fixed Docker bridge IP, downloads **deltachat-rpc-server**, then runs bun tests:

1. **madcore ↔ madcore**
2. **core ↔ core** (via `core-rpc.ts` + `deltachat-rpc-server`)
3. **cross** both directions

### Recommended: one command

```bash
cd external/madcore
make test
```

| Target | What it does |
|--------|----------------|
| **`make test`** | **Full pipeline** (see below) |
| `make test-init` | prereqs only: rpc-server + madmail + build |
| `make test-unit` | offline unit only |
| `make test-sj` | live SecureJoin only |
| `make madmail-up` / `madmail-down` | Docker only (enables webimap + websmtp) |

**`make test` order:**

1. Download/link `deltachat-rpc-server` → `.tools/`
2. Start madmail on `172.28.100.10` and **enable webimap + websmtp**
3. `bun run build`
4. Unit tests (`test/rpc/`)
5. Live SecureJoin (declaration order in `securejoin-docker.test.ts`):
   - **core ↔ core**
   - **madcore ↔ madcore**
   - **cross** both ways

### Manual

```bash
# once
bash test/live/download-rpc-server.sh
bash test/live/madmail-docker-up.sh
bun run build

# run
NODE_TLS_REJECT_UNAUTHORIZED=0 \
  MADMAIL_URL=https://172.28.100.10 \
  bun test test/live/securejoin-docker.test.ts
```

| Setting | Value |
|---------|--------|
| Network | `madmail-test` `172.28.100.0/24` |
| Container IP | `172.28.100.10` |
| HTTPS | `https://172.28.100.10/` (also `https://127.0.0.1:8443/`) |
| Data dir | `external/madcore/.madmail-docker/` (gitignored) |
| Core binary | `.tools/deltachat-rpc-server` or `DELTACHAT_RPC_SERVER` / PATH |

`madmail-docker-up.sh` enables **webimap** + **websmtp** (required for madcore).

Skip live suite: `SKIP_LIVE_SJ=1 bun test …`

### Expected

```text
✓ madmail is reachable
✓ madcore ↔ madcore SecureJoin
✓ core ↔ core SecureJoin (deltachat-rpc-server)
✓ cross: core inviter → madcore joiner
✓ cross: madcore inviter → core joiner
```

Stop container: `make madmail-down` or `docker rm -f madmail-test`
