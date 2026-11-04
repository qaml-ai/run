# Cloudflare core experiment — 2026-11-04

The core model loop, journal, private files, remote code mode and optional Linux
computers run on Workers/Durable Objects. The disposable Cloudflare measurements
below extend the earlier local experiment. They do not establish production
parity. The ECS runtime and its vendored Pi were not changed.

## Measured on Cloudflare

Measured November 4, 2026, in the `camelAI` account. The interrupted attempt
started at 19:38 UTC; this continuation inspected and reused its four Workers,
nine Durable Object namespaces, two Container applications and one R2 bucket.
Every resource name/class starts with `camelrun-proto-`. Every public HTTP route
requires the same random 64-character bearer secret, installed with
`wrangler secret put` from an ignored, mode-0600 local file. Preview URLs stayed
disabled. Only the benchmark Workers temporarily enabled `workers.dev`.

Versions: Wrangler 4.157.0, Agents 0.33.0, Pi 1.5.0, Sandbox SDK 1.0.3.
Workers AI used `@cf/zai-org/glm-5.3-flash`, capped at 256 output tokens per
dispatch. Exactly four real model calls were reserved. A persisted 24-call
ceiling includes failures/retries; load, recovery and safety tests use the
deterministic provider or no model. Worker/DO placement was platform-selected;
these tests did not select a region or measure inter-region latency.

The authenticated wrappers in `backends/cloudflare/bench/` import the prototype
or its stock remote sandbox. They add diagnostics, fixed test routes and spend
limits. The agent wrapper has distinct real-model and deterministic namespaces.
Client timing includes network round trips from the test machine; server timing
is elapsed time, not CPU. A newly named DO is not proof of a cold Worker isolate
or cold compiled Wasm module. Cloud evidence is retained in
[cloudflare-measurements-2026-11-04.json](cloudflare-measurements-2026-11-04.json).

### Agent turns, streaming and recovery

| Measurement | Cloud result | Method / limit |
| --- | ---: | --- |
| Fresh deterministic agent provisioning | p50 580 ms; range 523–664 ms, N=5 | Includes directory and first DO construction/configuration. |
| First deterministic turn after provisioning | p50 273 ms; range 184–495 ms, N=5 | Does not isolate platform cold-start time. |
| Warm deterministic turn | p50 231 ms; range 153–319 ms, N=5 | Same objects, second turn. |
| First real model turn | 3,249 ms | First turn after 1,086 ms provisioning; one observation. |
| Next two short real turns | 1,555 / 1,482 ms | Same agent, tiny requested replies. |
| Longer real SSE response | First text 2,582 ms; completion 6,576 ms | 25 text deltas; last delta 6,234 ms after submission. |
| 100 concurrent agent turns | 100/100 completed; p50 1,711 ms, p95 1,937 ms, max 2,182 ms | Independent agent DOs; each deterministic turn waits 1,500 ms. |
| Provision those 100 agents together | 56.45 s total; p50 29.28 s, p95 53.92 s | One directory serializes provisioning; this is a scaling bottleneck. |

SSE delivered incremental text and a final response, with text equal to the
completed reply. This verifies short streaming, not reconnect/replay behavior
of long-lived streams. The 100-agent run had 100 distinct constructor IDs and
100 overlapping server `began`/`endedAt` intervals. It measures journal,
scheduling, directory and transport behavior; it does not measure 100
concurrent Workers AI calls. No platform limit or request error occurred in
that run.

For recovery, a codemode script wrote and read a clock/random marker, then
waited on durable human input. Another prompt was accepted and queued. The
host overwrote the marker file before an immediate code-update deployment.
After deployment, the agent's in-memory constructor UUID changed. On resuming
at 19:49 UTC, the pending question and queued prompt survived; both completed.
Clock/random values and the completed read matched; the host's overwritten file
remained unchanged, proving that the completed nested write was not repeated.
This proves the deterministic journal case across a real deployment, not
exactly-once behavior for arbitrary external effects or idle eviction.

### Remote codemode

The caller and sandbox are separate Workers. The stock remote VM has a 32 MiB
allocation limit and 100,000 interrupt polls. The standalone benchmark caller
adds a 15-second wait deadline; the full PiHarness uses the stock timeout
configuration. Both Workers have 30-second CPU ceilings.

| Measurement | Result |
| --- | --- |
| Fresh caller/sandbox first callback, N=12 | p50 221 ms; p95 1,251 ms |
| Warm first callback, N=12 | p50 49 ms; p95 60 ms |
| 50 sequential nested echo calls, N=3 recheck | 3/3 passed; complete script p50 290 ms server / 463 ms client |
| Nested callback interval, 150 samples | p50 4 ms; p95 6 ms; mean 4.387 ms (~228 calls/s excluding startup) |
| 50 simultaneous independent callers/sandboxes | 50/50 passed; client p50 652 ms, p95 3,969 ms; batch 11.59 s |
| 50 simultaneous scripts on one caller/sandbox | 0/50 passed; all hit the 15-second caller deadline |

The independent concurrent scripts each used 20 nested calls. Their caller DOs
are benchmark adapters, not full PiHarness agents. The shared-sandbox failure's
exact cause has not been isolated; it must not be reported as successful
throughput.

Each safety case ran twice. All returned structured errors, preserved the
calling DO's constructor ID, and allowed a following successful script.

| Script | Caller result | Server wall time, first / recheck |
| --- | --- | ---: |
| Infinite loop | Interrupt budget exhausted | 5,540 / 14,691 ms |
| Repeated 1 MiB string allocations | VM out-of-memory error | 408 / 373 ms |
| Await never-resolving Promise | No possible progress error | 26 / 45 ms |
| Throwing script | Script error | 68 / 61 ms |
| Failing host tool | Tool error through script | 85 / 48 ms |

During the loop recheck, 210 calling-DO status probes had p50 35 ms and p95
115 ms latency. The interrupt count is not a predictable wall-time deadline.
This does not prove containment for every builtin or isolation from sibling
sandbox DOs sharing an isolate.

The same five cases also passed through a full deployed PiHarness agent with
the deterministic provider. End-to-end completion was 12,375 / 625 / 380 / 287 /
373 ms respectively. Each produced a tool error, preserved the agent constructor
ID and allowed a following prompt to complete. One state probe per case took
280 / 144 / 199 / 104 / 52 ms; this is a small responsiveness sample, not CPU
measurement. No additional Workers AI call was made.

Cloudflare telemetry supplied real CPU observations, but with delayed sampling.
The 19:57 UTC read covering the experiment so far reported:

| Namespace | CPU total | Active time | Isolate memory p50 / p95 / p99 |
| --- | ---: | ---: | ---: |
| Standalone caller | 1.442 s | 103.758 s | 3.04 / 3.38 / 5.95 MiB |
| Remote sandbox | 56.318 s | 453.748 s | 4.44 / 7.93 / 105.60 MiB |
| Full real-model agents | 0.185 s | 10.650 s | 23.08 / 23.08 / 23.08 MiB |
| Full deterministic agents | 11.935 s | 904.065 s | 19.08 / 20.80 / 21.56 MiB |

The platform CPU-exceeded, memory-exceeded and fatal-error counters were zero.
These are incomplete aggregate samples, not per-case CPU attribution or
per-agent heap. The sandbox's 105.60 MiB p99 is material despite its 32 MiB
per-VM setting: the isolate also owns Wasm/runtime memory and other objects.
Node compatibility CPU APIs were unimplemented and memory APIs returned
zero-filled stubs. **Heap per agent with codemode loaded remains unverified
against the 128 MB isolate limit.** Filtering a metric to an object does not
change its isolate memory scope; do not infer safe per-isolate agent capacity.

### Cloud computers

Docker 29.3.1 was available; no system software was installed. Two Container
apps used the same uploaded image, `durable_object` scheduling, no Internet
egress and the native `ctx.container` API. The SDK path additionally used
Sandbox 1.0.3 `Files`, `DirectoryBackup` and its scoped R2 gateway. The observed
location was `dfw14`, region `WNAM`.

Lite instances provide 1/16 vCPU, 256 MiB memory and 2 GB disk. Measurements
below are client elapsed time unless stated otherwise. Cold exec includes
starting a stopped VM and running Node, but excludes Docker build/upload.
The first placement and later starts are separated because they differed.

| Measurement | Native Container, lite | Sandbox SDK, lite |
| --- | ---: | ---: |
| First placement / first Node exec | 10.877 s | Not separately isolated |
| Stopped VM start + Node exec on recheck | 803 ms | 1,155 ms |
| Three warm Node execs | 83–146 ms | 206–415 ms |
| Small directory preparation | 197 ms | 280 ms |
| Large directory preparation | 52.216 s (earlier run: 8.604 s) | 7.988 s |
| Large TypeScript workload | 40.522 s | 1.196 s |

Basic instances provide 1/4 vCPU, 1 GiB memory and 4 GB disk. One additional
basic start/warm/wake pass measured 805 / 167 / 504 ms for native and
804 / 104 / 683 ms for SDK (warm values are medians of three). Both basic VMs
stopped about 25.2 seconds after their last response with the five-second idle
setting, and both lost the unsaved file. Large backups were measured on lite.

These are small one-shot samples. The large native timings varied sharply;
they do not establish that one provider is intrinsically faster. The small
fixture has 20 files and 241,635 bytes. The large fixture has 23,871 files and
567,051,546 bytes (about 541 MiB), including `node_modules`. The image contains
copies of this backend and its installed dependencies. Extracting that fixture
measures filesystem work, **not a network git clone**. Native macOS optional
dependency files are included as data; the executable workload uses pure JS
TypeScript transpilation.

| SDK R2 directory backup | Small | Large |
| --- | ---: | ---: |
| Source bytes | 241,635 | 567,051,546 |
| Compressed `tar+zstd` bytes | 83,090 | 192,860,817 |
| Backup to R2 | 1.486 s | 177.302 s |
| Restore after VM destruction | 2.026 s | 76.702 s |
| Post-restore file verification | 334 ms | 25.177 s |

Both restores passed file-count, total-byte and marker verification. The large
backup came close to the harness's 180-second operation deadline. The recorded
handles and R2 objects were explicitly deleted after verification.

Native cloud snapshot/restore was deliberately not executed. The public API
has no snapshot delete/list method; snapshots can remain restorable for 30 days,
and deleting a stored handle does not remove the snapshot. The documentation
does not establish that deleting an app removes those snapshots. Creating one
would prevent verifying the requested zero-leftover cleanup. This measurement
needs a verified deletion path or explicit permission to retain an expiring
snapshot. See [workspace save/restore](https://developers.cloudflare.com/sandbox/files/save-and-restore-a-workspace/)
and [native snapshot API](https://developers.cloudflare.com/containers/api/durable-object-container/).

The original harness failed its inactivity assertion for both providers:
both VMs still ran after ten seconds. That assertion was too early: the timeout
begins after the DO becomes inactive, not when an exec response arrives.
A benchmark-only change clears operation timers explicitly, and a separate
test polls the account instance API without sending traffic to the measured DO.
With a five-second inactivity setting, the platform stop timestamps were about
25.1 seconds after the last exec response for both lite providers. Wake took
798 ms native / 1,037 ms SDK; the unsaved file was gone. This verifies filesystem
loss on sleep and fresh-start wake, not persistent process/RAM resume. It does
not prove that leftover timers alone caused the original failure. The normal
backend adapter was not changed by this experiment.

### Cost and account visibility

The token could deploy/delete all test resources and read Workers, DO and R2
analytics. Actual billed cost was not available at measurement time. The v1
billable-usage endpoint returned account records ending at November 4 00:00 UTC,
before the experiment. The v2 endpoint returned HTTP 403, code 1171,
`billable-usage.api.resource.insufficient_permissions`. Its permission catalog
names `Billing Read`; endpoint-specific eligibility may also be required.
No billing or account setting was changed.

At the 19:57 UTC analytics read, available usage gave this unrounded estimate:

| Usage | Published-rate arithmetic | USD |
| --- | --- | ---: |
| Workers | 1,223 requests × $0.30/million + 1,555.445 CPU-ms × $0.02/million | 0.00039801 |
| Durable Objects | 1,848 requests × $0.15/million + 264.291367 GB-s × $12.50/million | 0.00358084 |
| R2 operations | 18 Class A × $4.50/million + 16 Class B × $0.36/million | 0.00008676 |
| Four Workers AI calls | (2,319 uncached × $0.15 + 2,048 cached × $0.03 + 319 output × $0.50) / million | 0.00056879 |
| Partial telemetry subtotal | Sum of the rows above | **0.00463440** |

This is incomplete, not the invoice: Container and R2-storage datasets still
returned no rows, SQLite operations were not counted, and analytics lagged the
tests. Empty data was not treated as zero usage. The measured compressed backups
totaled 192,943,907 bytes; one day's R2 peak storage at $0.015/GB-month adds about
`0.192943907 / 30 × 0.015 = $0.00009647` before allowances.

For spend control, a deliberately broad 1,457-second planning envelope through
the 20:03 UTC cleanup assumed
512 DOs active for the entire experiment, two lite and two basic VMs using full
CPU throughout, 10,000 Worker requests, one million Worker CPU-ms, 100,000 SQLite
writes, one million SQLite reads, 1,000 of each R2 operation class and 2 GB R2
storage for one day. The DO component is
`512 × 0.128 × 1457 / 1,000,000 × $12.50`; Container compute is
`2 × 1457 × ($0.000002015 + $0.000007780)`. With the other stated reserves and
model tokens, that envelope was **$1.352**, well below the $5 stop threshold.
It is an overestimate of provisioned work, not a bound on account invoice
rounding. Included allowances, contract rates, billing-unit rounding and
delayed usage determine the eventual bill. The existing account plan was not
changed or purchased for this test.

Rates checked November 4: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Containers](https://developers.cloudflare.com/containers/platform/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/) and
[GLM-5.3-flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/).

### Teardown and remaining gaps

At **20:03 UTC**, the complete paginated inventory and registry check returned:
Workers `[]`, Durable Object namespaces `[]`, R2 buckets `[]`, Container apps
`[]`, queues `[]`, images `[]` for the `camelrun-proto-` prefix. All four former
`workers.dev` endpoints returned 404. Before deletion, all four computer slots
reported stopped and both apps had empty active-instance lists. Both R2 backups
were removed. Explicit delete migrations removed the nine DO classes before
`wrangler delete` removed the four Workers. No native snapshot was created.
The generated bearer was removed from the local ignored token file after the
last verification. The final audit is in the attached measurement JSON.

All named mutations targeted prefixed resources. One cleanup caveat: Wrangler's
image-delete implementation also requests registry layer garbage collection.
That request completed, but it exposes no per-layer audit; no other image was
explicitly targeted. No routes, DNS, custom domains or account settings changed.

Native snapshots, per-agent heap, long-running streams and a final billed amount
remain unverified. Real-model 100-way load also remains untested under the
few-dozen-call budget. A further snapshot experiment needs an explicit retention
exception or a verified delete API; v2 billing needs `Billing Read`/endpoint
access. The 50-script shared-sandbox failure and serialized provisioning need
engineering work before production use.

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
| Many-agent scale | One DO per agent scales horizontally; shard directory/account indices | 100 overlapping deterministic cloud turns passed. Creating those agents took 56 seconds through one directory. Real-model fan-out, quota and billing load remain untested. | 6–12 |

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

The local results above predate the cloud measurements at the start of this
report. Remaining gaps include per-agent heap and complete CPU attribution,
native cloud snapshot deletion, actual invoice cost, account quotas and
placement guarantees, multi-hour streams, real-model concurrent load,
tenant/billing authority and arbitrary external-effect recovery. The cloud
experiment used only disposable prefixed resources in the company account;
no existing production resource was changed.

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
