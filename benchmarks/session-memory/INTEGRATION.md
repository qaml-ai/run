# Integrated engine comparison, 2026-10-20

This measures the compatibility adapter, not a fuller replacement of the
existing pi-agent-core runtime. See [REPLACEMENT.md](REPLACEMENT.md) for the
subsequent experiment that removes the legacy transcript and startup replay.

The integrated Pi engine retains less heap during a long uninterrupted run, but
the current compatibility adapter costs more CPU and has a higher whole-run
memory peak. These measurements support the bounded working-set design; they do
not establish an overall efficiency or latency win for switching engines.

Both sides ran the actual `AgentSupervisor` with `backend=run`, inline hosting,
the same local HTTP/SSE provider fixture, 32 KiB tool results, and Camel's existing
compaction policy. Pi used the native durable Harness and local SQLite journal;
the legacy transcript remained a compatibility projection. The provider bridge
was the same on both sides. Each fresh subprocess warmed up with one prompt,
then completed one uninterrupted 1,000-tool-call prompt. Three forced GCs ran
every 100 tools and after completion.

Node v22.21.1, arm64 macOS 27.0.1. Three fresh subprocesses per engine, run
sequentially. Figures below are medians; MiB means 1048576 bytes.

| Measurement | Legacy | Integrated Pi | Change |
| --- | ---: | ---: | ---: |
| Heap after warmup (MiB) | 47.28 | 48.05 | +0.77 |
| Heap at tool call 1,000 (MiB) | 78.09 | 48.91 | −37.4% |
| Heap growth during tools (MiB) | 30.80 | 0.86 | −97.2% |
| RSS at tool call 1,000 (MiB) | 240.78 | 225.11 | −6.5% |
| Whole-run peak RSS (MiB) | 296.25 | 363.23 | +22.6% |
| Heap after completion and GC (MiB) | 45.64 | 47.77 | +2.13 |
| Elapsed (seconds) | 15.36 | 19.04 | +23.9% |
| CPU (seconds) | 8.58 | 12.64 | +47.3% |

Every trial completed all 1,000 tools with zero tool errors, 499 successful
compactions, 2,004 history messages, and five messages in the final working
context. The successful final state and matching compaction counts make this a
closer comparison than the separate native-Harness results in
[RESULTS.md](RESULTS.md).

Pi's working heap stayed near its warmup level after host compaction released
archived messages and checkpointed the native context. Legacy retained roughly
another 31 MiB until the run ended. Both engines nevertheless reached their
largest RSS after the last tool sample. Pi rose from a median observed maximum
of 225.58 MiB at that sample to 363.23 MiB after settlement. The adapter currently
reads the run's canonical messages back into memory for the existing
`agent_end.messages` event; that is a likely contributor to the final spike, but
an allocation profile is needed to attribute it precisely. Releasing this
materialization without breaking event compatibility is an outstanding
optimization.

The elapsed measurement includes forced GC, local persistence, compaction, and
final settlement. It excludes imports, startup, and the warmup prompt. Peak RSS
is process-wide, so it includes those earlier phases. There are only three
trials per engine: these are local medians, with no p95 or production latency
claim. No source edits were made to the adapter during the measured trials.

This workload starts fresh sessions. It does not measure importing a large
existing session, cold reload, shared Postgres storage, S3, real providers, or
concurrent agents. In particular, the earlier 3.7 ms native Pi reload result
does not describe this integrated adapter, and these fresh-session memory
figures say nothing about a historical migration's memory peak.

Reproduce each trial with a fresh process:

```sh
AGENT_ENGINE=legacy AGENT_HOSTING=inline node --experimental-strip-types --disable-warning=ExperimentalWarning --expose-gc benchmarks/session-memory/live.mjs run 1000
AGENT_ENGINE=pi-durable AGENT_HOSTING=inline node --experimental-strip-types --disable-warning=ExperimentalWarning --expose-gc benchmarks/session-memory/live.mjs run 1000
```

The six individual raw JSON files, aggregate results, trial order, and source
snapshot hashes are in [results/2026-10-20/integrated](results/2026-10-20/integrated).
The working tree was uncommitted; the hashes were captured after the trials,
and were not separate per-trial snapshots. No deployment was performed.
