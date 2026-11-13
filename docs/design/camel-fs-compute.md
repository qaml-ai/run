# camel-fs compute: a VM on a ref

Status: design, 2026-11-13, docs only, for Miguel's decision on §3.

**Decided (Miguel, 2026-11-13 ~17:15): VMs are part of the camel-fs product and project.** Compute is optional:
camel-fs storage (the tier, the refs, the host block layer; [camel-fs-files.md](camel-fs-files.md) §6 and §9 under
option C) must run without it. Normal deployments are assumed to have it on.

This document covers five things:
- where the host-side code goes (§1);
- the compute API (§2);
- where VM control lives, the one open question, with both options and a recommendation (§3);
- the billing boundary (§4);
- the build order relative to option C's C1–C4 and the ledger rows it touches (§5).

It builds on [camel-fs.md](camel-fs.md) §1.4–§1.5 (Firecracker on nested KVM; jobs and computers on one substrate)
and on the job-hosts plan, whose image, netns pool, egress proxy and isolation suite stay.

## 1. One host process: the TypeScript host agent folds into `camelfsd host`

Today a VM host runs two programs that talk over a Unix socket:

| | `camelfsd host` (Go) | `jobhost` (TypeScript, Node) |
|---|---|---|
| owns | the block layer: images, the lazy origin (NBD), hydration, the chunk cache, mounts, checkpoints | enrollment, the WebSocket to the runtime, slots, Firecracker (`firecracker.ts`, `vm.ts`), the netns pool (`network.ts`), the egress proxy (`egress-proxy.ts`), the guest channel (`guest.ts` host side), the import proxy (`camelfsd.ts`) |
| size | the daemon | ≈ 1,700 lines in `jobhost/` plus `shared/job-host-protocol.ts` |

Inside each guest, `camel-guest` (also `jobhost/guest.ts`, run by `camel-init` behind `socat` on vsock 5000) runs
Node.

**After the merge**, one Go binary has three roles:

- **`camelfsd host`** owns the block device, Firecracker, the slots and the guest channel in one process.
  - Compute is a module behind `--compute`. Without the flag it is exactly today's storage-only host: no
    Firecracker, no netns pool, no slots, no `/v1/vms` routes. With it, the host advertises its shape (vCPUs,
    memory, slots, pool, features) and runs VMs.
  - The module is the Go port of `vm.ts`/`firecracker.ts` (launcher, jailer, the `VmLauncher` seam kept as an
    interface), `network.ts` (the netns pool), `egress-proxy.ts` and the host half of `guest.ts`. It also keeps the
    `isolation-suite.ts` checks as Go tests run against a real host.
  - The import proxy is not ported: the import is deleted by phase 2 (L82).
- **`camelfsd guest`** is the same binary built static for the guest. It replaces Node's `camel-guest` and keeps
  its op set:
  - today's ops: `run`, `collect`, `free`, `exit`, `camelfs_apply`, `camelfs_checkpoint`, `camelfs_checkpointed`;
  - added for sessions (§2): `exec` with a persistent shell, and streaming output;
  - on vsock 5000 directly, with no `socat`.

  The guest image no longer needs Node, which shrinks it and closes the guest-side Node limits (L39, L40). Its
  `camel-init` replacement powers off cleanly with `reboot(LINUX_REBOOT_CMD_POWER_OFF)` (L62).
- **`camelfsd api`** is the stateless tier (C1), which gains the compute routes of §2.

**Process model.** VMs must survive a `camelfsd` restart, or a daemon deploy kills every running job on the host.
- Each Firecracker runs under the jailer in its own systemd scope, not as a child that dies with the daemon.
- `camelfsd host` persists its mount and VM state (`mounts`, `vms` tables in the host-local SQLite).
- On start it re-adopts running VMs and their mounts instead of refusing a non-empty `mounts/`.
- The lazy origin moves to ublk with user recovery, so a restart stalls a cold guest's I/O instead of failing it.

That is L15's v1 fix, and compute makes it a prerequisite rather than a wish (§5).

**What stays:** the host image (x86-64, nested KVM, `m8id`/`c8id`), the netns pool and egress policy, the isolation
suite, attested enrollment (`shared/job-host-attest.ts`), and the guest vsock protocol for checkpoint and apply
(`camelfs-wire.ts` ported, byte-compatible).

## 2. The compute API: a VM on a ref

One resource, the **VM**, always attached to a ref. It serves both shapes: `job()` (one-shot: boot, run, checkpoint
if asked, destroy) and the `bash` VM / computer (a session: boot, many `exec`s and checkpoints, idle stop).
Every route is on the camel-fs service and carries a `camelfs+jwt` token (camel-fs-files.md §9.10).

| route | semantics |
|---|---|
| `POST /v1/vms` `{ id, lineage, ref, version?, mode: "job" \| "session", image, shape: { vcpus, memoryMiB, diskGiB }, pool, job?: { command, timeoutS, env, outputs, commit }, session?: { idleStopS }, network, usage: { payer } }` | idempotent by `id` (the runtime's job id or computer id). It takes the lease on `ref` (§9.9; `job/<id>` branches are created by the caller first), places the VM (§3), mounts `version` (default: the ref's head) as `/repo` or `/workspace`, and boots. → `202 { id, phase }`. A second call with the same `id` returns the same VM at any phase |
| `GET /v1/vms/{id}` | `{ id, phase, host, ref, version, lease: { epoch, deadline }, startedAt?, endedAt?, exit?, lastCheckpoint?: { version, tree, at } }`. Phases: `requested → placed → booting → running → stopping → ended` |
| `POST /v1/vms/{id}/exec` `{ command, shell?, timeoutS, env?, stdin? }` | runs a command. Output streams as `text/event-stream` (`stdout`, `stderr`, then `exit { code, timedOut, ms }`); a client that drops the stream can re-read the tail with `GET …/exec/{execId}`. `shell` names a persistent shell from `POST /v1/vms/{id}/shells` (cwd, env and shell state survive between calls: the `bash` tool's semantics). A `job`-mode VM runs its `job.command` once by itself and refuses `exec` |
| `POST /v1/vms/{id}/checkpoint` `{ message, trailers, time }` | the camel-fs.md §1.3 checkpoint plus the in-VPC `cas` on the VM's ref under its lease (§9.7, §9.9). → `{ version, tree, diff }`. Synchronous: the guest's index commits only after the ref moved. This is the per-turn checkpoint of the `bash` VM |
| `POST /v1/vms/{id}/stop` `{ checkpoint: true \| false }` | durable: records `stopRequested` before acting, so it reaches the host after any restart of anything (wf-durable's F1). Idempotent. A `session` stops by itself after `idleStopS` with no `exec`, with a checkpoint first; memory-snapshot sleep (§1.5) is a later addition behind the same call |
| events (§3, §4) | `vm.started`, `vm.checkpointed { version, tree }`, `vm.ended { exit, timedOut, stdout, stderr (capped as `WireResult` today), outputs, version?, checkpointError? }`, `usage.vm` (§4). Delivered at least once as signed webhooks into outbox rows (camel-fs-files.md §9.11's pipeline) |

**Mapping:**
- `job({ at, commit })` is `POST /v1/vms` in `job` mode, followed by `vm.ended`.
- The `bash` tool is `POST /v1/vms` in `session` mode on the agent's workspace ref (once, on demand), then `exec`
  per tool call with one persistent shell, `checkpoint` per turn that wrote, and the idle stop.
- A computer is a `session` with a longer idle stop. Its sleep becomes snapshot and restore later.

**Tokens:** the routes need a token on the VM's lineage with `acc: "w"` and the ref in `refs`. Reading a VM's
status or its exec tail needs `r`. `POST /v1/vms` is runtime-only (`sub` in `runtime:*`), because it starts a
metered resource. `exec` on a session is open to the token the runtime hands the agent's tool call. Whether `exec`
deserves its own access letter (`x`) is a C2-era detail; the default is `w`.

## 3. Where VM control lives (Miguel decides)

VM control is: the host inventory and placement, dispatch, durable job state, host authority ("is it still
running"), stop, and the metering events. Today all of it is in the runtime: `JobHostRegistry` (placement),
`JobHost` (one per host: the WebSocket, pending dispatches, results) and `HostJob` (one per job: admission, meter,
files, dispatch, wait, land), all in `backends/workers/src/jobs/hosts.ts`. wf-durable's in-flight design makes
those durable:
- (1) `JobHost`: durable last-seen, host-authority reconcile, no "went away" timer, `started` resent;
- (2) a `HostJob` job row, durable stop, `start`/`answered`/`result`;
- (3) outbox landing + `jobEnded`;
- (4) crash and restart integration tests.

### Option (i): control stays in the runtime; camel-fs compute is per-host

`JobHostRegistry`, `JobHost` and `HostJob` keep placement, dispatch and state, made durable by wf-durable's
(1)–(4). The compute API of §2 is addressed to a host the runtime chose (`POST /v1/vms` with `host`). The tier
forwards to that host in-VPC, or the host keeps its own WebSocket to the runtime and the "API" is that protocol,
renamed.

- **For it:** wf-durable's work lands as designed, and nothing they built is discarded. It is the smaller change
  now. Admission, metering and placement policy stay next to billing in one codebase.
- **Against it:**
  - Host authority crosses clouds. The host's heartbeat, its `running` list and its results travel to a Durable
    Object on Cloudflare, so F2 and F5 (the 30 s "went away" class, a lost VM noticed at its deadline) are fixed
    by protocol on a cross-cloud socket instead of disappearing.
  - camel-fs compute cannot run without camelRun's runtime, which contradicts "one AWS service that stands alone".
  - Every placement reads host state that lives in us-west-2 from a DO elsewhere.
  - Two control planes touch one VM: the tier owns its ref and lease, and the runtime owns its life.

### Option (ii): control moves into the camel-fs service, durable in DynamoDB

The tier owns VMs end to end. New tables:
- `hosts` (`host`: boot epoch, pool, shape, free slots, `lastSeenAt`, features; written by host heartbeats in-VPC);
- `vms` (`id`: the §2 phase row, host, lease epoch, `stopRequested`, result reference, `payer`);
- `deliveries` already exists for notify and carries `vm.*` and `usage.*` events.

Every transition is a conditional write: `requested → placed` names the host and takes a slot on the `hosts` item
in one transaction; `placed → booting` is written before the host is told. Placement is warm- and feature-aware
from the `warm` table camel-fs.md §1.2 already names (L32). Hosts reach the tier in-VPC: they register with their
attested identity, heartbeat with `running`, and pull or receive work over the VPC. The tier reconciles each
heartbeat's `running` list against `vms`, so a VM the host lost ends `host_lost` within one heartbeat. A host
absent for `HOST_LOST_MS` ends its VMs by an alarm-like sweep any tier node can claim. `stop` is the
`stopRequested` write plus delivery to the host.

The runtime keeps only billing and agent semantics:
- **admission** (the credit check before `POST /v1/vms`, Postgres, as `meter.admit` today);
- **the agent and workflow meaning of a job**: `HostJob` shrinks to a small durable row (admitted → requested →
  ended) that calls `POST /v1/vms` with the job id and lands `vm.ended` from its outbox;
- **settlement** from `usage.vm` events (§4).

`JobHost`, `JobHostRegistry`, the host WebSocket, `shared/job-host-protocol.ts` and the runtime's enrollment route
are deleted.

- **For it:**
  - Host authority is in-region, next to the hosts, so F2 and F5 disappear rather than being patched.
  - One owner per VM: the tier holds its ref, lease and life.
  - It uses the same pattern as refs (conditional writes, no serial owner, PITR).
  - camel-fs is a standalone storage + compute service, self-hostable without Cloudflare.
  - Placement reads local state.
  - The runtime loses ≈ 1,000 lines of `hosts.ts` plus the protocol.
  - A runtime moved into AWS later (celld) changes nothing here.
- **Against it:**
  - A larger build on the tier: Go placement, the `hosts`/`vms` state machine, a host work channel in-VPC.
  - Part of wf-durable's in-flight work is spent on code that is then deleted.

**Effect on wf-durable's PRs:**

| wf-durable PR | under (i) | under (ii) |
|---|---|---|
| (1) `JobHost` durability: last-seen, host-authority reconcile, no went-away timer, `started` resend | needed, lands as designed | **not needed**: `JobHost` is deleted; its logic (reconcile on heartbeat, host-lost sweep) is re-specified in Go on the tier, and its test plan carries over |
| (2) `HostJob` job row, durable stop, `start/answered/result` | needed | **kept, smaller**: the row and its phases stay, the placement and dispatch phases move to the tier, and `stop` becomes `POST /v1/vms/{id}/stop` |
| (3) outbox landing + `jobEnded`, recover on every wake | needed | **kept unchanged**: `vm.ended` arrives as a webhook into the same outbox row and lands through the same `jobEnded` |
| (4) crash and restart integration tests | needed | **kept**, against a fake compute API instead of a fake host socket |

**Recommendation: (ii).** It is the shape option C already chose for refs, for the same reasons: the authority sits
next to the thing it governs, there is one owner per resource, and the service stands alone. The F2/F5 class of
failures (cross-cloud liveness) stops existing instead of being made durable. The cost is concentrated in one
PR's worth of wf-durable work, (1), so wf-durable should **pause (1)** until Miguel decides and continue (2)–(4),
which survive either way. If Miguel picks (i), (1) resumes as designed and §2 gains the `host` parameter.

## 4. Billing boundary

camel-fs emits usage, and the runtime bills. Money stays in Postgres, and camel-fs never sees a balance, a price or
a credit.

- **`usage.vm`** has one event per VM per interval and a final one at `ended`: `{ id, vm, payer, pool, shape:
  { vcpus, memoryMiB }, host, from, to, seconds, final }`. Intervals are closed on the host's heartbeat clock and
  written in the same transaction as the `vms` row they extend, so an event cannot be lost or doubled by a crash.
  `payer` is the opaque string the runtime passed in `POST /v1/vms`.
- **`usage.storage`** has one event per lineage per GC mark: the exact deduplicated bytes the mark measured
  (camel-fs-files.md §6, quota). It is the billing basis for storage, independent of how quota is enforced between
  marks.
- **Delivery** reuses §9.11's pipeline: a `deliveries` item, a signed POST to the runtime, an idempotent insert keyed
  by event `id` into Postgres (`ON CONFLICT DO NOTHING`), `2xx` only after commit, retries for 24 h, and a loud
  drop. The runtime then prices and charges exactly as the meter does today. This replaces `meter.started`,
  `meter.stopped`, `meter.closed` and `lastSeen` (L75's ≈ 2.1 s of Postgres around a host job moves off the
  job's path).
- **Admission stays before the VM**: the runtime checks credit (and reserves, as `reserveComputer` does) before
  `POST /v1/vms`. A VM never starts without an admitted payer.
- **Money-path review:** the event schema, the idempotent insert and the settlement are money paths and go to the
  lead line by line before any of them merges.

The events use the same HMAC signature as notify. They land in our own Postgres and are never shown to a third
party, so an asymmetric signature buys nothing. If they ever must be verifiable outside camelRun, the scheme moves
to an Ed25519 key of the service's own.

## 5. Order, and the ledger rows this touches

Option C's storage sequence is C1 (`--role api` + tokens), C2 (the refs package), C3 (the runtime's `RepoClient`
swap) and C4 (hosts do the CAS in-VPC, notify, `RepoDO` deleted). Compute slots in as follows, each a PR stack onto
`camelfs/files-model`:

| step | what | depends on | option-neutral? |
|---|---|---|---|
| K1 | `camelfsd guest`: the Go guest agent, wire-compatible with today's `camel-guest` ops, clean poweroff; the guest image built once in CI, published content-addressed to the bucket, pinned by sha256 (L62, L64) | nothing; can start now beside C1 | yes |
| K2 | `camelfsd host --compute`: the Go port of `jobhost` (Firecracker + jailer in systemd scopes, netns pool, egress proxy, slots, vsock guest channel), **still speaking today's runtime WebSocket protocol**, so it replaces `jobhost` with no runtime change; persistent VM and mount state with re-adoption on restart; ublk recovery (L15, L16) | K1 | yes |
| K3 | periodic checkpoints for long jobs on the §1.3 cadence, and the synchronous checkpoint for sessions | K2, C4 (the in-VPC `cas`) | yes (L45) |
| K4 | the compute API (§2) and control: under (ii), `hosts`/`vms` on DynamoDB, placement, host channel in-VPC, reconcile, `usage.*` and `vm.*` events; under (i), host-addressed routes on the tier | C1, C2, Miguel's §3 decision | **no** |
| K5 | the runtime: `HostJob` → compute client (with wf-durable's (2)–(4)); under (ii), `JobHost`, the registry and the WebSocket deleted; billing from `usage.*` events | K4, C3 | no |
| K6 | `bash` VM sessions in the runtime: `exec` with the persistent shell, per-turn checkpoint, idle stop; memory-snapshot sleep after | K5 | — |

K1–K3 do not wait for the §3 decision. K4–K5 do. Storage stays independent of all of K: a deployment without
`--compute` is C1–C4 exactly.

**Ledger rows** ([camel-fs-v0-limitations.md](camel-fs-v0-limitations.md)):

| row | now | after |
|---|---|---|
| L62 guest kernel panic instead of poweroff | open, next guest change | fixed by K1: the Go init calls `reboot(LINUX_REBOOT_CMD_POWER_OFF)` and verifies the guest exited |
| L64 every host rebuilds the guest image with `debootstrap` | open | fixed by K1: built once in CI, content-addressed in the bucket, sha256-pinned; no Node in the guest |
| L32 placement is not feature- or lineage-aware | open | fixed by K4 under (ii) (warm-aware placement in the tier); under (i), by the runtime's registry, as scoped today |
| L15 a daemon restart ends every cold-mounted job | open (v1 half) | **required** by K2: one process owns VMs and devices, so restarts must re-adopt (persistent state, VMs in their own scopes, ublk recovery) |
| L16 crash fencing waits out the 5-minute lease | open | fixed by K2 + C2: the host's boot epoch is in its lease holder, and the tier fences a restarted host's old leases on sight |
| L45 one checkpoint at job end | open | fixed by K3 |

L72 and L81 (wf-durable) close as their rows say under (i). Under (ii), (2)–(4) close them and (1) is superseded
by K4's reconcile.
