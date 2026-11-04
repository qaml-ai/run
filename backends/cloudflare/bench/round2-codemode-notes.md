# Round two: codemode and agent heap

Cloud measurements on November 4, 2026, starting at 20:21 UTC. The fixtures use
Pi 1.5.0, Wrangler 4.157.0 and the existing prototype dependencies. All routes
require the ignored benchmark bearer. No Workers AI call was made by these
fixtures. Structured evidence is in `docs/round2-codemode.json`; the export
script also retains the failed runs.

## Why the shared sandbox misses its deadline

The failure is reproducible, but not deterministic at exactly 50 scripts.
With one caller and one sandbox, 2/4/8/16/32 concurrent scripts took median
331/965/1,649/2,633/6,612 ms on the server. One 50-script, 20-callback pass
completed 50/50 in 13,482 ms median. A 21-callback pass completed only 9/50
before the 15-second deadline. With 50 callers sharing one sandbox, 0/50
completed and none reached a host callback before the deadline.

Instrumentation recorded all 50 sandbox execute handlers entering before any
completed. It is not a whole-request input gate serializing them. Removing
host callbacks did not remove the problem: with a 60-second deadline, 50
scripts with zero callbacks completed at median 27,838 ms, one callback at
25,650 ms, and 20 callbacks at 13,712 ms. This rules out a mandatory callback
deadlock. Longer deadlines let the same stock VM implementation finish.

A separate native-VM probe, without the codemode prelude or RPC callbacks,
measured 1/8/16/32/50 QuickJS VMs in 324/567/1,755/12,941/13,838 ms client
time, including RPC, initialization, memory inspection and disposal.
Each bare VM had 1,376,256 bytes of Wasm linear memory and 64,098 bytes reported
by QuickJS as used memory. Fifty bare VMs used 68,812,800 bytes (65.625 MiB) of
linear memory before the prelude, bridge objects and host/runtime overhead.

Late periodic telemetry matched the `50-shared-one-callback` object by name:
21.689071 CPU seconds, 25.529652 active seconds, and sampled maximum memory
110,988,584 bytes (105.85 MiB), against a server median of 25.650 seconds.
The namespace's observed exceeded-CPU and exceeded-memory counters were zero
in that sample. This strengthens the CPU-pressure diagnosis: initialization
and VM execution consume most of the wall budget and delay callback handling.
CPU execution and garbage collection share the same thread, so their individual
contributions remain unknown. It does not prove that the 128 MB cap caused a
particular timeout, or that a periodic memory sample captures every peak.

## Fix and concurrency results

`codemode/routing.ts` selects a new stateless remote DO once per execution.
The callback exchange stays attached to that one RPC. Its per-agent admission
limit is four active remote executions. Excess work gets a structured sandbox
error; the helper does not add an unjournaled in-memory wait queue. The normal
PiHarness already serializes its own conversation turns. Admission is local to
one agent incarnation, not a durable quota across restarts or in-flight remotes
that outlive a caller reset.

An execution keeps its admission slot until the underlying RPC finishes or
rejects, even if the caller times out or closes. Releasing earlier would permit
more live VMs than the limit. As in stock Pi, a CPU-only remote can outlive the
caller deadline until an interrupt or the platform CPU boundary stops it.
This is not a remotely killable wall-time guarantee. Journal/replay behavior
is unchanged; a replay uses a fresh stateless VM with the original deterministic
execution input.

Direct caller DOs are benchmark surrogates, distinct from full Pi agents.
Their scripts make 20 sequential echo callbacks:

| Layout | Passed | Client p50 / p95 | Server p50 / p95 |
| --- | ---: | ---: | ---: |
| Existing per-agent routing, 50 agents / 50 scripts | 50/50 | 703 / 1,013 ms | 328 / 507 ms |
| Existing per-agent routing, 50 agents / 200 scripts | 199/200 | 1,002 / 2,043 ms | 470 / 1,604 ms |
| Per-execution, unbounded diagnostic, 200 scripts | 200/200 | 823 / 1,456 ms | 316 / 720 ms |
| Actual bounded helper, 50 agents / 50 scripts | 50/50 | 723 / 1,172 ms | 325 / 723 ms |
| Actual bounded helper, 50 agents / 200 scripts | 200/200 | 633 / 1,182 ms | 297 / 669 ms |
| Actual bounded helper, 200-script repeat | 200/200 | 519 / 1,177 ms | 288 / 792 ms |

The 199/200 run had one `Network connection lost` failure. The fixed helper's
normal fan-out had 43/179/176 maximum overlapping server intervals, respectively,
for its 50/200/200 runs. Thus fan-out is not proof of exactly 200 live VMs.

A first-callback barrier supplies that stronger proof. Two 200-script runs
both had all 200 VMs alive at the same barrier before any continued, and both
completed 200/200. Client p50/p95 was 10,780/10,834 ms initially and
3,342/3,380 ms on the repeat, including the wait for the final participant.
Both 50-script barrier attempts failed: one participant reported a code-update
reset in the first, and a network connection loss in the second. The other 49
then expired at the barrier. This demonstrates the added coordination failure
domain; it does not negate the successful simultaneous 200-VM runs.

Full PiHarness agents were also measured. Each script writes one file and makes
20 sequential reads through the real Pi tool journal, not the echo surrogate:

| Full-agent workload | Passed | Client p50 / p95 |
| --- | ---: | ---: |
| 50 actual agents, one script each | 49/50 | 1,716 / 2,238 ms |
| 50 actual agents, four submitted scripts each | 200/200 | 4,576 / 8,203 ms |
| Failed agent's recovery script | 1/1 | 1,915 ms |
| 50 actual agents, one-script repeat | 50/50 | 1,703 / 2,783 ms |

The full-agent failure was a structured remote `Network connection lost`
before any tool call. Recovery succeeded. Four requests per Pi agent are
queued turns, so that 200-request test has at most 50 executing conversations;
the separate barrier test proves simultaneous 200-VM capacity.

## Agent heap with codemode loaded

The heap fixture subclasses the actual `CamelAgent`, constructs its Workspace,
PiHarness, Lifecycle, registries and remote codemode extension, and executes
codemode before measuring. It appends real Pi user/assistant entry records,
each with 1,024 ASCII text bytes, and retains the context returned by Pi's
conversation context reader. The model is deterministic. These are busy,
loaded-context measurements, not idle SQLite storage sizes.

`performance.memory` is unavailable. The calibration grows retained ordinary
JavaScript double arrays in 4 MiB steps, recording both the agent constructor
ID and a module/isolate ID. The decisive observation is replacement on the
next request, not an assumed allocation exception: Cloudflare allows an
in-flight request to finish when it crosses the memory limit.

| Seeded messages | Text payload | SQLite bytes | Last added JS arrays before replacement | Loaded-context read, client |
| ---: | ---: | ---: | ---: | ---: |
| 0 (five initialization messages) | 328 bytes | 303,104 | 116 MiB | 42 ms |
| 1,000 | 1,024,328 bytes | 1,695,744 | 112 MiB | 60 ms |
| 10,000 | 10,240,328 bytes | 14,344,192 | 88 MiB | 254 ms |
| 50,000 | 51,200,328 bytes | 70,672,384 | Replacement immediately after the context read | 1,689 ms |

These are incremental headroom probes. Subtracting them from the nominal cap
does not reliably measure absolute heap because runtime overhead, GC and
delayed replacement affect the observation. The 50k full-context object does not
remain stable: its next request has new constructor and isolate IDs. The
initial ArrayBuffer control exceeded 128 MiB of external buffers without
reliable replacement, so it was rejected as a JS-heap calibration and is not
used for these estimates.

Sixteen independently addressed real agents with 1k messages each were held
busy concurrently for 20 seconds. All sixteen preserved constructor IDs.
They occupied sixteen observed isolate IDs, with one object per isolate.
Later GraphQL periodic samples for that 1k-history cohort measured whole-isolate
memory at 28,096,524–28,358,668 bytes (26.8–27.0 MiB). The deployed unit is one
agent per DO. A second fixture held contexts in-flight for 30 seconds without
adding probe arrays. The matched 10k object reported 64,247,820 bytes (61.27 MiB)
and preserved the instance on the next request. The matched 50k object reported
182,863,884 bytes (174.39 MiB), with nonzero memory-exceeded samples in its held
period, and its next request ran in a new isolate without retained context.
This proves over-limit replacement, not viable 174 MiB capacity. Exact object
IDs, sample windows and before/after instances are in `docs/round2-heap-metrics.json`.
No measured guarantee exists that an
operator can pack a chosen count into an isolate: placement is controlled by
Cloudflare. Three full 27 MiB footprints fit arithmetically inside 80% of a
128 MiB cap; this is not an observed packed capacity or a promise under load.
Only one observed 10k footprint fits that same reserve. A stable 50k full-context
agent needs bounded context/compaction.

Workers documentation confirms the 128 MB limit includes JS and Wasm memory,
and describes finishing in-flight work and replacing an over-limit isolate:
https://developers.cloudflare.com/workers/platform/limits/#memory

## Validation and cleanup handoff

The prototype typecheck, the dedicated benchmark typecheck, all unit tests,
and the existing full workerd integration file passed. Integration coverage
includes hostile scripts, aborts, disabled tools and hard-process restart
with codemode journal/human-input replay. Two focused routing tests exercise
callback affinity, admission release on failure and caller timeout/close while
the remote is still alive.

The agent request completion adapter was also corrected to merge the latest
stored record inside its completion transaction, including the `began` field
written while waiting for Pi. The
existing queued-turn integration now asserts that the observed running start
is unchanged at completion. Older interval/overlap artifacts must retain their
original limitations; this correction does not retroactively fill missing data.

Root cleanup owns these three Workers and four classes:

- Worker `camelrun-proto-r2-codemode`: classes `camelrun-proto-r2-caller` and
  `camelrun-proto-r2-barrier` (both migrations must be deleted).
- Worker `camelrun-proto-r2-heap`: class `camelrun-proto-r2-heap`; retire before
  the sandbox Worker because it holds a binding to that class.
- Worker `camelrun-proto-r2-sandbox`: class `camelrun-proto-r2-sandbox`.

No snapshots, container apps/images, R2 buckets or external model calls belong
to this part. Its broad planning reserve is $5: 2,000 DOs active for 1,200 s
would be $3.84 at 128 MB and $12.50/million GB-s, with room for request/SQLite
and Worker usage. Actual delayed usage must replace this envelope in the
combined round-two cost report.
