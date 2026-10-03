# Multi-agent: sub-agents and handoffs

Two built-in tools let agents work together, and the runtime runs both:

- **`delegate`**: the agent hands a task to a **sub-agent** and gets its answer
  back as the call's result, while it keeps the conversation. This is the
  OpenAI Agents SDK's `agent.as_tool()` and LangGraph's supervisor.
- **`handoff`**: the agent hands the **conversation** to another definition. The
  same agent goes on with the same history, under that definition's
  instructions, model and tools. This is the OpenAI Agents SDK's `handoffs`.

Both are durable. A sub-agent is an agent of its own, and a parent whose node is
lost while it waits collects the sub-agent's answer on another node. A handoff
is written to the agent before it takes effect, so it holds through restarts.

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
  parent's key scope. It is billed to the same account.
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
| Depth | A sub-agent's sub-agents count. Delegation stops at `maxDepth` (default 2: a parent, its children and theirs; at most 5). Past it, the call fails and the model does the work itself |
| Fan-out | `maxParallel` calls in flight per run (default 4, at most 16) |
| Busy agents | A running sub-agent takes one of your account's busy slots. At the limit, the call fails with `BUSY_AGENT_LIMIT` |
| Spend | Your account's spend limits apply to sub-agents too. A parent's own spend limits (the agent's, and the run's `spendLimit`) bound its sub-agents: each gets what the parent has left as its run's spend limit, and what it spent counts against the parent's. `run.usage.subagentCostUsd` says how much that was |
| Run rate and run limits | A sub-agent's run counts against your account's run rate. Its definition's `runLimits` apply to it |

Parallel sub-agents each start with what the parent has left, so together they
can pass the parent's limit by at most one sub-agent's spend each.

An agent cannot delegate to an agent already working on its chain (it would
wait on itself), and an agent's own key cannot change any of these settings.

### Cancelling

Aborting the parent's run (`agent.abort()`, `POST /v1/agents/{id}/abort`)
aborts the sub-agents it is waiting on. So does deleting the parent. A named
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

## Handoffs: `handoff`

Give a definition the `handoff` builtin and the definitions it may hand the
conversation to. A triage agent hands a refund to billing:

```ts
await agents.runtime.upsertDefinition("billing", {
  name: "Billing", description: "Refunds, invoices and charges",
  systemPrompt: "You are the billing agent. You can issue refunds.",
  mcpServers: [{ name: "payments", url: "https://payments.example.com/mcp", auth: { type: "runtime" } }],
});
const triage = await agents.runtime.upsertDefinition("triage", {
  name: "Triage", systemPrompt: "You help customers. Hand billing questions to billing.",
  handoff: { definitions: ["billing"] },
});

const agent = await agents.upsert(`support-${userId}`, { definition: triage.id });
const run = await agent.run("I was charged twice for order 42.");
run.handoffs; // [{ from: "Triage", to: "billing", definition: "def_…", toolCallId: "…" }]
run.text;     // billing's answer
```

```python
await agents.runtime.upsert_definition("billing", name="Billing", description="Refunds, invoices and charges",
    systemPrompt="You are the billing agent. You can issue refunds.")
triage = await agents.runtime.upsert_definition("triage", name="Triage",
    systemPrompt="You help customers. Hand billing questions to billing.", handoff={"definitions": ["billing"]})

agent = await agents.upsert(f"support-{user_id}", definition=triage["id"])
run = await agent.run("I was charged twice for order 42.")
run.handoffs  # [{"from": "Triage", "to": "billing", ...}]
```

The model gets a `handoff` tool with `to` (one of the definitions, by name) and
an optional `reason`. When it calls it:

1. The runtime records the handoff on the agent: from now on, its configuration
   is the target definition's: system prompt, model, thinking level, tools
   (builtins, MCP servers, OpenAPI sources) and run limits. The tools your
   application serves the agent stay, as does `systemPromptAppend`.
2. From the next model request, in the same run, the target definition answers,
   and sees the whole conversation. Nothing is summarized or filtered.
3. The history keeps the `handoff` call, with `{ from, to, definition, reason }`
   in its result's details. The stream has a `handoff` event, and the run's
   result its `handoffs`.

The conversation stays with the target in later runs, until it hands off again.
`GET /v1/agents/{id}` shows where it is: `handedOff: { definition, name, at }`,
or null while the agent runs as it was made.

### Handing back, and ping-pong

To hand back, give the target a `handoff` of its own that lists the first
definition. A handoff to the definition the agent was made from restores its
own configuration (`handedOff` becomes null).

A run may hand off at most `maxPerRun` times (default 3, at most 20). Past it,
the call fails and the model has to answer itself, so two definitions cannot
pass a conversation back and forth for ever.

### Handoffs and your configuration

- **Upserting the same configuration** (as an app does before each run) leaves
  the conversation where it was handed.
- **An upsert with a different configuration**, or applying the agent's
  definition (`apply: "all"`), takes the agent back to its own configuration
  first, then changes it.
- Applying a target definition's new revision does not reach agents handed off
  to it; their next handoff to it does.
- `handoff` needs a definition to hand off to, and is called by the model
  directly, never from `js_exec`. The same goes for `delegate`.

## Coming from the OpenAI Agents SDK

| OpenAI Agents SDK | camelRun |
| --- | --- |
| `Agent(handoffs=[billing_agent])` | `handoff: { definitions: ["billing"] }` on the agent's definition (or on the agent) |
| `handoff(agent, tool_name_override=…, tool_description_override=…)` | `{ name, definition, description }` in `handoff.definitions` |
| `on_handoff` callback | The `handoff` event on the stream, or `run.handoffs` after the run |
| `input_filter` (trim what the next agent sees) | Not supported: the next definition sees the whole conversation |
| `result.last_agent`, running it for the next turn | Not needed: the agent stays handed off. `GET /v1/agents/{id}` shows `handedOff` |
| `agent.as_tool(tool_name, tool_description)` | `delegate: { agents: [{ name, definition, description }] }` |
| Agents as tools in parallel (`asyncio.gather` in a tool) | Several `delegate` calls in one response run at once (`maxParallel`) |
| `max_turns` across handoffs | The run's `runLimits` (the target definition's after a handoff), and `handoff.maxPerRun` |

## Coming from LangGraph

| LangGraph | camelRun |
| --- | --- |
| Supervisor (`create_supervisor`, or a supervisor node routing to workers) | A lead agent with `delegate: { agents: [...] }`: the model routes, workers answer as tool results |
| Subgraphs (a compiled graph as a node) | A definition per subgraph, delegated to. Its history is its own agent's |
| `Send` (map-reduce over items) | Parallel `delegate` calls, one per item |
| Swarm (`create_swarm`, `create_handoff_tool`), `Command(goto=…)` | `handoff`: the active agent changes, the history is shared |
| Shared state between nodes | The conversation, for handoffs. For sub-agents, the task text and a shared [volume](files.md#volumes) |
| `recursion_limit` | `delegate.maxDepth`, `handoff.maxPerRun` and the run's `runLimits` |
| Checkpointed subgraph state | Each sub-agent's own history, read by its id (`run.toolCalls[i].agentId`) |
