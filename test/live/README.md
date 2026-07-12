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
| **`download-madmail.sh`** | Fetch/extract madmail **binary** → `.tools/madmail` |
| **`madmail-binary-up.sh`** / **`madmail-binary-down.sh`** | Run/stop madmail binary (CI / no Docker service) |
| **`download-rpc-server.sh`** | Fetch `deltachat-rpc-server` into `.tools/` |
| **`core-rpc.ts`** | **Pure JS** JSON-RPC client for `deltachat-rpc-server` (stdio) |
| **`securejoin-docker.test.ts`** | bun:test SecureJoin matrix (madcore + core + cross) |
| **`messaging-docker.test.ts`** | bun:test send/recv **decrypted** text (core + madcore + cross) |
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
make test      # local: Docker madmail + core binary
make test-ci   # CI:    madmail binary + core binary
```

| Target | What it does |
|--------|----------------|
| **`make test`** | **Local full pipeline** (Docker madmail) |
| **`make test-ci`** | **CI full pipeline** (madmail + core **binaries**) |
| `make test-init` | prereqs only: rpc-server + Docker madmail + build |
| `make test-init-ci` | prereqs only: both binaries + binary madmail + build |
| `make test-unit` | offline unit only |
| `make test-sj` | live SecureJoin only |
| `make madmail-up` / `madmail-down` | Docker only |
| `make madmail-binary-up` / `madmail-binary-down` | binary only |
| `make download-core` / `download-madmail` | fetch binaries into `.tools/` |

**`make test` order (local / Docker):**

1. Download/link `deltachat-rpc-server` → `.tools/`
2. Start madmail Docker on `172.28.100.10` and **enable webimap + websmtp**
3. `bun run build`
4. Unit tests (`test/rpc/`)
5. Live SecureJoin (core ↔ core, madcore ↔ madcore, cross both ways)

**`make test-ci` order (pipeline / binary):**

1. Download `deltachat-rpc-server` → `.tools/`
2. Download/extract **madmail binary** → `.tools/madmail` (from GHCR image or GitHub release)
3. Run madmail process on `https://127.0.0.1:8443` (unprivileged ports) + webimap/websmtp
4. Build + unit + SecureJoin (same matrix)
5. Stop madmail

GitHub Actions: `.github/workflows/ci.yml` runs unit job + `make test-ci` live job.

### Manual (Docker)

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

### Manual (binary — CI-shaped)

```bash
bash test/live/download-rpc-server.sh
bash test/live/download-madmail.sh
bash test/live/madmail-binary-up.sh
bun run build
NODE_TLS_REJECT_UNAUTHORIZED=0 \
  MADMAIL_URL=https://127.0.0.1:8443 \
  bun test test/live/securejoin-docker.test.ts
bash test/live/madmail-binary-down.sh
```

| Setting | Docker (local) | Binary (CI) |
|---------|----------------|-------------|
| Identity IP | `172.28.100.10` | `127.0.0.1` |
| HTTPS | `https://172.28.100.10/` | `https://127.0.0.1:8443/` |
| Data dir | `.madmail-docker/` | `.madmail-binary/` |
| Madmail | container `ghcr.io/themadorg/madmail` | `.tools/madmail` process |
| Core binary | `.tools/deltachat-rpc-server` | same |

Both paths enable **webimap** + **websmtp** (required for madcore).

Skip live suite: `SKIP_LIVE_SJ=1 bun test …`

### Expected

```text
✓ madmail is reachable
✓ madcore ↔ madcore SecureJoin
✓ core ↔ core SecureJoin (deltachat-rpc-server)
✓ cross: core inviter → madcore joiner
✓ cross: madcore inviter → core joiner

✓ core ↔ core send/receive decrypted text
✓ madcore ↔ madcore send/receive decrypted text in store
✓ cross messaging: core ↔ madcore decrypted both ways
✓ cross messaging: madcore inviter ↔ core joiner decrypted both ways
```

Messaging tests assert **plaintext** after decrypt:
- **core** — `get_message().text` matches the sent string; `showPadlock === true`
- **madcore** — `getChatMessages()` (MemoryStore / IndexedDB) has the same text

Stop container: `make madmail-down` or `docker rm -f madmail-test`
