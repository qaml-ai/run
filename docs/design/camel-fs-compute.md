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
  - Compute is a module behind `--compute` (K2a; the flag does not exist yet). Without the flag it is exactly today's storage-only host: no
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

## 2. The compute API: a VM on a ref (sessions only)

**Decided (Miguel, 2026-11-14): one `bash` tool, one VM per agent per branch, no jobs.** Agents get one `bash` tool,
backed by a VM that starts on the agent's first call and lives on that agent's branch (§6). The job interface goes:
there is no `job()` in workflows and no `job_run` agent tool. Parallel compute comes from child agents, each with
its own `bash` VM on its own branch. QuickJS code mode stays for small scripts that need no VM.

So the VM has one shape, a **session**: it boots, runs many `exec`s, checkpoints, and stops when idle. Every route
is on the camel-fs service and carries a `camelfs+jwt` token (camel-fs-files.md §9.10).

| route | semantics |
|---|---|
| `POST /v1/vms` `{ id, lineage, ref, version?, image, shape: { vcpus, memoryMiB, diskGiB }, pool, idleStopS, network, usage: { payer }, deadline }` | idempotent by `id` (the runtime's id for this agent's VM on this branch). It takes the lease on `ref` (§9.9; the tier takes it just before it writes `booting`, with the holder `<host>:<bootEpoch>:<vm id>`), places the VM (the tier, §3), mounts `version` (default: the ref's head) as `/workspace`, and boots. → `202 { id, phase }`. A second call with the same `id` returns the same VM at any phase. `deadline` is the credit lease of §4 |
| `POST /v1/vms/{id}/deadline` `{ deadline }` | extends the credit lease (runtime tokens only). Monotonic: a deadline earlier than the current one is refused, never applied. **A lapsed lease is final**: a call made at or after the current deadline (`now ≥ deadline`) answers `409 lease_expired` and never revives it (§4) |
| `GET /v1/vms/{id}` | `{ id, phase, host, ref, version, lease: { epoch, deadline }, startedAt?, endedAt?, lastCheckpoint?: { version, tree, at } }`. Phases: `requested → placed → booting → running → stopping → ended` (v2 adds `sleeping` after `running`, §6). Ended codes: `stopped` (a requested stop), `idle` (the idle stop), `host_lost`, `start_failed`, `lease_expired` (§4). Admission is the runtime's, before `POST /v1/vms`, so it is never an ended code |
| `POST /v1/vms/{id}/shells` → `{ shell }` | a persistent shell: cwd, environment and shell state survive between `exec`s, which are the `bash` tool's semantics |
| `POST /v1/vms/{id}/exec` `{ command, shell, cwd?, timeoutS, env?, stdin? }` | runs one command in the shell. Output streams live as `text/event-stream` (`stdout`, `stderr`, then `exit { code, timedOut, ms }`). The guest keeps at least the last exec per shell, bounded by 8 execs × 1 MiB of stdout and stderr per VM (stream-tagged, with offsets), plus the last 64 exit records. It lives in the guest's memory, so it survives a daemon restart, and it is dropped when the VM stops. A client whose stream dropped re-reads it with `GET …/exec/{execId}?offset=`. Past those bounds the read answers `410 tail_truncated { firstOffset }`, or `404 exec_unknown` for an exec it no longer knows. Nothing is written to S3 or a table for an exec |
| `POST /v1/vms/{id}/checkpoint` `{ message, trailers, time }` | the camel-fs.md §1.3 checkpoint plus the host's in-VPC `cas` on the VM's ref under its lease (camel-fs-files.md §9.7). → `{ version, tree, diff }`. Synchronous: the guest's index commits only after the ref moved |
| `POST /v1/vms/{id}/stop` `{ checkpoint: true \| false }` | durable: records `stopRequested` before acting, so it reaches the host after any restart of anything (wf-durable's F1). Idempotent. The VM also stops by itself after `idleStopS` (≈ 10 s by default) with no `exec` in flight, with a checkpoint first. Warm sleep (a memory snapshot, §6 v2) is a later addition behind the same API, as a `sleeping` state |
| events (§3, §4) | `vm.started`, `vm.checkpointed { version, tree }`, `vm.ended { code, version?, checkpointError? }` (on the notify webhook with `type: "vm.ended"`, camel-fs-files.md §9.11), `usage.vm` (§4) |

**What the session-only shape removes from this API:**
- job mode (`mode`, `job: { command, timeoutS, env, outputs, commit }`);
- the job's own timeout and the `exit` and `timeout` ended codes;
- `GET /v1/vms/{id}/result`, the host's result PUT, and the `results/<lineage>/<vm id>` objects with their
  lifecycle rule (L93's result half and L102 go with them);
- `resultKey`, `resultSha256` and `resultBytes` on `ended` and `vm.ended`.

The deadline lease, the usage stream (§4), the host CAS route, mTLS and the guest image policy are unchanged.

**Guest images** (the policy, decided 2026-11-14; K1 built the image):
- **The allowed set lives only in the tier's config:** a list of guest-image sha256s, each published
  content-addressed in the bucket as `guest/<sha>` with its manifest `guest/<sha>.json`. CI publishes, through the
  `camelfs-prod-guest-image-publisher` role.
- **The boot spec carries the image:** `POST /v1/vms`'s `image` names a sha256, and the tier's dispatch to the
  host (`boot[].image`) carries that sha.
- **The host verifies and keeps no pin:** it downloads `guest/<sha>` if its cache lacks it, verifies the bytes
  against `guest/<sha>.json`, and boots only on a match. The interim host-side pin from #979/#1007 is ledger L101
  and is deleted in K2c.
- **`POST /v1/vms` validates everything before any write**, in this order (K4d):
  1. `image` is in the allowed set, else `400 invalid_request` ("not allowed");
  2. `guest/<sha>.json` exists, else `400 invalid_request` ("unknown image"), and its recorded sha matches,
     else `500` (a corrupt manifest, never the caller's fault);
  3. the disk is at least the image's bytes, else `400 invalid_request` naming both sizes;
  4. `deadline` is in `(now, now + 24 h]`, else `400 invalid_request`;
  5. `idleStopS` is within its bounds (§6), else
     `400 invalid_request`.

  The host's own disk guard (L100, #979) stays as the last line.

**Tokens:** the routes need a token on the VM's lineage with `acc: "w"` and the ref in `refs`. Reading a VM's
status or its exec tail needs `r`. `POST /v1/vms` is runtime-only (`sub` in `runtime:*`), because it starts a
metered resource. `exec` on a session is open to the token the runtime hands the agent's tool call. Whether `exec`
deserves its own access letter (`x`) is a C2-era detail; the default is `w`.

## 3. Where VM control lives: in the camel-fs service

**Decided (Miguel, 2026-11-13 ~17:20): option (ii).** VM control lives in the camel-fs service, durable in
DynamoDB. That covers placement, dispatch, durable job and VM state, host authority ("is it still running"), stop,
and the metering events. The runtime keeps billing, from the usage events it pulls from camel-fs (§4), and agent
semantics. Under §6 the agent's own object is the compute API's only runtime client (no `HostJob`).

**Owners:**
- **wf-durable** owns the Go compute control (K4). Its approved durable-jobs design is the input: phases written
  before acting, host authority, outbox delivery, no load-bearing memory.
- **wf-durable** also owns the runtime side of K5: the agent's VM row (§6), admission (balance > 0, no holds), settlement,
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

**A host's `bootEpoch` follows its kernel boot.** The host sends `/proc/sys/kernel/random/boot_id` as
`Register.BootID`, and the tier answers the same epoch for the same `BootID`.
- So VMs and their leases survive a daemon restart.
- A new kernel boot bumps the epoch, which fences every older holder and ends that boot's VMs `host_lost`.

Hosts reach the tier in-VPC over mutual TLS (camel-fs-files.md §9.12). They enroll once with their STS
attestation for a host certificate, which is then their identity, heartbeat with `running`, and pull or
receive work over the VPC.
- **Reconcile:** the tier checks each heartbeat's `running` list against `vms`, so a VM the host lost ends
  `host_lost` within one heartbeat.
- **Host-lost sweep:** a host absent for `HOST_LOST_MS` has its VMs ended by a sweep any tier node can claim.
- **Stop:** the `stopRequested` write plus delivery to the host.

**The runtime keeps:**
- **admission**: the balance check before `POST /v1/vms` (balance > 0, in Postgres; no hold or reservation, §4);
- **the agent's meaning of its VM** (§6, superseding the job row described here first): the agent's object keeps
  one row per branch, calls `POST /v1/vms`, and lands `vm.ended` from its outbox;
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
- **Balances may go negative** (Miguel, 2026-11-14).
  - **Admission** requires the payer's balance > 0 before `POST /v1/vms`. A VM never starts without an admitted
    payer, but nothing is held or reserved: today's `reserveComputer` and credit holds go.
  - **Every charge lands**, even when it takes the balance below zero. The usage events are settled in full.
  - **Long-running work re-checks at each renewal:** the runtime extends a VM's deadline (every ≈ 3 min) only while
    the balance is still > 0. A voice call checks once, at create.
  - **Spend limits are unchanged.**
- **Credit enforcement is a deadline lease, not money.**
    - `POST /v1/vms` carries a `deadline`, and the runtime extends it (`POST /v1/vms/{id}/deadline`) at each
    renewal while the payer's balance is > 0. The lease is the stop mechanism, and it involves no hold.
  - A VM whose deadline lapses is stopped by camel-fs with code `lease_expired`, as `stop { checkpoint: true }`
    does, so the work up to that point is kept.
  - **Billing ends at the lease deadline, not when the stop finishes.** The runtime stopped extending at a renewal
    that found the balance ≤ 0, so the checkpoint and teardown after the deadline are not billed. In K4b, `stopRequestedAt` is set to
    `leaseDeadline`, which caps the final `usage.vm`'s `to`. The same rule applies to every requested stop: a user
    or runtime `stop` ends billing at the stop request (`stopRequestedAt`), not at the VM's exit.
  - camel-fs knows only the time, never why it was not extended.
  - **A lapsed lease is final** (wf-durable, K4b). An extension that arrives when `now ≥ deadline` answers
    `lease_expired` and does not revive the lease, even if the VM has not stopped yet. Reviving it would bill the
    lapsed gap retroactively, for time the runtime had already decided not to extend. The runtime's renewer treats
    `lease_expired` as "the VM is stopping" and lands it through `vm.ended` and the usage poll like any other end.
    It extends well before the deadline (at a fraction of the lease), so a slow round trip does not lapse a VM that
    still has credit.
- **Money-path review:** this section is the design; the implementation's money hunks (the event schema, the poller's
  insert and cursor, the settlement, the deadline extension) go to the lead line by line before any of them merges.

## 5. Order, and the ledger rows this touches

Option C's storage sequence is C1 (`camelfsd api` + tokens), C2 (the refs package), C3 (the runtime's `RepoClient`
swap) and C4 (hosts do the CAS in-VPC, notify, `RepoDO` deleted). Compute slots in as follows, each a PR stack onto
`camelfs/files-model`:

| step | what | depends on | note |
|---|---|---|---|
| K1 | **proto-block**: `camelfsd guest`: the Go guest agent, wire-compatible with today's `camel-guest` ops, clean poweroff; the guest image built once in CI, published content-addressed to the bucket, pinned by sha256 (L62, L64) | nothing; can start now beside C1 | |
| K2a | **proto-block**: the launcher in `camelfsd host --compute`: Firecracker + jailer with each VM in its own systemd scope, taps and slots, the vsock guest channel | K1 | now |
| K2b | **proto-block**: the egress proxy in Go | K2a, C3 | |
| K2c | **proto-block**: the hostwire host side (#1016), and **only hostwire**: there is no Go port of today's runtime WebSocket, and the TypeScript `jobhost` keeps serving the pilot until K5 cuts over. It covers mTLS terminated in the Go server verifying `spiffe://camelfs/tier` (camel-fs-files.md §9.12), results to `results/<lineage>/<vm id>`, a persistent `vms` table with re-adoption on restart (L15's state half, L16), and the deletion of the `camelfs-host+jwt` code and of L101's host image pin. Tested end to end against K4c's tier | K2b, K4c | |
| K2d | **proto-block**: ublk with user recovery (L15's restart-is-a-stall half), measured on the host before it is committed to | K2c | |
| K3 | **proto-block**: the synchronous checkpoint for sessions (per `bash` call that changed the tree, §6) | K2c, C4 (the in-VPC `cas`) | L45 obsolete |
| K4 | **wf-durable**: the compute API (§2) and control in Go on the tier: `hosts`/`vms` on DynamoDB, phases, placement, host channel in-VPC, reconcile, host-lost sweep, `vm.*` hints; K4b the `usage` table and the deadline lease; K4d `GET /v1/usage` | C1, C2 | — |
| K5 | **wf-durable**: the runtime side: the agent's VM row (§6), admission (balance > 0, no holds), the leased usage poller and settlement from pulled `usage.*` events, deadline extension, durable landing of `vm.*` events as outbox rows; `JobHost`, the registry and the WebSocket deleted | K4, C3 | — |
| K6 | the `bash` tool in the runtime (§6): one VM per agent per branch, `exec` with the persistent shell, a checkpoint per call that changed the tree, file tools routed into a live VM, idle stop; the job and computer deletions; memory-snapshot sleep after | K5 | owner named when K5 lands |

**Order** (the lead, 2026-11-14, option B): K2a now, then C3 (when wf-repos' R2 lands), then K2b → K2c → K2d.
K4 starts after C2. Storage stays independent of all of K: a deployment without
`--compute` is C1–C4 exactly.

**Ledger rows** ([camel-fs-v0-limitations.md](camel-fs-v0-limitations.md)):

| row | now | after |
|---|---|---|
| L62 guest kernel panic instead of poweroff | open, next guest change | fixed by K1: the Go init calls `reboot(LINUX_REBOOT_CMD_POWER_OFF)` and verifies the guest exited |
| L64 every host rebuilds the guest image with `debootstrap` | open | fixed by K1: built once in CI, content-addressed in the bucket, sha256-pinned; no Node in the guest |
| L32 placement is not feature- or lineage-aware | open | fixed by K4 (warm-aware placement in the tier) |
| L15 a daemon restart ends every cold-mounted job | open (v1 half) | **required** by K2c (state, re-adoption) and K2d (ublk recovery): one process owns VMs and devices, so restarts must re-adopt (persistent state, VMs in their own scopes, ublk recovery) |
| L16 crash fencing waits out the 5-minute lease | open | fixed by K2c + C2: the host's boot epoch is in its lease holder, and the tier fences a restarted host's old leases on sight |
| L45 one checkpoint at job end | open | obsolete under §6: no jobs; sessions checkpoint per call |

L72 and L81 (wf-durable): L72's control-flow half is fixed for the pilot by PR (1) and for good by K4–K5, where a
VM's state lives in `vms`. L81 closes with K4, because placement and the slot are one transaction there.

## 6. The `bash` tool, and what goes

**Decided (Miguel, 2026-11-14): simplify the interfaces.** One `bash` tool replaces `job`, `job_run`, workflows'
`job()` and the `computer` tool family. File tools keep working without a VM, and QuickJS code mode stays for small
scripts.

**The tool.** `bash { command, cwd?, timeoutSeconds? }` → `{ stdout, stderr, exitCode, timedOut, truncated }`.
- **One VM per agent per branch,** created on the agent's first `bash` call (§2 `POST /v1/vms`) on the branch the
  agent is working on: its workspace's `main`, or its own branch when it runs as a child. A second call on the
  same branch reuses the VM and never mounts a second one.
- **One persistent shell per VM:** cwd and environment carry across calls, like a terminal.
- **Timeouts:** `timeoutSeconds` defaults to 120 and is capped at 600. A timed-out command is killed and reported
  `timedOut: true`.
- **Background work:** `cmd &` or `nohup` runs on in the VM between calls only while the VM is awake. When the VM
  sleeps (below), background processes die. A long-running server needs the agent to keep calling `bash`, or it
  stops.
- **Output limits:** the model sees at most 32 KiB of each stream: the head and the tail, with a marker for what
  was cut (`truncated: true`). The full stream passes through the runtime and is not stored.
- **Checkpoints:** after every `bash` call that changed the tree, the runtime asks for a checkpoint (§2), so the
  ref moves and the change is a version. The idle stop checkpoints first. The agent's
  `checkpoint`/`restore`/`history`/`diff` tools are unchanged.
- **File tools and the lease, plainly:** while a VM is running on a branch, it holds the branch's lease, and the
  agent's file tools on that branch go into the VM (reads and writes run in the guest; the next checkpoint makes
  them durable). When the VM is stopped, the branch is unheld, and file tools and API writes work on the ref
  directly. There is never a second writer.
- **Sprite-like VMs: they sleep after seconds of inactivity and wake on the next call** (Miguel, 2026-11-14).
  Two tiers:
  - **v1 (now): idle stop with checkpoint.**
    - After `idleStopS` with no `exec` in flight, the tier freezes the VM, checkpoints it (a commit to the agent's
      branch, measured at ≈ 110–220 ms), and stops it.
    - `idleStopS` is one constant with a default of ≈ 10 **seconds**, at most 1 hour, counted only while no
      `exec` runs.
    - The next `bash` call boots a fresh VM from the branch's latest tree: a warm mount ≈ 2 ms plus a Firecracker
      boot ≈ 0.5 s (a cold host hydrates first, ≈ 3.7 s for a 660 MB root).
    - **Files persist, processes do not**, and the tool's description says so to the model.
    - Billing runs only while a VM runs, so a sleeping agent costs storage only.
  - **v2 (later, gated on a measurement): warm sleep.**
    - On idle, the host takes a Firecracker memory snapshot to its NVMe instead of stopping, and the next call
      restores it with processes intact.
    - It is host-affine: placement prefers the host that holds the snapshot.
    - It falls back to v1's cold boot when that host or the snapshot is gone.
    - It ships only after measuring restore time, snapshot size per VM shape, and the NVMe cost of keeping
      snapshots. The checkpoint still runs before the snapshot, so the branch is current either way.
  - **No API change for v2:** the VM row gains a `sleeping` state (`running → sleeping → running`) between
    `running` and `stopping`, and `GET /v1/vms/{id}` reports it. v1 never enters it.
- **The tool's description to the model** (in substance): "Runs a shell command in your machine. Your files
  persist on your branch. The machine sleeps after about 10 seconds without a command, and processes, including
  background `&` jobs and servers, do not survive the sleep. Keep calling to keep something running."
- **Money (§4):** admission at balance > 0 before `POST /v1/vms`. The deadline is renewed every ≈ 3 min while the
  balance is > 0. Usage is pulled, and charges may go negative.

**In the runtime, the agent's own object owns its VM.**
- The agent's Durable Object keeps one small row per branch: `{ vmId, ref, deadline, state }`, where `state` is
  `running` or `stopped` today and gains `sleeping` with v2.
- It renews the deadline from its alarm while the agent is active, and drops the row on `vm.ended`.
- There is no `HostJob`, `JobHost` or `JobHostRegistry`. Placement and host authority are the tier's (§3).

**Workflows: steps are agent turns or child agents, with no `job()`.**
- A workflow that fanned out jobs now starts child agents. Each child works on its own branch
  (`fork/<effect>`) with its own `bash` VM, and the workflow merges the branches with the existing merge and
  fast-forward effects (camel-fs-files.md §4).
- A step that ran one command runs it through a child agent's `bash`, or in QuickJS when it needs no VM.

**What replaces `computer` and `ContainerComputer`:** the `bash` tool on our hosts.
- Cloudflare Containers are no longer an agent compute substrate.
- A deployment without `--compute` has file tools and QuickJS but no `bash`.

**Deleted** (after K5 cuts over; nothing on the Node backend changes, and camel-bots on Node is unaffected):

| where | what |
|---|---|
| runtime: jobs | `backends/workers/src/jobs/` whole: `hosts.ts` (`JobHost`, `HostJob`, `JobHostRegistry`, enrollment, scaler routes), `job.ts`, `driver.ts`, `container-job.ts`, `camelfs.ts`, `camel-sync.ts`, `host-sync-store.ts`, `host-pricing.ts`, `repo.ts`; `agent-jobs.ts` (`job_run`); `workflow-jobs.ts` and `job()` in the workflow runner and its builtins; `shared/job-host-protocol.ts` |
| runtime: computers | `backends/workers/src/computers/` whole (the `computer` tool, `ContainerComputer`, the container provider, native and child forks, the egress gateway, `ComputerMeter` and its billing); `SHARED_COMPUTER_CONTROL`; the `COMPUTER_CONTAINERS` binding and its container image |
| runtime: surface | `job_run` and `computer` in tool selection, definitions, the API contract, OpenAPI, the SDKs' job and computer handles, the guides' job and computer sections |
| host | the TypeScript `jobhost` (already planned, K5); the job half of the guest (`run` and `collect` ops) |
| camel-fs | job mode, `GET /v1/vms/{id}/result`, `results/` and its lifecycle rule, the result fields on `ended` and `vm.ended` (§2) |

Roughly 2,600 lines of jobs (with `agent-jobs.ts` and `workflow-jobs.ts`) and 3,100 lines of computers go from the
Workers runtime, before tests.

**Ledger rows this makes obsolete** (they flip when the deletion lands):
- L25, L43, L44, L68 and L69: the per-job import, dispatch and placement legs.
- L70: the job result leg.
- L45: periodic checkpoints for long jobs; sessions checkpoint per call.
- L72 and L81: `JobHost`/`HostJob` durability.
- L93's result half, and L102: there are no results objects.
- L100's API half stays: disk ≥ image applies to sessions too.

**Open for Miguel:**
1. **The cost of fan-out.** A workflow that ran N jobs (compute only) now runs N child agents, each paying model
   turns. A workflow that wants many cheap parallel commands has no primitive for it. A child agent can still loop
   `bash` itself, but in series.
2. **No custom images per job.** Sessions boot only images on the tier's allowed list (§2, guest images), so
   anything that relied on a per-job image needs a new allowed image.
3. **File tools on a branch with a live VM go into the VM.** They are as fast as the VM and stop working if the VM
   is wedged, until it is stopped. This is the design's one new coupling.
4. **Self-host without compute has no `bash`.** The old Cloudflare-container provider covered that case.
5. **Public API break:** `job()`, `job_run`, the `computer` tool and their SDK handles go with no back-compat (the
   closed-alpha rule). Evals that use `job()` (`evals/workflows`) need rewriting over child agents.
