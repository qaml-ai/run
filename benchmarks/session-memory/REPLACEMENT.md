# pi-agent-core versus a pi-durable replacement, 2026-10-20

The fuller Pi replacement prototype improves long-run heap retention, elapsed
time, and large-session reload. Whole-run peak RSS is effectively unchanged.
This is evidence for continuing the replacement, not a completed production
integration or a deployment decision.

Follow-up: [NATIVE-COMPACTION.md](NATIVE-COMPACTION.md) tests replacing our
compaction logic with the native Pi task, including crash/failure checks.

The comparison is **our current pi-agent-core runtime** against a benchmark-only
**pi-durable replacement**. Unlike the compatibility adapter measured in
[INTEGRATION.md](INTEGRATION.md), the replacement has no legacy transcript
projection, full-log startup replay, or in-memory lifetime request/tool indexes.
Pi owns execution, canonical history, request admission, and context loading.

## Uninterrupted long run

Three fresh processes per implementation, alternating order on the same Apple
M3 Max / arm64 macOS host, Node 22.21.1. Both import the same modules before
measurement, warm up with one prompt, then execute one 1,000-tool prompt. Each
tool returns 31 KiB of text, just below Camel's output-capping threshold.

Both use the existing pi-ai 1.1.0 provider bridge, explicit credential handling,
local HTTP/SSE fixture, tool argument/result validation, 32,768-token model,
and the same Camel compaction functions and thresholds. Pi's own automatic
compaction is disabled for this matched-policy experiment. SQLite uses
`synchronous=FULL`; the existing runtime uses its normal file transcript.
Both emit the full `agent_end.messages` array, including its cloning and
materialization cost. No paged-event variant was used in these results.

| Measurement, median | Current pi-agent-core runtime | Pi-durable replacement |
| --- | ---: | ---: |
| Heap after warmup | 47.33 MiB | 47.88 MiB |
| Heap at tool 1,000 | 77.47 MiB | 48.61 MiB |
| Heap growth during tools | 30.15 MiB | 0.73 MiB |
| RSS at tool 1,000 | 240.17 MiB | 231.30 MiB |
| Whole-run peak RSS | 292.84 MiB | 294.05 MiB |
| Heap after completion and GC | 45.71 MiB | 47.73 MiB |
| Elapsed | 16.05 s | 5.24 s |
| CPU | 9.31 s | 8.42 s |
| Local storage before close, including SQLite WAL | 31.04 MiB | 38.26 MiB |

The replacement retained 37% less active heap, with 98% less heap growth.
It completed about 3.1 times as fast with 9.5% less CPU. It used about 23% more
local storage. Peak RSS differed by only 0.4%, so this is **not** a peak-memory
win. The full final event still requires materializing the run's messages.

All six trials produced identical SHA-256 hashes of the semantic model
requests and summary requests, identical request sizes and compaction timing
by tool-call number, 499 successful compactions, zero tool errors, 2,004 history
messages, and five final working messages. Full final events contained 2,002
messages. Request deduplication passed before and after reopening. Native
history retained all 1,000 tool-result IDs in order.

Three forced GCs run every 100 tools and after completion. Elapsed includes
those GCs, provider requests, persistence, summaries, and final settlement;
imports/startup/warmup are excluded. Peak RSS is process-wide and includes
imports and warmup. Core elapsed trials ranged 15.57–21.24 s, versus
5.19–5.32 s for the replacement. Three trials support local medians, not p95,
allocation-volume, or production-provider latency claims.

## Fresh-process large-session reload

These fixtures have identical canonical messages: each cycle contains a user
request, assistant tool call, and 4 KiB tool result. Each request and tool has a
unique ID. A checkpoint every 100 cycles keeps 30 recent messages plus a
summary. Native fixtures include a persisted, indexed terminal submission for
every historical request; deduplication data is not omitted to improve reload.
Fixtures are seeded rather than produced by 30,000 model runs, so this isolates
startup scaling, not the disk footprint of every historical scheduler task.

Each measured load is a fresh process after one unmeasured warmup load of that
fixture. Timing covers the actual Supervisor's start/status on the current
runtime, or native Harness open/current context on the replacement. Filesystem
caches are warm. Imports and fixture construction are excluded from elapsed;
peak RSS includes imports. Three trials per implementation and size:

| Historical messages / requests | Current reload | Replacement reload | Current retained heap growth | Replacement retained heap growth |
| --- | ---: | ---: | ---: | ---: |
| 3,000 / 1,000 | 13.87 ms | 4.53 ms | 0.53 MiB | 0.29 MiB |
| 30,000 / 10,000 | 82.41 ms | 4.53 ms | 1.79 MiB | 0.29 MiB |
| 90,000 / 30,000 | 216.03 ms | 4.69 ms | 3.79 MiB | 0.29 MiB |

At 90,000 messages, median peak RSS was 188.05 MiB versus 180.48 MiB; CPU was
270.87 ms versus 9.09 ms. The replacement's indexed checkpoint path avoids
scanning archived history at startup. Our existing replay is already streamed,
so it does not retain all archived message bodies, but its request/tool indexes
grow with session lifetime.

After the timed memory snapshots, **every trial** read all canonical history
and verified its complete hash against the fixture and the other runtime.
Oldest, middle, and newest request IDs were all rejected as duplicates without
dispatching a model or tool. These checks preserve history and admission
behavior; they do not test crash recovery or concurrent writers.

## Interpretation and limits

The earlier integrated result measured a compatibility adapter that still
carried the old transcript and reload work. This experiment removes that work,
which explains why the direction changes. Neither result is evidence that the
Pi library alone is intrinsically faster than pi-agent-core: the execution,
persistence, and host integration differ together.

`native-session.mjs` is a benchmark prototype, not wired into the runtime's
production selector. The current side runs the real inline AgentSupervisor;
the replacement implements the happy-path behaviors needed by this workload
directly over Pi. It does not yet implement the full surrounding host contract:
spend caps and billing, sandbox/files and oversized-result archival, RPC/auth,
human input, steering/cancellation/retry/error parity, history service indexing,
forks, all provider variants, lease fencing under failover, or production shared
Postgres integration. Matching provider traces and full final events make this
stronger evidence for the replacement architecture, not full product parity.

No production sessions were migrated and nothing was deployed. The default
runtime and previously prepared opt-in migration were not changed by this
comparison. The next implementation work is bringing this single canonical
storage path into the real host while retaining the existing migration archive
and rollback guarantees, then repeating the measurements through that host.

## Reproduce

From the repository with its locked dependencies installed:

```sh
node benchmarks/session-memory/run-replacement.mjs /tmp/replacement-results
node benchmarks/session-memory/run-replacement-reload.mjs /tmp/replacement-reload-results
```

`BENCH_TRIALS` defaults to 3; live `BENCH_LIVE_ROUNDS` defaults to 1000.
Reload `BENCH_COUNTS` defaults to `1000,10000,30000` cycles.
Reload fixture directory `BENCH_FIXTURES` defaults to
`/tmp/pi-replacement-reload` and should be empty for a new seed run.
The runners fail on parity errors and source changes during trials. Metadata
captures runtime, machine, revision, and source hashes before measurement.
The tree was uncommitted, so source hashes, not HEAD alone, identify this run.

Raw trials and metadata:
[long run](results/2026-10-20/replacement/results.json),
[reload](results/2026-10-20/replacement-reload/results.json).
