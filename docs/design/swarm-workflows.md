# Durable multi-agent workflows: a general harness

Status: proposal (2026-11-11), not built. Goal: make camelRun a general multi-agent harness: many agents on one
big task, orchestrated by code that lives for hours to weeks, with budgets, human gates, agent types and
ephemeral compute that serve any domain: research, data analysis, writing, operations, and code. Code work is one
capability of it; a repository that needs no always-on machine is an optional module (Part 2).

The first test, and the yardstick, is a Bun-shaped port: Jarred Sumner's Zig-to-Rust rewrite (May 2026) ran about
50 dynamic workflows over 11 days, 4 worktrees times 16 Claudes (64 at once), 6,778 commits, 1,448 files ported,
$165k at API prices with 72B cached input reads against 5.9B uncached. Every failure he hit has a line in this
document, and the design answers each one. It is the hardest shape we know of, not the definition of the harness.

## Swarm agents are not the traditional agent shape

The agent camelRun was built for is long-lived: it keeps a conversation for weeks, owns files, and may own a
machine (a computer attached to it, with a session that survives between turns). That shape is right for a chat
agent, a bot's builder, a person's managed computer, a browser session. It is the wrong shape for a swarm.

A swarm child exists for one effect: port this file, review that diff, audit this table, critique this section.
It is stateless beyond its task, it reads and writes through tools over storage the runtime owns, and when
something must compile, run or query it borrows compute for exactly that long. Nothing of it needs to outlive its answer. Designing around that, rather than
around a machine each child holds, is what makes the rest work:

| | A machine per agent (shared, forked or persistent) | Compute per job |
| --- | --- | --- |
| Cost | A VM is billed while it waits for a model; 64 of them wait 90% of the time | A job is billed while a command runs; editing costs storage only |
| Isolation | A shared checkout: `git stash` over someone else's work. A fork each: disk per fork (#702: 1.7 GB per worktree, OOM at ten builds on one box) | Each job is its own cgroup, namespace and disk, from a snapshot; nothing shared but the snapshot |
| Failure | A stress test exhausts the box's sockets, pids or disk for everyone | It exhausts its job, which fails with its outputs; the next job starts clean |
| Scaling to 64+ | 64 machines to start, lease, snapshot and sweep; `computerLimit` default 4 | 64 editors cost nothing extra; builds are `jobConcurrency` jobs, however many editors |
| Merging | Each fork's branch pushed and merged by hand | One object serializes commits onto a branch with a file-level merge |

So the swarm primitives are `agent()` over storage the runtime owns (volumes, and for code the repository
module) plus `job()` for compute, and **no forked or persistent VM appears in the swarm path**. Computers stay what they are: for interactive or long-lived agents, for
browsers, and for people's managed machines. They are not removed; they are not the primitive here.

## Recommendation

1. **A workflow is a new durable resource, `wf_…`, with a Durable Object of its own on Workers, and delegation
   gets an owner model so it can be one.** A child's parent is an **owner**, `{ kind: "agent" | "workflow", id }`,
   not an agent id: child rows, the chain root, lineage and inbox ownership are keyed by owner, and the agent-only
   assumptions (`parentAgentId` in a JSON header, a recursive walk over `agents` for the chain root, HMAC-signed
   lineage in prompt metadata) are deleted. A workflow is not an agent: it has no history, no prompts, no model,
   no compaction, and making it an agent kind would drag all of that along. It owns a deterministic script, a
   journal of every effect the script made, a budget, a status and its children; a script that waits a week holds
   no code slot, no connection and no model.
2. **Endings are durable for everyone.** A child writes its ending to its own outbox and an alarm delivers it to
   the owner until acknowledged; the fire-and-forget push, the in-memory sweep and the event firehose to the parent
   go, for agents and workflows alike, and child bookkeeping is an indexed SQLite table.
3. **The script runs by replay, on a generalized code-mode exchange.** Every event (a child ended, a gate was
   answered, a job finished, a timer fired) resumes the script in pi-codemode's sandbox, which already stops a VM
   that waits on sub-agents and replays delivered results in order on the next one. The exchange's caps and
   whether result bodies cross into the guest become parameters of the exchange, for every caller, so effects in
   the journal answer at once from a host-side table, the first effect not in it is started, and when nothing can
   go on the VM stops. Effects are keyed by an explicit `key` or by a content hash of their arguments, with an
   attempt number, so editing the script and resuming reruns only what changed, and a rerun is a new child. This
   is Claude Code's Workflow tool with stronger keys and no process to keep alive.
4. **Children are remote, always.** A workflow's `agent()` starts a real agent in its own object or node, through
   the existing delegation path, keyed by the effect key for exactly-once. The ~8 concurrent streams one object
   can hold (#696) are not a ceiling: the workflow object streams nothing, it starts and collects.
5. **Four agent types and four model classes, domain-neutral.** A child is a `worker` (does a task, may write),
   a `critic` (finds problems in someone else's output, read-only, separate context, answers in a schema, never
   the model instance that did the work) or a `lead` (plans, decides, judges inside the workflow); an
   `orchestrator` is the permission set an agent holds over the workflows it owns (write and edit the script,
   start, steer, answer gates, decide reruns, spend the budget within its own cap). **The primary interface is an
   agent given a task writing its own workflow**, through the `workflows` builtin, when the task warrants many
   agents; the agent that writes it is its orchestrator, with no hand-off. Writing the script directly
   (`POST /v1/workflows`) is the secondary interface. Its model is a class: `fast`, `strong`, `auto` (a
   Fusion-style router that switches at compaction with judgment kept on strong) or `max` (the strongest on the
   default tier, recommended for agents that orchestrate a lot), as late-bound virtual models
   `camelrun/fast|strong|auto|max`, pinnable per workflow and per call. Everything
   domain-specific (implementer, porter, researcher, auditor) is a worker with instructions. A changed mapping
   never invalidates cached results; the resolved model is recorded on every effect.
6. **Code work is an optional module: repositories as a volume kind with a repo object** that holds the tree at a
   commit, a trigram index, branch heads, and one private **layer** per agent (the files it changed, over the
   base). Agents read, search, edit and commit with the file tools; there is no checkout, no `stash`, no `reset`,
   no branch switch to step on. Commits go to the repo object as compare-and-swap on a branch head with a
   file-level merge. Git objects are written for push and read for pull with the GitHub App token the runtime
   already mints.
7. **Compute is a job, not a machine, and jobs are a runtime primitive.** `job({ command, at })` materializes a
   volume, a commit or an agent's layer into a container started from a warm snapshot (toolchains, dependencies,
   build caches, a query client), runs one command under the container's own limits, collects named output files,
   snapshots the caches if asked, and stops. A build, a test shard, a 500-table audit query and a notebook are the
   same primitive. In phase 1 `job()` is workflow-internal; the public `POST /v1/jobs` and the `jobs` builtin come
   in phase 4. Nobody shares a checkout, nobody runs `cargo check` beside 63 others, and a test that eats every socket
   on the box kills only its job. Jobs are `POST /v1/jobs` and a `jobs` builtin for ordinary agents too, not only
   a workflow global. No forked or persistent VM is in the swarm path; phase 1 is already VM-less for editing,
   on per-child volume forks, with the repo object following in phase 3.
8. **We run the job VMs ourselves, on AWS Nitro Sandboxes.** Firecracker microVMs created through the Nitro
   Enclaves driver on Graviton hosts with local NVMe (`r8gd` for builds, `c8gd` spot for test shards), at EC2
   performance, not nested. Measured on `r8gd.4xlarge`: about 1% build overhead on a Bun incremental build, 0.83 s
   cold start, p50 2.3 s for 32 at once. One substrate for phase 2; nested-virtualization Intel hosts with
   memory-snapshot restore (35 ms, 10x faster under burst) only if a start-latency-bound job class appears. XFS
   reflink clones of warm disk snapshots on the host, Firecracker's Async disk engine, dedicated build hosts with a
   pre-started build sandbox, our own host agent and scheduler, per-job netns with an egress allowlist and no IMDS. Phase 1 jobs run on the Cloudflare Containers driver only; Bun-class builds wait
   for our hosts in phase 2. Boat and Lambda MicroVMs stay behind the same `JobDriver` seam as fallbacks, not plan.
9. **Budget, cost and cache-hit reporting per workflow**, hard spend caps, a cap on total effects, and a step-rate
   guard, with every number on one console page. Fusion's measured 41–60% saving on implementation-heavy work
   puts a Bun-shaped bill at $65–95k with workers on `fast` and critics on `strong`, if the eval agrees on quality
   at equal rounds.
10. **Build it in five phases, on Workers only.** Phase 1 (8–10 weeks) is an ordered PR stack: the delegation
   owner model and durable endings first (they fix prior mistakes for every product), then the attempted call
   ids, the generalized exchange and the atomic volume commit, and the workflow object on top with `agent`,
   `parallel`, `gate`, `sleep`, the journal, the budget pause, the items API and `job()` on the Cloudflare driver.
   No compatibility shims: every in-repo caller (SDKs, CLI, console, docs) changes in the same PR, and schema
   changes that drop a column take two deploys. Then our own job hosts, then the code module. Node parity comes
   later, when a Node tenant needs it. The first test is a Bun-shaped
   port of one of our repositories; a research sweep and a data audit run on the same phase-1 harness.

## Prior mistakes this fixes

We are our only clients, so where the existing mechanism is the mistake, this design replaces it rather than
working around it. Rolling deploys are real (nodes migrate at boot and old nodes run against the new schema), so a
change that drops a column takes two deploys: expand, switch readers, contract. camel-bots, camelAI and camel-code
are production; the last column says which touch each path, and each one's in-repo caller changes in the same PR.

| Mechanism replaced | Why it is wrong | Replacement | Production callers |
| --- | --- | --- | --- |
| A child's parent is an agent id: `parentAgentId`/`parentRunId` in the `agents` header JSON (`child-parent.ts:8`), the computer-limit chain root found by a recursive walk over `agents` (`src/core/computer-limit.ts:18`), lineage carried as HMAC-signed prompt metadata (`delegation.ts:259`) | Only an agent can own work; the chain is recomputed by walking and re-verified by signing on every call instead of being stored once | An **owner** (`{ kind, id }`) on every child row, with `rootOwner` and the chain stored at creation; the signing and the walk go | camel-bots (persistent workers by `spawnAgent({ agent })`, `par`/`root` identity claims in tool calls, which keep their values); camel-code (delegate on the pilot) |
| `agent_inputs.agent` as the input's owner (`migrations/016`) | An input can only belong to an agent, so a gate of a workflow has nowhere to live | `owner_kind`, `owner_id` columns, backfilled from `agent`; `agent` dropped in the contract deploy | camelAI (`ask_user`), camel-bots (approvals), the inbox (#752) |
| Child endings pushed fire-and-forget to the parent (`agent-transport.ts:111`), recovered by an in-memory `setTimeout` sweep that dies with the isolate and polls every child every 5 s while armed (`delegation.ts:142-166`) | A lost push is recovered only while the parent happens to be resident; a hibernating owner never hears the ending | A **child-side outbox**: the ending is a durable row in the child's storage, delivered by the child's alarm to the owner's `receiveEnding` with backoff until acknowledged; no parent-side sweep | camel-bots (`child_<request>` notifications keep their shape), camel-code |
| Every child event relayed to the parent (`delegation.ts:181`) | A firehose the parent neither reads nor needs; it exists only so a watcher can see children through the parent | Children push endings and progress only; a watcher that wants a child's live events subscribes to the child by id (`watch` with `subagents: true` follows children itself; the `subagent_event` relay is deleted) | camel-bots (uses `subagent_start`/`subagent_end` and notifications, not the relay; its chat reads children by id with the `children` scope) |
| Child bookkeeping as `delegation:*` KV rows listed whole on every start, progress report and listing (`delegation.ts:339,539,181`) | O(n) per operation, O(n²) per run; fine at 4 children, not at 64 or 2,000 | A `children` SQLite table in the owner's object, indexed by status and call | all three (every delegate call) |
| A child's identity is `digest(run.id:callId)` and a stored non-running child is returned as is (`delegation.ts:286,301`) | A call can never be made again on purpose: a rerun, or an abort followed by re-issue, is a no-op | Call identity is `callId:attempt`, with the attempt on the row | all three (no caller sets attempts; the default is 1) |
| Code mode's exchange caps are fixed per call (256 calls, 32 in flight, 8 MiB of results) and every result body crosses into the 24 MiB guest (`codemode/limits.ts`, `src/limits.ts`) | Right for one model turn, wrong for a runner that replays thousands of effects | Caps and host-side result handles are parameters of the exchange; code mode keeps today's values as its parameters | camelAI and camel-bots (code mode; unchanged values) |
| Volume writes land file by file with a per-file version check (`volume.ts:342-358`); a multi-file commit interleaves with other writers | A commit of named files cannot be atomic from outside the volume object | `POST /v1/volumes/:id/commit { files: [{ path, version, key }], snapshot? }`: all version checks and writes in one transaction inside the volume object, a snapshot on success | camel-bots (`publish` reads snapshots; unchanged), camel-code |
| A volume fork pins its source blobs for 24 hours (`files.ts:528-532`) | A fork that lives longer than a day silently loses its base | Pins live as long as the fork | camel-bots (forks of builders), camelAI (thread forks) |

## The first test: what the Bun port needed, and what camelRun has

| Needed | Today | Gap |
| --- | --- | --- |
| A loop that runs for days and is edited and resumed | Code mode scripts run inside one turn: 60–120 s wall, 256 tool calls, 32 in flight (`docs/reference/limits.md`). Pi owns the script's calls and their replay after a node loss (`src/codemode-pi-launcher.ts:56`), so finished `delegate` calls are not made again, but only within that turn and that script text. An older `workflow` builtin was removed in favour of this, and its name is refused on input today (`backends/workers/src/workflow-refusal.ts`) | A workflow object that outlives turns, with resume across edits |
| 64 agents at once, thousands in total | `delegate.maxParallel` up to 64; busy agents 250 on Tier 1, 4,000 on Tier 3; a sub-agent lives a day; `agent_children` gives exactly-once | A parent that is not an agent; start and collection that does not pass through one object's connection budget |
| Implementer, two adversarial reviewers, a fixer, per item | Definitions, `delegate` from code with `output` schemas | A pattern, not a feature |
| Work queues refilled from `cargo check` and failing tests | Computers (`computer_exec`) held by an agent; disk forks measured in #702 | A job primitive with collected outputs and no machine held by anyone |
| A prepared PORTING.md and LIFETIMES.tsv every agent reads | Volumes, mounts, mount `instructions` | Nothing; put them in the definition's system prompt for cache hits |
| One repository, 64 editors, commits of one file at a time, no stash, no reset | A git checkout on a computer, shared by children (`computer: "share"`) or forked | A repository that is not a checkout |
| grep that does not freeze a disk | `grep` over a volume lists then reads the files it scans: at most 1,000 files, 32 MiB in all, 4 MiB a file, 10 s (`src/volume-tools.ts:28`). A Bun-scale tree (1,448 files, ~35 MB) cannot be searched whole today | An index, and a search that never leaves one object |
| Isolation for stress tests (sockets, pids, disk) | A container per computer | A container per job |
| "Make it compile" gamed into stubs | Reviewer prompts | A deterministic gate in the script that reads the diff |
| Spend visibility: $165k, 72B cached reads | `usage` per run and per sub-agent, `subagentCostUsd` | A ledger per workflow with cache share |
| Human reading outputs and steering | The console's agent pages, the inbox (#752) | A workflow page: items, samples, stuck items, gates |

## Part 1: the workflow object

### Identity, ownership, status

```json
{ "id": "wf_7c1…", "name": "port-zig-to-rust", "tenant": "acme", "owner": { "kind": "agent", "agentId": "client_…" },
  "status": "running", "revision": 3, "budget": { "usd": 200000 }, "concurrency": 64,
  "spent": { "usd": 41210.55, "calls": 2812, "cachedInputTokens": 18e9, "inputTokens": 1.4e9, "outputTokens": 1.6e8 },
  "phase": "Fix compiler errors", "counts": { "pending": 61, "running": 64, "completed": 2680, "failed": 7 },
  "createdAt": 1794100000000, "updatedAt": 1794390000000, "expiresAt": 1796692000000 }
```

- `status` is `running`, `paused`, `waiting` (nothing runs, a gate or timer is open), `completed`, `failed`,
  `aborted` or `budget_exhausted`. A workflow lives 30 days by default (`ttlSeconds`, at most 366 days), then its
  children, journal and layers go.
- `owner` is whoever started it: an API key, a console user, or an agent (through the `workflow` builtin). The owner's
  payer and bucket are billed; `subject` and `context` are fixed at start as for an agent.
- **Where it lives.** One `WorkflowObject` per workflow on Workers, with SQLite for the journal, items and ledger,
  and an alarm for timers and the step-rate guard. Decided: Workers only through phase 5; that is where camelCode
  and the pilot run. The script runner, journal format and effect keys still live in `shared/`, so when a Node
  tenant needs workflows the Node backend gets a `workflows` row plus an actor under `actor_owners`, the way
  volumes are (`docs/operations/architecture.md`), and the same contract tests.

### The script

Plain JavaScript, run in code mode's sandbox (pi-codemode; QuickJS-in-Wasm on Workers today, see Execution), with no filesystem or
network of its own. Its globals:

| Global | What it does |
| --- | --- |
| `agent(task, opts)` | Starts a sub-agent and returns its answer. `opts`: `{ key?, label?, type?, class?, definition?, instructions?, model?, output?, files?, layer?, timeoutSeconds?, phase? }` (`type` is `worker`, `critic` or `lead`; `class` is `fast`, `strong` or `auto`; see Agent types). With `output` (a JSON Schema) the answer is the validated object; without it, the text. A failed or aborted child returns `null` (and the item records why), so `.filter(Boolean)` is the idiom, as in Claude Code |
| `parallel(thunks)` | Runs thunks at once, up to the workflow's `concurrency`; a barrier |
| `pipeline(items, ...stages)` | Each item through every stage with no barrier between stages; a stage that throws drops the item to `null`. Phase 4: phase 1 writes the same thing as `parallel` over per-item async functions with explicit keys |
| `job(opts)` | A build, test or query run in an ephemeral container (Part 2). Returns `{ exitCode, outputs: { name: text }, durationMs }` |
| `repo(id)` | A handle on a repository: `commit`, `branch`, `diff`, `read`, `search`, `merge` (Part 2) |
| `gate(opts)` | A decision for a person: an inbox item. Returns the answer when it comes; `expiresInSeconds` and `recommended` as in `request_decision` |
| `sleep(seconds)` | A journaled timer; the script is not running meanwhile |
| `phase(title)`, `log(text)` | Progress grouping and a narrator line, as in Claude Code |
| `now()`, `random()` | The step's clock (when its results landed) and the workflow's seeded generator; `Date.now()` and `Math.random()` read the same, since the VM is restored from a snapshot or replayed deterministically (see "As built") |
| `args`, `budget` | The start's `args`, and `{ total, spent(), remaining() }` in USD |
| `workflow(name, args)` | Runs a saved script inline, one level deep, sharing the budget and concurrency |
| `queue(name)` | A durable work queue: `push(items)`, `claim(n)`, `done(id)`, `fail(id)`, `size()` (below) |

The script must be a pure function of its `args` and the journal: no module imports, no `fetch` (an `agent()` or a
`job()` does the fetching), no raw clock.

### Execution: replay from the top

**The sandbox that exists.** Code mode on Workers is not v8-exec. It is pi-codemode's QuickJS-in-Wasm in a
separate Worker's `CodemodeSandbox` object (`backends/workers/codemode/index.ts`): three 24 MiB heaps per object,
an interrupt-poll budget of 10,000 rather than a CPU clock (`codemode/limits.ts`), and per exchange 256 calls,
32 in flight and 8 MiB of results (`src/limits.ts`). Its `ScriptRun` (`codemode/sandbox.ts`) already does the hard
part: a VM stops once every call it has out waits on a person or a sub-agent, and the next result starts another
VM that replays every delivered result in order before going on; the VM is deterministic (same start, seed and
results), so the replay makes the same calls, which Pi already has. The workflow runner extends that rather than
reimplementing it. What is wrong for a runner is that the exchange's caps are fixed per call and every result
body crosses into the guest; so the exchange is generalized for every caller: `caps` (calls, in flight, result
bytes) and `results: "inline" | "handle"` are parameters an exchange is opened with. Code mode opens its exchange
with today's values; the runner opens its own with the journal's. Whether QuickJS stays the engine for the runner
is decided by the 500-effect measurement (Node already retired QuickJS for V8, `tenants.ts:63`; a V8 isolate for
untrusted scripts on Workers is the candidate if the poll budget does not fit).

1. An event arrives at the workflow object: a child's ending, a job's result, a gate's answer, a timer, a `resume`,
   or a new script revision. The object runs one step through its own exchange, `results: "handle"`, caps from the
   journal's size and the workflow's `concurrency`.
2. The guest runs the script. Each effect call computes its key (an explicit `key`, else a cheap guest hash, FNV-1a
   over the canonical arguments; the host keeps the sha256) and asks the host for it. **Result bodies stay
   host-side**: the host ships the guest a key→(status, hash, small result or handle) table at step start, and a
   terminal effect answers from it with no I/O. A result over 8 KiB is a handle `{ path, bytes, head }` to the
   workflow's volume, which the script reads through an effect if it needs the body. So 10,000 effects are a table
   of a few hundred KB in a 24 MiB guest, not 10,000 bodies.
3. A key not in the table is a **new effect**: the host records `pending` with `attempt: 1`, commits, then starts
   it (an agent, a job, an inbox item, a timer). A start happens only after the commit, so a crash between the two
   leaves a `pending` row the next step re-issues under the same `key:attempt`, which the delegation path dedupes.
4. When every call the script has out is pending, the VM stops, as it does today for sub-agents. When the script
   returns, the workflow completes with its return value (at most 1 MiB, saved to the workflow's volume).
5. A step must fit the sandbox: replaying 10,000 journaled effects costs 10,000 table lookups and the script's own
   logic between them, under the interrupt-poll budget. That is measured at 500 effects before the API is frozen
   (phase 1), and the journal caps at 2,000 effects until it is.

**Effect keys.** The key of an effect is `opts.key` if given, else the hash of `(kind, canonical arguments)` plus an
occurrence counter, so the third identical call outside any `parallel` is the third row. **Inside `parallel`, an
effect must give an explicit `key`**: branches complete in any order, so an occurrence counter there would hand
branch A the result branch B produced for the same arguments; the step faults `key_required` rather than guess.
A prompt that embeds an earlier result changes when that result changes, and reruns; that is right. A prompt
shared by a thousand items changes when its wording is edited, and all thousand would rerun; that is usually
wrong, so any effect whose prompt is a template over an item gives an explicit key:
`agent(review(file), { key: `review:${file}` })`. Each journal row carries `attempt`; the child's call id is
`${key}:${attempt}`, and the delegation path's dedupe (`digest(run.id:callId)`, `delegation.ts:286`) sees a rerun
as a new call. Without that, `resume({ rerun })` and abort-then-re-issue would return the stored child unchanged.
Claude Code's resume keeps the longest unchanged prefix; keys are better because a loop that reorders its items, or
a new stage inserted in the middle, keeps everything it already paid for.

**Journal.** One SQLite table `effects(key, attempt, kind, status, child, request, hash, result, started, ended,
cost, model, version)`, indexed by key and by status, so a step, a sweep or the items API never lists every row.
A workflow may hold 2,000 effects in phase 1 (the tenant's `workflowMaxEffects`, raised to 10,000 once the replay
measurement passes). `version` is the runner protocol version that wrote the row: the sandbox is a separately
deployed script, so a runner rolled back to a version that cannot read a row faults `journal_version` and pauses,
never `nondeterministic_script`.

**Determinism faults.** A step whose effect keys diverge from the journal's committed order (a script that depends
on something unjournaled) fails the step with `nondeterministic_script`, names the key, pauses the workflow, and
asks the owner. It never silently reruns.

### As built in phase 1 (runner and `WorkflowObject`)

Where the code (#802, #806) departs from the text above, and why:

1. **Snapshots, not replay, between steps** (`docs/design/workflow-step-snapshots.md`). A step restores the guest VM
   from its snapshot and delivers only the new results; replay from the top is the fallback for a missing, oversized
   (16 MiB of linear memory, 8 MiB gzipped) or other-build snapshot. A replay re-delivers each step's original batch,
   not a key → result table, so scripts whose control flow depends on completion order replay exactly.
2. **The step-rate guard throttles rather than pausing with `step_rate`.** Past 5,000 steps in an hour, steps wait
   on the alarm for the window to move; the owner has nothing to do.
3. **`Date.now()` and `Math.random()` do not throw.** They read the step's virtual clock and the workflow's seed,
   which the snapshot and the replay keep deterministic; `now()` and `random()` are the same values.
4. **A revision (an edit, or a resume that reruns keys) starts from a table** of what the journal held when it began:
   effects whose keys the script still asks for are answered from it, so only what changed runs again. A table
   answers at once, so order-dependent code may differ across an edit (never within a revision). A result that lands
   for a key the new revision no longer asks for is kept, not a fault, and shows as `unseen` in the key diff. An edit
   whose new effects exceed `rerunConfirmPercent` (25 by default) of the finished ones it inherited waits paused
   (`confirm_rerun`) until a resume confirms it.
5. **A refusal is never shown to the script.** A child refused for credit pauses the workflow (`payer_exhausted`), or,
   when it was the workflow's own budget share, makes it `budget_exhausted`; resume, or raising the budget, re-issues
   the effect under its next attempt, and the script, still waiting on the key, gets the new attempt's result.
6. **`sleep(seconds)` and gate expiry are the object's own alarm**, with the step window, the capacity renew (from
   open to close, slots held or not) and a five-minute sweep while the workflow runs or waits. One concern failing
   does not lose the others or the alarm.
7. **Ending stops what is still running.** Effects still out when a workflow completes, fails or is aborted are
   cancelled through the executor, their capacity slots given back, and the lease closed.
8. Deferred: `ttlSeconds` expiry, and the inbox item for `budget_exhausted`.

### Children and exactly-once

`agent()` uses the delegation path, with the workflow as the child's **owner**. Today five places in that path
assume the owner is an agent (the push to `env.AGENTS.getByName(parent)`, `parentAgentId` in the child's header,
the recursive chain-root walk in `reserveComputer`, the run-bound lineage signature, `agent_inputs.agent`). The
choice was between making a workflow an agent kind and generalizing the parent. On the merits, the owner model
wins: a workflow has no history, prompts, model, compaction or tools, and an agent kind without them would be
special-cased in every agent path (admission, listing, billing, the console); the parent abstraction, by contrast,
is five call sites that all want the same two fields. So:

| Owner model | |
| --- | --- |
| `Owner` | `{ kind: "agent" \| "workflow", id }`. Both kinds implement `receiveEnding(ending)`, `receiveProgress(report)`, `remainingBudget()`, `cancelChildren()` and `inbox` ownership. The Workers object for either is found by kind and id; on Node, by actor |
| Child row | `children(owner_kind, owner_id, call_id, attempt, child_id, request_id, status, root_owner, chain, depth, max_depth, started, ended, cost)` in the owner's SQLite (Workers) or `agent_children` with the same columns (Node), indexed by `(owner, status)` and `(owner, call_id)` |
| Chain | `root_owner` and `chain` are stored on the row when the child is made, by the runtime, and copied to the child's header as `owner`; nothing is recomputed by walking `agents`, and nothing is signed into prompt metadata. `reserveComputer` reads `root_owner` from the agent's header |
| Call identity | `callId:attempt`; a rerun or an abort-then-re-issue bumps `attempt` and makes a new child. The workflow's `callId` is the effect key |
| `DelegationHost` | Implemented by both objects; the workflow's `context()` returns its one run `wf_…:main` (steps are not runs), `remainingBudget()` is budget minus the ledger, `notify()` appends to the journal |

Then:

- The row is written before the child is prompted, so a re-issued effect finds the same child, as a resumed
  turn's `spawn_agent` does today (`docs/guides/multi-agent.md`, Exactly once).
- The child is a real agent: a definition's, or an inline one on the workflow's default model. It lives until the
  workflow ends or `ttlSeconds` passes, whichever is first, and its history is readable by id from the item.
- **Endings are durable, for every owner.** The child writes its ending (and each progress report) to an
  **outbox** in its own storage in the same transaction that records its run's outcome, and its alarm delivers it
  to the owner's `receiveEnding` with backoff until the owner acknowledges; the owner's receive is idempotent on
  `(child_id, request_id)`. There is no parent-side sweep and no push that can be lost: a hibernating workflow
  hears every ending when the child's alarm reaches it. The `setTimeout` sweep and the fire-and-forget push are
  deleted for agents too. Endings reach a parent agent as the same `child_<request>` notification they do today,
  so camel-bots's builder sees no change in shape.
- **No firehose.** A child pushes endings and progress only. A watcher that wants a child's live events subscribes
  to the child by id; the SDK's `watch` with `subagents: true` does that itself, and `subagent_event` on the
  parent's stream is removed, with the SDKs, the console and the docs changed in the same PR.
- The workflow's bookkeeping is the indexed `effects` table joined to `children`, never a scan.
- The child's chain root is the workflow. Its depth counts from there; `maxDepth` default 2 applies below it, so a
  child may delegate but its grandchildren may not. Children cannot start workflows.
- The child's run spend limit is the workflow's remaining budget divided by free concurrency slots, as today's
  `holdBudget` share, and its cost lands in the ledger when its ending does.
- `files` mounts the workflow's volume (read-only by default) into the child beside its workspace; `layer` gives the
  child a private layer on a repository (Part 2). A child has no computer: `computer` is refused on `agent()`, and
  compute is a `job()` from the script or from the child's `jobs` builtin.
- The one alarm of the workflow object multiplexes its timers, gate expiry and the step-rate guard; it needs no
  sweep of children, because endings come to it.

This is compatible with #696's remote-child shape (a child in its own object, owned by a Pi task): the owner
model is what that design's `RemoteChild` would call, and the outbox is how its `childDone` callback should be
delivered. In-object Pi children stay the wrong shape for a workflow (one object's connection budget is 6–8
streams).

### Long waits, gates, timers

A workflow that waits burns nothing: no isolate, no connection, no slot. On Workers the object hibernates; its one
alarm is armed for the earliest of the next timer, gate expiry and the step-rate window. A `gate()` is an inbox
item whose owner is the workflow (`owner_kind = "workflow"`; #752's `request_decision`, with `root` = the workflow
and `lineage` = `[workflow]`), so it shows on `/inbox` with the workflow's name, carries
attachments (a diff, a report in the workflow's volume) and a recommendation, and its answer is the event that runs
the next step. A gate's default expiry is 7 days; `onExpire: "recommended"` applies the recommendation, else the
workflow pauses with `waiting_on_gate`.

### Pause, edit, resume, abort

| Action | Effect |
| --- | --- |
| `POST /v1/workflows/:id/pause` | No new effects start. Running children and jobs go on (`{ children: "abort" }` stops them; their effects become `aborted` and are re-issued on resume under `attempt + 1`) |
| `PUT /v1/workflows/:id/script` | A new revision: `{ script, args? }`. The next step replays with it. Phase 1 answers `{ revision }` and the items API then shows the key diff (keys kept, keys newly pending); the dry replay that predicts an edit's cost is phase 4 |
| `POST /v1/workflows/:id/resume` | `{ rerun?: [exact keys] }` bumps those effects' `attempt` and runs a step; globs are phase 4 |
| `POST /v1/workflows/:id/abort` | Aborts children and jobs, settles the ledger, keeps the journal readable |
| `POST /v1/workflows/:id/budget` | Raises or lowers the cap. Lowering below spend pauses |

The Bun story in these terms: two minutes into the port, children run `git stash` over each other. Here they
cannot (Part 2). Hours in, reviewers accept stubs. The owner edits the reviewer prompt and adds a deterministic
gate, `PUT …/script`; the reviews keep their keys (`review:<file>`), so only unfinished and new items see the new
prompt, and `resume({ rerun: [...keys] })` is the deliberate choice if the owner wants the old ones redone.

### Budget, spend and cache reporting

- `budget.usd` is a hard cap enforced by the ledger, not a reservation: nothing in the runtime holds money for
  longer than one call (`CreditHolds` are per call with a 10-minute expiry, `credit-holds.ts:7,33-41`; end-user
  pools are daily, #784), so "hold the budget at start" does not exist and is not claimed. Children get their run
  spend limits from what the ledger says is left; a job's compute is charged at the provider's price; a step that
  would start an effect past the cap pauses the workflow with `budget_exhausted` and posts an inbox item to the
  owner with the numbers.
- **A payer running dry is a pause, not a null.** A child refused for credit (a 402, a tenant cap, a spend limit)
  is not a failed effect that `.filter(Boolean)` would drop: the runner distinguishes refusal from failure, marks
  the effect `refused`, and pauses the workflow with `payer_exhausted`. Resume re-issues it under the next attempt.
- **Who pays.** A workflow bills the tenant that owns it. A workflow started for an end user records `endUser` for
  attribution and keeps `budget.usd` as its explicit cap; it never draws on the end user's daily pool.
- **The `workflows` builtin's default budget** is the least of its `maxBudgetUsd` setting, the agent's own remaining
  `spendLimit`, and the tenant's `workflowBudgetCap`; a start above that becomes an inbox approval. An agent with a
  $50 limit cannot start twenty $100 workflows because its prompter asked.
- The ledger has one row per effect: child agent, model, served tier, input tokens, cached input tokens, output
  tokens, cost, duration, result size. `GET /v1/workflows/:id` sums it as `spent`. Usage records carry
  `workflow: wf_…` and `effectKey`, so `/v1/usage` and workspaces report per workflow. `cacheShare` on the page and
  the 50% and 80% alerts are phase 4; phase 1 has the 100% pause only.

### Limits for 64 at once and thousands in all

| Limit | Today | For workflows |
| --- | --- | --- |
| Script wall time | 60–120 s per code run; 10,000 interrupt polls; 24 MiB heap | Per step, unchanged. A workflow has no wall limit but `ttlSeconds` |
| Tool calls per script | 256, 32 in flight, 8 MiB of results per exchange | The runner's own exchange: effects per workflow 2,000 in phase 1, 10,000 once replay is measured (tenant max 100,000); results stay host-side; in flight = `concurrency`, 1–64, at most the tenant's busy-agent limit minus 10% |
| `delegate.maxParallel` | 4, max 64 | Not used; `concurrency` is the fan-out. A child's own `delegate` keeps its own `maxParallel` |
| Busy agents | by tier | Unchanged; a workflow at 64 needs Tier 1 (250). The step refuses to start a child at the limit and retries at the next step rather than failing the effect |
| A sub-agent's life | 1 day | The workflow's `ttlSeconds` |
| `AGENT_WAKES_PER_HOUR` 100 per chain | Notifications to a parent agent | Not a workflow's: a step is not a turn. The step-rate guard instead: 5,000 steps an hour per workflow, then steps wait for the window to move (the alarm), with `throttledUntil` on the workflow |
| Delegate `agents` allowlist 32 | | A workflow names definitions by id; the owner's key scope decides what it may use |
| Open requests per agent 32 | | A workflow's children are each their own agent; the workflow object's inbound queue is its event log, unbounded in SQLite |

Starting 64 children from one object passes through its outbound budget: #696 measured 100 remote starts in 1.6 s
at p50. Fine.

### Observability and the console

`GET /v1/workflows/:id/items?phase=&status=&cursor=` lists effects: `{ key, attempt, kind, label, phase, status,
agentId?, jobId?, startedAt, endedAt, costUsd, model, resultHead (500 chars), error? }`. `GET …/events` is SSE:
`step`, `effect_started`, `effect_ended`, `gate_opened`, `paused`, `completed`. `GET …/stuck` (phase 4) lists
running effects older than three times the phase's p95 or 30 minutes, with the child's latest `report_progress`.

The console page `/workflows/:id` shows the phase tree (Claude Code's progress tree, kept after the run), counts, the
spend line with cache share, stuck items, the last 50 `log()` lines, each item's sample output and a link to the
child's transcript, open gates with answer buttons, the script with a diff against the previous revision, and
`pause`, `resume`, `abort`, `edit`. `/workflows` lists the tenant's, running first.

### Agent types and model classes

The Bun port ran every agent on one Mythos-class model. Most of its tokens were mechanical work a cheaper model
does well enough when two strong critics stand behind it. The lever is to separate two things an earlier draft of
this document conflated: **how hard the thinking is** (the model class) and **what the agent is allowed to do**
(the type). Neither is a job title; "implementer", "porter", "researcher" and "auditor" are instructions.

**Model classes** are late-bound virtual models, resolved at each call the way `camelrun/default` resolves by name
to a list of real models with failover (`docs/guides/models-and-keys.md`, Virtual models):

| Class | For | Resolves to |
| --- | --- | --- |
| `camelrun/fast` | Bulk work: port a file, apply listed findings, extract, summarize, search | Decided: `openrouter/meta/muse-ember`, already the runtime default (#782, #783): $0.10/M in, $0.50/M out, $0.004/M cache read, 1M context, served by Meta and Google Vertex |
| `camelrun/strong` | Judgment: review, plan, decide, read ambiguity, final answers | Decided: `openrouter/google/gemini-4-carbon` on the **flex** service tier: $1/M in, $5/M out, $0.05/M cache read, half the default tier's $2/$10, lower priority and slower (below) |
| `camelrun/auto` | One conversation across tasks of unknown difficulty | A Fusion-style pair (strong main, fast sidekick) that switches only at compaction; below |

**Flex, and what happens when flex is full.** `strong` sends the top-level `service_tier: "flex"` parameter on
each request (OpenRouter's `google-ai-studio/flex` endpoint), never the `:floor` model variant, which is a price
sort and breaks the no-sort, no-order rule; routes still use `provider.only` and `ignore` filters only. Per
OpenRouter's service-tiers doc, an explicit flex request falls back only to endpoints priced at or below flex, and
Google's flex is the cheapest Carbon endpoint, so a flex capacity shortage surfaces as an error, not a fallback.
So the runtime handles it: retry flex with backoff inside a bounded window, then fall back to the default tier for
that call. The window is a per-workflow setting (`flexWaitSeconds`, default 600: workflows are latency-tolerant;
an ordinary agent's default is 30). A fallback is logged on the effect and in the ledger with its cost delta
(`items[].tier: { requested: "flex", served: "default", deltaUsd }`), and what is recorded is the response's own
`service_tier` field, which says which tier served, not what was asked. None of this exists yet: phase 1 adds the
`service_tier` parameter on the OpenRouter provider, the bounded retry, the per-workflow window, and the served
tier on usage records and the ledger.

**Agent types** are four small sets of behaviours and permissions, shipped as definitions a tenant can copy. Three
work inside a workflow; one owns it from outside:

| Type | Does | Permissions | Default class |
| --- | --- | --- | --- |
| `worker` | One task from instructions; may write | File tools, `commit` on its layer, `report_progress`; no sub-agents by default | `fast` |
| `critic` | Finds problems in someone else's output | Read-only mounts and layers; answers in a schema (`output` required); its own fresh context; never the model instance that did the work | `strong` |
| `lead` | Plans, decides, judges inside a workflow, as one of its effects; turns a goal into a work-list, resolves conflicts, writes the final answer | May write; may `delegate`; may open gates | `strong`, or `auto` for a long-lived one |
| `orchestrator` | The agent that owns a workflow, usually the agent that was given the task and wrote the workflow itself: writes and edits the script, starts, pauses, resumes and aborts, reads items, samples and the ledger, answers or escalates gates, decides reruns | The `workflows` builtin; may spend the workflow budget within its own cap and change the script; does no item work in it and never acts as a critic of it | Its own model; `max` recommended for agents that orchestrate a lot |

Why four, not three or five. Two (worker, critic) loses the thing Fusion showed must be protected: judgment has to
live somewhere with a fixed strong class and the permission to decide, and a worker with a strong model is not that
(it can still be re-pointed at `fast` by a pin). Five (the earlier implementer / fixer / reviewer / planner /
explorer) encoded a domain in the type system: an explorer is a read-only worker, a fixer is a worker with a
findings list, a planner is a lead. The orchestrator passes the test the others set (a new type must argue for a
permission the three lack): changing a running workflow's script and spending its budget are permissions no
worker, critic or lead has, and should not have. Types are what the runtime enforces; everything else is a prompt.

The Bun loop in these terms: the Claude Code session Jarred talked to is the `orchestrator` (it wrote each
dynamic workflow from his description, and he "monitored workflows, manually reading the outputs, and prompted
Claude to edit the loop"), the implementer is a `worker` with the porting instructions, the two
adversarial reviewers are two `critic`s (which resolve to different models when `strong`'s route list has two),
the fixer is a `worker` with the findings, and the planner that wrote PORTING.md and LIFETIMES.tsv is a `lead`. A
research sweep: `worker`s per source, `critic`s per claim, a `lead` to synthesize. A data audit: `worker`s per
table with a query `job()` each, `critic`s on the flagged ones, a `lead` to rank.

**The orchestrator is the agent that wrote the workflow.** The main interface is not a person writing a script
and not a separate orchestrator agent to delegate to: an agent is given a task, decides by itself that the task
warrants many agents, and writes a workflow to orchestrate them, as Claude Code writes its own dynamic workflows.
That agent is the workflow's orchestrator: `orchestrator` is the permission set it holds over the workflows it
owns, not a second agent. It keeps its conversation with the person, writes the script (usually from a saved
pattern), starts it with a budget, watches the items API and the ledger, reads sample outputs, answers the gates it
can and escalates the rest, edits the script when the loop is wrong, resumes, and decides what to rerun. Inside
the workflow it does no item work and is never a critic; a `lead` plans and judges there, as one effect among the
script's. Writing the script directly, `POST /v1/workflows` from a person or an application, is the secondary
interface, and a workflow started that way has its owner as orchestrator.

**Availability.** `delegate` today is not on by default: an agent has it when its definition or upsert gives it
`delegate` settings, and the SDKs add the builtin when those settings are passed (`docs/guides/multi-agent.md`,
Sub-agents). `workflows` matches that exactly: every agent that can delegate can write a workflow over the same
targets, with no further setting; a definition or an upsert turns it off with `workflows: false`, and a tenant
caps it (`workflowBudgetCap`, running workflows per tenant) or turns it off for everyone. The guardrails below
hold for whichever agent owns a workflow.

**Model.** The agent keeps its own model; writing a workflow does not switch it. `camelrun/max`, the strongest
available on the default tier (not flex), is the recommendation for an agent that orchestrates a lot, because
its token volume is tiny next to the workers' while its leverage is the highest (one bad loop edit wastes
thousands of worker calls, and it is often in a loop with a person who is waiting). It is a class rather than a
pin so that "the strongest we have" moves when the strongest moves and keeps failover. An agent on a cheaper
model that wants a stronger hand on the script asks for it as an option, not a hand-off: `workflow_start` and
`workflow_edit` take `draft: "max"`, which runs one `lead` sub-call on `camelrun/max` to write or revise the
script from the agent's description before the agent reviews and submits it. That keeps the conversation,
ownership and guardrails with the agent and spends the strong model only on the script, which is where its
leverage is. Day-one `max`, decided by Miguel (2026-11-11): Claude Fable 5.2 (`anthropic/claude-fable-5.2` on
OpenRouter, $8/$40 per M, default tier). It is the strongest available, and a different family from the workers
(`fast`, Muse Ember) and critics (`strong`, Gemini 4 Carbon), so an agent on `max` reading a critic's work
satisfies the never-the-same-model rule for free. Its price barely registers: the agent's script-writing and
steering is tens of thousands of tokens against the workers' millions. The tradeoff is a second provider's cache
and key in the loop.

**When to write a workflow** is model-facing behavior, so the builtin's description says it. Draft, for wording
review: *"Write a workflow when a task is many independent or repeated units of work (per file, per table, per
source), needs more than a few sub-agents at once, must keep running after your turn ends, or needs a person's
approval or a budget along the way; use `delegate` for a few sub-agents whose answers you need in this turn. A workflow outlives your turn
and reports back as it goes; you own it: you can edit its script, answer its gates and stop it."*

Orchestrator guardrails, enforced by the runtime, not the prompt, scoped to the agent that owns the workflow:

- its budget is bounded by its own limits: the least of its remaining `spendLimit`, its `maxBudgetUsd` (default
  $100, set on the definition) and the tenant's `workflowBudgetCap`; a start above that is an inbox approval;
- a budget increase above `orchestratorRaiseUsd` (default $500, tenant-set) goes to an inbox gate for a person;
- every script edit is recorded as a revision with its diff and the agent's stated reason (`reason` is required
  on `workflow_edit`), visible on the workflow page and in the items API's key diff;
- an edit whose key diff would rerun more than `rerunConfirmPercent` (default 10%) of completed effects needs
  confirmation: a gate to a person, or `confirm: true` on the edit with the reason;
- the agent cannot edit its own `maxBudgetUsd`; only the tenant can;
- it may not call `agent()` for its own workflow's item work and never takes `type: "critic"` in it; the runtime
  refuses both.

**End to end.** A camelCode agent in Slack is told "port this repo to Rust". In its turn it reads the tree, writes
PORTING.md with a `lead` sub-call, and decides the job is 1,400 files behind two critics each: a workflow. It
calls `workflow_start` with the review-loop pattern, the file list as `args`, a $20,000 budget (its `maxBudgetUsd`
is $25,000 on this definition) and `classes: { fast: muse-ember, strong: gemini-4-carbon }`, and tells the channel
what it started and the link. Phase ends arrive as `<workflow_notification>`s; it posts the counts. A critic's
findings show stubs getting through; it calls `workflow_edit` with the stricter critic prompt and a deterministic
stub gate, `reason: "critics accepted todo!() stubs in 14 files"`; the key diff would rerun 3% of completed
effects, under the threshold, so it goes through, and it answers the stub-gate question in Slack when a person
asks. A gate opens ("crate split conflicts in 12 files, merge?"); it reads the samples, answers two, escalates the
rest to the person with the diff attached. The workflow completes; it pushes the branch by a job, opens the PR
through the GitHub App, and reports the ledger: cost, cache share, rounds per file.

A workflow names them per call: `agent(task, { type: "critic" })`, with `class` to override the type's default and
`definition` when the script wants a specific definition instead. A type's prompt is its definition's system
prompt, so every call of a type shares one prefix and the provider's prompt cache hits across thousands of calls;
a workflow that puts PORTING.md into the worker definition's system prompt gets Bun's 92% cache share for free.

**Late binding.** `camelrun/strong` resolves at the moment of each call to the current route list for that class,
so a workflow written today gets a better or cheaper model when the class's default moves, with no edit. The
resolved real model is recorded on every effect (`items[].model`, the ledger, `usage.recorded`'s `servedModel`), so
a run is reproducible and a cost report says which model did what.

**Pinning.** A start may map classes to models for the whole workflow, and a call may override its own:

```js
// POST /v1/workflows { …, classes: { fast: "openrouter/deepseek/deepseek-v4.1-flash-1017", strong: "anthropic/claude-opus-5-5" } }
await agent(task, { type: "critic", model: "anthropic/claude-sonnet-5-5" });   // this call only
```

The order is: the call's `model`, then the call's `class`, then the workflow's `classes` map, then the type's
default class, then the class's current route list. A pinned model is a real model: no failover, as for any agent
that names one. OpenRouter routes under a class use `provider.only` and `ignore` allowlists only, never `order` or
`sort`, which disable its load balancing (the 2026-10-18 incident).

**Resume semantics.** A change to a class's route list, or to the workflow's `classes` map, does **not** change an
effect's key, so completed results stay cached: the model is an execution detail, not an argument. The owner who
wants old work redone on a stronger model says so: `resume({ rerun: ["impl:*"], classes: { fast: "…" } })`. A
call's explicit `model` or `class` is part of its arguments and does change its key, as any argument does.

**Within one agent: `camelrun/auto`, a Fusion-style class.** Classes are static per `agent()` call: the workflow
picks one for each effect. Cognition's Devin Fusion (June 2026) routes *within* one agent's session instead: a
frontier "main" agent and a cheap "sidekick" run in parallel, each with its own tools and its own persistent,
cached context; the main agent reads minimally, delegates by default, and keeps the plan, the reading of
ambiguity and the final review; lightweight classifiers decide mid-session when the controlling model should
change; and a switch happens only at context compaction, which is already a cache miss, so it costs no extra cache
penalty. On FrontierCode 1.1 Extended, Fusion scored 63.1 at $1.35 a task against Fable 5 xhigh at 64.9 / $10.53
and Opus 5 medium at 63.6 / $3.51: up to 60% cheaper, with the largest gains on implementation-heavy sessions, and
88% of Cognition's own merged PRs ran entirely on it. What failed for them is the lesson that matters here:
delegating judgment-heavy work lost the intent (a cross-team feature gated on a flag dropped from 54 to 27).

Recommend offering both. Per-call classes are right for a workflow's items, where the script already knows which
effect is mechanical and which is judgment, and where a thousand `worker` calls share one cached prefix.
`camelrun/auto` is right for ordinary agents, for camelCode's long-lived lead, and for a workflow's `lead`:
anything that holds one conversation across tasks of unknown difficulty. It would:

- resolve to a pair (`main` from `strong`'s route list, `sidekick` from `fast`'s) and start the turn on the main
  model;
- switch the backing model only at a compaction boundary. Pi's compaction is where camelRun already rebuilds the
  model's context from the journal (`docs/concepts.md`, Long conversations; the summary and recent messages are
  re-sent whole), so a switch there is a context the provider has to read anyway, on either model. Between
  compactions the model is fixed, so the cache keeps hitting;
- keep a persistent cached context per model: the summary-plus-recent window that compaction produces is the same
  bytes for both, so each model's prefix is warm as long as it is called within the provider's cache TTL;
- decide with **Jev as the router**: the decisions path the runtime already runs (TypeSafe's `typesafe/jev-1.14`
  through OpenRouter's decisions API, `POST /v1/decisions` and the `decide` builtin, `docs/guides/decisions.md`;
  `backends/workers/src/decision-policy.ts`, `decision-providers.ts`), which answers a typed question with
  calibrated probabilities in about 0.2–0.3 s for about $0.00002 a call. The question is typed, over the last
  compaction window and the pending input: `{ next: "fast" | "strong", effort: "low" | "high" }`; below a
  confidence threshold (0.7 at first) the answer is `strong`. It is asked **at decision points only**: turn start,
  each compaction, after a tool-heavy stretch (a run of tool results with no text), and when a worker asks for
  help. Never per request: a model switched mid-segment throws its prompt cache away, and Fusion's insight is
  that compaction is where the cache is already lost. OpenRouter's hosted `typesafe/jev-router`, which picks a
  model and effort per request, is rejected for that reason. Its OpenRouter call uses `provider.only` and
  `ignore` filters only, never `order` or `sort`;
- never let judgment leave the main model, whatever Jev says: the plan, ambiguity, approvals, `commit` onto a shared
  branch and the turn's final answer are main-model steps by rule, not by router;
- log every routing decision: the probabilities, the chosen model and effort, the decision's own cost, and the
  decision point, on the effect (`items[].routing[]`) and in the ledger, so the eval can score the router and a
  cost report can show what `auto` chose and why.

`servedModel` names which model answered each response, as it does for `camelrun/default` today, so usage, the
ledger and end-user credit holds are unchanged in shape. The eval for `auto` runs the first test (the Bun-shaped
port) and one non-code workflow (the research sweep above) three ways, all-`strong`, all-`fast` and `auto`, and
reports cost per completed task and quality for each; `auto` ships as a default for leads only when it is within
2% of all-`strong` on quality at a third or more off its cost.

**A menu of strengths, not only fast or strong.** Models differ in kind, not only in price: one is better at UI
and frontend work, another at reading a long context, another at math and data, at multilingual writing, at
vision. So Jev chooses from a small **menu** rather than a pair. The menu is operator-set (`AGENT_MODEL_MENU`),
overridable per tenant (`PUT /v1/tenants/{id}/menu`) and per workflow (`menu` on the start). Each entry is:

```json
{ "name": "ui", "model": "openrouter/…", "class": "fast", "strengths": "React, CSS, component layout, accessibility; weak at concurrency and systems code",
  "evidence": { "eval": "ui-tasks-v3", "score": 0.81, "baseline": { "strong": 0.78, "fast": 0.61 }, "at": "2026-11-02" } }
```

`strengths` is the text Jev sees as that option; `class` sets its cost and speed and whether it may take judgment
(a `fast` entry never does); `evidence` names the per-strength eval that admitted it. Jev's question stays one typed
question at the same checkpoints as before (turn start, compaction, after a tool-heavy stretch, a worker's help
request): `{ next: one of the menu's names, effort: low | high }` over the compaction window and pending input.
Nothing changes about when: never per request, since a mid-segment switch throws the prompt cache away. Below the
confidence threshold the answer is the class default (`strong` for a lead, `fast` for a worker); judgment stays on
`strong` whatever Jev says. Each decision is logged with the probabilities for every entry and the chosen name, so
an entry that keeps being chosen and keeps losing (critics' findings up, rounds up) shows in the ledger by strength.

The same menu serves the `worker` type: `agent(task, { type: "worker" })` under `auto` sends a UI task to the `ui`
entry and a parser to a systems-strong one; its critics stay on `strong` and on a different model than the worker's,
as the guardrail says. An author who already knows pins a specialist directly, with no Jev call:
`agent(task, { model: "camelrun/ui" })`, or `"model": "camelrun/ui"` in a definition, which resolves to the entry's
model with the class's failover and is recorded as `servedModel` like any virtual model.

**A strength is admitted by an eval, not a vibe.** An entry enters the menu only with `evidence` from a
per-strength eval the runtime keeps under `evals/menu/<strength>/`: a fixed task set for that strength (for `ui`,
40 component and layout tasks from real sessions), run on the candidate, on `strong` and on `fast`, scored by two
`critic`s with a rubric and, for UI, by a screenshot diff against the reference in a `job()`; the candidate enters
if it beats `fast` by a margin and is within a few points of `strong` at a lower cost. The same eval reruns when the
entry's model or the route list changes, and the entry's `evidence` is replaced or the entry removed. Routes under a
menu entry use OpenRouter `provider.only` and `ignore` filters only, never `order` or `sort`.

**Cost for the Bun shape, sharpened by Fusion's numbers.** Fusion's implementation-heavy sessions saved 41–62%
against a pure frontier harness, and its judgment-heavy ones 25–38% or went wrong. The port is overwhelmingly
implementation-heavy: 1,448 mechanical ports, 16,000 compiler errors, test fixes from stack traces, each behind two
critics. So expect workers on `fast` to take the $165k to **$65–95k** (a 41–60% saving) with the critics and the
lead still on `strong`, and `camelrun/auto` on a long-lived lead to save a further few percent of a small number. The honest caveat stands: a weaker implementer raises the reviewers' findings and the fixers' rounds, and
the port's 19 regressions were semantic subtleties a reviewer must catch. So the eval measures two things, not one:
**cost per merged task** (the review loop over a fixed repository and item set, to a green build) and **quality at
equal rounds** (findings caught and regressions introduced when the loop is capped at the strong model's round
count). A cheap implementer that needs one more round per item halves the saving; one that needs two erases it.

**Guardrails.**

- A critic never reviews its own work: the runtime refuses `agent({ type: "critic" })` whose input (`layer`, or
  `files`) was written by a child on the same resolved model in this workflow, unless the call sets
  `allowSameModel: true`. Two critics of one item resolve to different models when `strong`'s route list has two.
- A class's route list moves only with an eval on the saved pattern scripts (the review loop over a fixed
  repository and item set, scored on findings caught, rounds to converge and cost) and a turn-outcome watch after
  the change, as the standing rule for model default changes says. Route lists are operator-set
  (`AGENT_MODEL_CLASSES`) and per-tenant overridable with `PUT /v1/tenants/{id}/classes`.
- `GET /v1/models` lists `camelrun/fast`, `camelrun/strong`, `camelrun/auto` and `camelrun/max` with their
  `routes`, and `GET /v1/workflows/:id` shows the resolved map at start and any pins, so nobody has to guess which
  model ran.
- **The orchestrating agent's hand is logged and capped.** Its edits carry a diff and a reason, a raise above
  `orchestratorRaiseUsd` and an edit that reruns more than `rerunConfirmPercent` of completed effects go to a
  person, its budget is bounded by its own limits, and its `maxBudgetUsd` is the tenant's to set, never its own
  (above).
- **Judgment never goes to the cheap class.** `critic` and `lead` default to `strong`, the runtime refuses a
  `class: "fast"` or a `classes` pin that puts a fast-class model on them unless the start says
  `allowFastJudgment: true`, and `camelrun/auto` keeps plan, ambiguity, approvals, shared-branch commits and the
  final answer on `main` by rule. Cognition's one failed case is exactly this, and the port's regressions are the
  same kind.
- **Account for the cache TTL.** Provider prompt caches expire after about 5 minutes. A type whose calls pause past
  that (a phase that waits on a job, a gate open overnight) loses its prefix, and the next thousand calls pay full
  price until it is warm again. The workflow runner keeps each active type's prefix warm while the workflow runs
  (a minimal call every 4 minutes against the definition's prefix, costing a few cached tokens) and batches a
  phase's calls so they land within one window; `cacheShare` on the page shows when this is not working. Fusion
  names engineering around this TTL as its hardest implementation problem; it is ours too.
- **Route dynamically mid-task, not only from the first prompt.** A task's difficulty rarely shows in its first
  message and follow-ups are often harder. Within a workflow the script re-routes by result: a critic that returns
  findings above a threshold sends the next worker call to `strong` (`agent(..., { type: "worker", class: "strong"
  })`). Within one agent, `camelrun/auto`'s classifier runs at every compaction, not once at the start.

### A small library of patterns

The runtime ships these as saved scripts and documents them; they are plain scripts, not features.

**Implement, two adversarial reviewers, a fixer, per item.**

```js
export const meta = { name: "review-loop", description: "Implement, review twice, fix, commit", phases: [
  { title: "Implement" }, { title: "Review" }, { title: "Fix" }] };
const r = repo(args.repo);
await pipeline(args.files, async (file) => {
  const layer = await r.layer(`impl:${file}`, { from: args.branch });
  await agent(`Port ${file} from Zig to Rust following PORTING.md and LIFETIMES.tsv. Write ${rs(file)}. Commit only that file.`,
    { key: `impl:${file}`, type: "worker", definition: args.porter, layer, phase: "Implement" });
  return layer;
}, async (layer, file) => {
  const reviews = await parallel([0, 1].map(i => () => agent(
    `Find every way ${rs(file)} differs from ${file} or breaks PORTING.md. Only find bugs; never fix.`,
    { key: `review:${file}:${i}`, type: "critic", layer: layer.readOnly(), output: REVIEW, phase: "Review" })));
  return { layer, findings: reviews.filter(Boolean).flatMap(r => r.findings) };
}, async ({ layer, findings }, file) => {
  if (findings.length) await agent(`Apply these review findings to ${rs(file)}:\n${JSON.stringify(findings)}`,
    { key: `fix:${file}`, type: "worker", layer, phase: "Fix" });
  const diff = await layer.diff();
  if (/\b(todo!|unimplemented!)\(/.test(diff.added)) throw new Error(`stub added in ${file}`);   // the gate the reviewers gamed
  return r.commit({ layer, onto: args.branch, message: `port: ${file}` });
});
```

**A work queue refilled from compiler output.**

```js
const q = queue("errors");
for (let round = 0; q.size() === 0 || round < args.maxRounds; round++) {
  const check = await job({ key: `check:${round}`, at: args.branch, snapshot: "rust-warm", command: "cargo check -p " + args.crate + " --message-format=json > /out/errors.json; true", outputs: ["errors.json"] });
  const byFile = groupByFile(check.outputs["errors.json"]);
  if (!Object.keys(byFile).length) break;
  q.push(Object.entries(byFile).map(([file, errors]) => ({ id: `${round}:${file}`, file, errors })));
  await parallel(Array.from({ length: Math.min(64, q.size()) }, () => async () => {
    for (let item; (item = await q.claim(1, { leaseSeconds: 1800 }))[0]; ) {
      const { file, errors } = item[0];
      const layer = await r.layer(`fix:${file}:${round}`, { from: args.branch });
      await agent(`Fix these compiler errors in ${file}. No stubs. Commit only ${file}.\n${errors}`, { key: `fix:${round}:${file}`, type: "worker", layer });
      await r.commit({ layer, onto: args.branch, message: `fix: ${file}` }).then(() => q.done(item[0].id), e => q.fail(item[0].id, e.message));
    }
  }));
}
```

A claim is a lease; a child that dies past its lease returns the item to the queue, once, then `failed`.

**Map-reduce**: `parallel` over shards, each a `job` or an `agent`, then one `agent` over the concatenated outputs
written to the volume. **Crate by crate**: the queue pattern inside a `for` over `cargo metadata`'s crate list in
dependency order, one `job` per crate, 64 fixers across crates. **Sharded tests**: `parallel` over N `job`s each
running a slice of the test list, each failure an item for the review loop.

**Beyond code.** The same primitives, no repository:

```js
// A research sweep with critics: workers per source, critics per claim, a lead to write.
const notes = await pipeline(args.sources, src => agent(`Read ${src} and list its claims about ${args.question} with quotes.`,
  { key: `read:${src}`, type: "worker", output: CLAIMS, files: "/workflow" }));
const claims = dedupe(notes.filter(Boolean).flatMap(n => n.claims));
const judged = await pipeline(claims, c => parallel([0, 1].map(i => () => agent(`Try to refute: ${c.text}. Cite the source.`,
  { key: `refute:${c.id}:${i}`, type: "critic", output: VERDICT }))), votes => votes.filter(Boolean).filter(v => !v.refuted).length >= 2);
return agent(`Write the report from these surviving claims:\n${JSON.stringify(claims.filter((c, i) => judged[i]))}`,
  { key: "report", type: "lead", files: "/workflow" });
```

```js
// A data audit across 500 tables: a query job per table, a critic on what the worker flags, a lead to rank.
const audits = await pipeline(args.tables, async table => {
  const profile = await job({ key: `profile:${table}`, snapshot: "warehouse-client", command: `camel-profile ${table} > /out/profile.json`, outputs: ["profile.json"] });
  return agent(`Here is the profile of ${table}. Flag anything wrong: nulls, drift, duplicates, PII in the clear.\n${profile.outputs["profile.json"]}`,
    { key: `audit:${table}`, type: "worker", output: FINDINGS });
}, async (findings, table) => findings?.items.length
  ? agent(`Confirm or refute each finding for ${table}: ${JSON.stringify(findings)}`, { key: `confirm:${table}`, type: "critic", output: FINDINGS })
  : null);
await gate({ title: "Audit ready", body: `${audits.filter(Boolean).length} tables with confirmed findings`, recommended: "publish" });
return agent(`Rank these by severity and write the summary:\n${JSON.stringify(audits.filter(Boolean))}`, { key: "rank", type: "lead" });
```

### API and SDK

Built in phase 1 (Workers, on per tenant; `docs/guides/workflows.md`):

```
POST   /v1/workflows                     { script, args?, budget: { usd | null }, concurrency?, classes?, name?, allowFastJudgment? }  -> 201  (Idempotency-Key)
GET    /v1/workflows/{id}                 status, pauseReason, counts, spent, phase, revision, result
GET    /v1/workflows/{id}/items, /events, /diff?revision=
PUT    /v1/workflows/{id}/script          { script, reason, rerunConfirmPercent? } -> { revision, workflow }
POST   /v1/workflows/{id}/pause | resume | abort | budget
```

Still to come: `GET /v1/workflows[?status=&owner=]` (a list), `saved` scripts and `POST /v1/workflow-scripts
{ name, script }` (`workflow(name)`), `repo`, `ttlSeconds`, `subject` and `context` on a start, `args` on a script
edit, `/script?revision=` (the script text of a revision; `/diff` has what changed), dry-run `wouldRerun`/`wouldKeep`
on an edit, `/stuck` (phase 4), and the `auto` class (classes are `fast`, `strong` and `max`).

SDK: phase 1 has `agents.workflows` / `runtime.workflows` (TypeScript and Python) with `start`, `get`, `items`, `events`, `diff`, `edit`, `pause`, `resume`, `abort`, `budget` and `wait`. Planned beyond that: `agents.runtime.workflows.start({ ... })` returning a handle with `status()`,
`items()`, `events()`, `pause()`, `resume()`, `edit(script)`, `abort()`, `wait()`; Python mirrors it. The CLI gets
`camelrun workflows start|status|edit|resume`.

**An agent writes and steers one.** The `workflows` builtin (plural: the singular name belonged to the removed
builtin and `rejectWorkflow` still refuses it, so old inputs keep failing loudly) is on for every agent that has
`delegate` settings, as `delegate` itself is, and off with `workflows: false`: `workflow_start({ name | script,
args, budgetUsd, classes?, draft? })`, `workflow_status`, `workflow_items`, `workflow_edit({ script, reason,
confirm?, draft? })`, `workflow_pause`, `workflow_resume({ rerun? })`, `workflow_abort`, `workflow_budget({ usd })`.
The agent that starts a workflow owns it and holds the `orchestrator` permissions over it; the budget may not
exceed the least of its remaining `spendLimit`, its `maxBudgetUsd` (default $100, on the definition) and the
tenant's cap, and a start above that becomes an approval in the inbox instead. Phase ends, gates, alerts and the
ending reach it as `<workflow_notification>` runtime notices (the `child_` notification path, with the wake cap).
`POST /v1/workflows` from a person or an application is the secondary interface. The walkthrough above (Agent
types, End to end) is a camelCode agent in Slack doing exactly this.

## Part 2: the code module and jobs

Everything in Part 1 is domain-neutral. This part is the code module (repositories, layers, search, git), which a
workflow uses only when it names a `repo`, and jobs, which every domain uses: a build, a test shard, a warehouse
query, a notebook, a scraper are all one command in an ephemeral container.

### The repository object

A repository is a volume with `kind: "repo"` (made by `POST /v1/volumes { kind: "repo", github: "oven-sh/bun",
ref: "main" }` or `repos.create` in the SDK) and a repo object (`RepoObject` on Workers; a repo actor on Node) that
owns:

| State | Where |
| --- | --- |
| The tree at each known commit: path → `{ blobSha, mode, size }` | SQLite rows, one per path per tree, shared by content |
| Blob contents | The chunk store volumes already use: 1 MiB content-addressed chunks under `chunks/<tenant>/<aa>/<sha256>`, a file being its chunk list (`src/volumes.ts:25-53`), S3 on Node and R2 on Workers; the git blob SHA-1 is kept beside each file's content hash |
| Branch heads: name → commit | SQLite, changed only by compare-and-swap |
| Commit objects: parents, tree id, author, message | SQLite; the git object bytes are derived when pushing |
| Layers: `{ id, base: commit, files: path → blobSha or tombstone, owner, createdAt }` | SQLite, one row per changed path |
| The trigram index: trigram → sorted file ids, for the base tree, plus per-layer deltas | SQLite blobs, updated on every write |
| Hot blobs | The object keeps the base tree's text blobs in SQLite too, up to 2 GB, so reads and searches never leave the object |

A Bun-scale repository (1,500 files, 535k lines) is about 35 MB of source. A 1M-line repository is about 65 MB. The
object's SQLite holds 10 GB; both fit whole, with their index. The object is the only writer, so it is also the lock
every shared-checkout hazard needed and never had.

### Layers instead of worktrees

A layer is the agent's private view: its writes, over one base commit. A read looks in the layer, then the base
tree. (A volume fork pins its source blobs for 24 hours today, `files.ts:528-532`, which is a mistake for any
fork that outlives a day; the pin's lifetime becomes the fork's, released when the fork is deleted.) A layer costs the bytes of the files it changed, so 64 layers of a Bun-scale repository are a few MB in all;
the post's reason for not giving each Claude a worktree disappears. A child gets a layer as a mount:

```js
const layer = await repo(args.repo).layer(`impl:${file}`, { from: "main" });
await agent(task, { layer });   // the child sees /repo, read-write, through its ordinary file tools
```

Inside the child, `/repo` is a mount like any volume: `read`, `write`, `edit`, `ls`, `glob`, `grep` and `cp`, with
the "changed since you last read it" check. There is no shell, so there is no `git` to misuse: the layer has
`commit` as a tool, nothing else. A critic's layer is `readOnly()`: the same files, no writes.

**Phase 1: layers from volume forks.** Everything above needs the repo object (phase 3). Phase 1 gets the same shape
from what volumes do today: `volume.fork({ snapshot })` is metadata-only and shares content
(`docs/guides/files.md`, Volumes), so a child's layer is a fork of the repository volume at a snapshot, mounted
read-write at `/repo`. `layer.commit()` in phase 1 is a `commit` effect over a new volume operation,
`POST /v1/volumes/:id/commit { files: [{ path, version, key }], snapshot?: { name, labels } }`: inside the volume
object, one SQLite transaction checks every path's version and writes every file, or writes nothing and answers
`{ conflicts: [{ path, headVersion }] }`; a snapshot is taken in the same transaction on success. Today's writes
land file by file (`volume.ts:342-358`), which is right for a single write and wrong for a commit, and a lock
outside the object would only serialize what the object already serializes. The effect reads `changes(since)` on
the fork, sends the batch, and on a conflict answers `{ conflicts: [{ path, headVersion, ours, theirs }] }` for
the fix stage. The child's fork is kept until its commit effect settles, so the fix stage edits the same fork and
no paid effect is repeated for a conflict. That is an atomic commit of named files with no checkout anywhere. Push and pull are jobs in phase 1: `job({ snapshot: "git-base", command: "camel-sync
/repo --at <snapshot> && git add -A && git commit -m … && git push" })` with the GitHub egress token the job's
definition grants, as a computer's `git push` gets it today. `grep` keeps today's bounds (1,000 files, 32 MiB), so
phase 1 children search with `glob` narrowed to their area, and a workflow that needs a whole-tree search runs
`rg` as a job. Phase 3 replaces the fork with a layer row, the version check with the three-way merge, the job push
with the object's thin pack, and the bounded grep with the index; `agent()`'s `layer` option does not change.

### Commits, branches, merge

`repo.commit({ layer, onto, message, paths? })`:

1. The object reads the branch head `H` and the layer's base `B`.
2. For each changed path (or `paths`, the post's "commit a specific file at once"), if the path is unchanged between
   `B` and `H`, the layer's version wins. If it changed in both, a three-way merge (diff3 on lines) is tried; a clean
   merge wins; a conflict fails the commit with the conflicting paths and both sides, and the layer is **rebased**:
   its base becomes `H` and the conflicting files are rewritten with conflict markers for the agent to resolve.
   Nothing is lost and nothing is shared.
3. A new tree and commit are written, the head moves `H → H'` in one SQLite transaction, the index takes the delta,
   and the layer's base becomes `H'` with its committed files dropped.

Two agents committing the same file at once are serialized by the object; the second gets step 2's answer. There is
no `stash`, `reset`, `checkout` or `rebase -i` because there is no working tree. `repo.branch(name, { from })`,
`repo.merge({ from, into })` (same three-way rule, whole tree) and `repo.diff({ from, to | layer })` are the rest of
the surface. The four Bun shards are four branches merged into one at the end, with conflicts handed to a fixer.

### Search

`grep` over a repository is served by the object: the regex is turned into a trigram query (Russ Cox's code-search
trick, zoekt's index shape) that prunes the candidate files, and the regex runs over those candidates in the object.
The index is file-level (trigram → files), not positional, which keeps it small: measured on this repository's own
636 files (7.6 MB), the index is 1.3M postings, about 2 MB at 1.5 bytes a posting, 0.26× the source. Bun-scale is
about 9 MB; a 1M-line repository about 17 MB. Incremental: a write to a layer indexes that file's trigrams as a
delta over the base; a commit folds deltas into the base index.

| | ripgrep on the Bun EC2 box | Repo object |
| --- | --- | --- |
| Source warm in page cache | 20–40 ms for 35 MB | 5–30 ms: trigram lookup plus regex over the candidates, in-object, no I/O |
| Source cold, default gp2 IOPS | the post: minutes, and the disk frozen for everyone | the same 5–30 ms: the source is in the object |
| 64 agents at once | 64 processes contending for one disk | serialized in one object at ~20 ms each: a worst wave of about 1.5 s, no contention outside it |
| A pattern with no literal trigrams (`.*`) | a full scan | a full scan of 35 MB in-object, ~100–300 ms, capped at 1,000 matches |

So: as fast as warm ripgrep, far faster than the ripgrep the post actually had, and constant under load. The object's
single thread is the limit; at more than a few hundred searches a second the index moves to a read replica object
per branch. Not needed for 64 agents.

### Git without a VM

The object stores trees and blobs; git objects are a format it writes and reads at the edge:

- **Import.** `POST /v1/volumes { kind: "repo", github, ref }` runs an import job: an ephemeral container clones
  with `--depth 1 --filter=blob:none` (or fetches a tarball through `codeload.github.com`) and streams the tree into
  the object. History is not imported in v1; `repo.log` and `blame` come from GitHub's API through the App token.
  A Bun-scale import is one job of a minute.
- **Push.** `repo.push({ branch, to })` builds a thin pack of the commits, trees and blobs GitHub does not have
  since the last push (git SHA-1s are computed as blobs are stored; zlib and the pack format are small), and sends
  it to `git-receive-pack` over smart HTTP with the installation token the runtime mints, as it does for a
  computer's `git push` today, with the same egress rule (GitHub's hosts only). A pack of a few hundred changed
  files is a few MB and fits a Worker request. isomorphic-git does all of this in JS and is the first choice; a
  pack writer of our own is the fallback if its memory use at Bun scale is too high.
- **Pull.** `repo.fetch({ branch })` asks GitHub for the compare since the known head and applies the changed files
  as a commit; a branch that diverged (people pushed) is merged with the three-way rule. Deep history operations
  (bisect, interactive rebase, blame over moves) are a job in a container, never in the object.

The earlier decision to keep our own S3 volumes and add no filesystem provider stands: nothing here mounts a
network filesystem into a machine. The object serves file tools directly; containers get a tar of a commit.

### Jobs: the ephemeral compute boundary

A build or a test run needs a kernel, a toolchain and a disk. `job()` gives it one for exactly as long as it runs:

```js
const result = await job({ key: `test:${shard}`, at: layerOrCommit, snapshot: "bun-rust-warm",
  command: "bun test $(cat /job/shards/" + shard + ")", timeoutSeconds: 1800,
  outputs: ["junit.xml", "stderr.txt"], limits: { cpus: 4, memoryMiB: 12288, diskMiB: 16384, pids: 4096 } });
```

1. **Start from a warm snapshot.** A `snapshot` names a disk image the workflow or the tenant prepared: the
   repository at some commit with dependencies installed and build caches (`target/`, `node_modules`) filled. On
   our own hosts (below) it is a copy-on-write clone of an image on the host's NVMe, booted in a microVM; on the
   Cloudflare Containers driver, phase 1's only one, it is a container snapshot (#702: restore p50 200–350 ms,
   tails to 30 s on a cold host).
2. **Sync the tree.** The container runs `camel-sync /repo --at <commit or layer>`: it tells the object which commit
   the snapshot holds, and gets a tar of only the paths that differ (a layer over a commit the snapshot already has
   is a few files). No FUSE, no network filesystem, no `git` state to corrupt.
3. **Run one command** under the container's own cgroup: the `limits` are the container's, not a `systemd-run`
   inside a shared box. A test that spawns 10k processes hits `pids`; one that writes gigabytes hits `diskMiB`; one
   that opens every socket exhausts its own namespace. The job fails as a job, with its outputs, and the next job
   starts clean. A disk watermark check before the command (`free < 2 GiB` fails with `disk_low` and names the
   snapshot as too full) replaces the post's "ran out of disk and crashed several times anyway".
4. **Collect outputs** by name from `/out` into the workflow's volume; stdout and stderr are capped at 8 MiB each
   and saved whole. `exitCode` and timing come back to the script.
5. **Optionally snapshot** (`saveSnapshot: "bun-rust-warm"`) so the next job starts with this job's caches. Cloudflare
   snapshots cost 20–25 s per stored GB and a snapshot of a fork stores only its changes (#702), so a workflow
   refreshes its warm snapshot once per phase, not per job.
6. **Stop.** The container is destroyed. Nothing is shared with the next job but the snapshot.

**Heavy commands serialize by construction.** The post's rule "`cargo check` only at the start, no slow commands" was
a prompt; here it is the shape: an implementer has no shell. The workflow runs one `cargo check` per crate per
round as a job and hands the grouped errors to 64 fixers who only edit. A job's `limits` and `timeoutSeconds` are
the only knobs, and `concurrency` for jobs is separate (`jobConcurrency`, default 8, at most the tenant's computer
limit) so 64 editors never become 64 compilers.

**Jobs are a runtime primitive, not a workflow global.** `POST /v1/jobs { snapshot, at, command, outputs, limits,
timeoutSeconds }` and `GET /v1/jobs/{id}` exist on their own, the workflow's `job()` is one effect over them, and
ordinary agents get a `jobs` builtin (`job_run`, `job_status`, `job_output`) so an agent that today holds a computer
to run tests can instead run a job and hold nothing. In phase 1 only the workflow's `job()` ships, on the
Cloudflare driver, and that driver is **pilot-only** until the `containers` block reaches `wrangler.jsonc` (today it
is in `wrangler.pilot.jsonc` alone); the public route and the builtin are phase 4. Recommend yes, for every agent: a coding agent in Slack that
answers "do the tests pass?" is better served by a 40 s job from a warm snapshot than by a machine it keeps warm for
hours, and the same snapshot, `camel-sync` and limits serve both. Computers remain for agents whose work is the
machine: an interactive shell session, a browser, a person's managed computer. A job is a `computer_connections`
row with a lease and `kind: "job"`, so the existing sweep and uncertain-cleanup paths apply, and it is billed to the
workflow's budget or the agent's payer at the provider's price.

### Our own job hosts

Decided: we run the VMs ourselves. Jobs run on microVMs on hosts we own; Cloudflare Containers (phase 1's only
driver), Boat and Lambda MicroVMs sit behind the same `JobDriver` seam (`snapshot`, `create({ from })`, `run`,
`collect`, `destroy`) as bridges until the hosts land and as fallbacks after, not as the plan. The reasons are the
ones that made jobs the primitive: a Bun-class build wants 16 vCPU, 128 GiB and a `target/` past 20 GB, which no
managed provider gives at a price and a disk speed we control; a boot must be hundreds of milliseconds at 32 in
parallel, not a 30 s tail on a cold host; and egress, isolation and placement must be ours to set.

**Substrate: AWS Nitro Sandboxes on Graviton for every job class we have; nested-virt Intel with memory-snapshot
restore only if a start-latency-bound class appears.** Nitro Sandboxes (launched 2026-11-09;
`docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nitro-sandboxes.html`) let Firecracker v1.18 create
microVMs through the Nitro Enclaves driver, running beside the parent at EC2 performance, not nested, on Graviton
too. Enable at launch with `--enclave-options Enabled=true`. Their limits shape the host: no snapshot/restore and no
pause, so every job boots from its disk clone rather than resuming a memory image; the sandbox memory pool is
reserved at boot and sized per host; up to 5 sandboxes per vCPU and 896 per instance; no resize while running; on
x86 with SMT a sandbox gets only the physical cores (Graviton has no SMT, one more reason for it); incompatible
with nested virtualization on the same instance; and `169.254.169.254` must be blocked by us.

The spike (2026-11-11, `r8gd.4xlarge`, AL2023 arm64, Firecracker 1.18.0, direct mode, a 100 GiB pool; full
results in the spike's `results.md`) measured what matters:

| Measure | Result |
| --- | --- |
| Build overhead | About 1%: a one-file Bun incremental build (`build:debug:noasan`, `src/js_parser/lexer.rs`) 39.4 s on the host, 39.9 s in a 14 vCPU / 96 GiB sandbox; edit to linked binary 26.1 vs 26.4 s. Cold full build 224 s. Bun built cleanly on Graviton |
| Cold start to first command, idle host | 0.83 s median at 1 vCPU / 512 MiB with a reflink root (about 2.0 s without `quiet` on the kernel line); 1.5 s at 4 GiB, 2.5 s at 32 GiB, 6.3 s at 96 GiB |
| 32 at once | p50 about 2.3 s, max 3.4 s; CPU-bound on guest kernel boot, about 0.7 s of shared vCPU each. 8 at once p50 0.9 s, 16 at once 1.1 s |
| Large sandbox on a busy host | With a build running on the host: 16 GiB took 12 s, 32 GiB 38 s, once 235 s. The pool shares memory pressure with the host |
| Disk | Firecracker's default engine 13k random-read IOPS; `"io_engine": "Async"` 447k IOPS and 2.3 GB/s |
| Clone | XFS `reflink=1` on the instance NVMe and `cp --reflink=always`: about 1.5 ms per clone |
| Nested virt on `r8id.4xlarge` (x86), for comparison | Cold boot 0.8 s; memory-snapshot restore 35 ms; 32 restores at once p50 about 235 ms, max 302 ms: roughly 10x faster than Nitro cold starts under burst |

So one substrate wins for phase 2: every job we have (a build, a test shard, a query, an `rg`) runs for tens of
seconds to minutes, and a 1–3 s start is noise against it, while a 1% build tax is far below the 25–45% host
spread Cloudflare showed (#702). Nested-virt Intel with snapshot restore is the right answer only for a class
where start latency dominates, such as many tiny jobs or an interactive tool behind the `jobs` builtin; none is on
the plan, so it stays a second driver behind the seam, built when that class appears. Three design consequences
from the busy-host numbers: build sandboxes run on hosts that run nothing else; a build host starts its sandbox
before it is loaded, or keeps one pre-started build sandbox per host; and no host-side job ever runs on a sandbox
host. Next levers, not yet measured: a smaller guest kernel to cut the boot CPU, and pre-started pools per host.

| Pool | Instance | For | Buying |
| --- | --- | --- | --- |
| Build hosts | `r8gd` (Graviton, memory family, local NVMe): a Bun CI build runs on 16 vCPU / 128 GiB (`r8g.4xlarge`), ASAN on the 8xlarge | `cargo build`, `cargo check` per crate, link steps | On-demand or reserved; a small warm pool (2) |
| Test hosts | `c8gd`: a test shard fits 4 vCPU / 8–16 GiB; ASAN shards need 64 GiB | Sharded tests, lints, `rg` | Spot, scaled on queue depth, interrupted jobs retry by key |

**VM.** One Firecracker microVM per job (Cloud Hypervisor is the alternative if we need virtio-fs or hotplug). The
earlier spike on Kata over Cloud Hypervisor measured about 0.8 s to the first command, with the guest kernel at
init in 0.16 s; the rest was containerd and CNI serializing starts. So the driver is our own, with a pool of
pre-made network namespaces and taps per host, and no containerd in the path. The configuration that worked:
`enclave: { direct_mode: true, cpu_overcommit: true }` (`false` for a build sandbox), `--no-api`, run as root,
`nitro_enclaves.mempool=100G@0` set with grubby and a reboot, 36 written to
`/sys/class/misc/nitro_enclaves/pcie_slots` (80 slots on that host), `quiet` on the kernel command line, commands
over vsock.

**Disks.** A base image (kernel, rootfs with toolchains) and the warm build-cache snapshots live on the host's NVMe,
pulled from S3 on first use and kept while the host lives. A job gets a copy-on-write clone (decided: XFS with
`reflink=1` on the instance NVMe and `cp --reflink=always`, 1.5 ms a clone, simpler than dm-thin) with
Firecracker's `io_engine: "Async"` (required: the default engine does 13k IOPS, Async 447k), boots, `camel-sync`s
the changed files in, runs, and the clone is dropped. The disk
watermark check before the command stays, and `saveSnapshot` promotes the job's disk to a new snapshot in S3, once
per phase. A snapshot is `{ id, baseImage, sizeBytes, hosts: [...] }`; placement prefers a host that already holds
it, as Cloudflare's scheduler does.

**Host agent.** Ours, 1,000–1,500 lines: register and heartbeat; pull images; clone and boot (restore from a memory
snapshot only on a nested-virt host); sync files in
over the job's one allowed route to the runtime; run the command with the job's `limits` as the VM's vCPU, memory
and disk size and a pid cap in the guest; stream logs to the workflow's event stream; upload `/out` to S3; destroy.
The scheduler lives in camelRun: hosts in a `job_hosts` table with heartbeat and capacity (cores, memory, NVMe
free, snapshots held), placement on a host holding the snapshot with free cores, else any with free cores, else a
scale-out; a job is a `computer_connections` row with `kind: "job"`, a lease the host renews, and the existing
sweep for leases whose host stopped renewing.

**Isolation and egress.** Each job runs in its own netns with a tap into the host's bridge and nftables rules that
allow only the package registries and GitHub hosts the job's definition grants (with the App token added at the
host's gateway, as `computer.egress` does today), the runtime's API for sync and outputs, and nothing else: no
route to IMDS (`169.254.169.254` dropped at the host), no host services, no other job's address. The Incus spike
found that none of this is a default; it is written down here so it is a test, not an assumption.

**Ops we take on.** Patching hosts and rolling the ASG; Firecracker and guest kernel updates (a new base image, old
snapshots rebuilt by a job); capacity (queue depth scales the test pool; builds have a fixed warm pool); a host lost
mid-job (its leases expire and each job is re-issued by its key, so a workflow sees a slower job, never a lost one);
spot interruption (the two-minute notice drains the host); build hosts that run nothing beside their sandbox. Cost
at list: an `r8gd.4xlarge` build host is a few dollars an hour on-demand and a `c8gd.xlarge`-class test host well
under one on spot, so a 64-way Bun phase (8 builds, 32 test shards) is tens of dollars an hour of compute against
hundreds of model spend. The spike itself cost under $1 of instance time.

**Bridge until it lands.** Phase 1 ships the seam with the Cloudflare Containers driver only (repositories under
20 GB, on the pilot), already driven for computers (#702, `backends/workers/src/computers/objects.ts`). Bun-class
builds wait for our hosts in phase 2. Boat and Lambda MicroVMs stay behind the seam as fallbacks when our pool is
scaled to zero or a region is down, selected by `job({ provider })` or the tenant's default.

**What the spike settled.** The four numbers it was scheduled for are in the substrate table above: boot to first
command, the one-file rebuild against the bare host, the sandbox's build overhead, and 32 parallel boots. They set
phase 2 as planned, with reflink clones, the Async disk engine and dedicated build hosts as decided inputs rather
than options. The x86 nested-virt comparison ran on `r8id.4xlarge` before the plan changed; its Bun build was not
completed there (a missing `nasm`), so there are no x86 build numbers, only start and restore ones.

**Sharded tests.** The script lists tests (one job: `bun test --list > /out/tests.txt`), slices them into N shards,
runs N jobs at once, and feeds failures to the review loop. The post's four worktrees sharded by folder were a
stand-in for this.

## Part 3: safety, abuse and cost

| Risk | Guard |
| --- | --- |
| A workflow that never ends | `ttlSeconds` (30 days default), `budget.usd` hard cap, `maxEffects` (10,000), the step-rate guard (5,000 steps an hour) |
| A script that spawns thousands of agents at once | `concurrency` ≤ 64 and ≤ the tenant's busy agents; past it, effects wait for a slot rather than fail; a child that cannot be started in 10 minutes becomes `failed` |
| A runaway budget from an agent that writes workflows | The `workflows` builtin's default budget is the least of the agent's `maxBudgetUsd` (tenant-set, never its own to edit), its remaining `spendLimit` and the tenant's `workflowBudgetCap`; above it, an inbox approval; a raise above `orchestratorRaiseUsd` is a gate; `workflows: false` turns it off for a definition, and a tenant caps running workflows |
| A bad loop edit | Every edit carries a diff and a reason; an edit that would rerun more than `rerunConfirmPercent` of completed effects needs a person's confirmation; the owning agent does no item work in its workflow, so its own calls are few |
| A payer running dry mid-run | A refused child is `refused`, not `null`: the workflow pauses with `payer_exhausted` and resumes under the next attempt. End-user-started workflows bill the tenant under their explicit cap |
| Children of children | `maxDepth` 2 below the workflow; children cannot start workflows; `camelrun/spawn` directives from a child count as its own children |
| A loop with no progress | Ten consecutive failed effects of one key pattern pause the workflow with a message, as monitors stop at 10 errors |
| Nondeterministic scripts | Faulted and paused, never silently rerun |
| Jobs | Per-job container with `limits`; `jobConcurrency`; a job past `timeoutSeconds` is destroyed; a snapshot over the provider's cap is refused; a job never idles: there is no session to keep, so nothing is billed between commands |
| An agent holding compute for a swarm | A workflow child has no `computer` tool and no `computer: "share" | "fork" | "fresh"`: its compute is jobs, and `job()` from a child counts against the workflow's `jobConcurrency` |
| Repository abuse | A repo object takes 100,000 files and 2 GB of text in SQLite; larger trees keep only the index resident and read blobs from the chunk store; layers are capped at 10,000 changed paths |
| Pushing to GitHub | Only to the repositories and permissions the App grant names, with tokens the model never sees; `repo.push` to a protected branch fails as GitHub says |
| Cost visibility | The ledger and `/v1/usage` by workflow; the 100% pause in phase 1, `cacheShare` and the 50/80% alerts in phase 4. No budget is reserved at start: credit holds are per call, so the ledger is the cap |
| Rollout | `WorkflowObject` ships under a `new_sqlite_classes` migration tag; journal rows and the runner protocol carry `version`; a rollback that cannot read rows faults `journal_version` and pauses. Column drops (`parentAgentId`, `agent_inputs.agent`) are expand/contract across two deploys; no compatibility shims otherwise |
| Tenant-wide | A tenant's running workflows ≤ 20 (operator-set), effects a minute ≤ the tenant's runs a minute |

Billing: a workflow is a line in usage like an agent, with its children's model calls, its jobs' compute and its
storage (journal, volume, layers) under it. No new price: model calls at the model's price, compute at the
provider's, storage as volumes are.

## Part 4: phases, dogfood, open questions, non-goals

### MVP cut

The MVP is the workflow object plus a workflow-internal `job()`, on Workers, with no machine held by anyone, built
as an ordered PR stack whose first half fixes delegation for every product:

| PR | Delivers | Weeks |
| --- | --- | --- |
| 1. Owner model (expand) | `Owner` type; `children` SQLite table on Workers and the new columns on `agent_children`; `root_owner`/`chain` stored at creation; `reserveComputer` reads the root from the header; lineage signing deleted; `owner_kind`/`owner_id` on `agent_inputs` backfilled from `agent`; old columns still written | 2 |
| 2. Durable endings | Child outbox rows and alarm delivery; `receiveEnding`/`receiveProgress` on agent objects; the fire-and-forget push, the `setTimeout` sweep and the `subagent_event` relay deleted; SDK `watch` follows children by id; console and docs | 2 |
| 3. Attempted call ids | `callId:attempt` in delegation identity; contract tests | 0.5 |
| 4. Exchange parameters | `caps` and `results: "inline" \| "handle"` on the code-mode exchange; code mode passes today's values; a 500-effect replay harness | 1 |
| 5. Atomic volume commit, fork pins | `POST /v1/volumes/:id/commit`; fork pins live with the fork | 1 |
| 6. Contract deploy | Drop `parentAgentId`/`parentRunId` and `agent_inputs.agent` once no node writes them | 0.5 (overlaps) |
| 7. `WorkflowObject` | `new_sqlite_classes`; the runner on pi-codemode's stop-and-replay through its own exchange; the `effects` table (`key`, `attempt`, `version`); `agent`, `parallel` (explicit keys inside it), `gate` through the workflow's inbox, `sleep`, `log`, `phase`; pause, edit (new revision, key diff in the items API), resume with exact-key reruns, abort; the budget pause and `payer_exhausted`; the one alarm; items and events APIs; a plain console page; the `workflows` builtin on for agents with `delegate` settings (`workflows: false` to turn off), the `orchestrator` permissions on the owning agent, its bounded default budget, `draft: "max"`, the builtin's model-facing description, edit revisions with diff and reason, the raise gate and the rerun-percent confirmation | 3.5 |
| 8. Jobs and classes | `job()` on the `JobDriver` seam with the Cloudflare Containers driver (pilot-only until `containers` reaches `wrangler.jsonc`; Bun-class builds wait for our hosts in phase 2), `camel-sync`, limits, outputs; children on per-child volume forks with the atomic commit; the three in-workflow types as definitions; `strong`, `fast` and `max` as route names with the flex plumbing | 2 |

That is 10 weeks sequential, about 8 with two people on it, since PRs 4–5 are independent of 1–3. `fast` is
`muse-ember` and `strong` is Gemini 4 Carbon on flex, as decided above. The review loop runs on a real
repository from day one: workers edit forks, critics read them, commits land on the base volume atomically, and
one job per round runs the typecheck and tests and pushes.

Cut from phase 1, into phase 4: `pipeline` (write `parallel` over per-item functions), the dry-replay `wouldRerun`,
`rerun` globs, phase collapse, cache-prefix warming and `cacheShare`, event coalescing, `GET /stuck`, the public
`POST /v1/jobs` and the `jobs` builtin, the SDK and CLI surface, and the 50% and 80% alerts.

The compromise is in phase 1's commit and search, not in its compute: a conflicting file stops the commit instead
of merging (the fix stage gets the conflict and edits the same fork), `grep` stays within today's bounds (an `rg`
job covers the whole tree), and push is a job rather than the object's own pack. None of these puts a VM back in
the path.

Dogfood 1: camelCode runs the review loop over the 40-odd files of `backends/workers/src/delegation*` for a refactor
we want anyway, 8 at once, with the lead in Slack, one typecheck-and-test job per round. Measure: steps, replay time
at 500 effects, cache share, job start-to-first-command and cost per job, flex fallbacks and their cost delta,
conflicts per commit, and cost against the same work done by one agent on a computer.

### Phases

| Phase | Weeks | Delivers | Dogfood |
| --- | --- | --- | --- |
| 1. Delegation fixes, then the workflow object and jobs | 8–10 | The PR stack above: owner model and durable endings for every product, attempted call ids, exchange parameters, the atomic volume commit, the contract deploy; then `WorkflowObject` with `agent`, `parallel`, `gate`, `sleep`, the journal, the budget pause, the items and events APIs, the console page and the `workflows` builtin; then `job()` on the Cloudflare driver (pilot), volume-fork editing, the four types and the `fast`/`strong`/`max` routes with flex. Workers only | camelCode review loop on a chiridion refactor on the pilot: 8–16 children editing forks, one typecheck-and-test job per round, push by job; the same run twice, workers on `strong` against `fast`, as the first class eval |
| 2. Our job hosts | 4 | The Graviton host image (Nitro Sandboxes enabled, Firecracker v1.18 in direct mode, `io_engine: "Async"`, base rootfs with `quiet`, netns/tap pool, nftables, no IMDS), the host agent, `job_hosts` registration and placement, XFS reflink clones of NVMe snapshots pulled from S3, `saveSnapshot` to S3, the ASG with a dedicated `r8gd` build pool (one pre-started build sandbox per host, nothing else on the host) and a `c8gd` spot test pool scaled on queue depth, lease sweeps and retry by key on host loss | The same loop with jobs on our hosts, Bun-class builds included. Targets from the spike: build overhead ≤ 2%, test-shard start p50 ≤ 2.5 s at 32 parallel, build-sandbox start ≤ 7 s on an idle host, cost per job against Cloudflare |
| 3. Repositories | 4 | `kind: "repo"` volumes, the repo object, layer rows, commit with three-way merge, `diff`, `branch`, `merge`, the trigram index behind `grep`, import job, push and pull through the GitHub App from the object | The loop at 32 children, commits of one file at a time onto one branch, whole-tree `grep` from the object, one push a phase |
| 4. Queues and scale | 4 | `queue()`, `pipeline`, sharded tests on the spot pool, the public `POST /v1/jobs` and the `jobs` builtin for ordinary agents, the SDK and CLI, `/stuck`, the 50/80% alerts, `cacheShare` and prefix warming, the dry-replay `wouldRerun` and `rerun` globs, event coalescing, phase collapse in the journal, 10,000 effects, `auto`, saved patterns | A compile-error work queue on a Rust or TypeScript repository of ours: 64 fixers, 8 builds on `r8gd`, 32 shards on `c8gd`, a snapshot refreshed per crate |
| 5. Bun-shaped run | 3 | Docs, the class and `auto` eval harness, the menu's first per-strength evals | A full Bun-shaped run on a public repository, measured against the post's numbers: cost, cache share, wall time, conflicts, jobs per hour |
| Later | — | Node parity through the shared runner, when a Node tenant needs workflows | — |

### Open questions

1. **Replay cost in the QuickJS sandbox.** A step replays under a 10,000 interrupt-poll budget in a 24 MiB heap,
   with results host-side. Phase 1 measures a synthetic 500-effect journal before the API is frozen and caps the
   journal at 2,000 until 10,000 is shown to fit; the fallbacks are phase collapse (phase 4) and, if that is not
   enough, a V8 sandbox for the runner alone, which the QuickJS removal on Node (`tenants.ts:63`) suggests is the
   direction anyway.
2. **Child engine.** #696 is on hold. The owner model and the outbox are what its remote-child shape needs, so it
   can land on top of PRs 1–2 without undoing them; whether the `children` row then becomes a Pi task document is
   decided with #696, before phase 4.
3. **History.** v1 imports no git history and serves `log`/`blame` from GitHub. Is that enough for critics, or do
   they need `git log -p` on the file they review? If so, the import job keeps a shallow history of N commits.
4. **isomorphic-git in a Durable Object at Bun scale.** Pack building for a few hundred files is fine; a first push
   of a 1,500-file port is a 35 MB pack. Build it in a job if the object cannot.
5. **Our hosts: what is still open after the spike.** Overhead (1%), 32-way boot (p50 2.3 s), clones (reflink)
   and the disk engine (Async) are measured and decided. Open: whether a job class ever needs the nested-virt
   Intel pool's 35 ms restores (none planned); how much a smaller guest kernel cuts the 0.7 s of boot CPU per
   sandbox, which is what bounds a burst; how a pre-started build sandbox per host is kept warm without idling a
   96 GiB reservation; the 235 s outlier starting a 32 GiB sandbox on a busy host, which the dedicated-host rule
   avoids but does not explain; and how long a warm snapshot stays warm (`target/` invalidation after a toolchain
   bump).
6. **Fallbacks after our hosts land.** Keep Cloudflare (and Boat, Lambda) as fallbacks indefinitely (a region
   down, a pool at zero), or retire them once the pool has run a month? Each kept driver is one more to maintain
   under the seam.
7. **Pricing of steps and the repo object.** Steps and searches are Durable Object time today, unbilled to tenants,
   as monitor checks are. Measure before deciding.
8. **The eval bar, and `auto`'s classifier.** The day-one models are decided (`muse-ember` for `fast`, Gemini 4
   Carbon on flex for `strong`); open is the pass bar for the class eval (cost per merged task down by a third or
   more at quality within 2% at equal rounds?) and how often flex falls back under load. For `camelrun/auto`: how
   Jev's routing is scored before the three-way eval (a labelled set of decision points from real sessions, scored
   on wrong-way switches, with the cost of each kind of error weighed: a fast model on judgment is worse than a
   strong model on bulk), where the confidence threshold sits, whether to keep the sidekick's cache warm while the
   main model holds the turn (Fusion runs both in parallel; we would pay for two prefixes), and what a
   compaction-boundary switch costs on providers whose cache keys include the model.
9. **Layers for whole-tree refactors.** A refactor that touches 10,000 paths at once (the crate split) is one layer
   at the cap. Raise the cap, or run that phase as a job that commits through the object's bulk API?
10. **`max` evaluation.** `max` is Claude Fable 5.2 (decided). Open: whether `max` needs its own eval or rides on
    the class eval's orchestrator transcripts, and whether `draft: "max"` should be the default for an agent on
    `fast` (a cheap agent writing a $20,000 loop is the case the guardrails exist for).
11. **Types for other domains.** Four types cover code, research and audits in this document. A domain that needs
    a fifth (a `negotiator` that may spend, an `operator` that may run side effects without a gate) should argue
    for a permission the four lack, not a job title.
12. **Who curates the menu, and how often.** The operator's menu needs an owner who runs the per-strength evals
    and decides admissions and removals; a tenant's menu is its own. Re-evaluate every entry on a schedule (monthly?)
    and on every model or route change, and retire an entry whose ledger shows it losing for two weeks. Whether a
    tenant may add an entry with its own eval evidence, or only choose among the operator's, is open.
13. **The builtin's wording.** The "when to write a workflow" description above is a draft; it decides how often
    agents reach for a workflow against `delegate`, so it needs an eval of its own (tasks where a workflow is
    right against tasks where it is overkill) and a wording review before it ships.
14. **Nested workflows (later, not phase 1).** Should a workflow's child write a workflow of its own, so a task
    decomposes more than one layer deep (a Bun-style port as one workflow per crate group, each splitting its own
    files)? Phase 1 says no: children cannot start workflows, and `workflow(name, args)` (a saved sub-script run
    inline, one level, on the parent's budget and concurrency) covers most hierarchy with one owner and one ledger.
    Allowing it later needs:
    - an explicit grant from the parent script, never a default;
    - one budget for the whole tree, reserved from the root rather than inherited;
    - a depth cap (two levels of workflows), plus tree-wide caps on concurrency and effects, and loop detection
      across the tree (`AGENT_WAKES_PER_HOUR` counts one chain, not a tree of workflows);
    - gates that escalate to the root's owner;
    - a tree view on the workflow page.

    Build it only if the first test, run with flat workflows plus inline sub-scripts, shows that decomposition
    quality or the root agent's context is the limit.

### Non-goals

- A full git implementation in the runtime: interactive rebase, bisect, submodules, LFS, history rewriting. Jobs
  do those.
- A visual workflow builder, or a DSL. Workflows are JavaScript.
- Handoffs between agents, or long-lived agents per worker across workflows. A child is made for an effect.
- A general durable-execution service (Temporal). Effects are the six kinds above, and the runtime owns their
  semantics.
- Forked or persistent machines anywhere in the swarm path. A computer stays available for the agents whose work is
  the machine (interactive sessions, browsers, people's managed computers); a workflow's children never hold one.
- Managed compute providers as the plan for jobs. Cloudflare Containers is phase 1's bridge; it, Boat and Lambda
  are fallbacks behind the driver seam after that; the microVM hosts are ours, on Nitro Sandboxes.
- Node parity in phases 1–5. It comes when a Node tenant needs workflows, through the shared runner.
- Moving computers (the long-lived kind) onto our hosts in this work. They may follow once the job pool is proven;
  that is a separate decision.
- Multi-repository workflows in v1. One `repo` per workflow; a second repository is a second workflow or a job.
