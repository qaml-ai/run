# Agent cloud benchmark

`agent-worker.ts` imports the prototype's Worker and agent implementation. It
adds an operator-authenticated benchmark boundary, diagnostics, a deterministic
namespace, and a persisted Workers AI dispatch budget. It does not change the
production entrypoint or provider implementation.

The cloud configuration is `agent-wrangler.jsonc`. Its account is camelAI, its
Worker is `camelrun-proto-agent`, and every exported Durable Object class starts
with `camelrun-proto-`. It expects the separate
`camelrun-proto-codemode-sandbox` Worker and class. The `API_TOKEN` secret must be
at least 32 characters. Every public route, including health and diagnostics,
requires that exact bearer token. `BENCH_ENABLED=1` enables the routes;
`BENCH_BUILD` identifies a deployed build in diagnostics. Publishing and enabling
public routing are separate operator steps.

The original `/v1`, `/clients`, and `/experimental` routes use Workers AI. A
separate `/bench/deterministic` prefix uses the existing deterministic provider
and separate agent/directory namespaces. Requests cannot switch the real
namespace to the deterministic provider.

Each `AI.run` dispatch first reserves a durable slot in `BENCH_BUDGET`.
`BENCH_MAX_MODEL_CALLS` can lower the limit, but the code caps it at 24. The
counter survives deploys, includes failed attempts and retries, and has no reset
endpoint. Each real request also has an explicit `max_tokens` ceiling of 256.
The counter is an upper bound on binding dispatches, not a billing receipt or
proof that each dispatch completed. Use a new isolated Worker/namespace for a
fresh budget; do not delete or reset shared state.

## Runner

Run from `backends/cloudflare`. Keep tokens in an ignored protected file or set
`CAMELRUN_BENCH_API_TOKEN`; never put a token value in an argument. Replace the
URL below with the isolated benchmark endpoint.

```sh
node bench/agent-runner.mjs measure \
  --base-url https://BENCHMARK_HOST \
  --token-file bench/.state/api-token \
  --out bench/.state/agent-measure.json
```

The default performs three simple Workers AI turns, including one streamed
turn, then provisions 100 deterministic agents and starts 100 turns together.
It also verifies unauthenticated routes are rejected and streams a deterministic
turn. `--real-turns 0` skips paid model calls; the maximum is 10. `--agents`
accepts 1–100. JSON contains raw timings, server timestamps, observed generation
overlap, usage messages, instance IDs, and summaries. It never saves credentials
returned by agent creation.

Prepare a waiting codemode script and one durably accepted queued request:

```sh
node bench/agent-runner.mjs replay-prepare \
  --base-url https://BENCHMARK_HOST \
  --token-file bench/.state/api-token \
  --out bench/.state/agent-replay-prepared.json
```

Redeploy the isolated agent and codemode Workers, then resume:

```sh
node bench/agent-runner.mjs replay-resume \
  --base-url https://BENCHMARK_HOST \
  --token-file bench/.state/api-token \
  --state bench/.state/agent-replay-prepared.json \
  --out bench/.state/agent-replay-result.json
```

Resume refuses to proceed unless the agent's constructor UUID changed. It
checks that the pending human input and queued request survived, completes both,
and compares the script's random value, clock value, and completed file read.
It overwrites a file before the restart and verifies the script's completed
write does not run again. This proves this deterministic journal case; it does
not prove exactly-once behavior for arbitrary external effects. The runner does
not deploy, force a restart, remove resources, or change account configuration.

## Validation and measurement limits

```sh
./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext \
  --moduleResolution Bundler --lib ES2022 --types @cloudflare/workers-types \
  --strict --skipLibCheck --allowImportingTsExtensions \
  bench/agent-worker.ts bench/agent-worker.local.ts worker-configuration.d.ts
node --check bench/agent-runner.mjs
node --experimental-strip-types --test bench/agent-local.test.ts
```

The local test has no AI binding, removes cloud credentials from the workerd
environment, and exercises auth, 100 agents, streaming and a hard process kill.
Miniflare 5.20261103.0-beta generates an invalid local wrapper for string-named
exports containing hyphens. `agent-worker.local.ts` therefore reexports the same
classes with local-only identifiers. The cloud entrypoint retains the strict
names; a cloud dry run and cloud execution must validate them separately.

`/bench/meta` reports the model-call reservation count. Authenticated
`/bench/real/agents/:id/diagnostics` and
`/bench/deterministic/agents/:id/diagnostics` report a per-construction UUID,
build label, retained SQLite bytes, and the last 32 fetch wall times. These
samples include request I/O and may end when a turn is accepted; the runner's
total time includes completion. Neither timing is active CPU.

The subclass can instrument public `fetch` directly without touching the
adapter's private harness. It does not instrument private model-loop methods or
Lifecycle's installed alarm handler. Obtain active CPU from Cloudflare
invocation logs or traces. There is no per-object heap API in this wrapper;
authenticated inspector heap samples, if available, are isolate totals and can
include multiple objects. Do not divide an isolate heap delta into a promised
per-agent memory allocation.

100 deterministic turns measure the Worker, DO journal/storage, scheduling,
directory and transport path. They do not measure 100 real model turns or
Workers AI capacity. The real sample is deliberately small. Public routing,
real calls, a deployment boundary and cloud resource cleanup need separate
live evidence.
