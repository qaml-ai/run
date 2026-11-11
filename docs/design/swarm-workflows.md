# Durable swarm workflows and VM-less code work

Status: proposal (2026-11-11), not built. Goal: make camelRun the place to run many agents on one big coding task,
orchestrated by code that lives for hours to weeks, over a large git repository that needs no always-on machine.

The yardstick is Jarred Sumner's Bun port (Zig to Rust, May 2026): about 50 dynamic workflows over 11 days, 4
worktrees times 16 Claudes (64 at once), 6,778 commits, 1,448 files ported, $165k at API prices with 72B cached
input reads against 5.9B uncached. Every failure he hit has a line in this document, and the design answers each one.

## Recommendation

1. **A workflow is a new durable resource, `wf_…`, with a Durable Object of its own on Workers** (an actor on Node,
   as volumes are). It owns a deterministic script, a journal of every effect the script made, a budget, a status
   and its children. It is not a turn of any agent: a script that waits a week holds no code slot, no connection and
   no model.
2. **The script runs by replay.** Every event (a child ended, a gate was answered, a job finished, a timer fired)
   runs the script from the top in v8-exec; effects already in the journal return their recorded result at once;
   the first effect not in the journal is started; and when nothing can go on, the isolate ends. Effects are keyed
   by an explicit `key` or by a content hash of their arguments, so editing the script and resuming reruns only
   what changed. This is Claude Code's Workflow tool with stronger keys and no process to keep alive.
3. **Children are remote, always.** A workflow's `agent()` starts a real agent in its own object or node, through
   the existing delegation path, keyed by the effect key for exactly-once. The ~8 concurrent streams one object
   can hold (#696) are not a ceiling: the workflow object streams nothing, it starts and collects.
4. **Repositories become a volume kind of their own, with a repo object** that holds the tree at a commit, a
   trigram index, branch heads, and one private **layer** per agent (the files it changed, over the base). Agents
   read, search, edit and commit with the file tools; there is no checkout, no `stash`, no `reset`, no branch switch
   to step on. Commits go to the repo object as compare-and-swap on a branch head with a file-level merge. Git
   objects are written for push and read for pull with the GitHub App token the runtime already mints.
5. **Compute is a job, not a machine.** `job({ command, at })` materializes a commit (or an agent's layer) into a
   container started from a warm snapshot (dependencies and build caches), runs one command under the container's
   own limits, collects named output files, snapshots the caches if asked, and stops. Nobody shares a checkout,
   nobody runs `cargo check` beside 63 others, and a test that eats every socket on the box kills only its job.
6. **Budget, cost and cache-hit reporting per workflow**, hard spend caps, a cap on total effects, and a step-rate
   guard, with every number on one console page.
7. **Roles with late-bound models.** `agent(task, { role: "reviewer" })` names a definition whose model is a
   virtual `camelrun/role:<role>` resolved at each call; a workflow may pin roles to models at start and a call may
   override its own. A changed mapping never invalidates cached results; the resolved model is recorded on every
   effect. A cheap implementer class under strong reviewers roughly halves a Bun-shaped bill, if the eval agrees.
8. **Build it in four phases**, dogfooding with camelCode on a real refactor of one of our repositories after each.

## What the Bun port needed, and what camelRun has

| Needed | Today | Gap |
| --- | --- | --- |
| A loop that runs for days and is edited and resumed | Code mode scripts run inside one turn: 60–120 s wall, 256 tool calls, 32 in flight (`docs/reference/limits.md`). Pi owns the script's calls and their replay after a node loss (`src/codemode-pi-launcher.ts:56`), so finished `delegate` calls are not made again, but only within that turn and that script text. An older `workflow` builtin was removed in favour of this, and its name is refused on input today (`backends/workers/src/workflow-refusal.ts`) | A workflow object that outlives turns, with resume across edits |
| 64 agents at once, thousands in total | `delegate.maxParallel` up to 64; busy agents 250 on Tier 1, 4,000 on Tier 3; a sub-agent lives a day; `agent_children` gives exactly-once | A parent that is not an agent; start and collection that does not pass through one object's connection budget |
| Implementer, two adversarial reviewers, a fixer, per item | Definitions, `delegate` from code with `output` schemas | A pattern, not a feature |
| Work queues refilled from `cargo check` and failing tests | Computers (`computer_exec`), forks of a computer's disk (#702) | A job primitive with collected outputs and no shared machine |
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
- **Where it lives.** On Workers, one `WorkflowObject` per workflow, with SQLite for the journal, items and ledger,
  and an alarm for timers and the step-rate guard. On Node, a `workflows` row plus an actor served by one node under
  `actor_owners`, the way volumes are (`docs/operations/architecture.md`). The script runner, journal format and
  effect keys live in `shared/` so both backends run the same contract tests. Workers first: that is where
  camelCode and the pilot run.

### The script

Plain JavaScript, run in the same v8-exec sandbox as code mode (`docs/operations/sandbox.md`), with no filesystem or
network of its own. Its globals:

| Global | What it does |
| --- | --- |
| `agent(task, opts)` | Starts a sub-agent and returns its answer. `opts`: `{ key?, label?, definition?, instructions?, model?, output?, files?, layer?, timeoutSeconds?, phase? }`. With `output` (a JSON Schema) the answer is the validated object; without it, the text. A failed or aborted child returns `null` (and the item records why), so `.filter(Boolean)` is the idiom, as in Claude Code |
| `parallel(thunks)` | Runs thunks at once, up to the workflow's `concurrency`; a barrier |
| `pipeline(items, ...stages)` | Each item through every stage with no barrier between stages; a stage that throws drops the item to `null` |
| `job(opts)` | A build or test run in an ephemeral container (Part 3). Returns `{ exitCode, outputs: { name: text }, durationMs }` |
| `repo(id)` | A handle on a repository: `commit`, `branch`, `diff`, `read`, `search`, `merge` (Part 2) |
| `gate(opts)` | A decision for a person: an inbox item. Returns the answer when it comes; `expiresInSeconds` and `recommended` as in `request_decision` |
| `sleep(seconds)` | A journaled timer; the script is not running meanwhile |
| `phase(title)`, `log(text)` | Progress grouping and a narrator line, as in Claude Code |
| `now()`, `random()` | Journaled on first use, replayed after. `Date.now()` and `Math.random()` throw, as they would break replay |
| `args`, `budget` | The start's `args`, and `{ total, spent(), remaining() }` in USD |
| `workflow(name, args)` | Runs a saved script inline, one level deep, sharing the budget and concurrency |
| `queue(name)` | A durable work queue: `push(items)`, `claim(n)`, `done(id)`, `fail(id)`, `size()` (below) |

The script must be a pure function of its `args` and the journal: no module imports, no `fetch` (an `agent()` or a
`job()` does the fetching), no raw clock.

### Execution: replay from the top

1. An event arrives at the object: a child's ending, a job's result, a gate's answer, a timer, a `resume`, or a
   new script revision. Events within 500 ms coalesce into one step.
2. The object runs the script in v8-exec with the journal loaded. Each effect call computes its key, looks it up,
   and returns the recorded result if the effect is terminal. A non-terminal effect returns a promise that never
   settles in this step. A key not in the journal is a **new effect**: the runner records it as `pending`, commits
   the journal, then starts it (an agent, a job, an inbox item, a timer). A new effect is started only if the step
   commit succeeded, so a crash between the two leaves a `pending` row the next step re-issues with the same key, and
   the delegation path's exactly-once by key makes the re-issue find the same child.
3. When the microtask queue drains with only unsettled effects left, the step ends and the isolate goes away. When
   the script returns, the workflow completes with its return value (at most 1 MiB, saved to the workflow's volume).
4. A step is bounded by code mode's limits (2 s CPU, 128 MiB heap, 60 s wall): replaying is cheap because effects
   answer from the journal without I/O. The script's own compute between effects must stay small, which is what a
   script that mostly awaits does.

**Effect keys.** The key of an effect is `opts.key` if given, else `sha256(kind, canonical JSON of the arguments)` plus
an occurrence counter, so the third identical call is the third row. A prompt that embeds an earlier result changes
when that result changes, and reruns; that is right. A prompt shared by a thousand items changes when its wording is
edited, and all thousand would rerun; that is usually wrong. So any effect whose prompt is a template over an item
gives an explicit key: `agent(review(file), { key: `review:${file}` })`. The console warns when an edit would rerun
more than 10% of completed effects, and `resume({ rerun: ["review:src/*"] })` forces a set to rerun on purpose.
Claude Code's resume keeps the longest unchanged prefix; keys are better because a loop that reorders its items, or a
new stage inserted in the middle, keeps everything it already paid for.

**Journal size.** An effect's recorded result is at most 64 KiB; a larger one is written to the workflow's volume
(`/workflow/results/<key>`) and the script gets `{ path, bytes, head }`. A workflow may hold 10,000 effects by default
(the tenant's `workflowMaxEffects`, up to 100,000). A step loads the journal from SQLite: 10,000 rows of a few KB in
tens of milliseconds. Past 2,000 completed effects, a completed `phase()` whose effects are all terminal is
**collapsed**: the runner keeps one row per effect with its result but skips re-validating keys inside it, and the
script's replay inside the phase is a straight sequence of journal reads. This is the cost to measure first (see
Open questions).

**Determinism faults.** A step whose effect keys diverge from the journal's committed order of the same phase (a
script that depends on something unjournaled) fails the step with `nondeterministic_script`, names the key, pauses
the workflow, and asks the owner. It never silently reruns.

### Children and exactly-once

`agent()` uses the delegation path, with the workflow as the parent:

- An `agent_children` row (and on Workers the parent's child document) is written with `toolCallId = effect key`
  before the child is prompted, so a re-issued effect finds the same child, as a resumed turn's `spawn_agent` does
  today (`docs/guides/multi-agent.md`, Exactly once).
- The child is a real agent: a definition's, or an inline one on the workflow's default model. It lives until the
  workflow ends or `ttlSeconds` passes, whichever is first, and its history is readable by id from the item.
- Its ending is delivered to the workflow object by the node or object that ran it, and by the sweep otherwise; the
  workflow takes each ending once, keyed by the child's request id.
- The child's chain root is the workflow. Its depth counts from there; `maxDepth` default 2 applies below it, so a
  child may delegate but its grandchildren may not. Children cannot start workflows.
- The child's run spend limit is the workflow's remaining budget divided by free concurrency slots, as today's
  `holdBudget` share, and its cost lands in the ledger when its ending does.
- `files` mounts the workflow's volume (read-only by default) into the child beside its workspace; `layer` gives the
  child a private layer on a repository (Part 2).

This is deliberately independent of #696's choice of child engine. In-object Pi children are the wrong shape for a
workflow (one object's connection budget is 6–8 streams); the remote-child shape in #696 section 2 is exactly what
`agent()` needs, and if that lands, `agent()` becomes a `RemoteChild` task owned by the workflow's effect. Until
then, the existing child rows do the job.

### Long waits, gates, timers

A workflow that waits burns nothing: no isolate, no connection, no slot. On Workers the object hibernates; its alarm
is armed only for the next timer or the step-rate window. A `gate()` is an inbox item (#752's `request_decision`,
with `root` = the workflow and `lineage` = `[workflow]`), so it shows on `/inbox` with the workflow's name, carries
attachments (a diff, a report in the workflow's volume) and a recommendation, and its answer is the event that runs
the next step. A gate's default expiry is 7 days; `onExpire: "recommended"` applies the recommendation, else the
workflow pauses with `waiting_on_gate`.

### Pause, edit, resume, abort

| Action | Effect |
| --- | --- |
| `POST /v1/workflows/:id/pause` | No new effects start. Running children and jobs go on (`{ children: "abort" }` stops them; their effects become `failed` and will be re-issued on resume) |
| `PUT /v1/workflows/:id/script` | A new revision: `{ script, args? }`. The next step replays with it. Returns `{ revision, wouldRerun: n, wouldKeep: m }` computed by a dry replay, so the owner sees what an edit costs before it runs |
| `POST /v1/workflows/:id/resume` | `{ rerun?: [keys or globs] }` marks those effects as pending and runs a step |
| `POST /v1/workflows/:id/abort` | Aborts children and jobs, settles the ledger, keeps the journal readable |
| `POST /v1/workflows/:id/budget` | Raises or lowers the cap. Lowering below spend pauses |

The Bun story in these terms: two minutes into the port, children run `git stash` over each other. Here they
cannot (Part 2). Hours in, reviewers accept stubs. The owner edits the reviewer prompt and adds a deterministic
gate, `PUT …/script`; the dry replay says 1,210 reviews would rerun because the prompt changed; they keep their keys
(`review:<file>`) so instead only unfinished and new items see the new prompt, and `resume({ rerun: ["review:*"] })`
is the deliberate choice if the owner wants the old ones redone.

### Budget, spend and cache reporting

- `budget.usd` is a hard cap. Children get their run spend limits from it; a job's compute is charged to it at the
  provider's price; a step that would start an effect with no remaining budget pauses the workflow with
  `budget_exhausted` and posts an inbox item to the owner with the numbers.
- The ledger has one row per effect: child agent, model, input tokens, cached input tokens, output tokens, cost,
  duration, result size. `GET /v1/workflows/:id` sums it: `spent.usd`, `cacheShare` (cached input over all input).
  Bun's 72B cached against 5.9B uncached is a 92% cache share; a workflow whose share drops below 70% is doing
  something wrong (prompts that do not share a prefix, or a definition that changes mid-run), and the page says so.
- Usage records carry `workflow: wf_…` and `effectKey`, so `/v1/usage` and workspaces report per workflow.
- Alerts at 50%, 80% and 100% of budget go to the owner (an agent owner gets a `<workflow_notification>`; a person
  gets an inbox item and the tenant's webhook).

### Limits for 64 at once and thousands in all

| Limit | Today | For workflows |
| --- | --- | --- |
| Script wall time | 60–120 s per code run | Per step, unchanged. A workflow has no wall limit but `ttlSeconds` |
| Tool calls per script | 256, 32 in flight | Effects per workflow 10,000 (tenant max 100,000); in flight = `concurrency`, 1–64, at most the tenant's busy-agent limit minus 10% |
| `delegate.maxParallel` | 4, max 64 | Not used; `concurrency` is the fan-out. A child's own `delegate` keeps its own `maxParallel` |
| Busy agents | by tier | Unchanged; a workflow at 64 needs Tier 1 (250). The step refuses to start a child at the limit and retries at the next step rather than failing the effect |
| A sub-agent's life | 1 day | The workflow's `ttlSeconds` |
| `AGENT_WAKES_PER_HOUR` 100 per chain | Notifications to a parent agent | Not a workflow's: a step is not a turn. The step-rate guard instead: 5,000 steps an hour per workflow, then pause with `step_rate` |
| Delegate `agents` allowlist 32 | | A workflow names definitions by id; the owner's key scope decides what it may use |
| Open requests per agent 32 | | A workflow's children are each their own agent; the workflow object's inbound queue is its event log, unbounded in SQLite |

Starting 64 children from one object passes through its outbound budget: #696 measured 100 remote starts in 1.6 s
at p50. Fine.

### Observability and the console

`GET /v1/workflows/:id/items?phase=&status=&cursor=` lists effects: `{ key, kind, label, phase, status, agentId?,
jobId?, startedAt, endedAt, costUsd, model, resultHead (500 chars), error? }`. `GET …/events` is SSE: `step`,
`effect_started`, `effect_ended`, `gate_opened`, `budget_alert`, `paused`, `completed`. `GET …/stuck` lists running
effects older than three times the phase's p95 or 30 minutes, with the child's latest `report_progress`.

The console page `/workflows/:id` shows the phase tree (Claude Code's progress tree, kept after the run), counts, the
spend line with cache share, stuck items, the last 50 `log()` lines, each item's sample output and a link to the
child's transcript, open gates with answer buttons, the script with a diff against the previous revision, and
`pause`, `resume`, `abort`, `edit`. `/workflows` lists the tenant's, running first.

### Roles and model routing

The Bun port ran every agent on one Mythos-class model. Most of its tokens were implementers and fixers doing
mechanical work a cheaper model does well enough when two strong reviewers stand behind it. The lever is to name
the **role** an `agent()` plays and let the runtime pick the model.

**Roles are definitions, with a model class instead of a model.** A definition today names a model (or inherits
the runtime's default, fixed when the agent is made). A role is a definition whose `model` is a virtual name of
the form `camelrun/role:<role>`, resolved at each call, the way `camelrun/default` resolves by name to a list of
real models with failover (`docs/guides/models-and-keys.md`, Virtual models). The runtime ships default roles as
definitions a tenant can copy or override:

| Role | Does | Must not | Default model class |
| --- | --- | --- | --- |
| `implementer` | Writes the code for one item from a spec | Review, judge, merge | Cheap and fast (today DeepSeek V4.1 Flash via OpenRouter; Haiku 5.5 is about 11x cheaper than Sonnet 5.5 for this shape) |
| `fixer` | Applies a list of findings to the files named | Reinterpret the findings | Cheap and fast |
| `reviewer` | Finds bugs and spec violations; answers in a schema | Edit anything | Strong (today Claude Sonnet 5.5 or better) |
| `planner` | Turns a goal into a work-list, a porting guide, a shard plan | Write code | Strong, high reasoning effort |
| `explorer` | Reads and searches to answer a question about the tree | Write anything | Cheap and fast, large context |

A workflow refers to roles by name: `agent(task, { role: "reviewer" })` (`definition` still names a specific
definition when the script wants one). A role's prompt is the definition's system prompt, so every call of a role
shares one prefix and the provider's prompt cache hits across thousands of calls; a workflow that puts PORTING.md
and LIFETIMES.tsv into each role's system prompt gets Bun's 92% cache share for free. `report_progress`, file tools
and `commit` come from the role's builtins; a role with `readOnly` layers (reviewer, explorer) cannot write.

**Late binding.** `camelrun/role:reviewer` resolves at the moment of each call to the current route list for that
role, so a workflow written today gets a better or cheaper model when the role's default moves, with no edit. The
resolved real model is recorded on every effect (`items[].model`, the ledger, `usage.recorded`'s `servedModel`), so
a run is reproducible and a cost report says which model did what.

**Pinning.** A start may map roles to models for the whole workflow, and a call may override its own:

```js
// POST /v1/workflows { …, roles: { implementer: "openrouter/deepseek/deepseek-v4.1-flash-1017", reviewer: "anthropic/claude-opus-5-5" } }
await agent(task, { role: "reviewer", model: "anthropic/claude-sonnet-5-5" });   // this call only
```

The order is: the call's `model`, then the workflow's `roles` map, then the role's current default. A pinned model
is a real model: no failover, as for any agent that names one. OpenRouter routes under a role use `provider.only`
and `ignore` allowlists only, never `order` or `sort`, which disable its load balancing (the 2026-10-18 incident).

**Resume semantics.** A change to a role's default, or to the workflow's `roles` map, does **not** change an
effect's key, so completed results stay cached: the model is an execution detail, not an argument. The owner who
wants old work redone on a stronger model says so: `resume({ rerun: ["impl:*"], roles: { implementer: "…" } })`.
A call's explicit `model` is part of its arguments and does change its key, as any argument does.

**Cost and latency for the Bun shape, roughly.** Of the port's $165k, take implementers and fixers as 60% of
spend and reviewers and planners as 40% (two reviewers per implementer, but reviews read more than they write). A
cheap implementer class at a tenth of the strong model's price makes the bill about 0.6 × 0.1 + 0.4 × 1 = 46% of
the original, around $75k, and the cheap class streams faster, so the implement stage's wall time falls too. The
honest caveat: a weaker implementer raises the reviewers' findings and the fixers' rounds, and the port's 19
regressions came from semantic subtleties a reviewer must catch. The saving is real only if the eval says the
review loop still converges in the same number of rounds; if it takes one extra fix round per item, the saving
halves. The ledger's per-role lines show which it was.

**Guardrails.**

- A role never reviews its own work: the runtime refuses `agent({ role: "reviewer" })` whose `layer` was written by
  a child on the same resolved model in this workflow, unless the call sets `allowSameModel: true`. Two reviewers
  of one item resolve to different models when the role's route list has two.
- A role's default moves only with an eval on the saved pattern scripts (the review loop over a fixed repository
  and item set, scored on findings caught, rounds to converge and cost) and a turn-outcome watch after the change,
  as the standing rule for model default changes says. The route list is operator-set (`AGENT_ROLE_MODELS`) and
  per-tenant overridable with `PUT /v1/tenants/{id}/roles`.
- `GET /v1/models` lists each `camelrun/role:*` with its `routes`, and `GET /v1/workflows/:id` shows the resolved
  map at start and any pins, so nobody has to guess which model ran.

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
    { key: `impl:${file}`, definition: args.implementer, layer, phase: "Implement" });
  return layer;
}, async (layer, file) => {
  const reviews = await parallel([0, 1].map(i => () => agent(
    `Find every way ${rs(file)} differs from ${file} or breaks PORTING.md. Only find bugs; never fix.`,
    { key: `review:${file}:${i}`, definition: args.reviewer, layer: layer.readOnly(), output: REVIEW, phase: "Review" })));
  return { layer, findings: reviews.filter(Boolean).flatMap(r => r.findings) };
}, async ({ layer, findings }, file) => {
  if (findings.length) await agent(`Apply these review findings to ${rs(file)}:\n${JSON.stringify(findings)}`,
    { key: `fix:${file}`, definition: args.fixer, layer, phase: "Fix" });
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
      await agent(`Fix these compiler errors in ${file}. No stubs. Commit only ${file}.\n${errors}`, { key: `fix:${round}:${file}`, definition: args.fixer, layer });
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

### API and SDK

```
POST   /v1/workflows                     { name, script | saved, args?, budget: { usd }, concurrency?, repo?, ttlSeconds?, subject?, context? }  -> 201
GET    /v1/workflows[?status=&owner=]
GET    /v1/workflows/{id}                 status, counts, spent, phase, revision
PUT    /v1/workflows/{id}/script          { script, args? } -> { revision, wouldRerun, wouldKeep }
POST   /v1/workflows/{id}/pause | resume | abort | budget
GET    /v1/workflows/{id}/items, /stuck, /events, /script?revision=
POST   /v1/workflow-scripts               { name, script }   (saved scripts; `workflow(name)` and `saved` find them)
```

SDK: `agents.runtime.workflows.start({ ... })` returns a handle with `status()`, `items()`, `events()`, `pause()`,
`resume()`, `edit(script)`, `abort()`, `wait()`; Python mirrors it. The CLI gets `camelrun workflows start|status|edit|resume`.

**An agent starts and steers one.** The `workflows` builtin (plural: the singular name belonged to the removed
builtin and `rejectWorkflow` still refuses it, so old inputs keep failing loudly) gives the model
`workflow_start({ name | script, args, budgetUsd })`, `workflow_status`, `workflow_edit({ script })`,
`workflow_pause`, `workflow_resume`, `workflow_abort`. The agent is the owner; the budget may not exceed the builtin's `maxBudgetUsd` (default $100), and
a start above it becomes an approval in the inbox instead. Phase ends, gates, alerts and the ending reach the agent
as `<workflow_notification>` runtime notices (the `child_` notification path, with the wake cap). This is how a
camelCode lead in Slack runs a refactor: it scouts the work-list in its own turn, starts the workflow with the list
as `args`, and reports as phases end.

## Part 2: code work without a VM

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
tree. A layer costs the bytes of the files it changed, so 64 layers of a Bun-scale repository are a few MB in all;
the post's reason for not giving each Claude a worktree disappears. A child gets a layer as a mount:

```js
const layer = await repo(args.repo).layer(`impl:${file}`, { from: "main" });
await agent(task, { layer });   // the child sees /repo, read-write, through its ordinary file tools
```

Inside the child, `/repo` is a mount like any volume: `read`, `write`, `edit`, `ls`, `glob`, `grep` and `cp`, with
the "changed since you last read it" check. There is no shell, so there is no `git` to misuse: the layer has
`commit` as a tool, nothing else. The reviewer's layer is `readOnly()`: the same files, no writes.

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

1. **Start from a warm snapshot.** A `snapshot` names an image the workflow or the tenant prepared: the repository at
   some commit with dependencies installed and build caches (`target/`, `node_modules`) filled. On Workers it is a
   Cloudflare Containers snapshot (#702: restore p50 200–350 ms in-object, 0.63 s from outside, tails to 30 s
   on a cold host); on Boat a saved snapshot (fork 3.4 s, cheaper, up to 16 vCPU and 251 GB, FUSE-slow for the
   first minutes); on Lambda MicroVMs none (1 vCPU, 2 GiB: too small for a build, fine for a lint).
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

**Sizing, honestly.** A Bun-scale Rust debug build wants more than Cloudflare's `standard-4` (4 vCPU, 12 GiB, 20 GB
disk): a 100-crate `target/` runs past 20 GB. So the default job provider is Cloudflare Containers for repositories
that fit, and Boat `large`/`xlarge` with a saved snapshot for the Bun class; `job({ provider })` and the tenant's
default choose. Both are billed to the workflow's budget at the provider's price. A job is a `computer_connections`
row with a lease, so the existing sweep and uncertain-cleanup paths apply.

**Sharded tests.** The script lists tests (one job: `bun test --list > /out/tests.txt`), slices them into N shards,
runs N jobs at once, and feeds failures to the review loop. The post's four worktrees sharded by folder were a
stand-in for this.

## Part 3: safety, abuse and cost

| Risk | Guard |
| --- | --- |
| A workflow that never ends | `ttlSeconds` (30 days default), `budget.usd` hard cap, `maxEffects` (10,000), the step-rate guard (5,000 steps an hour) |
| A script that spawns thousands of agents at once | `concurrency` ≤ 64 and ≤ the tenant's busy agents; past it, effects wait for a slot rather than fail; a child that cannot be started in 10 minutes becomes `failed` |
| A runaway budget from an agent owner | The `workflow` builtin's `maxBudgetUsd`; above it, an inbox approval. The agent's own `spendLimit` does not cap the workflow; the approval does |
| Children of children | `maxDepth` 2 below the workflow; children cannot start workflows; `camelrun/spawn` directives from a child count as its own children |
| A loop with no progress | Ten consecutive failed effects of one key pattern pause the workflow with a message, as monitors stop at 10 errors |
| Nondeterministic scripts | Faulted and paused, never silently rerun |
| Jobs | Per-job container with `limits`; `jobConcurrency`; a job past `timeoutSeconds` is destroyed; a snapshot over 20 GB is refused |
| Repository abuse | A repo object takes 100,000 files and 2 GB of text in SQLite; larger trees keep only the index resident and read blobs from the chunk store; layers are capped at 10,000 changed paths |
| Pushing to GitHub | Only to the repositories and permissions the App grant names, with tokens the model never sees; `repo.push` to a protected branch fails as GitHub says |
| Cost visibility | The ledger, alerts at 50/80/100%, `cacheShare`, and `/v1/usage` by workflow. Prepaid tenants hold budget against credit at start and settle per effect |
| Tenant-wide | A tenant's running workflows ≤ 20 (operator-set), effects a minute ≤ the tenant's runs a minute |

Billing: a workflow is a line in usage like an agent, with its children's model calls, its jobs' compute and its
storage (journal, volume, layers) under it. No new price: model calls at the model's price, compute at the
provider's, storage as volumes are.

## Part 4: phases, dogfood, open questions, non-goals

### MVP cut

The MVP is Part 1 on Workers with today's computers for code work: a workflow object, the replay runner with
`agent`, `parallel`, `pipeline`, `gate`, `sleep`, `log`, `phase`, keys and journal, pause/edit/resume, budget and
ledger, the items API and a plain console page. Children work on forked computers (#702's `computer: "fork"`), so the
MVP already runs the review loop on a real repository, with the shared-checkout hazards still present but contained
to each fork.

Dogfood 1: camelCode runs the review loop over the 40-odd files of `backends/workers/src/delegation*` for a refactor
we want anyway, 8 at once, with the lead in Slack. Measure: steps, replay time at 500 effects, cache share, cost
against the same work done by one agent.

### Phases

| Phase | Weeks | Delivers | Dogfood |
| --- | --- | --- | --- |
| 1. Workflow object | 3 | `WorkflowObject`, runner, journal, keys, `agent()`, `parallel`, `pipeline`, `gate`, `sleep`, pause/edit/resume, budget, ledger, items API, console page, `workflows` builtin, the five default roles as definitions with `camelrun/role:*` virtual models, the `roles` map and per-call pin, the resolved model on every item, contract tests | camelCode review loop on a chiridion refactor, 8–16 children on forked computers; the same run twice, strong implementer against cheap, as the first role eval |
| 2. Repositories | 4 | `kind: "repo"` volumes, the repo object, layers, commit/merge/diff, the trigram index behind `grep`, import and push through the GitHub App, `layer` on `agent()` | The same loop with no computers for editing: 32 children on layers, commits of one file at a time, one push a phase |
| 3. Jobs | 3 | `job()`, snapshots on Cloudflare Containers and Boat, `camel-sync`, limits, outputs, `queue()`, sharded tests, `jobConcurrency` | A compile-error work queue on a Rust or TypeScript repository of ours, 64 fixers, 8 jobs |
| 4. Scale and Node | 3 | Phase collapse in the journal, 10,000 effects, `/stuck`, alerts, saved patterns, Node parity through the shared runner, docs | A full Bun-shaped run on a public repository, measured against the post's numbers |

### Open questions

1. **Replay cost at 10,000 effects.** The design assumes a step replays in well under 2 s CPU with phase collapse.
   Measure in phase 1 with synthetic journals before phase 4; the fallback is checkpointing the script's heap, which
   v8-exec does not do today.
2. **Child engine.** #696 is on hold. The workflow needs remote children either way; if Pi-owned children land, the
   `RemoteChild` task replaces the `agent_children` row for workflows too. Decide before phase 4, not before phase 1.
3. **Node parity.** camelRun is moving onto Workers and camelCode runs there. The runner is in `shared/` so Node can
   follow, but phases 1–3 are Workers only. Is a Node workflow needed for camel-bots before then?
4. **History.** v1 imports no git history and serves `log`/`blame` from GitHub. Is that enough for reviewers, or do
   they need `git log -p` on the file they review? If so, the import job keeps a shallow history of N commits.
5. **isomorphic-git in a Durable Object at Bun scale.** Pack building for a few hundred files is fine; a first push
   of a 1,500-file port is a 35 MB pack. Build it in a job if the object cannot.
6. **Job provider for the Bun class.** Cloudflare's 20 GB and 4 vCPU rule it out for a 100-crate Rust build. Boat is
   EU-only with FUSE-slow first minutes. Is a third provider (exe.dev standalone, measured as fast as fresh NVMe)
   worth a driver for jobs?
7. **Pricing of steps and the repo object.** Steps and searches are Durable Object time today, unbilled to tenants,
   as monitor checks are. Measure before deciding.
8. **Role defaults.** Which cheap model is the implementer class on day one, and what the eval's pass bar is
   (rounds to converge within 10% of the strong model's?). The 60/40 spend split above is an assumption to measure
   on dogfood 1.
9. **Layers for whole-tree refactors.** A refactor that touches 10,000 paths at once (the crate split) is one layer
   at the cap. Raise the cap, or run that phase as a job that commits through the object's bulk API?

### Non-goals

- A full git implementation in the runtime: interactive rebase, bisect, submodules, LFS, history rewriting. Jobs
  do those.
- A visual workflow builder, or a DSL. Workflows are JavaScript.
- Handoffs between agents, or long-lived agents per worker across workflows. A child is made for an effect.
- A general durable-execution service (Temporal). Effects are the six kinds above, and the runtime owns their
  semantics.
- Persistent machines per agent. A computer stays available for the agents that need one; a workflow's code work
  does not.
- Multi-repository workflows in v1. One `repo` per workflow; a second repository is a second workflow or a job.
