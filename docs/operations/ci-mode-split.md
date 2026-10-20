# Hosting-mode CI measurement (2026-10-20)

`AGENT_HOSTING` is passed from `.github/workflows/ci.yml` to `scripts/test-shard.ts` and inherited by test fixtures. `src/node-config.ts` validates it (default `process`); `src/node.ts` passes the setting to `AgentSupervisor`. Individual tests can explicitly choose a hosting mode. Production Terraform (`infra/terraform/variables.tf`) sets `inline`, so the complete PR/main suite runs inline.

## Paths that differ

| Branch | Inline | Process |
| --- | --- | --- |
| `supervisor:1`, `AgentSupervisor.start` | `startInline`: `createAgentHost`, callbacks, structured clones, supplied executor/outbound/history settings | `startProcess`: `rpc.childProcess` starts `agent-child.ts`; init/events/transcript/tool/auth/history/code-slot requests cross IPC; per-agent environment and watchdog |
| `supervisor:2`, `invoke` | Direct host call, clone inputs/results, race with stop | RPC request to child |
| `supervisor:3`, `flush` | Direct `historyFlush` | RPC `historyFlush` |
| `supervisor:4`, `halt` | Reject stopped promise; dispose host and flush history | Optional history flush, close RPC, SIGKILL, wait for child close; process-exit cleanup releases slots and cancels tools |

Model-written `js_exec` uses `codemode.ts` and V8 subprocesses in **both** modes. Inline can share the node's supplied executor; child hosts construct their own execution context and acquire/release node code slots over RPC. `sandbox.ts`, `sandbox-wire.ts`, `v8-exec.ts`, parser/inspection and voice workers remain isolated independently of hosting. Their tests are retained conservatively, even without an observed hosting branch. Neither matrix setting substitutes for the Linux image's launcher/seccomp isolation tests, which remain in CI.

## Method and reproduction

1. Unmodified scheduling baseline: [39463977499](https://github.com/qaml-ai/run/actions/runs/39463977499), five shards per mode, Blacksmith 16 vCPU, eight concurrent files, per-file disposable Postgres. Current checkout has **267** top-level test files, rather than the task's approximate 340. The old planner runs 267 inline and 257 process, skipping ten simulator files in process.
2. Full dual-mode trace run: [39465131049](https://github.com/qaml-ai/run/actions/runs/39465131049), **267/267 files passed in each mode on their first attempt**. instrument the four boolean expressions above in disposable test checkouts. A preload attributes hits to the test filename and carries that attribution into servers whose fixtures replace the environment. Each process records each branch/result once. Instrumentation is opt-in (`workflow_dispatch`, `measure_modes=true`); no application source instrumentation is committed or included in normal/image builds. The first trace attempt [39463962622](https://github.com/qaml-ai/run/actions/runs/39463962622) ran tests but produced no traces because Actions refuses `NODE_OPTIONS` writes through `GITHUB_ENV`; it is excluded as dynamic evidence. The corrected run passes `NODE_OPTIONS` directly to the test step.
3. Static scan: Babel parses value imports/re-exports, literal dynamic imports, worker/server URLs and spawn source paths transitively, including shared fixtures. Type-only dependencies are excluded. Computed source path prefixes conservatively include their directory. New hosting selectors and sandbox/worker modules become roots automatically. A checked-in union retains static reachability, area rules, dynamic hits and known one-mode failures. Static reachability does not prove a branch executes; a missing dynamic hit does not prove independence.
4. History: `gh run list --workflow ci.yml --status failure --limit 20`, then `gh run view --log-failed` and job metadata for each run. The bounded sample spans October 16–19, not all repository history. [history.json](ci-mode-split/history.json) records identified test failures. Files seen failing in just one mode are retained conservatively, including simulator failures where process previously was not scheduled. Setup failures without a test-file failure do not identify a mode-sensitive file. Log-privacy and docs failures seen in both modes are not counted as one-mode failures. The discarded trace attempt also observed a process-only `voice-realtime-sessions.test.ts` first-attempt failure, passing its retry; it is retained.
5. Download `test-timings-*` artifacts for baseline and corrected trace, and artifacts for the split validation. Run `python3 scripts/test-mode-report.py BASELINE_DIR TRACE_DIR AFTER_DIR` to rebuild [files.csv](ci-mode-split/files.csv) and [summary.json](ci-mode-split/summary.json). The CSV records each mode's file outcome, duration, retry and branch hits. A passing file may contain explicitly skipped tests; provider-live tests still require their existing opt-in credentials. No production requests or credentials are needed for the measurement.

## Measurements before the split

Categories overlap; the checked-in union is the scheduling decision.

| Category | Files |
| --- | ---: |
| Full Node suite | 267 |
| Static value reachability or area rule | 225 |
| Hosting/sandbox/worker area rule | 10 |
| Observed supervisor branch hit in either mode | 150 |
| Observed one-mode failure in bounded history or the discarded trace attempt | 7 |
| Union retained in process mode | 225 |
| Full-inline-only files | 42 |

| Run / estimate | Inline files | Process files | Test jobs | Test job-minutes | Test job window |
| --- | ---: | ---: | ---: | ---: | ---: |
| Uninstrumented old planner (actual) | 267 | 257 | 10 | 15.18 | 111 s |
| Full instrumented dual-mode trace (actual) | 267 | 267 | 10 | 22.83 | 186 s |
| Proposed PR/main split (estimate) | 267 | 225 | 9 | about 15–16 | about 140 s |

The baseline CI completed in 146 s; the trace run completed in 260 s. The trace includes preload/instrumentation overhead and extra simulator execution, so its durations are **not** a fair speed baseline. The estimate uses the uninstrumented baseline and inline simulator durations as a proxy for their process-matrix execution (the simulator itself pins inline), eight concurrent files, and the observed setup cost. Real split results are recorded in [PR #307](https://github.com/qaml-ai/run/pull/307) and its linked validation run.

The selection removes 40 formerly scheduled process files (93.4 file-seconds) but adds eight retained simulator files that the old process planner omitted (269.3 file-seconds measured inline). Two other simulator helpers remain inline-only. Thus 42 primary-only files means only **32 fewer file executions** relative to the existing CI, and no predicted compute saving. One fewer setup job may be offset by that conservative duplication and scheduling overhead. This experiment should not be interpreted as evidence for a large CI cost reduction.

## Selection and regression protection

PRs and main use five full inline shards plus four process-sensitive shards on large runners. Draft/fork/self-hosted shapes retain twelve shards per mode and two-file concurrency; process files are still selected. Nightly adds a separate five-by-two full hosting matrix, alongside the existing scaled properties. Every file, including all simulator files, is eligible in both nightly modes. The simulator itself explicitly uses inline, so its second run is deliberately conservative duplication.

`tests/mode-sensitive.json` is reviewable evidence, not a manually optimized allowlist. `scripts/test-mode-files.ts` fails if a current static/area dependency is absent or a listed file was removed. The checks job runs this guard even on docs-only changes. To update after adding or changing a test, inspect `node --experimental-strip-types scripts/test-mode-files.ts --derive`, preserve measured/historical entries, update the union, and rerun the guard. Rerun the opt-in full trace when hosting/fixture boundaries change. The AST guard runs once in the required checks job; shards read the validated manifest without repeating the graph traversal. New computed paths without a literal directory, custom loaders, generated source or unusual spawning require review; no finite trace establishes that every future conditional path is covered.

Local validation covers transitive imports, type-only exclusions, worker URLs, computed prefixes, newly introduced selectors, complete shard partitioning without duplicates, full measurement matrices and the existing CI success gate. The split is deliberately conservative: many tests import a server fixture only for a utility, but remain in process mode. File-count savings therefore overstate execution savings. Single before/after CI runs measure observed wall time and job occupancy, not a causal speedup, a percentile or billing (Blacksmith invoices can round differently). Other jobs and queueing can dominate overall CI wall time.
