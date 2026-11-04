# Cloudflare core experiment — 2026-11-04

The core model loop, journal, private files, remote code mode and optional Linux
computers run on Workers/Durable Objects. The disposable Cloudflare measurements
below extend the earlier local experiment. They do not establish production
parity. The ECS runtime and its vendored Pi were not changed.

## Round two — Cloudflare measurements

Round two began at 20:20 UTC on November 4, 2026, from an empty prefixed
inventory. The authorization permits native snapshot retention and a roughly
$100 stop point for this run, within $1,000 total prototype spending. The
account and bearer protections are unchanged. Only `camelrun-proto-*` resources
are used. The sections below supersede the round-one gaps where measured.
Raw results and failures are retained in the `round2-*.json` files beside this
report. The one-hour soak is complete; final accounting and teardown are
recorded below.

### Shared sandbox diagnosis and fix

Fifty scripts sharing one sandbox can exceed the 15-second caller deadline
without a whole-request serialization gate. Instrumentation saw all 50 execute
handlers enter before completion. Fifty zero-callback scripts still took
27.838 seconds at the median with a longer deadline. A separate bare-QuickJS
probe completed in 13.838 seconds for 50 VMs, including RPC and disposal;
their initial Wasm linear memory
alone totaled 65.625 MiB, before the Pi prelude and runtime overhead. Matched
periodic telemetry for the 50-script/one-callback sandbox recorded 21.689 seconds
of CPU in 25.530 active seconds, with a sampled maximum of 105.85 MiB. Its
25.650-second server median is consistent with CPU-heavy VM startup delaying
callback processing, rather than a callback deadlock. The namespace's observed
CPU/memory-exceeded counters were zero in that telemetry sample. These data
support CPU pressure, while not separating VM execution from garbage collection
or proving a 128 MB memory-limit hit. Longer deadlines let these scripts finish.

The prototype now uses `codemode/routing.ts` to select a separate stateless
sandbox DO for each execution, with four concurrent remote executions admitted
per agent incarnation. One remote is pinned through every callback and the terminal reply.
Excess work returns a structured error. A timed-out caller keeps its admission
slot until the remote actually settles; the platform CPU/interrupt boundary
still controls a CPU-only overrun. The change adds no unjournaled wait queue.
Admission is an in-memory bound, not a durable quota on remotes across restarts.

| Codemode workload | Passed | Client p50 / p95 |
| --- | ---: | ---: |
| Existing per-agent sandbox, 50 scripts / 50 caller DOs | 50/50 | 703 / 1,013 ms |
| Existing per-agent sandbox, 200 scripts / 50 caller DOs | 199/200 | 1,002 / 2,043 ms |
| New bounded per-execution helper, 50 / 50 caller DOs | 50/50 | 723 / 1,172 ms |
| New helper, 200 / 50 caller DOs | 200/200 | 633 / 1,182 ms |
| New helper, repeated 200 / 50 caller DOs | 200/200 | 519 / 1,177 ms |
| Full PiHarness, 50 agents with one script each | 49/50 | 1,716 / 2,238 ms |
| Full PiHarness, four queued scripts on each of 50 agents | 200/200 | 4,576 / 8,203 ms |
| Full PiHarness, repeated one script on each of 50 agents | 50/50 | 1,703 / 2,783 ms |

Direct caller scripts make 20 sequential echo callbacks. Full Pi scripts write
a private file and perform 20 reads through the real tool journal. Their four
requests per agent are queued, with at most 50 executing Pi conversations.
Two separate first-callback barrier runs proved exactly 200 live sandbox VMs
and both completed 200/200; client p50/p95 was 10.780/10.834 seconds, then
3.342/3.380 seconds, including straggler wait. The 50-participant barrier failed
twice after one RPC reset/loss stranded its other 49 participants. Those are
recorded coordination failures, not successful throughput. The ordinary
199/200 and full-Pi 49/50 runs each had a network-connection loss; the affected
full agent's subsequent recovery script passed.

The completion adapter also preserves the latest stored request record while
settling a turn, including the start timestamp written during the wait.
Older overlap counts remain lower bounds where that timestamp was missing.
See `round2-codemode.json` and `bench/round2-codemode-notes.md` for every trial.

### Busy agent heap, with remote codemode loaded

This is the actual CamelAgent, Workspace, PiHarness, Lifecycle and codemode
extension. Histories contain real Pi entries with 1,024 bytes of text per
message. The probe retains Pi's loaded conversation context and grows ordinary
JavaScript double arrays in 4 MiB steps. Constructor/isolate replacement on the
next request is the failure signal. An ArrayBuffer control was rejected because
external buffers did not provide reliable JS-heap calibration.

| Seeded messages | Text bytes | SQLite bytes | Added JS arrays before replacement |
| ---: | ---: | ---: | ---: |
| 0, plus initialization | 328 | 303,104 | 116 MiB |
| 1,000 | 1,024,328 | 1,695,744 | 112 MiB |
| 10,000 | 10,240,328 | 14,344,192 | 88 MiB |
| 50,000 | 51,200,328 | 70,672,384 | Replacement immediately after context load |

These are incremental headroom probes, not absolute memory measurements:
subtracting them from the cap cannot reliably account for native overhead,
GC and delayed replacement. Sixteen busy agents with 1k messages each kept
stable constructor IDs during a 20-second hold; Cloudflare placed them in
sixteen different observed isolates. Later GraphQL periodic samples from that
cohort measured 28,096,524–28,358,668 bytes (26.8–27.0 MiB) for the whole isolate.

A second fixture kept the context alive for 30 seconds inside one RPC, without
adding probe arrays. The matched 10k object reported **64,247,820 bytes
(61.27 MiB)** during that hold, no memory-exceeded event, and the same instance
on the next request. The matched 50k object reported **182,863,884 bytes
(174.39 MiB)** with nonzero `exceededMemoryErrors` samples. Its in-flight
request finished, but the next request had a new isolate/constructor and no
retained context. This is over-limit execution followed by replacement, not
174 MiB of viable capacity. These measurements include the entire isolate;
see `round2-heap-metrics.json` for exact names, object IDs and sample windows.

**One agent per DO is the tested unit.** We cannot force or promise a packing
count. Three such full footprints fit arithmetically within 80% of a 128 MiB
cap for 1k messages, and one for 10k messages, but that is not a measured
placement capacity or a guarantee under load.
A full 50k context requires compaction/windowing before production.

### Native snapshots and actual Linux builds

Native snapshots preserve the writable root filesystem, including `/workspace`
and a tested file in `/tmp`, after container destruction. They do not preserve
the running sleep process. A full-content hash check after corrupting and
restoring the built compiler matched the hash recorded before corruption,
after the first restore. That first restore separately matched file counts
and byte totals. Snapshots are tied
to the source image version. The documented limit is 20 GB; retention is 30 days
from capture or the latest restore. The limit and expiry are documented, not
maximum-size or 30-day experiments.

| Native snapshot | Source workspace | Returned snapshot bytes | Capture, server | Restore, server |
| --- | ---: | ---: | ---: | ---: |
| Small, basic | About 240 KB | 94,514 | 3.305 s | 0.808 s |
| Built TypeScript, standard-2 | 670,559,277 bytes; 84,040 files | 300,560,180 | 17.940 s | 24.431 s |
| Same large snapshot, repeat restore | Same | Same | — | 0.660 s |
| Small snapshot after deleting normal image tag | Same small workspace | Same | — | 1.370 s |

The second restore is cache-sensitive; do not advertise it as cold restore.
Restore timing is readiness, not a full read of the restored tree: the first
post-restore scan took another 8.260 seconds; the repeated restore's full hash
read took another 26.985 seconds.
The image-tag deletion test retained the snapshot's backing artifacts. It does
not establish restoration after those artifacts are removed.
Round one's SDK DirectoryBackup took 177.302/76.702 seconds to save/restore a
567 MB fixture on **lite**. The native large measurement uses **standard-2** and
a different real Linux tree. The comparison demonstrates mechanisms and
observed times, not a controlled API-only speedup. Native snapshots retain
rootfs state; DirectoryBackup writes a compressed directory archive into R2.

The real build is a shallow network clone of `microsoft/TypeScript` v5.9.3,
commit `c63de15a992d37f0d6cec03ac7631872838602cb`, then `npm ci --no-audit
--no-fund` and `npm run build:compiler`. It includes compiler/services output,
not the upstream test suite. No local fixture or shared npm cache replaces
those operations.

| Build stage | Basic: 1/4 vCPU, 1 GiB | Standard-2: 1 vCPU, 6 GiB |
| --- | ---: | ---: |
| Network clone | 214.693 s | 49.479 s |
| Install | 117.185 s | 25.836 s |
| Compiler build | Incomplete; timeout kill at 926.890 s | 101.553 s |
| Clean compiler rebuild | — | 98.600 s |

Standard-2's clone, install and first build totaled 176.867 seconds, compared
with 24.431 seconds to restore the already-built tree to readiness. Clone alone
took 49.479 seconds; it does not restore dependencies or compiler output.

The standard-2 clean rebuild's measured peak process RSS was 1,055,220 KiB.
Container analytics across that instance's run reported 2,503.09 MiB p99
memory for the whole container. This is separate from the single process's
peak RSS.
Basic's compiler artifact was absent after the configured 900-second process
group timeout; kill/drain completed at 926.890 seconds. The VM had no swap and
recorded no kernel OOM kill. It did record heavy page scanning/reclaim, and
the build interval used 199.932 seconds system CPU versus 29.350 seconds user
CPU. These observations suggest severe memory/file-cache pressure, without
proving a single cause. Two client requests also hit Node's independent
five-minute HTTP-header timeout. The original build's result was recovered
without dispatching another build; the client now uses bounded HTTPS with an
explicit longer deadline.

### One workspace with worker-shell and ContainerBackend

`@cloudflare/computer` 0.9.0 and its optional `just-bash` 3.0.1 peer ran with
`backends: [worker-shell, container]`. DO-to-shell, shell-to-container and
container-to-shell file visibility passed. The package's documented
`experimental` compatibility flag was rejected by cloud deployment (10021).
Removing it worked; the wrapper also needed the documented workspace RPC
accessor. This is an experimental integration, not a stable backend contract.

| Standard-2, flat TypeScript modules | 5,000 modules | 20,000 modules |
| --- | ---: | ---: |
| Source generation | 9.938 s | 109.469 s |
| Explicit source pull | 15.363 s / 5.69 MB | 125.013 s / 22.80 MB |
| Actual TypeScript compilation | 36.242 s; passed | Client failed after 301.181 s; see below |
| Explicit output pull | 14.536 s / 5.65 MB | 98.641 s for a partial 16,718-entry pull |
| Final verified source / output file count | 5,000 / 5,000 | 20,000 / 20,000 after reconciliation |
| Final DO SQLite size | 20,070,400 bytes | 80,068,608 bytes |
| computerd RSS, baseline / observed after build | 91,112 / 274,888 KiB | 93,424 / 330,868 KiB |
| computerd peak RSS | 275,916 KiB | 392,252 KiB |

The container daemon's RSS is distinct from agent DO heap and whole-VM memory.
The 20k compiler was still running roughly 346 seconds after dispatch, with
833,460 KiB RSS and 836,256 KiB peak RSS, despite losing the HTTP client and a
requested 300-second command timeout. A later diagnostic code deployment
interrupted its session. Recovering that execution returned `cancelled`, exit
143; subsequent reconciliation exposed all 20,000 outputs. **The 20k run did
not produce a successful build-duration measurement.** Its partial output pull
is not the full final-sync cost. The fixture places every module in one
directory, so its scaling ratio is deliberately harsh, not a general repo
estimate.

The delayed 20:41 UTC DO dataset reported isolate-memory p99 samples of 39.984
and 41.330 MiB for the two workspace objects, 105.729 seconds of CPU, 360.127
seconds of active time and 46.096 GB-seconds of duration. The memory samples
describe whole isolates even when filtered by object. CPU-exceeded,
memory-exceeded and fatal-error counters were zero; invocation telemetry
contained one error in 32 requests. These aggregate samples include setup,
interruption and recovery, and do not measure per-build CPU or per-agent heap.

One-second inactivity did not kill a live 15-second command because the SDK
kept it active. Forcing destruction five seconds into another command produced
`WritableStream RPC stub was disposed without calling close()` after 5.432 s.
Previously synced files survived; the unsynced write disappeared. The next
container command recovered in 28.537 s and repushed 10,008 durable entries.
Production needs durable execution IDs and reconnect handling, explicit sync
boundaries, enforced process-tree cancellation, and safe treatment of uncertain
interrupted commands. Evidence is in
[round2-computer-backend.json](round2-computer-backend.json).

### Real Workers AI load and hourly soak

The installed Pi catalog did not include Llama 3.2 1B, so its initial provisioning
probe failed before any model call. The measured model is the supported small
`@cf/ibm-granite/granite-4.0-h-micro`, capped at 64 output tokens and 64 KiB input
per dispatch. Full Pi agents perform the calls. The wrapper persists a maximum
of 90 dispatches per agent. Prompts and test histories contain no private data.

The first laptop-driven 500-agent attempt lost 89 provisioning connections;
411 were submitted and 398 completed. We retained that failure and moved
fan-out to one authenticated Worker with 25-at-a-time provisioning. The first
server-driven 500 run completed 487/500. Small-model tool selection also invoked
`ask_human` despite instructions and parked early soak turns. That preliminary
soak was stopped and recorded. The text-generation benchmark now removes
`tools` and `tool_choice` before dispatch; codemode is measured separately.
The first stop attempt had a benchmark-controller race: an in-flight alarm
could overwrite the stop timestamp and schedule another alarm. Residual
preliminary controllers were found at 21:01 UTC and stopped/aborted at 21:03
after adding an independent durable stop flag. Their extra activity is included
in account usage and kept separate from the `steady-*` cohort's results. The
first half of that cohort's run therefore includes additional background load.

| Clean model workload | Result | Accepted-to-completed p50 / p95 / maximum |
| --- | ---: | ---: |
| 100 agents, server fan-out | 100/100 | 1.758 / 5.984 / 79.665 s |
| 500 agents, server fan-out | 472/500; 28 capacity errors | 2.967 / 19.508 / 83.039 s |

Failed model histories explicitly report `Capacity temporarily exceeded`.
These are provider capacity failures, not a successful 500-agent production
qualification. Successful-turn percentiles exclude failed turns. The 500-run
observed overlap is a lower bound of 482 due to missing start timestamps in
some original completion records. All 28 failed requests subsequently completed
with a four-at-a-time retry pass. Four transport failures during an overlapping
code deployment were reconciled with their existing request IDs, without new
model dispatches.

A separate application admission queue provisioned 500 fresh agents and
launched at most four requests per second, with a cap of 40 in flight.
It passed **500/500 with zero retries or capacity errors**. Provisioning took
36.747 seconds; draining the admitted work took 136.041 seconds. Per-attempt
client p50/p95/p99/max was 1.919/3.377/5.327/18.964 seconds; these exclude time
waiting in the application queue. At most 12 were in flight and 11 server
turns overlapped. This is evidence for paced admission, not 500 simultaneous
model generations. See `round2-admission.json`.

A fresh 20-agent, one-minute-alarm soak ran from about 20:32 to 21:32 UTC.
All **1,200/1,200 turns completed**, with zero agent-turn errors across three
scheduled code deployments at 15, 30 and 45 minutes, plus an earlier diagnostic
deployment. Turn elapsed p50/p95/p99/max was **1.342/2.890/5.783/15.004 seconds**.
Alarm lateness p50/p95/p99/max was **1/3/190/342 milliseconds**. Each agent ran
60 turns. The controller recorded 1,200 distinct constructor IDs across its
1,200 alarms, so persistence and wakeup were exercised throughout, rather than
just keeping twenty controller instances resident.
The cohort used 1,201 model dispatch attempts: one internal provider error at
21:29:59 UTC produced a zero-token error entry and was automatically retried.
Its turn still completed. Thus terminal turn failures were 0/1,200, while
observed model-attempt failures were 1/1,201 (0.083%).
At the 30-minute deployment, one monitoring GET returned HTTP 500 and ended
the initial local supervisor. The durable alarms kept running. Monitoring
resumed from the existing records and original deadline, with bounded GET
retries and no new `/start` calls. This monitoring failure is retained separately
from agent-turn outcomes.

The matched invocation dataset is not error-free: the agent objects recorded
29 alarm invocations with `clientDisconnected`; their HTTP invocations were
successful. The timer controllers recorded three failed HTTP invocations at
the 30-minute deployment (two `clientDisconnected`, one `scriptThrewException`),
while controller alarms succeeded. These platform/RPC outcomes are separate
from the 1,200 successfully reconciled terminal turn records. See
`round2-soak-invocations.json` for the status and type breakdown.

### Cost model and accounting

Published marginal rates imply the following before included allowances,
account-specific terms and rounding. R2 uses decimal GB; Container memory uses
GiB. DO duration charges the fixed 128 MB allocation for each active object,
even if several share an isolate.

| Unit | Marginal model |
| --- | --- |
| Hibernation-eligible idle agent-hour | $0 DO duration; storage remains billable |
| Continuously active agent DO-hour | `0.128 × 3600 × $12.50 / 1e6 = $0.00576` |
| Active agent plus active sandbox for the whole hour | $0.01152, before requests/storage/model |
| Observed one-turn/minute agent-hour | About $0.00841 including DO, SQLite operations and model; see below |
| Observed timer-controller overhead per agent-hour | About $0.00037, separate from the agent |
| SQLite, million rows read / written | $0.001 / $1.00 |
| SQLite stored data | $0.20/GB-month; about $0.00000047/hour for the measured 1k-history database |
| Basic container-hour, memory + disk | $0.010008; up to $0.028008 with fully used CPU |
| Standard-2 container-hour, memory + disk | $0.057024; up to $0.129024 with fully used CPU |
| R2 object write / read | $0.00000450 / $0.00000036; deletes free |
| R2 standard storage | $0.015/GB-month |
| Granite model tokens | $0.017/M input, $0.112/M output |

The real R2 probe writes, verifies and deletes eight 64 KiB objects. Its object
operations total $0.00003888 before allowances, plus bucket/control calls and
daily peak storage. GraphQL works with the existing token. Container application
IDs need UUID formatting; adding `requestSource` to the AI query suppressed
binding-call rows. Some resource metrics become empty after deletion, including
historical windows, so the cost helper preserves the latest nonempty observation
per resource and records its original query window. Empty rows are not zero.
The final 21:35 UTC read estimates **$4.75287** of marginal usage: $4.46315
SQLite operations, $0.16683 DO compute/requests, $0.05803 Container compute and
egress, $0.06189 Workers AI, $0.00292 Worker CPU/requests, and $0.000043 R2
operations. The DO data contains 1,708,995,468 rows read and 2,754,155 rows written.
Bulk workspace sync and seeded-history probes account for most SQL cost.
The model/account analytics reports 3,608 requests, 3,345,099 input tokens and
46,184 output tokens. The application counters report 3,610 dispatch attempts,
3,341,179 input tokens and 46,084 output tokens; the different scopes and
ingestion mean these are cross-checks, not identical counters. Other
`camelrun-proto-bench-*` resources appeared during this run; model analytics
cannot be attributed by Worker, so account-wide exclusivity is not assumed.

For the twenty-agent hourly cohort, measured agent DO duration was
3,715.591 GB-seconds, or 29,028.051 active seconds summed across agents.
DO compute/requests plus SQL cost $0.143102, or $0.007155 per agent-hour.
The cohort's 1,410,000 input and 9,600 output tokens add $0.025045, making
**$0.008407 per agent-hour** at this one-turn-per-minute workload. Its separate
timer controllers add $0.000373 per agent-hour. These are workload observations,
not a flat price for arbitrary busy agents. Exact observations are in
`round2-soak-cost.json`, `round2-model-usage.json` and `round2-cost.json`.

This is an observed-usage estimate, not an invoice. Included allowances,
account-specific rounding, SQL stored byte-time, Workers logs and retained
snapshot/image storage are not fully quantified. Fifteen metric results use the
last nonempty pre-deletion observation, with each original window recorded in
`round2-telemetry-retained.json`; their unobserved tails are not claimed as zero.
No billing API permission was requested and no account setting was changed.

### Cleanup and retained snapshots

Verified at **21:36:55 UTC**: all seven Workers, nine DO namespaces, two
Container applications, one R2 bucket and three ordinary image tags created
by this run were deleted. All seven former Worker URLs returned HTTP 404.
The local benchmark bearer file was removed. The exact `camelrun-proto-r2-*`
inventory has no remaining Worker, namespace, application, bucket or queue.

| Retained native snapshot ID | Snapshot bytes | Last restore, UTC | Estimated expiry, UTC |
| --- | ---: | --- | --- |
| `abc216e1-49d8-4d92-a508-f886069f761b` | 94,514 | Nov 4, 20:46:44.514 | Dec 4, 20:46:44.514 |
| `7ee02af9-21ee-449d-a8a1-5c2b1dc2c649` | 300,560,180 | Nov 4, 20:29:53.280 | Dec 4, 20:29:53.280 |

The two allowed snapshots retain four registry aliases. Their unique snapshot
layers total 300,654,694 bytes, plus 160,154,763 bytes of shared converted base
layers; metadata and original image references are separate. Expiry is derived
from the documented 30-day TTL, not an observed deletion.

The final account-wide prefixed list also contains five
`camelrun-proto-bench-*` Workers, fifteen namespaces, five Container applications
and their registry artifacts, created outside this run after its empty
baseline. They were left untouched. Cleanup is verified against the recorded
round-two resources, not claimed as an empty account-wide `camelrun-proto-*`
list. `round2-cleanup.json` records both the empty owned inventory and these
excluded concurrent resources; `round2-snapshots.json` maps the retained aliases
and digests.

### Validation

The backend passes typecheck, all 12 unit tests and all 14 local workerd
integration tests. Unit coverage includes timeout/close admission across a
replacement sandbox bridge. Integration coverage includes hostile codemode,
queued request timestamps, abort and hard-process journal recovery. The
runtime and sandbox dry-run bundles pass. The benchmark TypeScript
configurations typecheck and all 48 benchmark JavaScript modules pass syntax
checks. These checks are separate from the cloud measurements above.

Repository `npm run docs` passes. The required `llms.txt`-filtered docs test
passes both tests on `rt-pool-2` at commit `9ff7bfae`: actual unauthenticated
serving and generated-content/link checks. Root docs inputs match that commit;
the report here is outside the root docs generator. The local attempt lacked
root dependencies, and the first Sprite setup failed before starting a job.
The later Sprite job completed successfully; the root runtime suite was not
rerun for this backend-only change.

### Verdict after round two

- Viable now: durable Pi turns and journal recovery, separate per-execution
  codemode DOs, bounded short histories, filesystem snapshots, and standard-2
  Linux install/build work.
- Needs Cloudflare/platform work or guarantees: dependable 500-way model
  capacity, better attributable per-object/isolate memory metrics, predictable
  isolate placement, larger supported memory for unwindowed 50k histories, and
  a clearer snapshot listing/deletion/billing surface.
- Needs our engineering: provider admission/retry queues, context windowing,
  bounded script admission/deadlines, efficient SQL access and incremental
  file sync, interrupted command reconciliation, sharded provisioning, and
  production auth/tenant, billing and external-effect recovery semantics.
- Not established: arbitrary process/RAM resume, exactly-once external effects,
  chosen multi-agent packing, multi-hour streaming or production parity.

Sources checked November 4: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Container pricing](https://developers.cloudflare.com/containers/platform/pricing/),
[Container snapshots](https://developers.cloudflare.com/containers/guides/snapshots/),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/), and
[Granite model](https://developers.cloudflare.com/workers-ai/models/granite-4.0-h-micro/).

## Measured on Cloudflare — round one

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

At the end of round one, native snapshots, per-agent heap, real-model 100-way
load and long-running streams remained unverified. Round two above uses the
subsequent snapshot-retention authorization and estimates costs from usage
analytics without billing API access. Long-running streams and a final invoice
remain outside the measured scope.

## What runs

One `CamelAgent` owns a PiHarness, Lifecycle and SQLite database. Agents 0.33
supplies Pi's storage adapter and recovery wake job. The existing TypeScript SDK
can provision an agent, send prompts, stream text, read history/files and abort.
Tests use a deterministic model; no paid model or Cloudflare account is needed.

Stock `createCodemodeExtension` calls `RemoteCodemodeSandbox` from `/portable`.
The `/cloudflare` implementation lives in a **separate Worker**, with one sandbox
DO per execution and four concurrent executions admitted per agent incarnation.
This keeps QuickJS/Wasm and synchronous script computation off the
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
| `WorkerShellBackend` | Experimental `just-bash` interpreter on Worker Loader. Shared-workspace reads/writes executed in round two. Shell-like tasks, not arbitrary native executables. The documented compatibility flag was rejected by deployment; the tested wrapper omitted it. |
| `ContainerBackend` + `withWorkspaceContainer` | Experimental Linux daemon and Workspace sync/FUSE. Round two measured two-way sync and a 5k-file build, plus interruption and 20k-file failures. Useful common Workspace API, with substantial IO and recovery work remaining. |
| `LegacyContainerBackend` | Deprecated. Do not build a new provider on it. |

The native and SDK providers above compare filesystem snapshot mechanisms.
Round two separately tests Computer's experimental Linux sync implementation.
Workspace assets/git/artifacts still need their own tests.

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

The local results above predate the two cloud rounds at the start of this
report. Round two adds heap pressure, native snapshots, real-model concurrency
and an hourly soak. Remaining gaps include exact heap/CPU attribution, native
snapshot lifecycle APIs, actual invoice cost, capacity and placement guarantees,
multi-hour streams, tenant/billing authority and arbitrary external-effect recovery. The cloud
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
