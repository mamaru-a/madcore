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

Offline unit tests stay under `test/rpc/` (browser-compatible, no network).
