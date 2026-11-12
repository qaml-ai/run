# Workflows

A **workflow** is a JavaScript script that runs many sub-agents, durably,
under a budget, and outlives the call that started it. The script says what
to do (`agent()`, `parallel()`); the runtime runs each sub-agent
exactly once, keeps every answer in a journal, and replays the script from the
top as answers land. You can pause it, change its script while it runs, raise
its budget, and resume it. A waiting workflow costs nothing.

Write a workflow when a task is many independent or repeated units of work
(per file, per table, per source), needs more than a few sub-agents at once,
must keep running after a turn ends, or needs a person's approval or a budget
along the way. Use [`delegate`](multi-agent.md) for a few sub-agents whose
answers you need in this turn.

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
| `job(opts)` | Runs one shell command in a container of its own: `{ command, timeoutSeconds, at?, files?, outputs?, limits?, internet?, key? }`. `at` (a volume id) starts it with that volume's files in its working directory; `outputs` names files it writes under `$JOB_OUT`. Answers `{ exitCode, timedOut, stdout, stderr, outputs, volume }`: each stream's end inline, and the whole streams and outputs kept in the workflow's own volume. Up to `jobConcurrency` (default 8) run at once. Paid by the agent that owns the workflow: a workflow started with an API key gets `null` (`job_payer_unavailable`). Jobs run on the Cloudflare pilot only for now (`JOBS_UNAVAILABLE` elsewhere) |
| `push(opts)` | A job that writes a volume's files onto a GitHub branch: `{ volume, repo: "owner/name", branch, app, message?, key? }`, with your GitHub App's installation token, which neither the script nor any model sees. Answers `{ pushed, commit, exitCode, … }` |
| `gate(opts)` | A decision for a person: `{ title, recommended?, expiresInSeconds? (7 days), onExpire?: "recommended" \| "pause", key? }`. Returns the answer when it comes. **Not available yet**: today a `gate()` fails at once (the script gets `null`, and its item says `gate() is not available yet`) |
| `sleep(seconds)` | A journaled timer; the script is not running meanwhile |
| `phase(name)` | Names the stage the workflow is in (`phase` on its summary, items and log lines) |
| `log(...parts)` | A line in the workflow's log |
| `args` | What it was started with (`args` in the start), frozen |
| `now()`, `random()` | The step's clock and the workflow's seeded generator (`Date.now()` and `Math.random()` read the same) |

A workflow's forks are deleted when it ends, once its commits have landed.

A `key` names an effect across replays. Outside `parallel()` one may be left
out (the call gets a counted key, `agent#2`); inside, give one. The same key
with different arguments is a `key_conflict` fault.

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
| `payer_exhausted` | A sub-agent was refused for credit (the account's spend limit, a 402). That is not a failed effect the script would see as `null`: the effect is `refused`, and **resume re-issues it under a new attempt** |
| `confirm_rerun` | An edit would re-issue more than `rerunConfirmPercent` of the finished effects. Resume to confirm, or edit again |
| `waiting_on_gate` | A gate passed its expiry without an answer |
| `capacity_refused` | The account is at its running-workflows limit |
| a fault code | The script itself went wrong: `key_required`, `key_conflict`, `step_budget`, a thrown error. `fault` on the summary has the message; edit the script and resume |

`resume` runs the next step. With `rerun: ["review:a.ts"]` it re-issues those
effects first, under a new attempt, which is how you redo work after an edit
without touching what was fine. `abort` ends it for good: its running
sub-agents stop and the journal stays readable.

## The API

```
POST /v1/workflows                       { script, args?, budget: { usd }, concurrency?, classes?, name?, allowFastJudgment? } -> 201
GET  /v1/workflows/{id}                  status, pauseReason?, phase?, revision, step, budget, spent, counts, result?, error?
GET  /v1/workflows/{id}/items            ?after=&limit=&status=&phase=&kind=   -> { items, next? }
GET  /v1/workflows/{id}/events           ?after=&limit=                        -> { events }
GET  /v1/workflows/{id}/diff             ?revision=                            -> { revision, reason?, kept, issued, unseen }
PUT  /v1/workflows/{id}/script           { script, reason, rerunConfirmPercent? } -> { revision, workflow }
POST /v1/workflows/{id}/pause            { children?: "abort" }
POST /v1/workflows/{id}/resume           { rerun?: [keys] }
POST /v1/workflows/{id}/abort
POST /v1/workflows/{id}/budget           { usd: number | null }
```

Start one with your API key. An `Idempotency-Key` header makes a retry the
same workflow (the key names it for your account).

```bash
curl -X POST $CAMELRUN_URL/v1/workflows \
  -H "Authorization: Bearer $CAMELAI_API_KEY" -H "Content-Type: application/json" -H "Idempotency-Key: port-2026-11" \
  -d '{ "name": "port", "script": "...", "args": { "files": ["a.ts", "b.ts"] }, "budget": { "usd": 20 }, "concurrency": 8 }'
# { "id": "wf_…", "status": "running", "revision": 1, "step": 1, "budget": { "usd": 20 }, "spent": { "usd": 0, … }, "counts": { "running": 2 }, … }

curl $CAMELRUN_URL/v1/workflows/wf_…/items?status=failed -H "Authorization: Bearer $CAMELAI_API_KEY"
```

`items` is the journal: one row per effect (`kind` `agent`, `gate` or
`timer`) with its `key`, `attempt`, `status` (`pending`, `running`, `done`,
`failed`, `refused`, `aborted`), `args`, `result`, `reason`, `costUsd` and
`model`, in the order they were issued; pass `next` back as `after`.
`counts` on the summary is the same by status. `events` is what happened
(`created`, steps, pauses, edits, the ending), by `seq`.

Edit the script while it runs: a new revision, replayed at the next step.
Effects whose keys and arguments are unchanged keep their results; new or
changed ones run. `reason` is kept with the revision, and `diff` shows what
the revision kept, issued and has not reached.

```bash
curl -X PUT $CAMELRUN_URL/v1/workflows/wf_…/script \
  -H "Authorization: Bearer $CAMELAI_API_KEY" -H "Content-Type: application/json" \
  -d '{ "script": "...", "reason": "critics accepted stubs; ask for a diff per finding" }'
curl -X POST $CAMELRUN_URL/v1/workflows/wf_…/resume -H "Authorization: Bearer $CAMELAI_API_KEY" \
  -H "Content-Type: application/json" -d '{ "rerun": ["review:a.ts"] }'
```

A bad request is 400 `INVALID_REQUEST` naming the field; a refusal of the
workflow's own (resuming one that ended, an edit that needs a confirm) is 409
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
const failed = await agents.workflows.items(wf.id, { status: "failed" });
await agents.workflows.edit(wf.id, { script: script2, reason: "critics accepted stubs" });
await agents.workflows.resume(wf.id, { rerun: failed.items.map(item => item.key) });
console.log((await agents.workflows.wait(wf.id)).result);
```

```python
wf = await agents.workflows.start(script, args={"files": files}, budget_usd=20, name="port", idempotency_key="port-2026-11")
done = await agents.workflows.wait(wf["id"])
if done["status"] == "budget_exhausted":
    await agents.workflows.budget(wf["id"], 40)  # above what was spent: it runs again by itself
    done = await agents.workflows.wait(wf["id"])
failed = await agents.workflows.items(wf["id"], status="failed")
await agents.workflows.edit(wf["id"], script2, reason="critics accepted stubs")
await agents.workflows.resume(wf["id"], rerun=[item["key"] for item in failed["items"]])
print((await agents.workflows.wait(wf["id"]))["result"])
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
`workflow_status` (with a `waitSeconds`), `workflow_items`, `workflow_edit`,
`workflow_pause`, `workflow_resume`, `workflow_abort` and `workflow_budget`.
The agent that starts a workflow owns it: only its tools reach it. It need
not poll: when the workflow ends (`completed`, `failed`, `aborted`), stops
(`budget_exhausted`, or paused for its payer, capacity, a fault or a rerun
confirm) or finishes a phase, the agent gets a message of its own, a turn,
with a block only the runtime writes:

```
<workflow_notification workflow="wf_…" name="port" status="completed" event="completed">
{"workflowId":"wf_…","status":"completed","phase":"report","counts":{"done":41},"spentUsd":12.4,"budgetUsd":20,"result":…}
</workflow_notification>
```

Notifications take turns from the agent's wake budget, as its sub-agents'
notifications do. `workflow_status` and `workflow_items` read more when it
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
