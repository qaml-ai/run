# Integrated pi-durable replacement

These measurements predate the port onto production commit `70d001ef9e51`.
The raw source manifests identify that original snapshot; they do not establish
performance of the port. Production compatibility is validated separately.

Measured locally on 2026-10-20, Node 22.21.1, macOS arm64. Both arms use the actual
inline `AgentSupervisor`: the current pi-agent-core runtime and the opt-in
pi-durable replacement. Nothing was deployed.

## Continuous run

Three alternating trials in fresh processes, with identical local fake HTTP
provider and 1,000 sequential tools returning 31 KiB each. Both retain all 2,004
history messages, emit complete public events, finish without errors, and reject
duplicate requests before and after reload. Initial provider requests match;
subsequent requests differ because each engine owns its compaction policy.
Within each arm the provider trace hashes match across trials.

| Median | Current pi-agent-core | Pi-durable replacement |
| --- | ---: | ---: |
| Elapsed | 15.69 s | 6.84 s |
| Process CPU | 8.29 s | 10.33 s |
| Active heap at tool 1,000, after GC | 77.76 MiB | 49.22 MiB |
| Whole-process peak RSS | 289.45 MiB | 284.17 MiB |
| Same-process session reopen | 30.52 ms | 6.59 ms |

The replacement reduces active heap by 37% and elapsed time by 56% in this local
workload. Peak RAM falls only 1.8%, while CPU rises 25%. It is not a general
claim that Pi uses less CPU or makes real providers faster. Full `agent_end`
history reconstruction still contributes to peak memory.

The current path performs 500 summaries (499 cuts); Pi performs 333. Synthetic
reported model input is 20.63M versus 16.11M tokens, and summary input is 0.77M
versus 0.67M. These counts describe this deterministic provider, not production
cost or summary quality. Local journal size is 31.04 versus 37.91 MiB; Pi's
canonical and control records have storage overhead that must be metered.

The local stores are fsynced JSONL and SQLite `synchronous=FULL`. Postgres,
process IPC, multiple simultaneous agents, real-provider latency and summary
quality are outside these timings. Separate correctness tests cover Postgres
and process hosting. GC sampling changes execution timing. The full request
traces, individual trials, machine metadata and source hashes are retained in
[raw continuous-run results](results/2026-10-20/integrated-native).

## Large-session reload

Three fresh-process trials per arm load the same 90,000-message history,
30,000 request IDs and 30,000 tool IDs, with 4 KiB tool results and a compacted
30-message working context. Fixture construction and one-time migration are
outside the measurement; filesystem caches are warm. No model or tool executes.
All full-history hashes match, and oldest/middle/newest request IDs deduplicate.

| Median | Current pi-agent-core | Pi-durable replacement |
| --- | ---: | ---: |
| Reload | 212.28 ms | 10.56 ms |
| Retained heap added by reload | 3.79 MiB | 0.44 MiB |
| Whole-process peak RSS | 183.48 MiB | 178.75 MiB |

Reload is approximately 20 times faster with 88% less added retained heap. This
is checkpoint loading, not import performance or a cold-disk benchmark. Peak
RSS includes module imports. See [raw reload results](results/2026-10-20/integrated-reload).

## Reproduce

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/session-memory/run-integrated.mjs
BENCH_BACKENDS=core,integrated BENCH_COUNTS=30000 BENCH_TRIALS=3 BENCH_FIXTURES=/tmp/pi-native-host-reload node --experimental-strip-types --disable-warning=ExperimentalWarning benchmarks/session-memory/run-replacement-reload.mjs benchmarks/session-memory/results/2026-10-20/integrated-reload
```

The 90,000-message fixtures were created before the automatic migration size
guard was added. That guard now deliberately defers fresh imports above 64 MiB
or 200,000 records; the historical results and their source hashes remain valid.
For a fresh fixture on current code use `BENCH_COUNTS=1000`, or use an already
migrated native fixture to measure large-session reload independently of import.
The reload command seeds its synthetic fixtures when absent. Keep first import
out of steady-state reload comparisons. The source manifest records the exact
snapshot for each run. Earlier compatibility-adapter and prototype results
measure different implementations; use this report for the current integrated
replacement. The `integrated-native-before-reload-boundary-fix` directory retains
the preceding trials for audit, not as the final result.

## Readiness

Local validation covers migration and rollback, complete history, indexed request
deduplication, compaction failure, crash recovery, lease fencing, human input,
forks/exports and atomic Postgres usage receipts. The Pi suite passed 131 tests;
additional inline stack tests passed 36 and process tests passed 15. Typechecks
passed. Production rollout still needs a large-import memory budget, native
Postgres storage metering, and staged real-provider validation. See
[operations](../../docs/operations/pi-durable.md).
