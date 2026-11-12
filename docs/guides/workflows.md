# Workflows

A **workflow** is a JavaScript script that runs many sub-agents, durably,
under a budget, and outlives the call that started it. The script says what
to do (`agent()`, `parallel()`); the runtime runs each sub-agent
exactly once, keeps every answer in a journal, and replays the script from the
top as answers land. You can pause it, change its script while it runs, raise
its budget, and resume it. A waiting workflow costs nothing.

Write a workflow when a task covers more than about 10 files, tables,
documents or sources, or is a port, migration, audit or research sweep: list
its units, give each to its own `agent()`, and keep the agent that owns the
workflow to planning, checking and reporting. When the units edit files, give
each `repo` (the volume) and `commit()` its fork. Run a single command with
`job_run`, not a workflow, and use [`delegate`](multi-agent.md) for a few
sub-agents whose answers you need in this turn. The `workflows` builtin tells
agents the same. An agent need not poll a workflow it started: a
`<workflow_notification>` tells it when the workflow finishes or stops.

Workflows run on Workers runtimes only, and are **enabled per account**: ask
us to turn them on. Until then every call answers 403 `WORKFLOWS_OFF`, and
agents get no `workflows` tools.

## The script

Plain JavaScript; its body runs as an async function, so `await` and `return`
work at the top level, and what it returns is the workflow's `result`. It has
no filesystem, network or imports of its own: an `agent()` does the fetching.
Its globals:

| Global | |
| --- | --- |
| `agent(prompt, opts)` | Starts a sub-agent and returns its answer. `opts`: `{ key?, type?, class?, output?, instructions?, label?, definition?, model? }`. With `output` (a JSON Schema) the answer is the validated object; without it, the text. A failed or aborted sub-agent returns `null` (the item records why), so `.filter(Boolean)` is the idiom |
| `parallel(fns)`, `parallel(items, fn)` | Runs the functions (or `fn` over each item) at once, up to the workflow's `concurrency`, and waits for all of them, even after one fails. **Every `agent()` inside it needs an explicit `key`** (the workflow faults with `key_required` otherwise): branches finish in any order, and keys are how results are matched to calls on replay |
| `agent(prompt, { repo })` | With `repo` (a volume id), the sub-agent gets its own copy of that volume at `/repo` (a fork: no bytes copied) and edits it with its file tools; it answers `{ text, fork }` (or the validated object with `fork` in it) |
| `commit(fork, opts)` | Puts a sub-agent's edits (`result.fork`) on the volume it was forked from, all files or none: `{ committed: true, seq, files, removed }`, or `{ committed: false, conflicts: [{ path, headVersion }] }` when the volume changed under any of them (nothing is written; the script decides what to do) |
| `job(opts)` | Runs one shell command in a container of its own: `{ command, timeoutSeconds, at?, files?, outputs?, limits?, internet?, key? }`. `at` (a volume id) starts it with that volume's files in its working directory; `outputs` names files it writes under `$JOB_OUT`. Answers `{ exitCode, timedOut, stdout, stderr, outputs, volume }`: each stream's end inline, and the whole streams and outputs kept in the workflow's own volume. Up to `jobConcurrency` (default 8) run at once. Paid by the agent that owns the workflow; a workflow started with an API key is paid by its account, and its usage shows under the workflow's id. A job the account's credit or monthly spend limit refuses pauses the workflow (`payer_exhausted`) until it is raised. Jobs run on the Cloudflare pilot only for now (`JOBS_UNAVAILABLE` elsewhere) |
| `push(opts)` | A job that writes a volume's files onto a GitHub branch: `{ volume, repo: "owner/name", branch, app, message?, key? }`, with your GitHub App's installation token, which neither the script nor any model sees. Answers `{ pushed, commit, exitCode, … }` |
| `gate(opts)` | A decision for a person, in the account's [inbox](human-input.md): `{ title (or question), body?, options? (2 to 4 labels), recommended?, reason?, priority?, expiresInSeconds? (7 days), onExpire?: "recommended" \| "pause", key? }`. The workflow waits, durably, and `gate()` returns what they chose (an option's label, or their own words); a decline returns `null`. Past its expiry it takes `recommended` when `onExpire` is `"recommended"`, else the workflow pauses (`waiting_on_gate`) and the item stays answerable: the answer lands and a resume goes on. Who may answer is as for the owning agent's own decisions (its `humanInput.approvers`); with no owning agent, anyone with the account's key. The agent that owns the workflow hears it open (event `gate_opened`) |
| `sleep(seconds)` | A journaled timer; the script is not running meanwhile |
| `phase(name)` | Names the stage the workflow is in (`phase` on its summary, items and log lines) |
| `log(...parts)` | A line in the workflow's log |
| `args` | What it was started with (`args` in the start), frozen |
| `now()`, `random()` | The step's clock and the workflow's seeded generator (`Date.now()` and `Math.random()` read the same) |
| `toBase64(value)`, `fromBase64(text, opts?)` | Base64 of any text (as UTF-8) or bytes, and back: text, or a `Uint8Array` with `{ as: "bytes" }`. `btoa`/`atob` take Latin-1 only. `TextEncoder` and `TextDecoder` (UTF-8) are there too |

A workflow's forks are deleted when it ends, once its commits have landed and no cached result (below) names them.

A script is compiled before it starts: a syntax error is refused as `script_error`, with
its line and column, and nothing runs.

A `key` names an effect across replays. Outside `parallel()` one may be left
out (the call gets a counted key, `agent#2`); inside, give one. The same key
with different arguments is a `key_conflict` fault, which ends the workflow.

The script must be a pure function of `args` and the journal: no raw clock,
no imports, no state kept outside it. Each **step** replays the script with
the results landed so far; a call whose `key` is in the journal returns its
stored answer, a new one starts an effect. The runner stops at the first call
it cannot answer yet.

```js
phase("port");
const ported = await parallel(args.files.map(file => () =>
  agent(`Port ${file} from Bun to Node. Keep behaviour identical.`, { key: `port:${file}`, type: "worker" })));

phase("review");
const findings = await parallel(args.files.map(file => () =>
  agent(`Review the port of ${file}. List problems.`, {
    key: `review:${file}`, type: "critic",
    output: { type: "object", properties: { problems: { type: "array", items: { type: "string" } } }, required: ["problems"] },
  })));

const bad = findings.filter(Boolean).flatMap(finding => finding.problems);
log(`${bad.length} problems in ${args.files.length} files`);

phase("report");
return agent(`Write the port report. Problems: ${JSON.stringify(bad)}`, { key: "report", type: "lead" });
```

## Agent types and model classes

`type` says what a sub-agent is allowed to do; `class` says how hard it thinks.
Neither is a job title: "porter", "auditor" and "planner" are instructions in
the prompt.

| Type | Does | Default class |
| --- | --- | --- |
| `worker` | One task from instructions; may write files | `fast` |
| `critic` | Finds problems in someone else's output, in a fresh context; `output` is required | `strong` |
| `lead` | Plans, judges and writes the final answer; may delegate | `strong` |

Classes are virtual models, `camelrun/fast`, `camelrun/strong` and
`camelrun/max`, resolved to real models at each call (see [Models and
keys](models-and-keys.md)): `fast` for bulk work, `strong` for judgment,
`max` for the strongest available. Pin a type for the whole workflow with
`classes: { worker: "strong" }` in the start; a single call's `class` wins over
that. A `critic` or `lead` on `fast` is refused unless the start says
`allowFastJudgment: true`.

## Budgets and pauses

`budget.usd` is a hard cap on what the workflow's sub-agents spend, enforced by
its ledger (`spent` on the summary; `costUsd` on each item). `null` is no cap.
A step that would start an effect past the cap stops the workflow with status
`budget_exhausted`. Raise the budget (`POST …/budget`) above what was spent
and it runs again by itself: the effects the cap refused are issued again,
under a new attempt.

A workflow that stops without ending is `paused`, and `pauseReason` says why:

| `pauseReason` | |
| --- | --- |
| `user` | You paused it. Running sub-agents finish unless the pause said `children: "abort"` |
| `payer_exhausted` | A sub-agent was refused for credit (the account's spend limit, a 402). That is not a failed effect the script would see as `null`: the effect is `refused`, and **resuming re-issues it under a new attempt**. It tries again by itself (after 5 minutes, doubling to 30), or resume it now |
| `waiting_on_gate` | A gate passed its expiry without an answer and without `onExpire: "recommended"`. It can still be answered in the inbox; resume after it is |
| `capacity_refused` | The account is at its running-workflows limit. It tries again by itself every minute |
| `journal_version` | Its journal was written by a newer runtime than the one that woke it (during a deploy). It goes on by itself |

`resume` runs the next step. `abort` ends it for good: its running sub-agents
stop and the journal stays readable.

When the script itself goes wrong (`key_required`, `key_conflict`,
`step_budget`, `stalled`, a thrown error), the workflow ends `failed`, with
`fault: { code, message }` on the summary; what was still running is stopped.

## Changing a workflow: start a new one

A workflow's script is not edited. To change one, abort it (or let it end) and
start a new one with the fixed script. Its `agent()` and `job()` calls whose
arguments match a result an earlier workflow of the same owner finished are
answered from that result, at no cost: no sub-agent or container runs. Such an
item has `origin: "cache"` and `cachedFrom` (`workflowId:key:attempt`), and the
summary's `counts.cached` counts them.

- The owner is the agent that started it (its `workflows` builtin), or the
  account for a workflow started with an API key; workflows of other owners
  never share results.
- Only results that finished (`done`) are reused: never a failed, refused or
  aborted one, and never a `commit()` or `push()` (they change a volume or a
  branch).
- `agent(prompt, { repo })` is reused only while the volume is still at the
  version the earlier sub-agent's fork started from; its answer has the same
  `fork`, which `commit()` lands as before.
- Pass `nocache: true` to an `agent()` or `job()` to run it again regardless.
- A result is kept for 7 days from the last time it was reused; an owner keeps
  at most 2,000 results and 64 MiB (the least recently used go first), and a
  result over 1 MiB is not kept.

## The API

```
POST /v1/workflows                       { script, args?, budget: { usd }, concurrency?, classes?, name?, allowFastJudgment? } -> 201
GET  /v1/workflows/{id}                  status, pauseReason?, phase?, step, budget, spent, counts, result?, error?, fault?
GET  /v1/workflows/{id}/items            ?after=&limit=&status=&phase=&kind=   -> { items, next? }
GET  /v1/workflows/{id}/events           ?after=&limit=                        -> { events }
POST /v1/workflows/{id}/pause            { children?: "abort" }
POST /v1/workflows/{id}/resume
POST /v1/workflows/{id}/abort
POST /v1/workflows/{id}/budget           { usd: number | null }
```

Start one with your API key. An `Idempotency-Key` header makes a retry the
same workflow (the key names it for your account).

```bash
curl -X POST $CAMELRUN_URL/v1/workflows \
  -H "Authorization: Bearer $CAMELAI_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: port-2026-11" \
  -d '{ "name": "port", "script": "...", "args": { "files": ["a.ts", "b.ts"] }, "budget": { "usd": 20 }, "concurrency": 8 }'
# { "id": "wf_…", "status": "running", "step": 1, "budget": { "usd": 20 }, "spent": { "usd": 0, … }, "counts": { "running": 2 }, … }

curl $CAMELRUN_URL/v1/workflows/wf_…/items?status=failed -H "Authorization: Bearer $CAMELAI_API_KEY"
```

`items` is the journal: one row per effect (`kind` `agent`, `gate` or
`timer`) with its `key`, `attempt`, `status` (`pending`, `running`, `done`,
`failed`, `refused`, `aborted`), `args`, `result`, `reason`, `costUsd` and
`model`, its `origin` (`script`, `reissue`, or `cache` with `cachedFrom`), in
the order they were issued; pass `next` back as `after`. `counts` on the
summary is the same by status, plus `cached`. `events` is what happened
(`created`, steps, pauses, `effect_cached`, the ending), by `seq`.

A bad request is 400 `INVALID_REQUEST` naming the field; a refusal of the
workflow's own (resuming one that ended) is 409
`WORKFLOW_CONFLICT`; another account's workflow is 404.

## In the SDKs

`agents.workflows` (`runtime.workflows` on the lower-level client) has the same
calls, and `wait` polls until the workflow settles: `completed`, `failed`,
`aborted`, `paused` or `budget_exhausted`.

```ts
const wf = await agents.workflows.start({ script, args: { files }, budget: { usd: 20 }, name: "port" }, { idempotencyKey: "port-2026-11" });
let done = await agents.workflows.wait(wf.id);
if (done.status === "budget_exhausted") {
  await agents.workflows.budget(wf.id, 40); // above what was spent: it runs again by itself
  done = await agents.workflows.wait(wf.id);
}
if (done.status === "failed") {
  // Fix the script and start again: the sub-agents that finished are not run (or paid for) again.
  const again = await agents.workflows.start({ script: script2, args: { files }, budget: { usd: 20 }, name: "port" });
  done = await agents.workflows.wait(again.id);
}
console.log(done.result);
```

```python
wf = await agents.workflows.start(script, args={"files": files}, budget_usd=20, name="port", idempotency_key="port-2026-11")
done = await agents.workflows.wait(wf["id"])
if done["status"] == "budget_exhausted":
    await agents.workflows.budget(wf["id"], 40)  # above what was spent: it runs again by itself
    done = await agents.workflows.wait(wf["id"])
if done["status"] == "failed":
    # Fix the script and start again: the sub-agents that finished are not run (or paid for) again.
    again = await agents.workflows.start(script2, args={"files": files}, budget_usd=20, name="port")
    done = await agents.workflows.wait(again["id"])
print(done["result"])
```

`wait` takes `timeoutMs` and `pollMs` (`timeout` and `poll` seconds in
Python; default no limit, every 2 s) and throws an `AgentError` with the latest
summary as `workflow` when the time passes. The synchronous Python client has
the same calls, not awaited.

## An agent writes and steers one

The main way a workflow starts is not a person writing a script: an agent is
given a task, decides it warrants many sub-agents, writes the workflow, and
steers it. Every agent with [`delegate` settings](multi-agent.md) on a runtime
with workflows enabled has the `workflows` builtin: `workflow_start`,
`workflow_status` (with a `waitSeconds`), `workflow_items`, `workflow_pause`, `workflow_resume`, `workflow_abort` and `workflow_budget`.
The agent that starts a workflow owns it: only its tools reach it. It need
not poll: when the workflow ends (`completed`, `failed`, `aborted`), stops
(`budget_exhausted`, or paused for its payer or capacity), finishes a phase or opens a `gate()` for a person (`gate_opened`,
with the gate's key, inbox item id, title and expiry), the agent gets a
message of its own, a turn, with a block only the runtime writes:

```
<workflow_notification workflow="wf_…" name="port" status="completed" event="completed">
{"workflowId":"wf_…","status":"completed","phase":"report","counts":{"done":41},"spentUsd":12.4,"budgetUsd":20,"result":…}
</workflow_notification>
```

Notifications take turns from the agent's wake budget, as its sub-agents'
notifications do. They never fill the agent's request queue: while the agent
is busy they wait in its own outbox, and the next one to land brings the
others with it, one block per workflow (that workflow's latest notice; an
earlier one it replaces is folded in), up to 20 workflows a turn. `workflow_status` and `workflow_items` read more when it
needs to. Its budget may
not exceed the least of the agent's remaining spend limit and `maxBudgetUsd`
(default $100); above that, a person starts it through the API.

```ts
const lead = await agents.upsert("port-lead", {
  systemPrompt: "You port codebases. For many files, write a workflow.",
  builtins: ["delegate"], delegate: { instructions: true }, workflows: { maxBudgetUsd: 50 },
});
```

`workflows: false` turns the builtin off for an agent that may delegate but
should not start workflows. Both settings go on the agent's configuration
(`upsert`, `createAgent`), set by whoever configures it, never by the agent.

## Running one command: `job_run`

When an agent only needs to run a command (a build, a test, a script), it does not need a workflow. On a runtime with
workflows and jobs (the Cloudflare pilot today), every agent has the `job_run` tool. It runs one shell command in a
fresh container and waits for it to finish, up to 15 minutes:

```
job_run({ command, timeoutSeconds? (300), at?: volumeId, files?: { path: text }, outputs?: [path], internet?: false })
-> { ok, exitCode, timedOut, stdout, stderr, outputs?, missing?, seconds }
```

- `at` starts the command with that volume's files in its working directory (a copy: changes are not saved back).
- `outputs` names files the command writes under `$JOB_OUT`, and returns them inline.
- `stdout` and `stderr` are each cut to their last 4,000 characters, and each output to its first 4,000.

The container time is metered as the agent's own computer time, against its spend limit. The tool's call id names the
job, so a replayed call runs nothing again and answers the same way. `workflow_start` tells an agent with `job_run` to
use it for a single command.
