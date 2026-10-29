# Workflows: a script that runs the plan

A **workflow** is a JavaScript script an agent runs to coordinate many sub-agents at
once. One tool call (`run_workflow`) carries the whole plan, the agents' answers stay
in the script's variables, and only the script's return value comes back to the
model. It is for work one conversation cannot coordinate turn by turn: a sweep over
every route handler, a migration across hundreds of files, a question checked against
several independent sources.

This is Claude Code's *dynamic workflows* idea, built on the same sub-agents the
[`delegate` builtin](multi-agent.md) starts: a workflow's `agent()` calls make real
child agents, with the same limits, links, budget and events.

## Turn it on

Give the agent the `workflow` builtin and say whom its scripts may coordinate:

```ts
const lead = await agents.upsert("migration-lead", {
  instructions: "You plan migrations. Write a workflow when the work is a sweep.",
  workflow: { agents: ["worker"], maxAgents: 40, maxParallel: 6 },
});
```

```python
lead = await agents.upsert("migration-lead",
    instructions="You plan migrations. Write a workflow when the work is a sweep.",
    workflow={"agents": ["worker"], "maxAgents": 40, "maxParallel": 6})
```

The settings bring the builtin with them (the SDKs add it), as `delegate` does; in
REST, send both:

```http
POST /v1/agents
{ "builtins": ["workflow"], "workflow": { "agents": ["worker"] } }
```

A definition takes the same pair, for every agent made from it:

```json
{ "name": "Migration lead", "systemPrompt": "…", "builtins": ["workflow"],
  "workflow": { "agents": ["worker", "reviewer"] } }
```

| Setting | |
| --- | --- |
| `agents` | Who a script may coordinate: definition keys or ids (a new child agent for each `agent()` call), or `{ agent: "key" }` for an existing agent that keeps its history. Up to 32. |
| `instructions` | `true`: the script may start a child with instructions of its own instead, on its own model (the runner-up to naming an agent). |
| `maxAgents` | The most `agent()` calls one workflow may make: 32 by default, up to 256. The ceiling is a hard stop, not a warning. |
| `maxParallel` | Agent calls in flight at once: 4 by default, up to 16. The rest wait their turn. |
| `maxDepth` | How deep a chain of agents may go, counted with `delegate`'s: 2 by default, 1–5. |

## What the model writes

The tool takes a `script` (and optional `args`). The script is plain JavaScript with
top-level `await`:

```js
export const meta = { name: "audit-routes", description: "Audit every route for missing auth" }

phase("discover")
const found = await agent("List every .ts file under src/routes/.", {
  agent: "worker",
  label: "list",
  schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
})

phase("audit")
const audits = await pipeline(found.files, file =>
  agent(`Audit ${file} for missing authentication checks. Reply with the issue, or "fine".`, { agent: "worker", label: file }),
)

phase("report")
const report = await agent(`Group these findings by severity:\n${audits.join("\n")}`, { agent: "reviewer", label: "report" })
return { files: found.files.length, report }
```

| API | |
| --- | --- |
| `await agent(prompt, { agent?, label?, phase?, schema? })` | One sub-agent. Resolves to its text, or with `schema` (a JSON Schema for an object) its validated object. Resolves to `null` if it failed, was stopped, or is not one of the agents the settings allow. |
| `await parallel([...])` | A barrier over `agent()` calls started at once; a failed call is `null` in its place. |
| `await pipeline(items, ...stages)` | Each item through the stages, items running together. A stage that returns `null` or `undefined` ends that item (kept as `null`), so `filter(Boolean)` drops them. |
| `phase(title)` | Groups the agents after it under a title in progress events. |
| `log(message)` | A progress line, in the stream's `workflow_progress` events. |
| `args` | What the call passed as `args`. |
| `export const meta = { name, description }` | Free-form metadata for the script; the runtime does not use it. |

Each agent sees only the prompt it is given — never the parent's conversation — so
put in it everything the child needs. Only the script's return value comes back to
the model: return a summary or the fields it needs, not everything every agent said.

`schema` shapes one child's answer exactly as a
[structured output](structured-output.md) prompt does, validated before the call
returns; a schema failure makes that call `null` rather than failing the workflow.

## The tool's result

```json
{
  "status": "completed",
  "agents": [
    { "index": 0, "label": "list", "agent": "worker", "status": "completed" },
    { "index": 1, "label": "src/routes/a.ts", "agent": "worker", "status": "failed", "error": "…" }
  ],
  "value": { "files": 12, "report": "…" }
}
```

A script that throws, runs past its deadline (10 minutes), asks past `maxAgents`, or
is stopped answers `status: "failed"` (or `"canceled"`) with an `error`, and the call
is an error result. A child that fails is `null` to the script instead, so a script
can decide what a partial failure means.

## Who the children are

Every `agent()` call makes a child agent, as a `delegate` call does:

- **linked to its parent**: `parentAgentId` and `parentRunId` on the agent and in its
  run's metadata, one step down the delegation chain (`delegationDepth`).
- **acting for whom the parent acts** (`subject`, `context`), with its key scope, and
  billed to the same account.
- **bounded by the parent's budget**: parallel children share what the run has left,
  and what they spend counts against the parent's limit (`run.usage.subagentCostUsd`).
- **taken from the tenant's busy slots** like any agent, and its own definition's
  `runLimits` apply.
- **a day long**, as a scratch agent is: read its history meanwhile with its id from
  `run.toolCalls`… or from the workflow's `agents` list, which names each call.

A script cannot coordinate an agent already working on its chain (it would wait on
itself), and a workflow's children may not go past `maxDepth` — counted together with
`delegate`'s, so a workflow started by a delegated agent is one chain.

### A script's clock and dice

`Date.now()` is fixed at the time the request started and `Math.random()` is seeded
from the run, so a script replayed on another node asks exactly the same questions
and finds the children it already made instead of starting new ones. `new Date()` and
`performance.now()` are not frozen — keep them out of prompts, or pass the time in
`args`.

## Crash safety

Each child is keyed by the workflow call and by what it was asked (a hash of the
prompt, agent, instructions and schema, plus how many times that ask came up). If the node running a workflow is lost, the turn resumes on another node,
runs the script again from the top, and every `agent()` call finds the child it
already made and waits for — or collects — its answer. Agent work is never done
twice. The script's `Date.now()` and `Math.random()` are fixed for its run, so a replay asks
the same questions (see above); anything else it reads from the outside is not.

## Watching a workflow

Ask for a run's children's events and the workflow's own arrive with them —
`?subagents=1` in the API, `subagents: true` in the SDKs:

| Event | |
| --- | --- |
| `workflow_start` | `{ toolCallId }`: the script began |
| `workflow_progress` | `{ toolCallId, phase? , log? }`: a phase began, or a log line |
| `subagent_start`, `subagent_end` | one per `agent()` call, as for `delegate` (the `name` is the call's `label`) |
| `workflow_end` | `{ toolCallId, status, agents, ms, error? }`: the script ended |

The children's own streams and histories always have everything; these are the
parent's view.

## Limits

| | |
| --- | --- |
| `agent()` calls per workflow | 32 by default, at most 120 (`maxAgents`) |
| Agent calls in flight | 4 by default, at most 16 (`maxParallel`); the rest queue inside the script |
| Items per `parallel()` / `pipeline()` | 512 |
| A script | 32,000 characters; its `args` 64 KB; its return value 64 KB |
| A task (one `agent()` prompt) | 24,000 characters; an answer is cut at 24,000 characters with a marker |
| `phase()` calls / `log()` lines | 64 / 100 (500 characters each) |
| Answer size | text is cut at 24,000 characters with a marker; a JSON answer over 24,000 bytes answers `null` |
| Workflows running at once per node / per tenant | 4 / 2; the rest wait for a sandbox slot |
| Deadline | 10 minutes, then the sandbox is killed |
| Depth | counted with `delegate`'s `maxDepth` (2 by default) |

## Where the script runs

The script runs in the runtime's sandbox — the same `v8-exec` isolate `js_exec`
uses: a bare V8 with no Node globals, no filesystem, no network, and no module
loader. It is killed at its deadline or when the run stops, so a loop in a script
cannot hold the node. What a script can do is what its `agent()` calls can do, and
nothing more; `import()` is refused before it starts.

A workflow holds a sandbox for minutes rather than seconds, so the node admits a
few at once (4 by default, 2 per tenant); the rest wait for a slot. Everything else
the sandbox enforces — CPU, tool calls, argument and transfer sizes — is `js_exec`'s,
and is what a workflow's own caps stay inside.

## Running a workflow without the model

This release is the model's tool: the agent writes the script and calls
`run_workflow`. Running a fixed script from your code — a `workflow` request
method, `POST /v1/agents/{id}/workflow`, and `agent.workflow(script)` in the
SDKs — is a follow-up. Until it lands, drive one from code with a prompt, or keep
the script in a prompt the agent calls verbatim.

## Where the script runs

The script runs in the runtime's sandbox — the same `v8-exec` isolate `js_exec`
uses: a bare V8 with no Node globals, no filesystem, no network, and no module
loader. It is killed at its deadline or when the run stops, so a loop in a script
cannot hold the node. What a script can do is what its `agent()` calls can do, and
nothing more; `import()` is refused before it starts.

A workflow holds a sandbox for minutes rather than seconds, so the node admits a
few at once (4 by default, 2 per tenant); the rest wait for a slot. Everything else
the sandbox enforces — CPU, tool calls, argument and transfer sizes — is `js_exec`'s,
and is what a workflow's own caps stay inside.

## Running a workflow yourself

An application can run a script without a model turn: the same tool the model
would call, on demand.

```ts
const run = await agent.workflow(`
  const [a, b] = await parallel([
    agent("Summarize src/auth.ts", { agent: "worker" }),
    agent("Summarize src/billing.ts", { agent: "worker" }),
  ])
  return { a, b }
`, { args: { ticket: "ENG-42" }, spendLimit: { usd: 0.50 } })

if (run.status !== "completed") console.error(run.error, run.agents)
console.log(run.value)
```

```python
run = await agent.workflow("""
  files = await agent("List the .ts files under src/", agent="worker",
                      schema={"type": "object", "required": ["files"], "properties": {"files": {"type": "array", "items": {"type": "string"}}}})
  return await parallel([agent(f"Check {f}", agent="worker") for f in files["files"]])
""", spend_limit={"usd": 0.5}, args={"ticket": "ENG-42"})
if run["status"] != "completed":
    print(run["error"], run["agents"])
```

```http
POST /v1/agents/{id}/workflow
Idempotency-Key: 8a1f…
{ "script": "return await agent('hi', { agent: 'worker' })", "args": { "ticket": "ENG-42" },
  "spendLimit": { "usd": 0.5 } }
```

`run` is `{ status, agents, value, error? }`, plus `code: "aborted"` if the run was
stopped. It is the run's outcome (`GET /v1/agents/{id}/requests/{requestId}`): the
request settles when the script does, and its children are that run's sub-agents
(`run.toolCalls`, `usage.subagentCostUsd`). The agent needs the `workflow` builtin
and its settings, exactly as when its model calls the tool.

`spendLimit` bounds the run and is shared by the children the script starts.
Idempotency is the request's: the same id runs the script once.

In the SDKs: `agent.workflow(script, options)` in TypeScript and Python, the
low-level `agent.request("workflow", { script, args })` on an agent client, and
`POST /v1/agents/{id}/workflow` in REST.

## Notes

- Named targets (`{ agent: "key" }`) are real agents with their own queue: two
  calls to one in the same script run one after the other, so a fan-out over one
  named agent is sequential. Definition targets make a new child per call and are
  the parallel choice.
- A workflow that stops names each child's request when it aborts it, so it cannot
  stop another caller's turn or cancel another caller's suspended questions on a
  shared named agent.
- `maxAgents` bounds one `run_workflow` call, and every workflow call is also
  bounded by the chain's signed agent budget: a run starts with 120 agent calls for
  its whole subtree, a workflow takes `min(maxAgents, budget)` of them, and each
  child inherits an even share of the rest. A definition that also enables `workflow`
  therefore cannot fan out past the chain's budget, and `delegate` passes the share on.
- A workflow a child agent starts does not take a second sandbox slot (its parent
  already holds one, and waiting on the gate it holds would deadlock). What bounds
  it is the number of agents a node may run and that same chain budget.
