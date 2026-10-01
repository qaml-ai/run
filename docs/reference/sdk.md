# SDKs

The TypeScript SDK (`@camelai/run`) and the Python SDK
(`camelai-run`). Start with the [Quickstart](../quickstart.md);
this page is the reference.

```sh
npm install @camelai/run      # Node 22+, Bun, Deno, Cloudflare Workers
pip install camelai-run       # Python 3.11+; "camelai-run[server]" for serve_tools
```

| TypeScript entry | |
| --- | --- |
| `@camelai/run` | everything portable: `Agents`, `tool`, `schema`, the lower-level `AgentRuntime` and `AgentClient`, the types |
| `@camelai/run/node` | the same for Node and Bun, plus local file paths as attachments, `nodeListener` |
| `@camelai/run/server` | `serveTools`, `verifyRuntimeToken`, `runtimeAuth`, `runtimeIdentity`: serving tools over HTTP |
| `@camelai/run/watch` | `watchAgent`: reading an agent from a browser |
| `@camelai/run/mcp` | `fromMcpServer`: attaching an MCP SDK server (needs `@modelcontextprotocol/sdk`) |
| `@camelai/run/testing` | `testRuntime`: signing identity tokens in tests |

The public types need nothing else installed: messages and events are declared
in the SDK (`Message`, `AgentEvent`, `AssistantMessage`, …).

## Agents

```ts
const agents = new Agents({ apiKey, url });   // or `await using agents = new Agents()`
```

```python
async with Agents(api_key, url=url) as agents: ...
```

The Python SDK is async-only: every call is awaited inside `async def`. From
synchronous code (a script, a Django view, a Celery task), run it with
`asyncio.run(...)`. Its names are the TypeScript ones in snake_case
(`throw_on_error`, `run.tool_errors`, `part.is_error`), as the tables below show.

- `apiKey` defaults to the `CAMELAI_API_KEY` environment variable, `url` to
  `CAMELAI_BASE_URL`, else `https://run.camelai.com`.
- `agents.close()` closes every agent's connection so the process can exit;
  their runs go on in the runtime.
- `agents.runtime` is the lower-level `AgentRuntime`: definitions, volumes,
  mounts, `listAgents()`, `browserToken(agentId)`, `inbox()`, `toolSources(agentId)`.

### `agents.upsert(key, config)`

The agent for `key` (1 to 80 of `A-Z a-z 0-9 _ -`), made if there is none, and
brought to `config` if it differs. Returns a connected `Agent`. See
[Concepts](../concepts.md#agents-are-durable-and-keyed).

| TypeScript | Python | |
| --- | --- | --- |
| `model` | `model=` | `"provider/model-id"` from `GET /v1/models` |
| `instructions` | `instructions=` | the system prompt |
| `instructionsAppend` | `instructions_append=` | text after the prompt (a definition's, say): per-conversation context |
| `tools` | `tools=` | tools served from this process: `{ name: tool({...}) }`, or a list of `@tool` functions |
| `mcp` | | an MCP server of yours to attach instead (`fromMcpServer`) |
| `definition` | `definition=` | make it from a definition (its model, prompt and tool sources) |
| `thinkingLevel` | `thinking_level=` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `subject`, `context` | `subject=`, `context=` | whom it acts for, and claims for its tools; fixed at creation |
| `keyScope`, `spendLimit`, `modelHeaders` | `key_scope=`, `spend_limit=`, `model_headers=` | see [Models and keys](../guides/models-and-keys.md) |
| `mounts`, `fileTools` | `mounts=`, `file_tools=` | its volumes (fixed at creation), and whether it has file tools |
| `name` | `name=` | a label, shown in the console |
| `attach` | `attach=` | `false`: declare `tools` without serving them (another process does) |
| `takeover` | `takeover=` | replace the process serving the tools now |
| `onEvent(event, runId)` | `on_event=` | every event, for display; runs in order, apart from the connection; plain or async |
| `onInput(input)` | `on_input=` | each input as it is asked: return an answer, or nothing |
| `onError(error)` | `on_error=` | errors from the connection and from `onEvent` |

`agents.agent(session, { tools, … })` connects to an agent you hold the
credentials of (`{id, token}`) without changing it.

### `Agent`

| TypeScript | Python | |
| --- | --- | --- |
| `agent.id` | `agent.id` | `client_…`: safe to log and store |
| `agent.run(text, options)` | `await agent.run(text, …)` | send a message, wait for the run: a `Run` |
| `agent.stream(text, options)` | `agent.stream(text, …)` | the run as it happens: `for await` / `async for` over parts |
| `agent.pendingInputs()` | `pending_inputs()` | inputs waiting on people, each with `answer()` |
| `agent.history()`, `historyPage({ before, limit })` | `history()`, `history_page(before=, limit=)` | the whole history (a list of messages, oldest first), or a page of whole turns |
| `agent.steer(text)` | `steer()` | `run` with `whileRunning: "steer"` (joins the running turn, else starts one): the run that took the message |
| `agent.configure({ model, instructions, thinkingLevel, tools })` | `configure(…)` | change it between runs |
| `agent.schedule({ text, inSeconds, at, everySeconds })` | `schedule(…)` | wake it later; `schedules()`, `unschedule(id)` |
| `agent.files` | `agent.files` | `list`, `download`, `upload`, `link` by the paths the agent sees |
| `agent.abort()` | `abort()` | stop the running turn |
| `agent.delete()` | `delete()` | delete it, its history and files |
| `agent.close()` | `close()` | close this process's connection |
| `agent.client` | `agent.client` | the lower-level `AgentClient` |

Run options (`run`, `stream`):

| TypeScript | Python | |
| --- | --- | --- |
| `user` | `user=` | who sent it: your user id, or `{ id, name, username }`; the model sees who, tools get `identity.actor` |
| `files` | `files=` | attachments; see [Files](../guides/files.md) |
| `metadata` | `metadata=` | your own key-value data about the message (16 strings); the model never sees it |
| `idempotencyKey` | `idempotency_key=` | the run's id: the same key returns the same run, joining it if it is still going |
| `signal` | `timeout=` | stop waiting; the run goes on |
| `throwOnError` | `throw_on_error=` | `false`: return a failed run instead of throwing `RunError` |
| `whileRunning` | `while_running=` | `"queue"` (default) or `"steer"` |
| `spendLimit` | `spend_limit=` | `{usd}`: this run's own budget; see [Spend limits](../guides/models-and-keys.md#spend-limits) |
| `allowDisconnected` | `allow_disconnected=` | run even with nobody serving the agent's tools (else refused: `APPLICATION_NOT_CONNECTED`) |

### `Run`

`{ id, status, text, inputs, error, usage, files, toolErrors, sourceErrors, raw }`
(Python: `tool_errors`, `source_errors`). `status` is `completed`,
`input_required` or `failed`; `error` is `{ code, message, uncertain? }`. See
[Concepts](../concepts.md#runs) and [Errors](../reference/errors.md#run-failures).

Each of `run.inputs` is the input (`id`, `kind`, `message`, `detail`,
`responders`, `expiresAt`, …) with `answer(value, { from })` and
`decline({ from })` (Python: a dict with `answer(value, from_=)` and
`decline(from_=)`), which resolve with the resumed run. See [Human
input](../guides/human-input.md#answering).

### Stream parts

| `type` | fields |
| --- | --- |
| `text` | `text`: reply text as it is written (successive messages separated by a blank line) |
| `tool_call` | `id`, `name`, `arguments` |
| `tool_result` | `id`, `name`, `output` (the result's text), `isError` (`is_error`) |
| `input_required` | `input`, with `answer()` |
| `done` | `run`: always last |

Every part but `done` has `raw`, the event it came from. `stream.result()`
resolves with the run; breaking out of the loop stops the reading, not the run.

## Tools

```ts
tool({ description, input: schema.Object({...}), execute: (args, context) => result, timeoutMs?, needsApproval?, exposure?, executionMode?, resultFormat? })
```

```python
@tool(name=None, description=None, timeout=None, needs_approval=None)
def or_async_def(arg: str, context: ToolContext): ...
```

`context` (`ToolContext`):

| TypeScript | Python | |
| --- | --- | --- |
| `idempotencyKey` | `idempotency_key` | the same for every attempt of this call: key side effects by it |
| `callId` | `call_id` | this attempt's id |
| `toolCallId` | `tool_call_id` | the model's tool call |
| `identity` | `identity` | who the call is for: `user`, `subject`, `actor`, `tenant`, `agent`, `context`, `origin`, `approval` |
| `origin` | `origin` | where the turn came from (a channel) |
| `signal` | (task cancellation) | aborted when the runtime cancels the call |
| `progress(message \| { progress, total, message })` | `progress(message, progress=, total=)` | report progress; restarts the deadline |
| `confirm`, `ask`, `requireUrl` | `confirm`, `ask`, `require_url` | ask the user; see [Human input](../guides/human-input.md) |

See [Tools](../guides/tools.md) for attached and served tools, identity and
the definitions' sources, and `serveTools` / `serve_tools`. With several
processes (web workers, task queues, serverless), serve tools over HTTP: see
[Several processes, workers and deploys](../guides/tools.md#several-processes-workers-and-deploys).

## Errors

- `AgentError`: `status` (HTTP, or 0), `code` (a stable name where the runtime
  gives one: `APPLICATION_CONNECTED`, `APPLICATION_REPLACED`, `REPLAY_GAP`,
  `spend_limit`, …), `requestId`, `uncertain`, `retryAfterMs` (Python
  `request_id`, `retry_after` in seconds).
- `RunError extends AgentError`: a failed run, with `run`.

The SDKs retry 429 and 503 (honouring `Retry-After`) and transient failures of
idempotent requests. See [Errors](../reference/errors.md).

## The lower-level API

`Agents` and `Agent` are built on `AgentRuntime` and `AgentClient`, which stay
available and stable for code that needs the wire's shape: `agents.runtime`,
`agent.client`, or `new AgentRuntime({ url, apiKey })` directly.

| TypeScript | Python | |
| --- | --- | --- |
| `runtime.upsertAgent(key, options)` | `runtime.upsert_agent(key, …)` | upsert, returning credentials (not connected) |
| `runtime.createAgent({ tools, ttlSeconds, idempotencyKey, … })` | `runtime.create_agent(tools=[...], …)` | provision and connect; with `idempotencyKey`, the same as an upsert |
| `runtime.connectAgent(session, { tools, attach, takeover })` | `runtime.connect_agent(session, tools=, attach=, takeover=)` | connect with stored credentials |
| `runtime.browserToken(agentId, options)` | `runtime.browser_token(agent_id, …)` | a browser token |
| `runtime.me()` | `runtime.me()` | who the API key is: `tenant`, your tenant's id, which `serveTools` takes |
| `runtime.setProvider(name, config)`, `providers()`, `deleteProvider(name)` | `set_provider(name, base_url=, models=, api_key=, headers=)`, `providers()`, `delete_provider(name)` | a provider of your own: any OpenAI-compatible server and its models; see [Custom models](../guides/custom-models.md) |
| `runtime.listAgents()` | `runtime.list_agents()` | the tenant's agents, each with the `key` it was made with (`null` without one) and its `name` |
| `runtime.upsertDefinition(key, input)`, `createDefinition`, `updateDefinition`, `definition(s)`, `deleteDefinition` | `upsert_definition(key, …)`, `create_definition`, … | definitions; the same key is the same definition |
| `runtime.createVolume`, `volume(id)`, `mounts`, `setMounts` | `create_volume`, `volume(id)`, … | volumes and mounts |
| `runtime.inbox(state)`, `toolSources(agentId)` | `inbox(state=)`, `tool_sources(agent_id)` | inputs across agents; an agent's tools |
| `client.prompt(text, { from, actor, files, metadata, whileRunning, idempotencyKey, signal })` | `client.prompt(text, from_=, …)` | a run's raw result: `{ reply, error, stopped, inputs, files, toolErrors, … }`; rejects on a runtime error |
| `client.request(method, params, options)` | `client.request(method, params, …)` | any request (`prompt`, `continue`, `execute`, `configure`, `status`, `abort`) |
| `client.waitForRequest(id)` | `wait_for_request(id)` | wait for a request already sent, from any process |
| `client.requestStatus(id)`, `outcomes()` | `request_status(id)`, `outcomes()` | a request's record; every request's state |
| `client.answer(inputId, { action, content, from })`, `inputs(state)` | `answer(input_id, action=, …)`, `inputs(state=)` | inputs, raw |
| `client.execute(code)` | `execute(code)` | run code in the sandbox with the agent's tools, outside its history |
| `client.steer(text)` | `steer()` | the legacy `steer` request, which holds the message for the running (or next) turn; new code uses `prompt` with `whileRunning: "steer"` |
| `client.setMetadata({ name, type })` | `set_metadata(name=, type=)` | rename or regroup |
| `client.destroy()`, `close()` | same | delete the agent; close the connection |

`client.prompt()` resolves with the run's raw result, even when the model
failed (`result.error`), and rejects only on a runtime error. Requests have no
timeout unless you pass `timeoutMs` or `signal` (Python: `timeout`).

### Events, reconnects and replay

The SDK holds one SSE stream per agent (`GET /clients/:id/events`) and
reconnects with backoff. The runtime numbers events and replays them from memory
from `Last-Event-ID`: up to 512 events or about 2 MiB. Where it cannot (a
restarted node, a cursor too old), the SDK asks for a snapshot of the running
turn instead (`?snapshot=1`), and recovers every settled request's outcome from
`/state`, so a run's result never depends on its event arriving. A request still
waiting also asks for its own status every 30 s (`pollMs`, Python
`poll_interval`).

A `message_update` is its delta alone (`assistantMessageEvent`), not the whole
message: fold the message from its `message_start` and the deltas since
(`@camelai/run/watch` does). A subscriber that cannot replay gets a
`snapshot` of the running turn first. See the [event
reference](../reference/events.md).

`onEvent` (`on_event`) handlers run one at a time, in order, apart from the
stream: a slow handler never holds up tool calls, and what it throws goes to
`onError`. Past 10,000 events waiting, streamed deltas are dropped (with one
`onError`) until it catches up. `close()` stops them: the call in progress may
finish (`close()` waits up to 2 seconds for it), and events still queued are
dropped.

### Tool calls and connections

Tool calls are MCP: each attached connection is an MCP session with the SDK as
the server (the runtime sends `initialize`, `tools/list`, `tools/call` and
`notifications/cancelled` as `mcp` events, and the SDK answers with `POST
/clients/:id/mcp`, naming its connection). A call goes to one connection, once.
If the connection drops or the call's deadline passes before its answer arrives,
the model gets an "outcome unknown" result and the call is never sent again.

A connection whose tools differ from those the agent was last given (the ready
event's `toolsHash`) declares them, between the agent's turns (`syncTools:
false` to leave them). One connection at a time serves an agent's tools. A second is refused with
`APPLICATION_CONNECTED` unless it asks to take over (`takeover`); the SDK names
its connection when it reconnects, so it keeps its place. A connection that was
replaced, or finds the tools taken when it reconnects, hears
`APPLICATION_REPLACED` / `APPLICATION_CONNECTED` on `onError` and goes on
following the agent without serving them. A client with `attach: false` follows
the stream read-only (`?watch=1`) and never contends.

This is not an exactly-once transaction across the runtime and your database.
Authorization, transactional writes and idempotency stay in your tools: use
`context.idempotencyKey`.

### History in pages

`historyPage({ limit, before })` (`GET /clients/:id/history?limit=50`) answers
whole turns, oldest first, with at least `limit` messages where there are that
many: `{ entries: [{ index, message }], next, total }`. Pass `next` as `before`
for the page before it (`null` at the start). A settled page never changes, so it
can be cached. `history()` answers the whole transcript.

### Portable use

The portable entry (`@camelai/run`) imports no Node modules and reads
environment variables only where the platform has them, so it runs on
Cloudflare Workers and other runtimes without a filesystem. A client keeps its
stream's cursor in memory; a new one starts from a snapshot of the running turn.

### The wire

`GET /clients/:id/events` streams SSE; `POST /clients/:id/requests` accepts
idempotent requests; `POST /clients/:id/mcp` carries the application's MCP
messages; all with the agent's token as `Authorization: Bearer`. `/clients/*`
refuses requests with a browser `Origin`. Application code should use the SDK
rather than speak this protocol.

## Agent identity and Studio

`name` identifies an agent and `type` groups agents in Studio, e.g. `September
release` and `Docs launch`, both `release-reviewer`. Rename or regroup without
changing its history with `agent.client.setMetadata({ name, type })`
(`set_metadata(name=, type=)`). SDK-created agents appear in a local Studio
(`npm run studio`) at `/studio/agents`; Studio observes the runtime, and your
application keeps serving its tools.

## 0.11.2 (TypeScript) / 0.7.2 (Python), 2026-10-01

- `@camelai/run` and `camelai-run` ship this version's docs for coding agents:
  `SKILL.md` (the setup skill also served at https://run.camelai.com/SKILL.md)
  and `sdk.md` (this reference), at `node_modules/@camelai/run/docs/` and next
  to `camelai_run`'s code. `camelai_run` is now a package rather than a single
  module; imports are unchanged.
- A missing API key's error (`new Agents()`, `Agents()`, the CLI) says where to
  create one, https://run.camelai.com/console/tokens, and points coding agents
  at SKILL.md.
- `npm create @camelai/run-app` writes an `AGENTS.md` (and a `CLAUDE.md` that
  imports it) for coding agents, and its agent names no model, so it gets the
  account's default; `AGENT_MODEL` still chooses one.

## 0.11.1 (TypeScript) / 0.7.1 (Python), 2026-09-30

- `@camelai/run/watch` (and so `createAgentChat`) reads a snapshot's history before
  asking whether a turn runs. A message sent just as the watcher connected could
  otherwise show in history with no turn running, and a chat's status went
  `submitted`, `ready`, `submitted` before the reply streamed.
- `verifyRuntimeToken` / `serveTools` (`verify_runtime_token` / `serve_tools`)
  with `runtime` set to either of the hosted runtime's URLs,
  `https://run.camelai.com` or `https://agents.camelai.dev`, expect the issuer
  `https://agents.camelai.dev`, which the hosted runtime's identity tokens name
  at both. Pass `issuer` to expect another.
- The default `url` (and the CLI's) is `https://run.camelai.com`, the hosted
  runtime's new address. `https://agents.camelai.dev` keeps working, with the
  same agents, tokens and OAuth grants, so an earlier version or a configured
  URL needs no change.
- `close()` stops `onEvent` (`on_event`): events still queued when it is called
  are dropped instead of handed over, and `close()` waits only for the call in
  progress. Before, a slow handler kept being called for the whole backlog after
  `close()` returned.

## Changes in 0.9 (Python 0.5)

- New: `Agents`, `upsert`, `run`, `stream`, `Run`, `RunError`, `input.answer()`.
  The lower-level API stays.
- The default `url` is `https://agents.camelai.dev` (was localhost); the API key
  also reads `CAMELAI_API_KEY`.
- `onEvent` is no longer awaited in the stream: handlers run in order apart from
  it, and their errors go to `onError`. Python's async `on_event` now runs.
- Requests have no default timeout (was 180 s); pass `signal` / `timeoutMs`
  (Python `timeout=`). At most 1000 may wait at once (was 8).
- A tool returning `undefined` sends `null` (was a failure).
- `context.idempotencyKey` is the stable key for side effects; `callId` changes
  with each attempt, as it always did.
- Tools may time out per tool (`timeoutMs`, `@tool(timeout=)`) and report
  `context.progress()`.
- Python tools may be plain functions (run in a thread).
- One process serves an agent's tools at a time (`APPLICATION_CONNECTED`,
  `takeover`, `attach: false`).
- `agent.session`'s token is left out of logs and JSON; use `agent.id` to name an
  agent.
- The types no longer come from Pi: `Message`, `AgentEvent` and the rest are the
  SDK's own.
- Keyed agents (made with an idempotency key) live until deleted, and upsert
  instead of failing when their configuration changes (server-side). The
  lower-level `createAgent` / `create_agent` without a key of yours still makes a
  scratch agent that lives a day.
- `serveTools`, `runtimeAuth`, `verifyRuntimeToken` (`serve_tools`,
  `verify_runtime_token`) require `tenant`, and refuse other tenants' tokens.
- `nodeListener` no longer trusts `X-Forwarded-*` unless `trustProxy: true`; set
  `origin` behind a proxy.
- The session's token is left out of its JSON (TypeScript) and it is not
  JSON-serializable (Python): store credentials explicitly,
  `{ id: session.id, token: session.token }` or `session.credentials()`.

## Examples

[`examples/`](../../examples) has runnable programs, each of which exits when done:

| | |
| --- | --- |
| [`quickstart.ts`](../../examples/quickstart.ts), [`quickstart.py`](../../examples/quickstart.py) | the quickstart |
| [`stream.ts`](../../examples/stream.ts) | streaming a run to the terminal |
| [`approval.ts`](../../examples/approval.ts) | a tool that needs approval, answered in code |
| [`release-board.ts`](../../examples/release-board.ts), [`inventory.py`](../../examples/inventory.py) | an application's tools over its own data |
| [`team-todos.ts`](../../examples/team-todos.ts) | served tools with the runtime's identity tokens |
| [`file-report.ts`](../../examples/file-report.ts) | files in and out |

Each reads `CAMELAI_API_KEY` (and `CAMELAI_BASE_URL` for a runtime of your own).
`npm run demo:clients` runs the release board and inventory examples against a
temporary local runtime with scripted code, calling no model.
