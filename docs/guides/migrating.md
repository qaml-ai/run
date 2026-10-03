# Coming from the OpenAI Agents SDK or LangGraph

The concepts mostly carry over. The main difference is where the agent lives. In
the OpenAI Agents SDK and LangGraph, the loop runs in your process, and its state
lives in a session or checkpointer that you run. In camelRun the loop runs in the
runtime, and so do the agent's history and files. Your process provides the
tools and starts runs.

This page maps each concept. It also lists what camelRun does not have, so you
know before porting.

## The same agent, ported

OpenAI Agents SDK:

```python
from agents import Agent, Runner, SQLiteSession, function_tool

@function_tool
def lookup_order(order_id: str) -> dict:
    """Look up an order by id."""
    return orders.get(order_id)

agent = Agent(name="Support", instructions="You help with orders.", tools=[lookup_order])
result = await Runner.run(agent, "Where is order 42?", session=SQLiteSession("user-123"))
print(result.final_output)
```

camelRun:

```python
from camelai_run import Agents, tool

@tool
def lookup_order(order_id: str) -> dict:
    """Look up an order by id."""
    return orders.get(order_id)

async with Agents() as agents:  # reads CAMELAI_API_KEY
    agent = await agents.upsert("user-123", instructions="You help with orders.", tools=[lookup_order])
    run = await agent.run("Where is order 42?")
    print(run.text)
```

The key (`"user-123"`) does the job of the session: the same key is the same
agent, with its history, from any process. `upsert` creates the agent the first
time and later brings it to the configuration you pass. Nothing is stored on
your side.

> **Deploy topology: one process serves an agent's tools.** In the OpenAI Agents
> SDK and LangGraph, every worker runs its own loop with its own tools. Here the
> loop is in the runtime, and tools passed to `upsert(tools=…)` are served by
> the **one** process holding the agent's connection. A straight port that
> upserts with `tools` in every gunicorn or uvicorn worker, or every Celery
> task, works with one worker and fails at two: `AgentError: Another process
> serves this agent's tools…` (`APPLICATION_CONNECTED`). With several workers,
> serve the tools over HTTPS instead, and make agents from a definition that
> names the server, with no `tools`: then any worker can run any agent, and
> deploys lose no call. See [Served tools](tools.md#served-tools-over-http-for-serverless-and-many-users).

```python
from camelai_run import serve_tools

# In your web app (pip install "camelai-run[server]"): every worker serves the same tools.
tools_app = serve_tools([lookup_order], runtime="https://run.camelai.com", tenant="acme")  # mount at /mcp

# Once, at deploy time: a definition naming the server.
definition = await agents.runtime.upsert_definition("support", name="Support", systemPrompt="You help with orders.",
    mcpServers=[{"name": "shop", "url": "https://app.example.com/mcp", "auth": {"type": "runtime"}}])

# In any worker or task: no tools here, so no worker holds them.
agent = await agents.upsert("user-123", definition=definition["id"])
run = await agent.run("Where is order 42?")
```

```ts
import { serveTools } from "@camelai/run/server";

// In your web app, on every instance: POST /mcp.
export const POST = serveTools({ lookup_order }, { runtime: "https://run.camelai.com", tenant: "acme" });

const definition = await agents.runtime.upsertDefinition("support", {
  name: "Support", systemPrompt: "You help with orders.",
  mcpServers: [{ name: "shop", url: "https://app.example.com/mcp", auth: { type: "runtime" } }],
});
const agent = await agents.upsert("user-123", { definition: definition.id });
```

`tenant` is your account's id (`GET /v1/me`). One long-lived process that holds
the tools, with every other process upserting with `attach=False`, works too;
see [Several processes, workers and deploys](tools.md#several-processes-workers-and-deploys).

## OpenAI Agents SDK

| OpenAI Agents SDK | camelRun |
| --- | --- |
| `Agent(name, instructions, tools, model)` | `agents.upsert(key, instructions=, tools=, model=)`; models are `provider/model` ids from `GET /v1/models` |
| `Runner.run(agent, input)`, `result.final_output` | `agent.run(text)`, `run.text` |
| `Runner.run_streamed` | `agent.stream(text)`: text, tool calls and results as they happen, then `done` with the run |
| `@function_tool` | `@tool` (TypeScript: `tool({ input, execute })`). Arguments are checked against the schema first. See [Tools](tools.md) |
| Sessions (`SQLiteSession`, Redis…) | The agent's key. History is durable and compacted when it gets long; `agent.history()` reads it |
| `output_type=Model` | `run(text, output=Model)`, `run.output` (`pip install "camelai-run[pydantic]"`). See [Structured output](structured-output.md) |
| Handoffs | No built-in handoff; see [Handoffs and multi-agent](#handoffs-and-multi-agent) |
| `agent.as_tool()` | A tool that runs another agent; see below |
| Input guardrails | Your code, before `run()`. With `createAgentHandler`, `onSend` can rewrite or refuse a message |
| Output guardrails | Your code, on `run.text` or `run.output`, before you use it |
| Tool approval (`needs_approval`), interruptions | `@tool(needs_approval=True)`; the run ends `input_required` and `run.inputs[0].answer(True)` resumes it, from any process, days later if need be. See [Human input](human-input.md) |
| `RunContextWrapper` (context for tools) | `context` and `subject` on the agent, plus `user` on each run. Tools get them in `context.identity`, set by your code and never by the model. See [Identity](tools.md#identity-who-a-call-is-for) |
| Hosted tools: `WebSearchTool` | `builtins=["web_search"]` |
| `CodeInterpreterTool` | `js_exec`, always on: JavaScript in a sandbox that can call the agent's tools. It has no Python |
| `FileSearchTool` (vector stores) | No equivalent. Agents have files and file tools, not vector search |
| `MCPServerStreamableHttp` | `mcpServers` in a [definition](definitions.md): the runtime calls the server itself. A local MCP server object can be attached with `fromMcpServer` (TypeScript) |
| Tracing (`trace()`, the traces dashboard) | OpenTelemetry trace export to your own backend (LangSmith, Langfuse, Honeycomb, Datadog, Tempo, any OTLP endpoint): a span per run, model call, tool call and wait, continuing your `traceparent`. See [Observability](observability.md). Also the event stream (`on_event`, `stream()`), `run.completed` and `usage.recorded` [webhooks](webhooks.md), and `GET /v1/agents/:id/history` |
| `max_turns` | `run_limits={"maxResponses": n}` on the agent (at most 1,000 model responses and 2 hours a run by default); a run that reaches it stops with `stopped: "turn_limit"`. `spend_limit={"usd": …}` on a run, or on the agent, bounds what it spends |
| `ModelSettings` (temperature, top_p) | Not settable. `thinking_level` is |

## LangGraph

| LangGraph | camelRun |
| --- | --- |
| `create_react_agent(model, tools, prompt)` (LangChain's `create_agent`) | `agents.upsert(key, model=, tools=, instructions=)`: the runtime runs the tool loop |
| Checkpointer and `thread_id` | The agent's key. One agent per thread: `upsert(f"thread-{thread_id}")` |
| `graph.get_state(config)` | `agent.history()`, `agent.history_page()` |
| `interrupt()` in a node or tool | In a tool: `await context.confirm(…)`, `await context.ask(…)`. The model can also ask, with `builtins=["ask_user"]` |
| `Command(resume=…)` | `run.inputs[0].answer(value)` |
| `graph.stream(…, stream_mode="messages")` | `agent.stream(text)`, or the agent's events |
| `response_format`, `with_structured_output` | `run(text, output=Model)` |
| A custom `StateGraph` | Your own code: a sequence of runs, branching on `run.output`. There is no graph DSL; see below |
| `Send` (map-reduce) | `asyncio.gather` over runs of several agents |
| Long-term memory (`Store`) | Files. Mount a shared [volume](files.md#volumes) in several agents |
| Time travel (`get_state_history`, replay from a checkpoint) | Not supported. A conversation cannot be forked or rewound |
| LangSmith | Export traces to LangSmith's OTLP endpoint (`PUT /v1/telemetry`, [preset](observability.md#presets)); include content to see messages |

## Handoffs and multi-agent

camelRun has no handoff primitive, and no graph. Two patterns cover most uses:

**Delegate.** One agent calls another through a tool, and the conversation stays
with the first agent (the equivalent of the Agents SDK's `as_tool`, or a
LangGraph supervisor):

```python
@tool(timeout=300)  # a run can take longer than a tool's default 15 seconds
async def ask_billing(question: str) -> str:
    """Ask the billing specialist a question about invoices, refunds or charges."""
    specialist = await agents.upsert("billing-specialist", instructions="You answer billing questions.")
    return (await specialist.run(question)).text

support = await agents.upsert("support-user-123", instructions="You help customers.", tools=[ask_billing])
```

The specialist is an ordinary agent with its own history. Key it per customer
(`f"billing-{user_id}"`) if it should remember earlier questions, or keep one
key to share it.

**Route.** Your code picks the agent for each message. A small agent with
structured output can make the decision:

```python
class Route(BaseModel):
    team: Literal["billing", "technical", "general"]

router = await agents.upsert("router", instructions="Pick the team that should answer this message.")
team = (await router.run(message, output=Route)).output.team
answer = await (await agents.upsert(f"{team}-user-123", instructions=PROMPTS[team])).run(message)
```

What does not carry over: in a handoff, the receiving agent takes over the
conversation and sees its history. In camelRun each agent has its own history,
so pass what the other agent needs in the message.

## Bringing conversations over

Existing conversations can continue in camelRun. Create the agent with its
history in `initialMessages`, converted to the runtime's message format (user,
assistant with tool calls, tool results). See [Bringing in existing
conversations](multi-user.md#bringing-in-existing-conversations).

## What camelRun adds

- **Durable runs.** A run survives your process restarting and the runtime's
  nodes being replaced. A run waiting on a person waits for days at no cost.
- **Tools anywhere.** Tools run in your process (attached) or behind an HTTPS
  endpoint (served, for serverless and many workers), and the model can call
  many of them from code in `js_exec`. See [Tools](tools.md).
- **Channels and schedules.** Slack, Telegram, Discord, GitHub and email can
  reach an agent directly, and agents can wake themselves. See
  [Channels](channels.md).
