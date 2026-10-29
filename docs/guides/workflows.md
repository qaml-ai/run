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
| `maxAgents` | The most `agent()` calls one workflow may make: 32 by default, up to 120. The ceiling is a hard stop, not a warning. |
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
| `subagent_start`, `subagent_end` | one per `agent()` call, as for `delegate` (the `name` is the target's name) |
| `workflow_end` | `{ toolCallId, status, agents, error? }`: the script ended |

The children's own streams and histories always have everything; these are the
parent's view.

## Limits

| | |
| --- | --- |
| `agent()` calls per workflow | 32 by default, at most 120 (`maxAgents`) |
| Agent calls in flight | 4 by default, at most 16 (`maxParallel`); the rest queue inside the script |
| Items per `parallel()` / `pipeline()` | 512 |
| A script | 32,000 characters; its `args` 64 KB; its return value 64 KB |
| A task (one `agent()` prompt) | 24,000 characters; an answer is cut at 24,000 bytes with a marker |
| `phase()` calls / `log()` lines | 64 / 100 (500 characters each) |
| Answer size | text is cut at 24,000 bytes with a marker; a JSON answer over 24,000 bytes fails the workflow |
| Top-level workflows running at once per node / per tenant | 4 / 2; the rest wait for a sandbox slot |
| Deadline | 10 minutes, then the sandbox is killed |
| Depth | counted with `delegate`'s `maxDepth` (2 by default) |

## Where the script runs

The script runs in the runtime's sandbox — the same `v8-exec` isolate `js_exec`
uses: a bare V8 with no Node globals, no filesystem, no network, and no module
loader. It is killed at its deadline or when the run stops, so a loop in a script
cannot hold the node. What a script can do is what its `agent()` calls can do, and
nothing more; `import()` is refused before it starts.

A workflow holds a sandbox for minutes rather than seconds, so the node admits a
few top-level workflows at once (4 per node, 2 per tenant); the rest wait for a slot.
Nested workflows do not take another slot, to avoid waiting on the slot their
parent holds. They remain bounded by the node's agent capacity, the tenant's
busy-agent limit, chain depth and spend limits. Each workflow has a 10-minute
deadline and a 24 MB transfer budget; CPU, tool-call and per-message limits are
`js_exec`'s.

## Running a workflow without the model

This release is the model's tool: the agent writes the script and calls
`run_workflow`. Running a fixed script from your code — a `workflow` request
method, `POST /v1/agents/{id}/workflow`, and `agent.workflow(script)` in the
SDKs — is a follow-up. Until it lands, drive one from code with a prompt, or keep
the script in a prompt the agent calls verbatim.

## Notes

- Named targets (`{ agent: "key" }`) are real agents with their own queue: two
  calls to one in the same script run one after the other, so a fan-out over one
  named agent is sequential. Definition targets make a new child per call and are
  the parallel choice.
- When a script returns, fails or reaches its deadline, it stops any children it
  left running. When a node drains or loses ownership, those children stay running
  for the next owner to collect. An explicit user abort stops the workflow and its
  children.
- `maxAgents` bounds one `run_workflow` call, not an entire subtree. A child whose
  definition enables `workflow` can start another workflow within the chain's depth,
  spend and busy-agent limits. There is no signed subtree agent budget.
