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
See [Moving Camel Bots to v2](docs/V1_MIGRATION.md) for the volume importer and cutover sequence.

## Persistent Firecracker workspaces (Lazy FUSE + OverlayFS)

The Worker uses the existing camelFS API (`KindTree` + `KindBlob` in local or S3 storage). For `--vm-driver=firecracker`, there is no host ext4 image, no `libext2fs` editor, and no host NBD block device:

- On VM start, `camelfsd` sends only the commit's `Tree` metadata to `camelfs-guest-init` over virtio-vsock (`port 10000`).
- `camelfs-guest-init` mounts a read-only metadata-cached FUSE `lowerdir` (which lazily fetches immutable blobs on demand from the host over vsock `port 10001`) under a writable Linux `overlayfs` at `/workspace` (backed by guest `tmpfs`).
- On `exec` checkpoints, `camelfs-guest-init` walks only the `overlayfs` `upperdir` (`O(changed files)`), returning incremental puts/deletes without freezing ext4 or scanning unchanged files.

The guest kernel requires `CONFIG_FUSE_FS` and `CONFIG_OVERLAY_FS`, and `/workspace` mutations during a single VM session must fit in guest memory/scratch. Use absolute paths for `--firecracker-kernel` and `--firecracker-rootfs`.

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
Each table has string keys `PK` and `SK`. Set `--firecracker-kernel` and
`--firecracker-rootfs` (no workspace template, editor, or NBD devices needed). Bind the daemon to loopback and route
`camelfs-v2-pilot.camelai.dev` to it through a Cloudflare tunnel. Set
`CAMELFSD_PUBLIC_KEYS` to the public half of the Worker's Ed25519 signing key.

Use Wrangler's `--secrets-file` for the first deployment. Supply
`ADMIN_SECRET`, `VAULT_SECRET`, and `CAMELFS_SIGNING_KEY` through that file and
keep the file outside the checkout. The signing key is
`<kid>:<base64url-encoded Ed25519 seed>`. The daemon's public key uses the same
key ID. The pilot config provides no development bearer tokens.

Run one direct Firecracker daemon per VM table, with a stable data directory.
A daemon exit kills its child microVMs. At startup,
camelfsd retires their VM records and releases the matching ref leases before
serving requests. Interrupted commands surface an error and the next VM opens
the last committed workspace. To replace a host, stop or fence the old host
before starting the replacement against its tables.

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
VM tables, and signing key. Run camelfsd as a system service on cgroup v2 with
`KillMode=control-group` and `Restart=on-failure`. Set
`CAMELFSD_FC_JAILER=/usr/local/bin/jailer` using the same Firecracker release as
`CAMELFSD_FC_BIN`. The jailer uses UID and GID 201000 plus the VM's allocated
guest CID. Reserve that range on the dedicated host, and use a
short data path such as `/nvme/v2` for the Unix sockets. Create fresh
`ADMIN_SECRET`, `VAULT_SECRET`, and `CAMELFS_SIGNING_KEY` for the production
Worker. The deploy creates its own Durable Objects. Supply a separate
`TOOL_IDENTITY_PRIVATE_JWK` secret for Camel Bots tool signing. Bootstrap new v2
tenants and issue v2 credentials for the clients joining the rollout.

Set `AZURE_OPENAI_SOL_ENDPOINT` to the Azure resource serving the
`gpt-6.2-sol` deployment and `AZURE_OPENAI_SOL_API_KEY` to its key before
selecting `azure/gpt-6.2-sol` as the Worker default. The same route serves
explicit model requests and uses low reasoning effort.

Set `BUILDER_CUTOVER_CREDIT_TENANT_ID` to the shared Camel Bots tenant and
`APP_RUNTIME_CREDIT_TENANT_IDS` to the comma-separated IDs of the other
first-party app runtime tenants in the production Worker. The Worker admits
turns on those authenticated service tenants regardless of the platform
balance. It meters usage at the normal rate and restores the balance to $25
when settlement leaves less than $15. Customer entitlements and credit limits
remain enforced by each app. Verify both bindings on every production version.

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
