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

## Persistent Firecracker workspaces

The Worker uses the existing camelFS API. For `--vm-driver=firecracker`, v2 camelfsd stores a disk map in each repository commit. The AWS backend stores the map and the disk's content-addressed 256 KiB chunks in S3. The ref update publishes the tree and disk together.

Provision one empty ext4 template and compile the workspace editor on Linux with the e2fsprogs development headers. For example, on Ubuntu with `libext2fs-dev` installed:

```sh
cd v2/camelfsd
cc -O2 -Wall -Wextra -Werror tools/workspace-editor/edit.c -lext2fs -o /opt/camelfs-workspace-editor
mkfs.ext4 -F /var/lib/camelfsd/empty-workspace.ext4 512M
```

Configure camelfsd with `--workspace-template /var/lib/camelfsd/empty-workspace.ext4`, `--workspace-editor /opt/camelfs-workspace-editor`, and `--workspace-nbd /dev/nbd0,/dev/nbd1`. The daemon needs access to the kernel's NBD driver and one dedicated NBD device per running Firecracker guest. The guest rootfs must mount the workspace drive at `/workspace` and serve the existing v2 vsock protocol. Use absolute paths for the Firecracker kernel and rootfs.

While the VM sleeps, a write edits only the necessary ranges of its parent ext4 image with libext2fs. A start loads the committed map and fetches chunks on demand. A live file write is also sent to the running guest. Guest commands still use the v2 file snapshot protocol, and camelfsd applies changed regular files from that snapshot to the persistent disk. This keeps the repository history and disk in sync. Guest-only directory metadata, symlinks, and other state outside the repository tree are outside that checkpoint contract.

For a v2 commit created without a disk map, make a new commit on its ref through the write API with disk storage enabled. An empty write request is sufficient to import the existing file tree onto the shared template. Existing historical commits still serve their file reads. A Firecracker start requires a commit with a disk map.

To verify the native editor through the HTTP API, set `CAMELFSD_TEST_WORKSPACE_EDITOR` to the editor's absolute path and run `go test ./internal/api -run TestWorkspaceDiskHTTP -v`. To test Linux block I/O, set `CAMELFSD_TEST_NBD` to a dedicated, unused local NBD device and run `go test ./internal/workdisk -run TestKernelNBD -v` with NBD privileges.
