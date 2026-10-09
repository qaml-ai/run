# Multi-agent: sub-agents

The `delegate` built-in lets an agent hand a task to a **sub-agent** and get its
answer back as the call's result, while it keeps the conversation. This is the
OpenAI Agents SDK's `agent.as_tool()` and LangGraph's supervisor. The runtime
runs it, and it is durable: a sub-agent is an agent of its own, and a parent
whose node is lost while it waits collects the sub-agent's answer on another
node.

The `agents` built-in starts sub-agents in the **background** instead: the
model goes on at once, and each one's answer arrives as a message of its own
when it ends. See [Background sub-agents](#background-sub-agents).

camelRun has no handoffs: an agent cannot pass its conversation to another
agent. See [Coming from the OpenAI Agents SDK](#coming-from-the-openai-agents-sdk).

## Sub-agents: `delegate`

Give an agent the `delegate` builtin and say whom it may delegate to: its
`agents`, by definition key or id. The SDKs add the builtin when you pass the
settings.

```ts
await agents.runtime.upsertDefinition("researcher", {
  name: "Researcher", description: "Finds sources and summarizes them",
  systemPrompt: "You research a question and answer with sources.", builtins: ["web_search", "web_fetch"],
});

const lead = await agents.upsert("research-lead", {
  instructions: "You plan research and write the report. Delegate each question to the researcher.",
  delegate: { agents: ["researcher"] },
});
const run = await lead.run("Compare the three largest EV makers' 2025 margins.");
```

```python
await agents.runtime.upsert_definition("researcher", name="Researcher", description="Finds sources and summarizes them",
    systemPrompt="You research a question and answer with sources.", builtins=["web_search", "web_fetch"])

lead = await agents.upsert("research-lead",
    instructions="You plan research and write the report. Delegate each question to the researcher.",
    delegate={"agents": ["researcher"]})
run = await lead.run("Compare the three largest EV makers' 2025 margins.")
```

A definition takes the same settings, for every agent made from it:

```json
{ "name": "Research lead", "systemPrompt": "…", "builtins": ["delegate"], "delegate": { "agents": ["researcher", "writer"] } }
```

The model gets a `delegate` tool that lists the agents with what each is for
(the definition's `description`, unless the entry gives its own):

| Argument | |
| --- | --- |
| `agent` | Which agent, by its name in the list |
| `instructions` | Instead of `agent`, with `instructions: true` in the settings: a system prompt for a sub-agent the model designs itself, on its own model |
| `task` | What to do. The sub-agent sees only this, not the conversation |
| `output` | A JSON Schema for an object: the answer comes back in that shape (see [Structured output](structured-output.md)) |

The call's result is `{ agentId, requestId, status, text, output?, error? }`.
`status` is `completed`, `input_required` (the sub-agent waits on a person) or
`failed`. The model sees a failed or waiting sub-agent as a failed call, with
the reason.

### Who the sub-agent is

An entry in `agents` is one of these:

| Entry | The sub-agent |
| --- | --- |
| `"researcher"` or `{ definition: "researcher", name?, description? }` | A new agent made from the definition, for each call |
| `{ agent: "billing-specialist", name?, description? }` | Your existing agent with that key. It keeps its own history across calls. Runs queue, one at a time, like any of its runs |
| `instructions: true` (a setting, not an entry) | A new agent with the model's instructions, the parent's model, and the parent's `web_search` and `web_fetch` if it has them |

A sub-agent the runtime makes is a real agent:

- It is **linked to its parent**: `parentAgentId` and `parentRunId` in
  `GET /v1/agents/{id}` and the agent list, and in the metadata of its run.
- It **acts for whom the parent acts** (`subject`, `context`) and uses the
  parent's key scope. It is billed to the same account. Its tool servers'
  [identity tokens](tools.md) also name its parent and its chain's first agent
  (`par` and `root`; `identity.parentAgentId` and `rootAgentId` in the SDKs).
- It has its **own workspace**. Pass it what it needs in the task, or mount a
  shared [volume](files.md#volumes) in both definitions.
- It **lives a day**, as a scratch agent does. Read its history in the meantime
  with its id, from `run.toolCalls`:

```ts
const call = run.toolCalls.find(call => call.tool === "delegate");
const child = await agents.get(call.agentId!);
console.log(await child.history());
```

### Parallel sub-agents

The model may call `delegate` several times in one response. The calls run at
once, up to `maxParallel` (default 4) per run; the rest wait their turn. This is
map-reduce: one call per item, and the model combines the answers.

```ts
delegate: { agents: ["researcher"], maxParallel: 8 }
```

### Limits

Sub-agents are agents, so everything that bounds agents bounds them, and the
parent's limits cover them:

| Limit | |
| --- | --- |
| Depth | A sub-agent's sub-agents count. Delegation stops at `maxDepth` (default 2: a parent, its children and theirs; at most 5). Past it, the call fails and the model does the work itself. Only the runtime places a run in a chain: its child runs' `delegation*` metadata is signed (`delegationSignature`), and a prompt of yours that sends those keys starts a chain of its own |
| Fan-out | `maxParallel` calls in flight per run (default 4, at most 16) |
| Busy agents | A running sub-agent takes one of your account's busy slots. At the limit, the call fails with `BUSY_AGENT_LIMIT` |
| Spend | Your account's spend limits apply to sub-agents too. A parent's own spend limits (the agent's, and the run's `spendLimit`) bound its sub-agents: each gets what the parent has left as its run's spend limit (shared evenly among sub-agents running at once), and what it spent counts against the parent's. `run.usage.subagentCostUsd` says how much that was |
| Run rate and run limits | A sub-agent's run counts against your account's run rate. Its definition's `runLimits` apply to it |

Parallel sub-agents split what the parent has left: each holds its share until
it ends, and a later call gets an even share of what no running sub-agent
holds. So together they stay within the parent's limit, but for the one
response each may finish past its own.

An agent cannot delegate to an agent already working on its chain (it would
wait on itself), and an agent's own key cannot change any of these settings.
The model calls `delegate` directly, never from `js_exec`.

### Cancelling

Aborting the parent's run (`agent.abort()`, `POST /v1/agents/{id}/abort`)
aborts the sub-agents it is waiting on (and cancels the parent's queued runs). So does deleting the parent. A named
agent is aborted only while it runs the parent's task, never another.

### When a node is lost

A sub-agent is keyed by the parent's tool call, and its run by the call too. If
the parent's node is lost while it waits, the parent's run resumes on another
node and makes the call again. That call finds the same sub-agent and run, and
waits for its answer; the task never runs twice. The sub-agent, if its own node
was lost, resumes like any agent.

### Watching sub-agents

A sub-agent's progress can appear on its parent's event stream. Ask for it:
`subagents: true` in the SDKs, or `?subagents=1` on the events URL. Without it
you get none of these events.

| Event | |
| --- | --- |
| `subagent_start` | `{ toolCallId, agentId, requestId, name, depth }`: the call started its sub-agent |
| `subagent_event` | `{ toolCallId, agentId, event }`: one of the sub-agent's events (its streamed text left out). A grandchild's events arrive nested in its parent's |
| `subagent_end` | `{ toolCallId, agentId, requestId, status, error? }` |

```ts
const lead = await agents.upsert("research-lead", { delegate: { agents: ["researcher"] }, subagents: true });
for await (const part of lead.stream("…")) {
  if (part.type === "subagent_start") console.log(`→ ${part.name} (${part.agentId})`);
  if (part.type === "subagent_end") console.log(`← ${part.agentId}: ${part.status}`);
}
```

In a browser, the watcher (`@camelai/run/watch`, with `subagents: true`) folds
them into `state.subagents`, by delegate call, and a chat made with
`watch: { subagents: true }` shows each sub-agent as a collapsible transcript
under its call in `<AgentChat>` (`part.subagent` for a tool renderer of your own).
A browser token that lists its `events` needs these types listed too.

A sub-agent's events are relayed while it runs on the same node as its parent,
which it does unless a node was lost; its own stream and history always have
everything.

## Background sub-agents

The `agents` builtin gives the model five tools, with the same `delegate`
settings (whom it may start, `maxDepth`, `maxParallel`). The builtin needs them,
as `delegate` does; an agent may have both builtins.

```ts
const lead = await agents.upsert("research-lead", {
  instructions: "Start a researcher for each question, and write the report as their answers come in.",
  builtins: ["agents"], delegate: { agents: ["researcher"], maxParallel: 8 },
});
```

| Tool | |
| --- | --- |
| `spawn_agent({ agent \| instructions, task, output?, name? })` | Starts a sub-agent, as `delegate` would, and returns `{ agentId, name }` at once. `name` is the model's handle for it, unique among its running sub-agents (default: the agent's name and a number, `researcher-1`) |
| `wait_agent({ agents?, timeoutMs? })` | Waits until one of the given sub-agents (names or ids; default: any running one) ends, or `timeoutMs` passes (default 5 minutes, at most 10). Returns each one's `status`, with the answer (`text`, `output?`, `error?`) of those that ended |
| `list_agents()` | The agent's sub-agents: `{ agentId, name, status, startedAt, endedAt? }`, `status` being `running`, `completed`, `failed`, `aborted` or `input_required` |
| `send_message({ to, text })` | Messages one of its sub-agents (name or id) or, from a sub-agent, its parent (`"parent"`). See [Messages](#messages) |
| `interrupt_agent({ agent })` | Aborts one of its running sub-agents; its notification follows with status `aborted` |

The sub-agent is the same as a delegated one: the same targets, chain and
depth limit, identity and key scope, and it lives a day. It gets what its parent
agent may still spend (its `spendLimit`) as its own run's limit. A stateless run
(`POST /v1/runs`) cannot start one: nothing would hear it end.

### Notifications

When a sub-agent's run ends (completed, failed, aborted, or waiting on a
person), the runtime sends its parent a prompt with request id
`child_<the child's request id>`. It queues behind the parent's running turn,
or starts a turn if the parent is idle. Its message is a user message with a
source of its own, in history, events and exports:

```json
{ "role": "user", "content": [{ "type": "text", "text": "Found 3 sources: …" }],
  "source": { "kind": "agent", "agentId": "client_…", "name": "researcher-1" }, "requestId": "child_spawn_…",
  "metadata": { "agentId": "client_…", "name": "researcher-1", "status": "completed", "output": { … }, "usage": { … } } }
```

The model reads it in a block only the runtime writes, never as the person:

```text
<agent_notification name="researcher-1" status="completed">
Found 3 sources: …
</agent_notification>
```

The sub-agent's text cannot close the block or open another: such tags in it
(and in any user message or tool result) are neutralized, as sender blocks are.
UIs should render a message with `source` as a notification, not as the user.

A sub-agent whose ending a `wait_agent` call answered adds no notification:
one already on its way ends without its message (`result.skipped`).
A parent waiting on a person (an approval, `ask_user`) gets its notifications
once they answer: a new message would supersede what it asked.

A sub-agent that waits on a person notifies with status `input_required`, and
`metadata.inputs` lists what it asked. Answer its inputs as any agent's
(`POST /v1/agents/{child}/inputs/{id}`, or a browser token with the `children`
scope reads them); it resumes, and its next ending notifies again.

### Messages

`send_message` goes between an agent and its own sub-agents and parent, no one
else:

- **Parent to sub-agent:** the text joins the sub-agent's running turn, or
  starts a turn that keeps its history. A sub-agent that had finished works
  again, and its answer comes back as a new notification. The sub-agent reads
  `<agent_message name="parent">…</agent_message>`.
- **Sub-agent to parent:** `to: "parent"`, which the runtime resolves through
  the run's signed chain. It reaches the parent as a notification does, without
  the sub-agent's turn ending, as `<agent_message name="researcher-1">…`, with
  `source` and `metadata.kind: "message"`. The parent's stream has
  `subagent_message` (`{ agentId, name, text }`). A sub-agent the runtime made has
  `send_message` even without the builtin.

A turn sends at most 20 messages, and the turns messages start count against
the wake cap below, so two agents messaging each other stop.

### Stopping sub-agents

- `interrupt_agent`, or `POST /v1/agents/{child}/abort` for one sub-agent: its
  turn is aborted, and its parent's notification says `aborted`.
- Aborting the parent (`agent.abort()`, `POST /v1/agents/{id}/abort`) aborts its
  running sub-agents too. `{ "children": "keep" }` (`abort({ children: "keep" })`)
  leaves them running.
- Deleting the parent aborts its running sub-agents and deletes the ones the
  runtime made. Named agents it started (`{ agent: "…" }` targets) stay.

### Exactly once

Each sub-agent has a row in `agent_children`, written before its prompt is sent
and keyed by the `spawn_agent` call, so a turn resumed on another node finds
the same sub-agent and never starts a second. Its ending is delivered by the node
that ran it, as the run ends, and otherwise by a sweep on any node (every
`AGENT_CHILD_SWEEP_MS`, default 15 s). Every delivery sends the same request,
which the parent takes once, so a node lost on the way (the sub-agent's, the
parent's, or both) delays the notification by a sweep and never repeats it.

### Cost and loop guards

- What the sub-agent spent is charged to the parent's spend limit when its
  notification lands (or its `wait_agent` answers it), and shows in that run's
  `usage.subagentCostUsd`.
- Spend limits apply to the turns notifications start. A parent at its limit
  gets the notification in history, without a turn: the run ends with
  `stopped: "spend_limit"`.
- Notifications and messages may start at most `AGENT_WAKES_PER_HOUR` turns
  (default 100) per chain of agents (counted by its first agent) and clock hour,
  so agents that keep starting each other stop. Past it, a notification or
  message lands in history without a turn, and its run ends with
  `stopped: "agent_loop_limit"`, naming the limit. Send the agent a message to
  go on. A refusal is recorded before the message lands, so a node lost then
  never lets the turn run on another.
- At most `maxParallel` sub-agents run at once per parent; past it,
  `spawn_agent` fails and the model waits for one.

### Events

With `?subagents=1` (`subagents: true` in the SDKs), the parent's stream has
`subagent_start` (with `background: true`) when a sub-agent starts,
`subagent_event` with its events while it runs on the parent's node, and
`subagent_end` (with `background: true`, `name` and `status`) when its
notification lands or a `wait_agent` answers it, and `subagent_message` when it
messages its parent. Its own stream and history always have everything.

A browser token minted with the `children` scope (with the others it needs:
`{ "scopes": ["events", "history", "children"] }`) reads the agent's sub-agents
too, by their ids, as it reads the agent: a chat can reload a sub-agent's
transcript with its parent's token.

## Coming from the OpenAI Agents SDK

| OpenAI Agents SDK | camelRun |
| --- | --- |
| `agent.as_tool(tool_name, tool_description)` | `delegate: { agents: [{ name, definition, description }] }` |
| Agents as tools in parallel (`asyncio.gather` in a tool) | Several `delegate` calls in one response run at once (`maxParallel`) |
| `handoffs=[…]`, `handoff()` | Not supported: there are no handoffs. Delegate to the specialist instead: the conversation stays with the first agent, which relays the answer. Or route in your code, running the agent the message is for (see [Migrating](migrating.md#handoffs-and-multi-agent)) |
| `max_turns` | The run's `runLimits`, and `delegate.maxDepth` for chains of agents |

## Coming from LangGraph

| LangGraph | camelRun |
| --- | --- |
| Supervisor (`create_supervisor`, or a supervisor node routing to workers) | A lead agent with `delegate: { agents: [...] }`: the model routes, workers answer as tool results |
| Subgraphs (a compiled graph as a node) | A definition per subgraph, delegated to. Its history is its own agent's |
| `Send` (map-reduce over items) | Parallel `delegate` calls, one per item |
| Swarm (`create_swarm`), `Command(goto=…)` | Not supported: there are no handoffs. Use a supervisor (`delegate`) instead |
| Shared state between nodes | The task text, and a shared [volume](files.md#volumes) |
| `recursion_limit` | `delegate.maxDepth` and the run's `runLimits` |
| Checkpointed subgraph state | Each sub-agent's own history, read by its id (`run.toolCalls[i].agentId`) |
