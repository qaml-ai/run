# Cloudflare core experiment — 2026-11-04

The core model loop, journal, private files, remote code mode and optional Linux
computers run locally on Workers/Durable Objects. This supports continuing the
experiment. It does not establish production parity, cloud reliability or cost.
The ECS runtime and its vendored Pi were not changed. Nothing was deployed.

## What runs

One `CamelAgent` owns a PiHarness, Lifecycle and SQLite database. Agents 0.33
supplies Pi's storage adapter and recovery wake job. The existing TypeScript SDK
can provision an agent, send prompts, stream text, read history/files and abort.
Tests use a deterministic model; no paid model or Cloudflare account is needed.

Stock `createCodemodeExtension` calls `RemoteCodemodeSandbox` from `/portable`.
The `/cloudflare` implementation lives in a **separate Worker**, with one sandbox
DO per agent. This keeps QuickJS/Wasm and synchronous script computation off the
agent's isolate. A DO class in the agent's own Worker would not give that boundary.
The extension owns the tool journal; this adapter does not implement a second
replay protocol. `tools.<name>` reaches registered Pi tools. Disabling file tools
removes them from the callable set as well as the model's tool list.

`ask_human` writes a Pi conversation document and waits on its durable watch.
`GET /clients/:id/inputs` lists pending questions. The experimental
`POST /experimental/agents/:id/inputs/:taskId` accepts `{"answer":"..."}`.
The regular operator/scoped-agent authorization applies. Repeating the same
answer is idempotent; changing an accepted answer is refused.

The restart test kills the complete local process group while a script waits for
human input. It restarts both Workers on the same SQLite state, then answers.
The script's random number, clock value and completed read result replay
identically. A file deliberately overwritten by the host during the pause stays
overwritten: the completed script write is not executed again. This proves this
replay case, not exactly-once behavior for every external effect. Interrupted
unsafe tools remain unsafe; idempotency needs to live at the effect's authority.
No child-agent delegation implementation was added.

## Code mode safety observations

Local workerd, Pi 1.5.0, stock remote limits: 32 MiB per VM and 100,000 interrupt
polls. Timings include request/polling and a following successful recovery prompt.
They are single local observations, not cloud latency promises.

| Script | Observed result | End-to-end time | Concurrent agent state read |
| --- | --- | ---: | ---: |
| `while (true) {}` | Interrupt budget; clean tool error | 2,735 ms | 4 ms |
| Repeated 1 MiB string allocations | VM memory failure; clean tool error | 165 ms | 4 ms |
| Await a never-resolving Promise | No possible progress; clean tool error | 81 ms | 4 ms |
| Throw an Error | Script error returned through the tool | 83 ms | 4 ms |
| Read a missing file via a tool | Tool failure returned through the script | 88 ms | 4 ms |

All five leave the calling agent responsive and able to run another prompt.
A test-only in-memory instance ID is unchanged across all five failures; the
calling agent DO was not reconstructed. This does not prove every malicious workload is contained
without impact on sibling **sandbox** DOs: multiple DOs can share an isolate.
Remote loops stop at an interrupt poll, not by a wall-clock timer. A non-polling
builtin or exhaustion of the Worker's CPU limit can reset its sandbox isolate.
The configured sandbox CPU ceiling is 30 seconds. Pi documents abort/timeout as
ending the caller's wait while remote computation stops at its next tool call
or interrupt-budget exhaustion.

An indefinitely pending Promise with no work is different from a host tool
waiting for human input. The latter intentionally waits until an answer or abort.
It survives restart, but is not a zero-cost hibernated wait: Lifecycle's running
job and the remote execution can keep both objects active. The stock tool does
not impose a short deadline over human input. Metering or a parked continuation
design would be needed before admitting unlimited human waits.

## Computers

`ComputerProvider` exposes `exec`, read/write, snapshot/restore and sleep. The
registered `computer` tool selects `container` or `sandbox`; it works inside
codemode too. Each provider has a dedicated DO per agent and a serial operation
queue. Linux files are separate from the SQLite-backed Computer Workspace.
The optional bindings exist only in `wrangler.computers.test.jsonc`.

Both providers use the new native `ctx.container` execution/lifecycle API and
`scheduling_policy: "durable_object"`. Snapshot support requires that policy;
the older `Container` wrapper's `sleepAfter` interface is not compatible with it.
The equivalent here is `setInactivityTimeout(60_000)`. The DO stores handles only
after successful capture. A failed capture leaves the prior handle intact.

| Provider | Persistence | Verified locally | First exec | Restore + read |
| --- | --- | --- | ---: | ---: |
| Native Container | `snapshotContainer`, full filesystem | Real Docker exec/files, blocked egress, destroy and restore | 808 ms | 468 ms |
| Sandbox SDK 1.0.3 | `Files`, `DirectoryBackup`, scoped R2 gateway | Real Docker shim and local R2, destroy and restore | 796 ms | 293 ms |

These measurements use cached images on Docker Desktop; image pull/build and
Wrangler startup are excluded. They are filesystem restoration, not process or
RAM resume. The tests also exercise the model → codemode → computer tool path.
No real Container allocation, cloud snapshot, R2 bucket or account API was used.

Container snapshots are immutable, tied to their image, have a 30-day TTL
refreshed by restore, and are capped at 20 GB. Sandbox directory backups can
move files across images and use an application-managed R2 retention policy.
Neither mechanism saves running processes. `sleep` destroys the VM; inactivity
also discards unsaved files. Explicitly snapshot before sleeping and restore
before accessing saved state. This is not automatic durable-volume semantics.
Backup versions are not garbage-collected by this prototype.

SDK 1.0.3 exports `Files` and `DirectoryBackup`, not the old `Sandbox`/`getSandbox`
manager. Its matching image supplies `/usr/local/bin/sandbox-shim`. The backup
gateway grants access to one object for one operation, then denies access. It
does not require opening general Internet access. Both providers start with
`enableInternet: false`; the tests explicitly check an external fetch fails.
`/workspace` must be created at runtime: putting it in the image's lower overlay
layer made the SDK's atomic restore fail with `EXDEV`; that was reproduced and fixed.

Commands use argv, a 30-second maximum deadline, 64 KiB stdout/stderr limits,
1 MiB file transfers and relative file paths. Overflow kills the exec process.
Agents can intentionally use a shell through argv; the Linux VM is the isolation
boundary, not the path validator. Agent abort does not yet cancel an in-flight
computer RPC; its own deadline still applies. Snapshot operations and image
capture cannot promise immediate cancellation. Lifecycle, output bounds and
failed-capture behavior also have unit coverage using fakes.

### Other Computer 0.9 backends

The installed README and declarations expose these alternatives:

| Backend | Status and fit |
| --- | --- |
| `WorkerJavaScriptBackend` | Stable; already tested here. Dynamic Worker, private SQLite files, no network. Useful for bounded JS, not Linux processes. |
| `WorkerShellBackend` | Experimental `just-bash` interpreter on Worker Loader. Shell-like file tasks without a Linux VM; not arbitrary native executables. Requires opt-in. Inspected, not executed here. |
| `ContainerBackend` + `withWorkspaceContainer` | Experimental Computer integration for Linux, daemon and Workspace sync/FUSE. Useful when a common Workspace API matters; heavier IO and recovery tradeoffs. Inspected, not executed here. |
| `LegacyContainerBackend` | Deprecated. Do not build a new provider on it. |

The two tested providers above deliberately compare native snapshots with SDK
directory backup. They do not claim to validate Computer's experimental Linux
sync implementation. Workspace assets/git/artifacts likewise need their own tests.

## Feature mapping and remaining effort

Estimates are additional engineering person-days for a reviewed prototype with
focused tests, not production delivery commitments. Ranges exclude a migration,
security review, live load qualification and product rollout. Rows overlap.

| camelRun feature | Fit and authority | Current evidence / gap | Days |
| --- | --- | --- | ---: |
| Journal and history | Clean per-agent DO + SQLite; R2 for large exports | Pi restart tested. Full-history materialization and unbounded request retention must become indexed/paged/retained. | 3–5 |
| Fork | Pi conversation fork fits same DO; new-agent clone needs export/import and R2 for files | Pi API available, adapter fork route and large-file consistency unimplemented. | 3–6 |
| Credits and billing holds | Account DO serializes reservations; D1 ledger/reporting; Queues outbox delivery | Cross-agent/account writes are not atomic. Needs reserve/commit/release idempotency, expiry and reconciliation. Not implemented. | 8–15 |
| Tenants and API keys | Tenant/account authority in DO or D1; scoped lookup at Worker | Single operator and per-agent HMAC tokens tested. Tenant policy, rotation and quotas absent; one global directory will bottleneck. | 5–8 |
| Usage events | Durable SQLite outbox with canonical model entries; Queues, consumer dedupe and D1/R2 analytics | Model messages contain usage, but no billed receipts or accounting summaries. | 4–7 |
| Scheduled wakes | DO alarms + Lifecycle fit agent recovery; one alarm must multiplex scheduled work | Crash recovery tested, user schedules/cron semantics and cancellation absent. | 3–5 |
| MCP and tools | Pi registry/codemode fits; Worker host mediates outbound MCP and credentials | Local tools tested. Remote MCP/client tools, auth, retries and approval policy absent. Enabling external MCP would intentionally widen today's egress policy. | 6–10 |
| File volumes | Private small files fit Workspace SQLite; R2 + metadata authority for large/shared volumes | Private files and explicit Linux restore tested. Shared mounts, locking, versioning and automatic persistence absent. | 7–12 |
| Human input | Pi durable document/watch fits state and restart | Simple pause/answer tested. TTL, notifications, delegation and economical parked waits missing. | 3–6 |
| Long streams | Live watch + SSE fits connected clients; durable journal is canonical | Short streams/queued attribution tested. Not multi-hour load or deploy-mid-stream. SSE pins activity; needs bounded buffering, reconnect reconciliation and ideally hibernating WebSockets. | 4–8 |
| Many-agent scale | One DO per agent scales horizontally; shard directory/account indices | Sixteen additional active agents measured locally. No live placement, fan-out, quota, hot-tenant or billing load test. | 6–12 |

Continuous CPU-heavy programs and persistent arbitrary Linux process/RAM resume
do not fit a DO isolate. They require a Container or another compute service;
filesystem snapshots do not close that gap. There is no single transaction
across agent, tenant, billing and volume DOs. Keep ownership explicit and use
idempotent messages rather than assuming Postgres-wide transaction semantics.

## Limits and heap measurement

Workers provide 128 MB per isolate, shared by co-located DOs, not 128 MB reserved
per agent. A VM's 32 MiB QuickJS allocation cap is not the sandbox isolate's
whole memory use. Wasm, JS heap, bindings and other VMs also consume memory.
Keeping the remote code Worker separate removes that VM heap from the agent.

SQLite DO limits relevant here: 10 GB per object; 2 MB row/string/blob and
combined KV key/value; 100 KB SQL statement; 100 bound parameters. CPU is
30 seconds per request by default, configurable to five minutes. I/O wait is
not active CPU. Objects are single-threaded; a hot directory or account is still
a bottleneck even with many agent objects. The documented soft target is about
1,000 requests/second for an individual object, workload-dependent.

The local inspector's `Runtime.getHeapUsage` reported the following after
loading codemode and executing a script for each new agent:

| Additional agents | JS used heap | Delta / additional agent |
| ---: | ---: | ---: |
| 0 (baseline with existing test agents) | 19,593,300 bytes | — |
| 1 | 21,376,648 bytes | 1,783,348 bytes |
| 8 | 24,475,156 bytes | 610,232 bytes |
| 16 | 30,402,380 bytes | 675,568 bytes |

This is an aggregate local agent Worker heap, not an allocation profiler or
steady-state per-agent guarantee. GC was not forced (local inspector did not
complete `HeapProfiler.collectGarbage`). It includes transient allocations and
existing test agents; it excludes the separate sandbox's Wasm heap and Docker.
Do not extrapolate a safe agent count by dividing 128 MB by these deltas.
The test emits raw baseline/current heap fields to make future runs comparable.

Raw local observations are in [measurements.json](measurements.json).

## Verification and sources

From `backends/cloudflare`: `npm ci`, `npm run typecheck`, `npm test`,
`npm run test:integration`, `npm run test:computers` (requires local Docker),
and `npm run build`. The build only bundles the two Workers with `--dry-run`.
The optional computer config is also dry-run bundled during this experiment.
Integration temp state is removed and local processes are stopped after tests.
The repository docs generator also passed without changing its outputs. Its
`llms.txt` test could not load because the root runtime dependencies (`pg`) are
not installed; backend docs are outside that generator.

Unverified: real Workers AI/provider behavior, Cloudflare CPU/memory enforcement,
cloud Container/R2 performance and billing, account quotas and placement,
multi-hour streams, many-agent production load, complete erasure, tenant/billing
authority, and external side-effect recovery. No production resources were read
or written. Public package/docs/image downloads and GitHub PR operations were
the only external services used.

- [Upgrade/API review](UPGRADE.md)
- [Agents Pi integration](https://developers.cloudflare.com/agents/harnesses/pi/)
- [Pi Codemode limits and replay](https://github.com/earendil-works/pi/blob/v1.5.0/packages/codemode/README.md)
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Native Container API](https://developers.cloudflare.com/containers/api/durable-object-container/)
- [Container snapshots](https://developers.cloudflare.com/containers/guides/snapshots/)
- [Container limits](https://developers.cloudflare.com/containers/platform/limits/)
- [Sandbox files](https://developers.cloudflare.com/sandbox/reference/files/)
- [Sandbox directory backups](https://developers.cloudflare.com/sandbox/reference/directory-backups/)
- [Computer backend status](https://github.com/cloudflare/computer/blob/main/packages/computer/README.md)
