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

## v2 pilot

Deploy from `v2/` with `worker/wrangler.pilot.jsonc`. This creates a separate
API at `run-v2-pilot.camelai.dev` with its own Durable Objects, media bucket,
and events queue. Start with fresh repositories. The v2 API and storage layout
use separate data from the original pilot.

On the Firecracker host, build the guest init and install it on a copy of a
Linux ext4 rootfs with Bash and the tools needed by pilot workloads.

```sh
cd v2/camelfsd
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /tmp/camelfs-guest-init ./cmd/camelfs-guest-init
scripts/install-guest-init.sh /path/to/base.ext4 /tmp/camelfs-guest-init /path/to/v2-rootfs.ext4
```

Run one direct Firecracker daemon for the pilot's VM table. Set
`CAMELFSD_BACKEND=aws`, `CAMELFSD_VM_DRIVER=firecracker`, the pilot S3 bucket,
and the `camelfs-v2-pilot-repos` and `camelfs-v2-pilot-vms` DynamoDB tables.
Each table has string keys `PK` and `SK`. Set the kernel, v2 rootfs, template,
editor, and NBD device paths as above. Bind the daemon to loopback and route
`camelfs-v2-pilot.camelai.dev` to it through a Cloudflare tunnel. Set
`CAMELFSD_PUBLIC_KEYS` to the public half of the Worker's Ed25519 signing key.

Use Wrangler's `--secrets-file` for the first deployment. Supply
`ADMIN_SECRET`, `VAULT_SECRET`, and `CAMELFS_SIGNING_KEY` through that file and
keep the file outside the checkout. The signing key is
`<kid>:<base64url-encoded Ed25519 seed>`. The daemon's public key uses the same
key ID. The pilot config provides no development bearer tokens.

The same end-to-end suite can target a dedicated Firecracker daemon with
`CAMELFSD_TEST_URL` and `CAMELFSD_TEST_SIGNING_KEY`. The file and VM case
covers a live edit, a stop, an API edit during sleep, and a read after restart.

## Production v2 route

`worker/wrangler.production.jsonc` deploys `camelrun-v2-prod` to
`run.camelai.com/v2` and `run.camelai.com/v2/*`. Keep the existing proxied DNS
record for the AWS load balancer. Cloudflare sends everything outside these
routes, including `/v1`, `/console`, and `/ops`, to the existing origin.

Create the production R2 bucket and queue named in the configuration. Set up
`fs-v2.camelai.dev` with its own Firecracker host, S3 bucket, DynamoDB repo and
VM tables, and signing key. Create fresh `ADMIN_SECRET`, `VAULT_SECRET`, and
`CAMELFS_SIGNING_KEY` for the production Worker. The deploy creates its own
Durable Objects. Bootstrap new v2 tenants and issue v2 credentials for the
clients joining the rollout.

Build and check the release with the v2 package's pinned Wrangler:

```sh
cd v2
npm exec -- wrangler deploy --dry-run -c worker/wrangler.production.jsonc --outdir dist/production-worker
```

Run the filesystem and VM smoke against the candidate daemon. Verify a workload
that installs dependencies and builds, the expected concurrent VM load, and
restoring a committed workspace on a replacement host. The pilot uses a single
direct Firecracker host and its guest image has no outbound network.

After deployment, verify `/v2` and `/v2/health` report the v2 Worker and that
`/v2/repos` rejects an unauthenticated request. Test an authenticated v2 repo
write, first command, live edit, stop, and restart with a test tenant. Verify
the existing production smoke, including `/v1` and the console, on the same
hostname. To remove v2 ingress, detach the two v2 routes and keep the Worker,
queue, and data bindings in place.
