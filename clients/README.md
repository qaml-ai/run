# Hosted agent SDK

Expose ordinary application functions. The runtime runs the model loop, saves
conversation history, and executes generated code in QuickJS/WASM. The SDK
handles provisioning, SSE, tool results, reconnects, and shutdown.

These SDKs are for trusted TypeScript backends and Python. Remote connections require HTTPS. The model key stays on the host.

## TypeScript

```ts
import { AgentRuntime, schema, tool } from "./clients/node.ts";

const runtime = new AgentRuntime({
  url: "http://127.0.0.1:8790",
  apiKey: process.env.AGENT_RUNTIME_TOKEN,
});

const agent = await runtime.createAgent({
  name: "Research notes",
  type: "note-assistant",
  systemPrompt: "You help users summarize their selection and save useful notes. Keep replies concise.",
  tools: {
    read_selection: tool({
      description: "Read the selection in my application",
      input: schema.Object({}),
      execute: () => myApp.selection,
    }),
    save_note: tool({
      description: "Save a note in my application",
      input: schema.Object({ note: schema.String({ maxLength: 4000 }) }),
      execute: async ({ note }, { callId, signal }) => {
        // note is inferred as string. Use callId as an idempotency key if
        // your database/service supports one; honor signal for cancellation.
        return myApp.saveNote(note, { idempotencyKey: callId, signal });
      },
    }),
  },
  onEvent: event => renderAgentEvent(event),
});

try {
  await agent.prompt("Summarize my selection and save a note.");
} finally {
  await agent.destroy();
}
```

The Node/Bun entry shown above persists its event cursor to disk.
For Cloudflare Workers or other Web API environments, import `clients/typescript.ts`
instead and inject `journalStore: { load, save }` backed by your application's
durable storage. That portable entry defaults to memory and does not read
environment variables. `save(sessionId, journal)` must resolve only after commit.

Keep `agent.session` in secret storage and reconnect with
`runtime.connectAgent(credentials, { tools, onEvent })`. An async
`onEvent(event, requestId)` finishes before the SDK moves past its event.
`history()`, `continue()`, `steer(text)`, `followUp(text)`, and `configure(...)`
operate on the same persistent agent. `steer` and `followUp` are accepted while
the agent is idle and delivered to its next run.

## Python

`pip install camelai-agent-runtime` (Python 3.11+), or from this repository add
`clients/python` to `sys.path` as the demos do.

```python
from camelai_agent_runtime import AgentRuntime, ToolContext, tool

@tool
async def read_inventory():
    """Read stock and target quantities from our application."""
    return await database.inventory()

@tool
async def plan_restock(sku: str, quantity: int, context: ToolContext):
    """Save a local restock plan without placing an order."""
    return await database.plan(sku, quantity, idempotency_key=context.call_id)

async with AgentRuntime() as runtime:
    agent = await runtime.create_agent(
        name="Downtown cafe",
        type="inventory-planner",
        system_prompt="You manage cafe stock. Plan restocks without purchasing anything.",
        tools=[read_inventory, plan_restock],
    )
    try:
        await agent.prompt("Plan restocks for items below target.")
    finally:
        await agent.destroy()
```

Python's `@tool` derives names, descriptions, and JSON schemas from function
names, docstrings, and annotations. This first version supports `str`, `int`,
`float`, `bool`, `list`, and `dict`, plus an optional `context: ToolContext`.
Callbacks must be async; use `asyncio.to_thread` for blocking operations. Python
cancellation uses task cancellation. Both SDKs expose parallel tool calls without
requiring applications to handle messages, request IDs, or raw HTTP.

## Tools are an attached MCP server

Both SDKs serve an application's tools to its agent as an MCP server, attached
over the agent's own connection. The runtime treats it like a remote MCP server
it calls itself: the same tool names, results and "outcome unknown" handling.
`tool({...})` and `@tool` build that server; a TypeScript application can attach
one written with the MCP SDK instead:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fromMcpServer } from "./clients/mcp.ts";

const server = new McpServer({ name: "shop", version: "1.0.0" });
server.registerTool("price", { description: "Price of a SKU", inputSchema: { sku: z.string() } },
  async ({ sku }) => ({ content: [{ type: "text", text: `${sku}: $3` }], structuredContent: { sku, cents: 300 } }));
const agent = await runtime.createAgent({ mcp: await fromMcpServer(server) });
```

The same server can run remotely later, as a definition's `mcpServers` entry,
without changing its tools. Code in `js_exec` gets a tool's data: its
`structuredContent`, or its one text block (parsed when it is JSON). A tool's own
failure is an MCP error result, which the model sees and which throws in code.
`callId`, `toolCallId` (for a call from js_exec, the js_exec call's, with
`innerCallId`), `actor` and `origin` reach the server's handlers as
`_meta["agent-runtime/…"]`, and progress it reports for a call
(`notifications/progress`) reaches the agent's events as a `tool_execution_update`.

## Serving tools to many users

When one server answers tools for many users' agents, serve them over HTTP and
let the runtime say who each call is for. A definition names the server with
`auth: { type: "runtime" }`; the runtime then signs a short-lived token for every
request, naming the agent's `subject` and `context` (set when you create it) and
the turn's actor (a prompt's `actor`, or its `from.id`). `serveTools` verifies it
and hands each call an `identity`:

```ts
import { schema, tool } from "@camelai/agent-runtime";
import { serveTools } from "@camelai/agent-runtime/server";

const tools = {
  list_todos: tool({
    description: "The current user's to-dos", input: schema.Object({}),
    execute: (_args, { identity }) => db.todos({ user: identity!.user, team: identity!.context.team }),
  }),
};
// A fetch handler: Workers, Bun and Deno serve it as is; Node with nodeListener from "@camelai/agent-runtime/node".
export default { fetch: serveTools(tools, { runtime: "https://agents.camelai.dev" }) };
```

```ts
await runtime.createDefinition({ name: "Todos", mcpServers: [{ name: "todos", url: "https://todos.example.com/mcp", auth: { type: "runtime" } }] });
const agent = await runtime.createAgent({ definition: id, subject: "team-acme", context: { team: "acme" }, tools: {} });
await agent.prompt("What's on my plate?", { from: { id: "alice", name: "Alice" } }); // identity.user is "alice"
```

- `identity` is `{ user, subject, actor?, tenant, agent, definition?, context, origin? }`.
  Authorize as `user`: the turn's actor, else the agent's subject. It comes from
  the verified token, never from the model's arguments.
- Requests without a valid token for this server get a 401: signature (the
  runtime's published Ed25519 keys), issuer, audience (by default the request's
  URL, else `audience`), and expiry are all checked. The server keeps no sessions.
- The same `tools` work attached (`createAgent({ tools })`): the runtime sends
  the same identity with each call over the agent's connection, so tools can
  move between attached and served without changes.
- It serves MCP's protected-resource metadata
  (`/.well-known/oauth-protected-resource/<path>`) naming the runtime, whose own
  metadata is at `/.well-known/oauth-authorization-server`.
- Built with the MCP SDK or Cloudflare's `createMcpHandler` instead? Verify with
  `runtimeAuth(request, { runtime })`, pass the result as the request's `auth`
  (or `authContext`), and read `runtimeIdentity(extra)` in a tool handler.
  `verifyRuntimeToken(token, { runtime, audience })` checks a token on its own.
- Test authorization without a runtime: `testRuntime()` from
  `@camelai/agent-runtime/testing` signs tokens with a key of its own.

```ts
const rt = await testRuntime();
const handler = serveTools(tools, rt.options);
const result = await rt.callTool(handler, "https://app.test/mcp", "list_todos", {}, { subject: "alice", context: { team: "acme" } });
```

In Python (`pip install cryptography` for token checks), `serve_tools` is an
ASGI app, and a tool's `context.identity` is a `RuntimeIdentity`:

```python
from camelai_agent_runtime import ToolContext, serve_tools, tool

@tool
async def list_todos(context: ToolContext) -> dict:
    """The current user's to-dos"""
    return {"todos": db.todos(user=context.identity.user, team=context.identity.context["team"])}

app = serve_tools([list_todos], runtime="https://agents.camelai.dev")  # uvicorn, or mount in FastAPI
```

`verify_runtime_token(token, runtime=..., audience=...)` and `TestRuntime()` match
the TypeScript helpers. [examples/team-todos.ts](../examples/team-todos.ts) runs
the whole pattern against a runtime.

## Agent identity and Studio

`name` identifies an individual agent; `type` groups agents in Studio. For example,
`September release` and `Docs launch` can both be `release-reviewer` agents. Types
are free-form labels, not an enum, template, or separate runtime object. Each
agent retains its own conversation and stable ID. Both fields accept 1–120
characters. Existing clients may omit them (ID as name, `general` as type).

Rename or regroup without changing its URL or history:

```ts
await agent.setMetadata({ name: "October release", type: "release-reviewer" });
```

```python
await agent.set_metadata(name="Uptown cafe", type="inventory-planner")
```

When connected to the runtime launched by Agent Studio, SDK-created agents
appear automatically at `/studio/agents`; no UI registration is required.
Studio observes the runtime journal; your application's SSE connection continues
to own its tool callbacks. Get the runtime URL from the terminal or local
`.agent-runtime/studio/studio.json` (`runtimeUrl`), and its operator credential
from `.agent-runtime/studio/secrets.json` (`operator`). Keep credentials server-side.
Use `STUDIO_EXAMPLES=0 npm run studio` to skip launching demos (existing agents remain listed).

## Run the demos

From the repository root:

```sh
npm ci
python3 -m venv /tmp/camelai-client-demo
/tmp/camelai-client-demo/bin/pip install -r clients/python/requirements.txt
PYTHON=/tmp/camelai-client-demo/bin/python npm run demo:clients
```

One temporary host runs two independent agent processes concurrently:

- [TypeScript release board](../examples/release-board.ts) reads application
  issues and saves a release readiness note.
- [Python SQLite inventory](../examples/inventory.py) reads its own database and
  saves restock quantities, recording the tool call ID alongside each write.

The default run is deterministic: supplied scripts exercise real QuickJS and
SSE/HTTP callbacks without calling a paid model. It cleans up its host, agents,
and temporary journals. `AGENT_RUNTIME=node` or `bun` selects the child runtime.

For a model-driven run, start `npm start` with the provider configuration
and tenants file in the [host README](../README.md#configuration), then run:

```sh
export AGENT_URL=http://127.0.0.1:8790
export AGENT_RUNTIME_TOKEN=your-tenant-operator-token
bun examples/release-board.ts --prompt \
  "Review release readiness and save a note naming blockers and owners."
/tmp/camelai-client-demo/bin/python examples/inventory.py --prompt \
  "Plan restocks for everything below target and explain the quantities."
```

## Lifecycle and recovery API

| TypeScript | Python | Purpose |
| --- | --- | --- |
| `runtime.createAgent({tools})` | `runtime.create_agent(tools=[...])` | Provision and connect |
| `runtime.createAgent({definition, tools})` | `runtime.create_agent(definition=..., tools=[...])` | Provision from a definition (`GET /v1/definitions`): it supplies the model, prompt and tools; `tools` answer its tools, and others are added |
| `runtime.connectAgent(session, {tools})` | `runtime.connect_agent(session, tools=[...])` | Reattach using scoped credentials |
| `agent.prompt(text, { from, actor })` | `agent.prompt(text, from_=, actor=)` | Run a model turn; `from` ({id, name?, username?}) tells the model who sent it, `actor` tells only tools |
| `agent.execute(code)` | `agent.execute(code)` | Diagnostic QuickJS execution, outside model history |
| `agent.status()` / `agent.abort()` | Same | Inspect or cancel a turn |
| `agent.outcomes()` | Same | Inspect recorded requests and tool outcomes |
| `agent.requestStatus(id)` | `agent.request_status(id)` | Recover a timed-out request's result |
| `agent.close()` | Same | Disconnect locally, retain hosted agent |
| `agent.destroy()` | Same | Revoke the session and stop its agent |

The SDK automatically retries provisioning and request POSTs with the same
idempotency key. Callers can supply `idempotencyKey` (Python `idempotency_key`) to
resume a request after their own restart. Reusing a key with different parameters
fails. Request errors include `requestId` / `request_id` for status inspection.
`agent.session` contains scoped credentials: store them securely to reconnect;
never log them. `createAgent` needs an operator key, but `connectAgent` doesn't.
Provision on your trusted backend and give the client only its scoped session.

`close()` does not cancel a hosted model turn. If you intend to stop one, await
`abort()` before closing. Disconnecting during a client tool may leave an
uncertain outcome. `destroy()` is intended for demo/ephemeral sessions. In an
application, keep the agent connected across multiple prompts.

## What reconnects guarantee

The host numbers events and replays them from memory using `Last-Event-ID`.
Both SDKs reconnect with backoff. A bounded replay window holds up to 512 events
/ approximately 2 MiB; if the cursor falls behind it, or the host restarted,
SDKs recover request outcomes from saved session state and emit `replay_gap`.
Display events (token deltas, progress) outside that window are not
reconstructed, and SDKs persist their cursor only for responses, never once per
streamed token.

Tool calls are MCP, as for any server: each connection to the event stream is a
new MCP session (the runtime sends `initialize`), the runtime's JSON-RPC
messages arrive as `mcp` events (live only: never buffered or replayed), and
the SDK answers with `POST /clients/:id/mcp`, naming its connection. A call goes
to one connection, once. With no application connected (after a few seconds'
grace for a reconnect) it fails without running. If the connection drops, or
the call's deadline passes, before the answer arrives, the runtime cannot know
whether the side effect happened: the model gets an explicit "outcome unknown"
result, so the turn continues and the model can check the real state before
repeating anything, and the call is not sent again. The runtime also sends MCP's
`notifications/cancelled`, which aborts the tool's `signal`. Nothing waits for
an operator. Timeouts and cancellation are not rollback.

This is **not an exactly-once transaction across the SDK and your database**.
Business authorization, transactional writes, and application idempotency stay
in your tools. A new model-issued call gets a new call ID; the SDK cannot infer
that two different calls represent the same business operation. Ordinary tool
exceptions are returned to the model; uncertainty is explicit for interrupted
execution. Keep handlers and schemas trusted.

## Persistence and limits

- Host journals are append-only logs under `AGENT_DATA_DIR/client-sessions`,
  fsynced when a request is accepted, a run begins, and an outcome is recorded.
  SDK cursors default to `.agent-runtime/client-sdk`, configurable with
  `stateDirectory` / `state_directory` or `AGENT_CLIENT_STATE_DIR`. Use persistent,
  application-owned directories. Do not share one SDK journal between concurrent
  application processes.
- Sessions and deduplication records survive a host restart with the same data
  directory and session secret. A request that was running when the host died
  completes with an `uncertain` error; the interrupted turn is closed with
  "outcome unknown" results when the agent next starts, and is never rerun.
- Session credentials expire after 24 hours and can be revoked via `destroy()`.
  There is no renewal or automatic cleanup policy yet. Sessions load lazily and
  unload when idle. Once a journal grows, settled records are folded away,
  keeping the most recent 256 requests for idempotent retries; retrying an older request ID starts it again. This file store is
  local to one host, not distributed hosting.
- Tool calls default to a 15-second deadline. The existing sandbox, schema,
  argument, result and concurrency limits remain enforced. JSON frames are
  capped at 1.1 MB, with bounded SSE output buffering and no event compression.
- TLS is required remotely. Redirects are disabled. Credentials are headers,
  never URL parameters. The host rejects browser `Origin` headers for now;
  browser SDK packaging, CORS and a user-authenticated credential handoff remain
  separate work. No browser or production application route has been switched.

The wire transport is ordinary HTTP: `GET /clients/:id/events` streams SSE;
`POST /clients/:id/requests` accepts idempotent requests; `POST /clients/:id/mcp`
carries the application's MCP messages. Application code should
use the SDK rather than implement this protocol itself.

Validation: `npm test` covers the host and TypeScript SDK;
`python3 tests/python_sdk.py` covers Python schema
inference, reconnects and lost request/result acknowledgements. Both suites
accept `AGENT_RUNTIME=node` or `AGENT_RUNTIME=bun` for the hosted agent processes.

## System prompts

Pass `systemPrompt` (TypeScript) or `system_prompt` (Python) when creating an
agent. This defines the application instructions and takes precedence over the host's
`AGENT_SYSTEM_PROMPT`, and is stored with that agent. Reconnecting or restarting
the host retains it; `connectAgent` / `connect_agent` do not change configuration.
The runtime automatically prepends tool discovery, sandbox execution and result
handling instructions. Developers only need to describe the agent’s role and
behavior; no `js_exec` instructions are needed. The stored application prompt is
kept separate from the assembled prompt, so reconnects do not duplicate instructions.
Prompts must be nonblank strings of at most 32,000 characters.
Sandbox capability restrictions are enforced independently of the prompt.

Changing the prompt or tools of an agent that has history (a `configure` request)
never rewrites the start of its context, so the provider's prompt cache stays
valid. The change is appended as a system message where the conversation stands,
replacing the application's instructions section and adding or removing tools
from that point. Providers that accept system messages mid-conversation get it in
place; others get it folded into the leading system message (and lose the cache
once, as before). The runtime records the change in the agent's transcript, so
a reload on any node rebuilds the same context. Compaction folds earlier changes
into the leading message. An agent without history just gets a new leading message.
Editing an existing agent's prompt through the Studio UI is not implemented yet.
