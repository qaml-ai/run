# Memory per agent: Node runtime, Workers backend on workerd, and on celld

Measured 2026-11-11 on one Sprite (8 vCPU, 16 GB, x86_64), from `origin/main` at 5e2d58ca. The question: does the
Workers backend (this directory, Durable Objects) cost much more memory per agent than the Node runtime that runs
production on ECS, and could it be self-hosted on [celld](https://celld.dev/docs/)?

Short answer: **not much on workerd, the Workers runtime: about 2.2 MB per resident agent against about 1.2 MB on
Node, at 300 agents each. On celld the same backend costs about 35 MB per resident agent (45 MB with
code mode): by its logs, celld evaluates the application's 16 MB bundle again for every Durable Object it
activates.** celld runs
the backend only after four local workarounds, and at 100 agents and 10 turns at once its single dev node fell over.

## Results

Same API calls, same deterministic fake model, same local Postgres for every runtime. "Runtime" is the RSS of the
processes that serve agents: Node's server process (and its v8-exec children while code runs), workerd's Worker
process, or the celld node. Wrangler's dev proxy (a second workerd), Wrangler, esbuild and Postgres are not counted;
Postgres is reported apart. Per agent = (resident - baseline) / agents. Baseline is taken after one warm-up agent has
run a plain and a code turn, so lazily loaded modules count as baseline. Resident is sampled just after every agent's
state was read (`GET /v1/agents/:id/state`, which loads an unloaded Node agent and wakes an evicted Durable Object).

| Runtime | Agents | Turns at once | Baseline MB | Resident MB | **MB per agent** | Peak in turns MB | After idle MB | Turns ok | Runtime CPU ms/turn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Node (inline, as prod) | 300 | 50 | 219 | 581 | **1.2** | 579 | 357 (30 s) | 900/900 | 57 |
| Workers on workerd | 300 | 10 | 302 | 955 | **2.2** | 882 | 946 (30 s) | 900/900 | 379 |
| Workers on celld | 10 | 50 | 310 | 772 | **46** | 790 | 379 | 30/30 | 964 |
| Workers on celld, no code turn | 10 | 50 | 294 | 640 | **35** | 743 | 262 | 21/30 | 1,285 |

The other sizes (resident read through `GET /v1/agents/:id`, which does not wake an evicted object):

| Runtime | Agents | Turns at once | Baseline MB | Resident MB | MB per agent | Peak in turns MB | After idle (150 s) MB | Turns ok | Runtime CPU ms/turn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Node | 10 | 50 | 218 | 231 | 1.3 | 231 | 198 | 30/30 | 79 |
| Node | 100 | 50 | 185 | 441 | 2.6 | 437 | 239 | 300/300 | 61 |
| Node | 1,000 | 50 | 217 | 1,310 | 1.1 | 1,317 | 799 | 3,000/3,000 | 60 |
| Workers on workerd | 10 | 50 | 307 | 459 | 15 | 445 | 458 | 30/30 | 317 |
| Workers on workerd | 100 | 10 | 307 | 819 | 5.1 | 790 | 816 | 300/300 | 379 |
| Workers on workerd | 100 | 50 | 256 | 937 | 6.8 | 923 | 935 | 190/300 | 847 |
| Workers on workerd | 1,000 | 10 | 298 | 1,118 | 0.8 (not all resident) | 1,102 | 1,110 | 3,000/3,000 | 411 |
| Workers on celld | 100 | 10 | 300 | node exited | | 1,294 | | 105/300 | |

- **workerd frees an idle object after a short inactivity** ("Actor freed due to inactivity"), so its figures
  with many agents count only the recently used ones: the 1,000-agent run ended at 1,118 MB, about 0.8 MB an agent,
  because most objects had been freed by the end of a 22-minute run at 10 turns at once. The 300-agent row, with
  every object woken just before the sample, is the per-resident cost. Per agent also falls with N (15 MB at 10)
  because V8 grows its heap in steps.
- **Node** keeps an agent hosted for `AGENT_IDLE_MS` (90 s here, 300 s in production), so all 1,000 were hosted at
  the sample: about 1.1 to 1.3 MB each, for agents with three short turns.
- **Peak at 50 concurrent turns** is within a few percent of the resident figure on every runtime: with three short
  turns per agent, memory follows the agents loaded, not the turns in flight.
- **Idle** is after 150 s (30 s in the 300-agent rows) with no requests. Node unloads after `AGENT_IDLE_MS` and
  returns most of it (1,000 agents: 1,310 to 799 MB; V8 keeps some freed heap). celld evicts a cell after
  `CELLD_IDLE_EVICT_S` (60 s here) and drops back near baseline. workerd's RSS did not drop: freed objects' heap
  stays with the isolate for reuse. On Cloudflare, idle objects are the platform's to place and bill
  (`measurements/README.md`, hibernation).
- **Turns ok**: workerd at 50 concurrent turns failed 110 of 300 with `Session persistence failed`. Local workerd
  runs every object of the Worker on one thread, and the Workers backend's turn costs 6 to 7 times Node's CPU (last
  column), so 50 at once overran its timeouts; at 10 at once nothing failed. Node's CPU column leaves out v8-exec's
  short-lived processes (one per code run), so it is low by their share.
- **V8 heap against RSS** was not separated in these runs. In production, `heapUsedBytes` averages 142 MB of a 498 MB
  RSS (below).
- **Postgres**, the same server for every run: 250 to 1,300 MB PSS on Node and workerd (Node's 1,000-agent run was
  the highest). On celld it reached 4 to 10 GB PSS in the 100-agent runs: connections the node dropped mid-use
  piled up as backends.

### Why celld costs more per agent

celld's logs show a pool of at most 8 isolates (one per CPU) and a "cell isolate startup" for every activation:
266 `CamelAgent`, 46 `CodemodeSandbox` and 2 `TenantAdmission` starts in the 100-agent run. Each cell evaluates the
whole bundle (16.3 MB of JavaScript: the backend, Pi, the provider SDKs; plus 0.6 MB of QuickJS Wasm) in its own
context, and that heap is per cell: about 35 MB for an agent cell and about 10 MB more for its code mode sandbox cell. On workerd, as on
Cloudflare, every object of a Worker shares one isolate and one copy of the modules, so an object costs only its own
state. celld's "one 8 GB node holds 1,000 resident cells" (about 8 MB a cell) is for small Workers; with this bundle
an 8 GB node would hold roughly 150 to 200 resident agents. Idle eviction keeps that from being the whole story:
memory follows agents active in the last `CELLD_IDLE_EVICT_S`, and an inactive agent costs only its bucket objects.

## Production reference (read-only, CloudWatch, 2026-11-04 to 11-11)

`camelai-agent-runtime` on ECS Fargate: 1 vCPU / 4 GB tasks, `AGENT_HOSTING=inline`, 5 tasks (up to 10 at times),
`AGENT_IDLE_MS=300000`.

- Container Insights `MemoryUtilized` per task: daily average 373 to 549 MB, daily maximum 1,130 to 1,512 MB, of
  4,096 MB reserved.
- The runtime's own metrics (`AgentRuntime` namespace, per node): `hostedAgents` averages 3.6 per task (maximum 25);
  `rssBytes` averages 498 MB (maximum 1,608 MB); `heapUsedBytes` averages 142 MB.
- An hourly least-squares fit of RSS on hosted agents gives about **372 MB + 35 MB per hosted agent** (r = 0.40).
  Real agents carry long histories, files, tool sources and in-flight model streams, so this is an upper reference,
  not comparable with the benchmark's three-turn agents. It does show production nodes are far from memory-bound:
  at 25 hosted agents a task used about a third of its memory.

## Method

`benchmarks/agent-memory/run.ts` (harness), `workers.ts` (workerd and celld fixtures), `celld/` (celld entry and
shims), `summarize.mjs`. Per run:

1. Start the runtime against a fresh database (Node: a fresh schema, as the contract fixture does; Workers: a fresh
   database copied from the migrated template). Node runs `src/server.ts` with `AGENT_HOSTING=inline`, production's
   mode. The Workers runs use `src/index.ts` itself, not the contract test wrapper.
2. One warm-up agent runs a plain turn and a code turn; 10 s of samples give the baseline.
3. Create N agents (20 at a time), then three turns each, C agents at a time: a plain turn, a code turn (the fake
   model calls `codemode` with a loop summing 0..999 and the harness checks the tool result says 499500, so a broken
   sandbox cannot pass), and a plain turn. Each answer is about 500 characters.
4. Read every agent's state once more, 50 at a time, and sample for 5 s (resident); then 150 s (or `--idle-wait`)
   with no requests (idle).

Every process is sampled once a second from `/proc/<pid>/status` (VmRSS, VmHWM) and `/proc/<pid>/stat`
(CPU), grouped by command line; Postgres is counted by PSS (`smaps_rollup`) because its backends share buffers. The
result files, without their per-second samples, are in `../measurements/agent-memory.json`. The first runs (all
but the two 300-agent rows) read agents through `GET /v1/agents/:id` at the resident sample; the harness now reads
`/state`.

The fake model is the contract suite's OpenAI-compatible server (`tests/runtime-server.ts`), on localhost for every
runtime. Postgres is Ubuntu's 18.6 with `fsync=off` (CI uses 16 in a container; Docker on a fresh Sprite needs the
pool's runc setup), `max_connections=1000`.

```sh
AGENT_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres \
  node --experimental-strip-types benchmarks/agent-memory/run.ts --backend=node --agents=1000
# --backend=workers (needs backends/workers npm ci), --backend=celld (needs celld on PATH; CELLD_* passes through)
# --concurrency=10, --code=0 (no code turn), --idle-wait=150, --node-idle-ms=90000
node benchmarks/agent-memory/summarize.mjs agent-memory-*.json
```

## Substitutions and caveats

- **workerd is local workerd under Wrangler, not Cloudflare.** It runs every object of the Worker on one thread
  and frees idle objects on its own schedule, not the platform's. Memory per resident object is the comparable
  figure; throughput and idle are not.
- **Node** is a single process here; in production, the same per-agent memory sits on top of each task's ~370 MB.
- **celld** is `celld dev` 0.6.3: one node, its local object store. A real fleet uses two or more nodes and a
  bucket; the dev node's writes wait on its local store, which is where it broke down (below).
- To run the Workers backend at all, celld needed (all in `benchmarks/agent-memory/celld/`, none in the backend):
  1. **Hyperdrive** is unsupported and variables must be strings: `HYPERDRIVE_URL` (the same direct local
     connection string Hyperdrive's local mode passes) becomes `env.HYPERDRIVE` in the entry. Images and Analytics
     Engine bindings are dropped (nothing in the benchmark uses them; `METRICS` is optional in the code).
  2. **One application per fleet**: the code mode sandbox, a separate Worker on Cloudflare, is exported from the same
     Worker. It worked: code turns ran in QuickJS on celld.
  3. **Node APIs**: `node:net` (`isIP`, called at module load) and `node:http`/`node:https` (`Agent`, subclassed at load
     by `agent-base`) are missing; esbuild aliases them to small shims (`net-shim.ts`, `http-shim.ts`) through
     `CELLD_ESBUILD`.
  4. **Async `storage.transaction()`** runs inside `blockConcurrencyWhile()` on celld and deadlocked when two events
     opened transactions at once (the agent's admit, its event cursor and Pi's Chord store do so on every first
     prompt): every first prompt hung 30 s and the object was reset. The entry serializes transactions per object
     behind a promise chain, without rollback. This is a benchmark shim, not a fix.
- With those, 10 agents ran cleanly (all turns, all code results). The run without a code turn lost 9 of 30 turns
  to 503s. At 100 agents and 10 turns at once, Postgres connections broke mid-use (`Connection terminated
  unexpectedly` in `waitUntil` work; celld closes sockets when their event ends), agents' startup took 4 to 7 s, the
  node's lease renewals timed out on its local store, and after about 16 minutes it fenced itself and exited
  (`SELF-FENCE: node lease not renewed within TTL`). The 1,000-agent celld run was not attempted.

## What blocks the Workers backend on celld in production

- **Postgres**: no Hyperdrive. The backend opens a short-lived connection per operation (`src/postgres.ts`), which
  Hyperdrive pools; on celld every one would be a new TCP and TLS connection to the database, and sockets cannot
  outlive their event, which breaks the work the backend does in `waitUntil`. It needs a pooler (PgBouncer or
  similar) next to the fleet and a connection layer that keeps queries inside their event.
- **Node APIs the backend uses that celld 0.6.3 lacks** (probe: `benchmarks/agent-memory/celld-probe`):
  `dns.resolve4/6` (the outbound policy resolves a hostname before calling a tenant's model endpoint or a
  model-chosen URL, `src/security-outbound.ts`; the benchmark's model was an IP literal), `crypto.createCipheriv` (sealing secrets
  and identity keys, `src/accounts.ts`, `src/runtime-identity.ts`), `crypto.scrypt` (passwords), `node:net`,
  `node:http(s)`. Ed25519 signing, hashes and HMAC work.
- **Bindings**: Images (attachments), Analytics Engine (money metrics), Email sending, Containers (computers,
  experimental on celld) and Secrets Store have no celld equivalent; the code mode sandbox must live in the same
  Worker.
- **Semantics**: async transactions inside `blockConcurrencyWhile()` (above) need a fix in celld or in the backend.
- **Memory**: about 35 to 45 MB per resident agent cell (15 to 20 times workerd's), so capacity is set by agents
  active within the eviction window, at roughly 150 to 200 per 8 GB node. A smaller bundle per class would help: each cell loads all of it.
- **Operations**: TLS ingress, the bucket, node leases and upgrades are ours; the single dev node's collapse under
  modest load was not investigated further and needs a multi-node, real-bucket test before any conclusion on
  throughput.
