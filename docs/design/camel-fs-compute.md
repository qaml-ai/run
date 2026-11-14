# camel-fs compute: a VM on a ref

Status: design, 2026-11-13, docs only. §3's question was decided by Miguel the same day: control lives in the
camel-fs service.

**Decided (Miguel, 2026-11-13 ~17:15): VMs are part of the camel-fs product and project.** Compute is optional:
camel-fs storage (the tier, the refs, the host block layer; [camel-fs-files.md](camel-fs-files.md) §6 and §9 under
option C) must run without it. Normal deployments are assumed to have it on.

This document covers five things:
- where the host-side code goes (§1);
- the compute API (§2);
- where VM control lives: in the camel-fs service, decided (§3);
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
| `POST /v1/vms` `{ id, lineage, ref, version?, mode: "job" \| "session", image, shape: { vcpus, memoryMiB, diskGiB }, pool, job?: { command, timeoutS, env, outputs, commit }, session?: { idleStopS }, network, usage: { payer }, deadline }` | idempotent by `id` (the runtime's job id or computer id). It takes the lease on `ref` (§9.9; `job/<id>` branches are created by the caller first; the tier takes it just before it writes `booting`, with the holder `<host>:<bootEpoch>:<vm id>`), places the VM (the tier, §3), mounts `version` (default: the ref's head) as `/repo` or `/workspace`, and boots. → `202 { id, phase }`. A second call with the same `id` returns the same VM at any phase. `deadline` is the credit lease of §4 |
| `POST /v1/vms/{id}/deadline` `{ deadline }` | extends the credit lease (runtime tokens only). Monotonic: a deadline earlier than the current one is refused, never applied. **A lapsed lease is final**: a call made at or after the current deadline (`now ≥ deadline`) answers `409 lease_expired` and never revives it (§4) |
| `GET /v1/vms/{id}` | `{ id, phase, host, ref, version, lease: { epoch, deadline }, startedAt?, endedAt?, exit?, lastCheckpoint?: { version, tree, at } }`. Phases: `requested → placed → booting → running → stopping → ended`. Ended codes: `exit`, `stopped`, `timeout`, `host_lost`, `start_failed`, `lease_expired` (§4) (admission is the runtime's, before `POST /v1/vms`, so it is never an ended code) |
| `GET /v1/vms/{id}/result` | the full result body (`acc: r` on the VM's lineage): `{ exit, timedOut, stdout, stderr, outputs, version?, checkpointError?, timings }`, up to ≈ 33 MiB (the guest's 8 + 8 + 8 MiB stream and output limits, plus base64). **The host writes it** (reversing #972, approved by the lead 2026-11-14): it PUTs the full result JSON to `<lineage>/results/<vm id>`, then reports in-VPC `ended { code, exit, timedOut, version?, checkpointError?, resultKey, resultSha256, resultBytes }`. The tier checks that `resultKey` is exactly `<the VM's lineage>/results/<the VM's id>`, HEADs the object and checks its size, then records the sha in the same `TransactWriteItems` that commits `ended`, the host's `free`/`vms`, the `vm.ended` delivery and the final `usage.vm`. This route streams the object and verifies `resultSha256` as it goes, with a loud `500` on a mismatch, never a silent body. Expiry after 7 days (a read after it is a loud `404`); how the lifecycle rule selects result objects (a host-set tag, or a `results/<lineage>/<vm id>` key) is fs-infra's open detail. The `vms` row and `vm.ended` never carry the body (DynamoDB's 400 KB item limit, L93) |
| `POST /v1/vms/{id}/exec` `{ command, shell?, timeoutS, env?, stdin? }` | runs a command. Output streams as `text/event-stream` (`stdout`, `stderr`, then `exit { code, timedOut, ms }`); a client that drops the stream can re-read the tail with `GET …/exec/{execId}`. `shell` names a persistent shell from `POST /v1/vms/{id}/shells` (cwd, env and shell state survive between calls: the `bash` tool's semantics). A `job`-mode VM runs its `job.command` once by itself and refuses `exec` |
| `POST /v1/vms/{id}/checkpoint` `{ message, trailers, time }` | the camel-fs.md §1.3 checkpoint plus the in-VPC `cas` on the VM's ref under its lease (§9.7, §9.9). → `{ version, tree, diff }`. Synchronous: the guest's index commits only after the ref moved. This is the per-turn checkpoint of the `bash` VM |
| `POST /v1/vms/{id}/stop` `{ checkpoint: true \| false }` | durable: records `stopRequested` before acting, so it reaches the host after any restart of anything (wf-durable's F1). Idempotent. A `session` stops by itself after `idleStopS` with no `exec`, with a checkpoint first; memory-snapshot sleep (§1.5) is a later addition behind the same call |
| events (§3, §4) | `vm.started`, `vm.checkpointed { version, tree }`, `vm.ended { code, exit, timedOut, resultKey, resultSha256, resultBytes, version?, checkpointError? }` (the body is read with `GET …/result`), `usage.vm` (§4). Delivered at least once as signed webhooks into outbox rows (camel-fs-files.md §9.11's pipeline) |

**Mapping:**
- `job({ at, commit })` is `POST /v1/vms` in `job` mode, followed by `vm.ended`.
- The `bash` tool is `POST /v1/vms` in `session` mode on the agent's workspace ref (once, on demand), then `exec`
  per tool call with one persistent shell, `checkpoint` per turn that wrote, and the idle stop.
- A computer is a `session` with a longer idle stop. Its sleep becomes snapshot and restore later.

**Tokens:** the routes need a token on the VM's lineage with `acc: "w"` and the ref in `refs`. Reading a VM's
status or its exec tail needs `r`. `POST /v1/vms` is runtime-only (`sub` in `runtime:*`), because it starts a
metered resource. `exec` on a session is open to the token the runtime hands the agent's tool call. Whether `exec`
deserves its own access letter (`x`) is a C2-era detail; the default is `w`.

## 3. Where VM control lives: in the camel-fs service

**Decided (Miguel, 2026-11-13 ~17:20): option (ii).** VM control lives in the camel-fs service, durable in
DynamoDB. That covers placement, dispatch, durable job and VM state, host authority ("is it still running"), stop,
and the metering events. The runtime keeps billing, from the usage events it pulls from camel-fs (§4), and agent
semantics. `HostJob` becomes a thin client of the compute API.

**Owners:**
- **wf-durable** owns the Go compute control (K4). Its approved durable-jobs design is the input: phases written
  before acting, host authority, outbox delivery, no load-bearing memory.
- **wf-durable** also owns the runtime side of K5: the small `HostJob` row, admission and reservation, settlement,
  and the durable landing of camel-fs results as outbox rows. Its earlier PR (2)/(3) work folds into that,
  smaller.
- **proto-block** owns the host-agent merge (§1) and K1–K3.

**The tier owns VMs end to end.** New tables:
- `hosts` (key `pool` + `host`): boot epoch, shape, `free` slots, the string set `vms` of the VMs placed on it,
  `lastSeenAt`, features. Heartbeats write it in-VPC, and every placement and every end update `free` and `vms`
  in the same transaction as the VM's row. A reconcile is then one strongly consistent `GetItem`, with no index.
- `vms` (key `id`): the §2 phase row, host, lease epoch, `stopRequested`, `resultRef`, `payer`, `deadline`,
  `billedTo`, `usageSeq`.
- `deliveries` (key `shard` + `id`, camel-fs-files.md §9.11) already exists for notify, and carries the `vm.*`
  hints.
- `usage` (key `shard` + ULID, camel-fs-files.md §9.13) holds the usage events, which the runtime pulls.

Every transition is a conditional write:
- `requested → placed` names the host and takes a slot on the `hosts` item in one transaction.
- `placed → booting` is written before the host is told.

Placement is warm- and feature-aware, from the `warm` table camel-fs.md §1.2 already names (L32).

Hosts reach the tier in-VPC over mutual TLS (camel-fs-files.md §9.12). They enroll once with their STS
attestation for a host certificate, which is then their identity, heartbeat with `running`, and pull or
receive work over the VPC.
- **Reconcile:** the tier checks each heartbeat's `running` list against `vms`, so a VM the host lost ends
  `host_lost` within one heartbeat.
- **Host-lost sweep:** a host absent for `HOST_LOST_MS` has its VMs ended by a sweep any tier node can claim.
- **Stop:** the `stopRequested` write plus delivery to the host.

**The runtime keeps:**
- **admission**: the credit check and reservation before `POST /v1/vms`, in Postgres, as `meter.admit` and
  `reserveComputer` today;
- **the agent and workflow meaning of a job**: `HostJob` shrinks to a small durable row (admitted → requested →
  ended) that calls `POST /v1/vms` with the job id and lands `vm.ended` from its outbox through the same `jobEnded`
  path;
- **settlement** from the `usage.vm` events it pulls (§4), and extending each VM's credit deadline.

`JobHost`, `JobHostRegistry`, the host WebSocket, `shared/job-host-protocol.ts` and the runtime's enrollment route
are deleted in K5.

**wf-durable's in-flight PRs:**

| PR | outcome |
|---|---|
| (1) `JobHost` durability: last-seen, host-authority reconcile, no went-away timer, `started` resend | **lands anyway**, because it is nearly done and protects the pilot's host jobs until K5 deletes `JobHost`. Its reconcile and host-lost logic, and its test plan, are re-specified in Go for K4 |
| (2) `HostJob` job row, durable stop, `start/answered/result` | folds into K5, smaller: the row keeps admitted → requested → ended; placement and dispatch move to the tier; `stop` becomes `POST /v1/vms/{id}/stop` |
| (3) outbox landing + `jobEnded`, recover on every wake | folds into K5 unchanged: `vm.ended` arrives as a webhook into the same outbox row |
| (4) crash and restart integration tests | kept, against a fake compute API instead of a fake host socket |

**Why (ii).** It is the shape option C chose for refs, for the same reasons:
- the authority sits next to the thing it governs, so host liveness is decided in-region and the cross-cloud
  failure class (F2, F5: the 30 s "went away" timer, a lost VM noticed only at its deadline) stops existing
  instead of being patched;
- there is one owner per VM (its ref, lease and life);
- it uses the same conditional-write pattern with PITR;
- placement reads local state;
- the runtime loses ≈ 1,000 lines of `hosts.ts` plus the protocol;
- camel-fs is a standalone storage + compute service.

**Rejected alternative (i):** keep placement, dispatch and state in the runtime's `JobHostRegistry`/`JobHost`/
`HostJob`, with a host-addressed compute API. It was the smaller change, but host authority would cross clouds,
compute could not run without camelRun's runtime, and two control planes would touch every VM.

## 4. Billing boundary

camel-fs records usage, and the runtime pulls it and bills. Money stays in Postgres, and camel-fs never sees a
balance, a price or a credit. **Decided (Miguel, 2026-11-13 ~18:50): pull, not push** (camel-fs-files.md §9.13).
Owners: wf-durable (K4b the table and the deadline lease, K4d the route, K5 the poller).

- **`usage.vm`** is written for each VM per 60 s of host-reported run time (never past `stopRequestedAt`, below), closed on the heartbeat that crosses
  the boundary, plus a final event at `ended`: `{ ulid, eventId, vm, payer, pool, shape: { vcpus, memoryMiB }, host,
  from, to, seconds, final }`, with `eventId = <vm>:<seq>`.
  - Each is written into the `usage` table (key `shard` + `ulid`) in the same `TransactWriteItems` that advances
    the `vms` row's `billedTo` and `usageSeq` under the condition `billedTo = :prev AND usageSeq = :n`. So an interval is neither lost nor doubled by a crash or a
    racing tier node.
  - On host loss, the final event's `to` is the last heartbeat that listed the VM (#968's rule).
  - `payer` is the opaque string the runtime passed in `POST /v1/vms`.
- **`usage.storage`** is written for each lineage per GC mark: the exact deduplicated bytes the mark measured
  (camel-fs-files.md §6, quota), written with the mark's own commit. It is the billing basis for storage,
  independent of how quota is enforced between marks.
- **The runtime pulls.** `GET /v1/usage` (camel-fs-files.md §9.13) is read by one leased poller per deployment
  every ≈ 20 s. It inserts with `ON CONFLICT DO NOTHING` and advances its cursor in one Postgres transaction, then
  prices and charges as the meter does today.
  - This replaces `meter.started`, `meter.stopped`, `meter.closed` and `lastSeen`, so L75's ≈ 2.1 s of Postgres
    around a host job moves off the job's path.
  - There is no usage webhook.
- **Admission stays before the VM**: the runtime checks credit (and reserves, as `reserveComputer` does) before
  `POST /v1/vms`. A VM never starts without an admitted payer.
- **Credit enforcement is a deadline lease, not money.**
  - `POST /v1/vms` carries a `deadline`, and the runtime extends it (`POST /v1/vms/{id}/deadline`) while the
    payer's credit lasts.
  - A VM whose deadline lapses is stopped by camel-fs with code `lease_expired`, as `stop { checkpoint: true }`
    does, so the work up to that point is kept.
  - **Billing ends at the lease deadline, not when the stop finishes.** The lease is the credit the runtime has
    held, so the checkpoint and teardown after the deadline are not billed. In K4b, `stopRequestedAt` is set to
    `leaseDeadline`, which caps the final `usage.vm`'s `to`. The same rule applies to every requested stop: a user
    or runtime `stop` ends billing at the stop request (`stopRequestedAt`), not at the VM's exit.
  - camel-fs knows only the time, never why it was not extended.
  - **A lapsed lease is final** (wf-durable, K4b). An extension that arrives when `now ≥ deadline` answers
    `lease_expired` and does not revive the lease, even if the VM has not stopped yet. Reviving it would bill the
    lapsed gap retroactively, against credit the runtime did not hold during it. The runtime's renewer treats
    `lease_expired` as "the VM is stopping" and lands it through `vm.ended` and the usage poll like any other end.
    It extends well before the deadline (at a fraction of the lease), so a slow round trip does not lapse a VM that
    still has credit.
- **Money-path review:** this section is the design; the implementation's money hunks (the event schema, the poller's
  insert and cursor, the settlement, the deadline extension) go to the lead line by line before any of them merges.

## 5. Order, and the ledger rows this touches

Option C's storage sequence is C1 (`--role api` + tokens), C2 (the refs package), C3 (the runtime's `RepoClient`
swap) and C4 (hosts do the CAS in-VPC, notify, `RepoDO` deleted). Compute slots in as follows, each a PR stack onto
`camelfs/files-model`:

| step | what | depends on | note |
|---|---|---|---|
| K1 | **proto-block**: `camelfsd guest`: the Go guest agent, wire-compatible with today's `camel-guest` ops, clean poweroff; the guest image built once in CI, published content-addressed to the bucket, pinned by sha256 (L62, L64) | nothing; can start now beside C1 | |
| K2 | **proto-block**: `camelfsd host --compute`: the Go port of `jobhost` (Firecracker + jailer in systemd scopes, netns pool, egress proxy, slots, vsock guest channel), **still speaking today's runtime WebSocket protocol**, so it replaces `jobhost` with no runtime change; persistent VM and mount state with re-adoption on restart; ublk recovery (L15, L16) | K1 | |
| K3 | **proto-block**: periodic checkpoints for long jobs on the §1.3 cadence, and the synchronous checkpoint for sessions | K2, C4 (the in-VPC `cas`) | L45 |
| K4 | **wf-durable**: the compute API (§2) and control in Go on the tier: `hosts`/`vms` on DynamoDB, phases, placement, host channel in-VPC, reconcile, host-lost sweep, `vm.*` hints; K4b the `usage` table and the deadline lease; K4d `GET /v1/usage` | C1, C2 | — |
| K5 | **wf-durable**: the runtime side: the small `HostJob` row, admission and reservation, the leased usage poller and settlement from pulled `usage.*` events, deadline extension, durable landing of `vm.*` events as outbox rows; `JobHost`, the registry and the WebSocket deleted | K4, C3 | — |
| K6 | `bash` VM sessions in the runtime (owner named when K5 lands): `exec` with the persistent shell, per-turn checkpoint, idle stop; memory-snapshot sleep after | K5 | — |

K1–K3 can start now. K4 starts after C2. Storage stays independent of all of K: a deployment without
`--compute` is C1–C4 exactly.

**Ledger rows** ([camel-fs-v0-limitations.md](camel-fs-v0-limitations.md)):

| row | now | after |
|---|---|---|
| L62 guest kernel panic instead of poweroff | open, next guest change | fixed by K1: the Go init calls `reboot(LINUX_REBOOT_CMD_POWER_OFF)` and verifies the guest exited |
| L64 every host rebuilds the guest image with `debootstrap` | open | fixed by K1: built once in CI, content-addressed in the bucket, sha256-pinned; no Node in the guest |
| L32 placement is not feature- or lineage-aware | open | fixed by K4 (warm-aware placement in the tier) |
| L15 a daemon restart ends every cold-mounted job | open (v1 half) | **required** by K2: one process owns VMs and devices, so restarts must re-adopt (persistent state, VMs in their own scopes, ublk recovery) |
| L16 crash fencing waits out the 5-minute lease | open | fixed by K2 + C2: the host's boot epoch is in its lease holder, and the tier fences a restarted host's old leases on sight |
| L45 one checkpoint at job end | open | fixed by K3 |

L72 and L81 (wf-durable): L72's control-flow half is fixed for the pilot by PR (1) and for good by K4–K5, where a
VM's state lives in `vms`. L81 closes with K4, because placement and the slot are one transaction there.
