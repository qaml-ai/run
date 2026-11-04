# Remote codemode cloud measurements — 2026-11-04

These observations use the deployed `camelrun-proto-codemode-bench` caller DO
and the separate `camelrun-proto-codemode-sandbox` Worker. They use the stock
Pi codemode 1.5.0 `RemoteCodemodeSandbox` and `CodemodeSandboxDurableObject`.
There are no model calls. Every HTTP route requires the benchmark bearer token.

The caller uses a 15-second deadline. The remote uses the stock 32 MiB VM limit
and 100,000 interrupt polls; both Workers have a 30-second CPU limit. A fresh
object name is a cold DO sample, not proof of a cold Worker isolate or cold
compiled Wasm module. Server timings are elapsed wall time. Client timings
include the network from the test machine. Callback differences measure serial
round trips through a trivial host echo tool.

## Start and nested calls

| Case | Samples | Server p50 / p95 | Client p50 / p95 | Other |
| --- | ---: | ---: | ---: | --- |
| Fresh caller + sandbox, one marker | 12 | 226 / 1,255 ms | 539 / 3,315 ms | First callback 221 / 1,251 ms |
| Warm, one marker | 12 | 55 / 68 ms | 104 / 180 ms | First callback 49 / 60 ms |
| Warm, 20 serial echo tools + marker | 12 | 165 / 250 ms | 221 / 353 ms | 240 callback deltas: p50 6 ms, p95 10 ms |
| 50 serial echo tools + marker, initial run | 3 | 269 / 552 ms | 392 / 1,482 ms | All returned 50; 150 callback deltas p50 4 ms, p95 8 ms |
| 50 serial echo tools + marker, live recheck | 3 | 290 / 450 ms | 463 / 817 ms | All returned 50; 150 callback deltas p50 4 ms, p95 6 ms |

The N=50 recheck at 19:50 UTC had a mean callback interval of 4.387 ms
(approximately 228 serial echo calls/second excluding startup). The two warm
N=50 complete scripts took 232 and 290 ms inside the caller. A 19:50 UTC
three-sample start recheck observed fresh-object first callbacks of
190–423 ms and warm first callbacks of 47–83 ms.

## Concurrency limit discovered

Fifty simultaneous scripts sharing one caller and one remote sandbox all
returned the caller's 15-second timeout (0/50 successful). Fifty scripts with
independent caller/sandbox names succeeded 50/50, with client p50 652 ms,
p95 3,969 ms, maximum 11,590 ms and a full-batch completion time of 11,591 ms.
The latter scripts each called 20 echo tools plus a marker. These are benchmark
caller DOs, not 50 full PiHarness agents.

Do not label the failed batch as successful throughput. The stock remote source
states that executions reaching one DO share its thread and interleave while
waiting on tools. The exact cause of the 50-way timeout was not isolated; these
results establish that this shared-DO configuration is not ready for that load.

## Safety and caller responsiveness

Each case ran twice, once in the interrupted attempt and once in the live
recheck. Every case returned a structured codemode error; the caller's in-memory
instance ID stayed unchanged and a following marker script succeeded.

| Case | Caller result | Server time, first / recheck | Caller probe during recheck |
| --- | --- | ---: | --- |
| Infinite loop | Interrupt budget exhausted | 5,540 / 14,691 ms | 210 probes; p50 35 ms, p95 115 ms |
| Repeated 1 MiB string allocations | `InternalError: out of memory` | 408 / 373 ms | 5 probes; p50 35 ms, p95 40 ms |
| Await a never-resolving Promise | No possible progress error | 26 / 45 ms | Finished before an active probe arrived |
| Throwing script | Script error | 68 / 61 ms | One active probe, 42 ms |
| Failing host tool | Tool error returned through script | 85 / 48 ms | Finished before an active probe arrived |

The loop's wall time varied widely despite the fixed interrupt count. Neither
15 seconds of caller waiting nor the loop's wall time is its CPU usage. The
caller remains responsive during remote work. This does not establish that
hostile scripts cannot affect sibling sandbox DOs that share a Worker isolate,
or that a caller timeout immediately stops every remote builtin.

## Memory and CPU: measured scope and gap

`process.cpuUsage()` throws as unimplemented; `process.memoryUsage()` and
`process.resourceUsage()` return zero-filled stubs. Those values are not
measurements of zero usage.

At 19:49 UTC the account's delayed GraphQL analytics supplied these periodic
DO observations over the 19:38–19:49 window:

| DO namespace | CPU sum | Active time sum | Memory p50 / p95 | Billed duration field |
| --- | ---: | ---: | ---: | ---: |
| Benchmark caller | 20.696 ms | 2.047 s | 2.55 / 3.36 MiB | 0.262 GB-s |
| Remote sandbox | 36.094 ms | 59.162 s | 6.65 / 6.65 MiB | 7.573 GB-s |

These are sparse, delayed telemetry, not complete totals for every run. Memory
is for an entire V8 isolate; filtering by an object does not turn it into an
individual agent heap. The full agent Worker's request telemetry showed
18.65 / 19.20 MiB p50 / p95, but that is a different isolate and is not caller-DO
heap. Therefore **per-agent heap with codemode loaded remains unverified**
against Cloudflare's 128 MB isolate limit. The remote's 32 MiB VM ceiling is a
configured per-execution limit, not observed per-agent heap.

The later 19:57 UTC read is more representative: the sandbox's CPU total was
56.318 seconds and its isolate memory p99 reached 105.60 MiB. Caller CPU was
1.442 seconds with memory p99 5.95 MiB. The early sample above must not be used
as a headroom estimate. The main feasibility report and committed measurement
JSON contain the later snapshot.

## Evidence

Ignored local raw artifacts (no credentials embedded):

- `bench/.state/codemode-live.json`: initial 12-sample starts, 50-way batches,
  safety results, every callback and probe.
- `bench/.state/codemode-fifty.json`: initial exact N=50 serial benchmark.
- `bench/.state/codemode-fifty-refresh.json`: exact N=50 live recheck.
- `bench/.state/codemode-refresh.json`: start and safety live recheck.
- `bench/.state/telemetry-refresh.json`: namespace-filtered GraphQL response,
  schemas, units and queries.

All recheck authentication probes returned HTTP 401 without a bearer token.
