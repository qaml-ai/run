# camelRun v2 (`camelrun-next`)

A clean-sheet rewrite of camelRun built on **100% Cloudflare Workers + SQLite Durable Objects** (zero Postgres, zero D1), paired with a **simplified Go `camelfsd` service** for Git-backed repositories and Firecracker session VMs.

## Architecture

- **`worker/`** — Cloudflare Worker (`Hono` v2 API, R2 media bucket, Cloudflare Queue webhooks/channels) with **only 2 Durable Object classes** communicating via **native Workers DO RPC**:
  - `TenantDO` — horizontally sharded per-tenant SQLite database + coordinator (`tenant_profile`, `api_keys`, `provider_keys`, `credit_ledger`, `usage_daily`, `definitions`, `agents_index`, `repos`, `webhooks`, `channels`, `active_leases`, `rate_buckets`). Tenant-routed bearer tokens (`cr_live_<tenantId>.<secret>` and `agt_tok_<tenantId>.<agentId>.<secret>`) hit `TenantDO` directly with zero single-region D1 bottleneck.
  - `AgentDO` — per-agent SQLite state (`config`, `messages`, `compactions`, `runs`, `steers`, `events`, `inputs`, `schedules`, `children`, `step_cache`, `vm_session`, `voice_sessions`), streaming turn loop (defaulting to `openrouter/meta/muse-ember`), batch & steer queues, compaction, instant fork, human inputs/approvals, hibernatable WebSockets, QuickJS `codemode`, sub-agent delegation, replay-based workflows, realtime voice broker, and dreaming.
- **`camelfsd/`** — Standalone Go service for content-addressed Git-like repos (`lineages`, `refs`, `leases`, `write`, `read`, `ls`, `grep`, `history`, `diff`, `restore`, `merge`, `fork`) and session VMs (`1 VM per (lineage, ref)` with persistent bash shells, atomic post-command commits, `billableMs` metering, and outbound compute host multiplexing). Supports both SQLite+FS (`--backend=local`) and 2-table DynamoDB+S3 (`--backend=aws`).
- **`sdk/`** — Zero-dependency TypeScript v2 client (`CamelRun`) with SSE streaming and bidirectional WebSocket local-tool serving (`defineTool`).
- **`tests/`** — End-to-end integration tests running real `workerd` (Miniflare) against a live compiled `camelfsd` server.

## Quickstart (Local Dev & Tests)

```sh
npm run typecheck
npm run test:go
npm run test:ts
```

See [docs/API_V2.md](docs/API_V2.md) and [docs/CAMELFS_CONTRACT.md](docs/CAMELFS_CONTRACT.md) for wire protocols.
