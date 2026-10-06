# SDKs

The TypeScript SDK (`@camelai/run`) and the Python SDK
(`camelai-run`). Start with the [Quickstart](../quickstart.md);
this page is the reference. The two have the same features, named in each
language's style; their version numbers are their own and do not line up.

```sh
npm install @camelai/run      # Node 22+, Bun, Deno, Cloudflare Workers
pip install camelai-run       # Python 3.11+; "camelai-run[server]" for serve_tools, "camelai-run[pydantic]" for pydantic output
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
  their runs go on in the runtime. A process serving tools first finishes the
  calls it is running, up to `drainMs` (Python `drain=`, seconds; default 25 s),
  while new calls go to another process: call it on SIGTERM. See [deploying a
  tool process](../guides/tools.md#deploying-a-tool-process).
- `connection` (Python `connection=`) says when agent handles hold their event
  stream. `"lazy"`, the default: only while `agent.stream()` reads a run, so a
  server holding many agents (50 keyed agents behind one page, say) holds no idle
  connections, and `agent.run()` waits for its outcome by asking for it (`GET
  /clients/:id/requests/:id?wait=25`, again until it settles). A handle that serves
  tools, or has `onEvent`, `onInput` or `onConnection` (`on_event`, `on_input`),
  needs the stream throughout, so it holds it from `upsert`/`get` until `close()`
  whatever this says. `"eager"` holds it from the start for every handle. Each
  `upsert`, `get`, `fork` and `agent` call may say otherwise (`connection`).
  The lower-level `connectAgent` (`connect_agent`) stays eager unless asked.
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
| `keyScope`, `spendLimit`, `runLimits`, `modelHeaders` | `key_scope=`, `spend_limit=`, `run_limits=`, `model_headers=` | see [Models and keys](../guides/models-and-keys.md) |
| `mounts`, `fileTools` | `mounts=`, `file_tools=` | its volumes (fixed at creation), and whether it has file tools |
| `codeMode` | `code_mode=` | `false`: no `js_exec`; every tool is called directly, and an agent with no tools at all gets little more than its instructions as its system prompt. See [Tools](../guides/tools.md#without-code-codemode-false) |
| `name` | `name=` | a label, shown in the console |
| `builtins` | `builtins=` | tools the runtime answers itself, without a definition: `web_fetch`, `web_search`, `schedule`, `ask_user`, `delegate` |
| `delegate` | `delegate=` | sub-agents it may hand tasks to (`{ agents, instructions?, maxDepth?, maxParallel? }`); brings its builtin. See [Multi-agent](../guides/multi-agent.md) |
| `subagents` | `subagents=` | also deliver its sub-agents' progress: `subagent_start`, `subagent_event`, `subagent_end` events, and stream parts |
| `attach` | `attach=` | `false`: declare `tools` without serving them (another process does) |
| `takeover` | `takeover=` | replace the process serving the tools now |
| `onEvent(event, runId)` | `on_event=` | every event, for display; runs in order, apart from the connection; plain or async |
| `onInput(input)` | `on_input=` | each input as it is asked: return an answer, or nothing |
| `onError(error)` | `on_error=` | errors from the connection and from `onEvent` |

### `agents.get(keyOrId, { tools, … })`

The existing agent with this key (or id), as it is: `upsert` sets an agent to
the `config` it is given, `get` changes nothing. Use it where a process only
runs or reads agents that another process configures. It throws an `AgentError`
with `status` 404 when no live agent has the key or id, and 409
`AGENT_KEYLESS` for an agent made without a key. It takes `tools`, `onEvent`,
`onInput`, `onError`, `attach` and `takeover` as `upsert` does (Python:
`await agents.get(key, tools=[…])`). REST: `GET /v1/agents/{keyOrId}/credentials`
gives the agent's `{id, token, expiresAt}`, to the account's own credentials
only (an API token, an OAuth grant, a console session): a browser token gets
403 and an agent's token 401, and browsers get no CORS access to it. From `@camelai/run` 0.13.1 and
`camelai-run` 0.9.1.

`agents.agent(session, { tools, … })` connects to an agent you hold the
credentials of (`{id, token}`) without changing it.

`agent.configHash` (Python `agent.config_hash`), from `upsert` and `get`, is a
hash of the agent's configuration (from `upsert`, the one it asked for). Equal
hashes are equal configurations: an upsert that changes nothing returns the
hash the agent has, and is not counted as an agent create. Every agent's is in
`agents.runtime.listAgents()` (`list_agents()`), so a deploy script can tell
what changed without keeping a manifest. It is opaque: compare it, never parse it.

### `Agent`

| TypeScript | Python | |
| --- | --- | --- |
| `agent.id` | `agent.id` | `client_…`: safe to log and store |
| `agent.run(text, options)` | `await agent.run(text, …)` | send a message, wait for the run: a `Run` |
| `agent.stream(text, options)` | `agent.stream(text, …)` | the run as it happens: `for await` / `async for` over parts |
| `agent.pendingInputs()` | `pending_inputs()` | inputs waiting on people, each with `answer()` |
| `agent.history()`, `historyPage({ before, limit })` | `history()`, `history_page(before=, limit=)` | the whole history (a list of messages, oldest first), or a page of whole turns |
| `agent.steer(text, options)` | `steer(text, …)` | hand the running turn a message (else start one), answered as soon as the runtime has it: `{id, status: "accepted" \| "taken" \| "queued", steeredInto?}`. `wait: true` (`wait=True`) resolves with the run that took it instead, as `run(text, { whileRunning: "steer" })` |
| `agent.configure({ model, instructions, thinkingLevel, tools })` | `configure(…)` | change it between runs |
| `agent.schedule({ text, inSeconds, at, everySeconds })` | `schedule(…)` | wake it later; `schedules()`, `unschedule(id)` |
| `agent.files` | `agent.files` | `list`, `download`, `upload`, `link` by the paths the agent sees |
| `agent.abort({ queued })` | `abort(queued=)` | stop the agent: its running turn, and the runs queued behind it (each fails with code `cancelled`); `queued: "keep"` stops the running turn only. Resolves with `{aborted, cancelled}` |
| `agent.fork({ key, name, atMessage, ttlSeconds })` | `fork(key=, name=, at_message=, ttl_seconds=)` | a new agent with its configuration, a copy of its history and of its files: see [Forking](#agentforkoptions) |
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
| `history` | `history=` | `"none"`: the model sees the instructions and this message only, not the agent's history; the run is still recorded. See [Runs without the history](../concepts.md#runs-without-the-history) |
| `whileRunning` | `while_running=` | `"queue"` (default) or `"steer"` |
| `spendLimit` | `spend_limit=` | `{usd}`: this run's own budget; see [Spend limits](../guides/models-and-keys.md#spend-limits) |
| `allowDisconnected` | `allow_disconnected=` | run even with nobody serving the agent's tools (else refused: `APPLICATION_NOT_CONNECTED`) |
| `output` | `output=` | structured output: a zod (or other Standard Schema), TypeBox or JSON Schema (Python: a pydantic model class, or a JSON Schema dict) for an object; the answer is `run.output`. See [Structured output](../guides/structured-output.md) |
| `traceparent` | `traceparent=` | a W3C trace context (`00-<trace-id>-<span-id>-<flags>`), sent as the `traceparent` header: when the tenant exports telemetry (`runtime.telemetry`), the run's spans continue your trace, under that span. Not part of the run's idempotency |

### `agent.fork(options)`

A new `Agent` made from this one: its configuration, a copy of its history and
a fork of its workspace, each its own from then on ([Forking](../concepts.md#forking)).
`atMessage` (Python `at_message=`) ends the copied history at a history index
(that message and the tool results answering it) or a request id (that run's
whole turn); by default it ends with the last turn that finished, never mid-turn.
`key` is the fork's own: forking again with it returns the same fork, and
`agents.get(key)` finds it; without one, the SDK makes one up for its own retries
and the fork lives a day (`ttlSeconds` to change that), as `createAgent`'s
does. `subject`, `context`, `instructionsAppend` (Python `instructions_append=`)
and `modelHeaders` (`model_headers=`) are the fork's own instead of the source's. It takes `tools`, `onEvent` and the rest as `agents.get` does.
`fork.forkedFrom` (`forked_from`) is `{agentId, atMessage}`. `agents.fork(id,
options)` forks an agent by id. Lower level: `runtime.forkAgent(id, options)`
(`fork_agent`) returns the fork's credentials and `forkedFrom`. REST: `POST
/v1/agents/{id}/fork`. From `@camelai/run` 0.13.1 and `camelai-run` 0.9.1.

```ts
const fork = await agent.fork({ key: "support-b", atMessage: 5 });
await fork.run("Try the other approach");
```

### `agents.run(config)` and `agents.runs`

A stateless run ([guide](../guides/stateless-runs.md)): a configuration and an
input in, a `Run` out, nothing carried over and no agent made.

```ts
const run = await agents.run({ instructions: "Vote yes or no.", input: "Ship on Friday?", output: Vote });
```

```python
run = await agents.run("Ship on Friday?", instructions="Vote yes or no.", output=Vote)
```

`config` takes an agent's configuration (`model`, `instructions`,
`instructionsAppend`, `definition`, `builtins`: `web_fetch`, `web_search`,
`delegate`; `delegate`, `thinkingLevel`, `subject`, `context`, `keyScope`,
`runLimits`, `modelHeaders`, `mounts`, `fileTools`, `name`) and the run's own:
`input`, `files` (inline bytes), `output`, `user`, `metadata`, `idempotencyKey`,
`spendLimit`, `retentionSeconds`, `signal`, `throwOnError`, `traceparent`
(Python: snake_case keywords, `input` first). It resolves with a `Run` (no
`inputs`), and throws a `RunError` when the run failed unless
`throwOnError: false`.

| `agents.runs.` | |
| --- | --- |
| `create(config, { wait })` | start one; resolves at once with the runtime's view (`StatelessRun`: `status` `running`…), or with `wait` once it ends within it |
| `get(id, { wait })` | the run, as it is or as it ended (`wait`: seconds, at most 25) |
| `stream(config)` / `stream(id)` | resolves with a stream of its parts (as an agent's, without `input_required`), `done` last; `result()` is the run |
| `abort(id)` | stop it: it ends `failed`, code `aborted` |
| `delete(id)` | delete it before its retention ends |
| `messages(id)` | its messages |
| `events(id, { lastEventId })` | its raw event frames, to its `response`, reconnecting with `Last-Event-ID` |

Python's `agents.runs.stream(input, …)` or `stream(run_id=…)` resolves with a
`StatelessRunStream`. The lower level is `runtime.createRun`, `getRun`,
`waitForRun`, `abortRun`, `deleteRun`, `runMessages` and `runEvents` (Python:
`create_run`, `get_run`, …).

### `Run`

`{ id, status, text, output?, inputs, error, usage, files, toolErrors, toolCalls, sourceErrors, raw }`
(Python: `tool_errors`, `tool_calls`, `source_errors`). `toolCalls` lists every
tool call the run made, with `ok` or an error `code`, not their arguments or
results (see [Run outcomes](events.md#run-outcomes)); a `delegate` call has its
sub-agent's `agentId`, and `usage.subagentCostUsd` is what its sub-agents spent. `status` is `completed`,
`input_required` or `failed`; `error` is `{ code, message, uncertain? }`.
`output` is a run with `output`'s answer, typed by its schema (`Run<T>`; Python:
an instance of the pydantic model). See
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
| `subagent_start`, `subagent_end` | with `subagents: true`: `toolCallId` (Python `id`), `agentId` (`agent_id`), `name` at the start, `status` at the end |
| `done` | `run`: always last |

`run.toolCalls` names a call's tool `tool` and its id `toolCallId`; stream parts
have the same values as `name` and `id`, and, from `@camelai/run` 0.13.1 and
`camelai-run` 0.9.1, also as `tool` and `toolCallId` (`tool_call_id`), so code
can use one name for both. `name` and `id` stay.

Every part but `done` has `raw`, the event it came from. `stream.result()`
resolves with the run; breaking out of the loop stops the reading, not the run.

## Tools

```ts
tool({ description, input: schema.Object({...}), execute: (args, context) => result, timeoutMs?, needsApproval?, exposure?, executionMode?, resultFormat? })
```

```python
@tool(name=None, description=None, timeout=None, needs_approval=None, exposure=None)
def or_async_def(arg: str, context: ToolContext): ...
```

`exposure` is how the model may call the tool: `"direct"` (as a tool of its
own), `"codemode"` (only from code in `js_exec`) or `"both"`. Left out, it is
`both` for an agent with up to 10 tools and `codemode` past that, so the model
can call your tools from `js_exec` unless they say `"direct"`; see
[Keeping tools out of js_exec](../guides/tools.md#keeping-tools-out-of-js_exec).

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
| `runtime.connectAgent(session, { tools, attach, takeover, connection })` | `runtime.connect_agent(session, tools=, attach=, takeover=, connection=)` | connect with stored credentials (`connection: "lazy"`: see [Agents](#agents)) |
| `runtime.browserToken(agentId, options)` | `runtime.browser_token(agent_id, …)` | a browser token |
| `runtime.me()` | `runtime.me()` | who the API key is: `tenant`, your tenant's id, which `serveTools` takes |
| `runtime.setProvider(name, config)`, `providers()`, `deleteProvider(name)` | `set_provider(name, base_url=, models=, api_key=, headers=)`, `providers()`, `delete_provider(name)` | a provider of your own: any OpenAI-compatible server and its models; see [Custom models](../guides/custom-models.md) |
| `runtime.listAgents()` | `runtime.list_agents()` | the tenant's agents, each with the `key` it was made with (`null` without one) and its `name` |
| `runtime.upsertDefinition(key, input)`, `createDefinition`, `updateDefinition`, `definition(s)`, `deleteDefinition` | `upsert_definition(key, …)`, `create_definition`, … | definitions; the same key is the same definition |
| `runtime.createVolume`, `volume(id)`, `mounts`, `setMounts` | `create_volume`, `volume(id)`, … | volumes and mounts |
| `runtime.inbox(state)`, `toolSources(agentId)` | `inbox(state=)`, `tool_sources(agent_id)` | inputs across agents; an agent's tools |
| `runtime.telemetry.set({ endpoint, headers, protocol, sampleRate, include: { content } })`, `get()`, `test()`, `clear()` | `await runtime.telemetry.set(endpoint, headers=, protocol=, sample_rate=, include_content=)`, `get()`, `test()`, `clear()` | export each run as an OpenTelemetry trace to your OTLP/HTTP endpoint (see [Telemetry](#telemetry)) |
| `client.prompt(text, { from, actor, files, metadata, whileRunning, output, idempotencyKey, signal })` | `client.prompt(text, from_=, …)` | a run's raw result: `{ reply, output, error, stopped, inputs, files, toolErrors, … }`; rejects on a runtime error. `output` here is `{ schema }`, a JSON Schema |
| `client.request(method, params, options)` | `client.request(method, params, …)` | any request (`prompt`, `continue`, `execute`, `configure`, `status`, `abort`); `traceparent` (`traceparent=`) continues your trace |
| `client.waitForRequest(id)` | `wait_for_request(id)` | wait for a request already sent, from any process |
| `client.requestStatus(id, { wait })`, `outcomes()` | `request_status(id, wait=)`, `outcomes()` | a request's record (`wait`: seconds, at most 25, to wait for it to settle first); every request's state |
| `client.answer(inputId, { action, content, from })`, `inputs(state)` | `answer(input_id, action=, …)`, `inputs(state=)` | inputs, raw |
| `client.execute(code)` | `execute(code)` | run code in the sandbox with the agent's tools, outside its history |
| `client.steerMessage(text, options)` | `steer_message(text, …)` | `prompt` with `whileRunning: "steer"`, answered as soon as the runtime has it: `{id, status: "accepted" \| "taken" \| "queued", steeredInto?}` (`client.prompt(text, { whileRunning: "steer" })` waits for the turn that took it) |
| `client.status()`, `client.abort({ queued })` | `status()`, `abort(queued=)` | whether the agent is busy (`busy`, `activeRun`, `queuedRuns`, as `GET /v1/agents/{id}` says too); stop it (its running turn, and unless `queued: "keep"` the runs queued behind it) |
| `client.steer(text)` | `steer()` | the legacy `steer` request, which holds the message for the running (or next) turn; new code uses `steerMessage` |
| `client.setMetadata({ name, type })` | `set_metadata(name=, type=)` | rename or regroup |
| `client.destroy()`, `close()` | same | delete the agent; close the connection |

`client.prompt()` resolves with the run's raw result, even when the model
failed (`result.error`), and rejects only on a runtime error. Requests have no
timeout unless you pass `timeoutMs` or `signal` (Python: `timeout`).

### Telemetry

`runtime.telemetry` (in the simple interface, `agents.runtime.telemetry`) is the
tenant's trace export, `/v1/telemetry`: each run becomes an OpenTelemetry trace,
with spans for its model calls and tool calls, sent to an OTLP/HTTP endpoint
(LangSmith, Langfuse, Honeycomb, Datadog, Tempo, your own collector). See
[Observability](../guides/observability.md) for the spans, presets and what is
exported.

```ts
await agents.runtime.telemetry.set({ endpoint: "https://api.honeycomb.io/v1/traces", headers: { "x-honeycomb-team": key } });
const { ok, traceId } = await agents.runtime.telemetry.test();   // one test span, sent now
const run = await agent.run("Summarize ticket 123", { traceparent }); // continues your trace
```

```python
await agents.runtime.telemetry.set("https://api.honeycomb.io/v1/traces", headers={"x-honeycomb-team": key})
result = await agents.runtime.telemetry.test()
run = await agent.run("Summarize ticket 123", traceparent=traceparent)
```

- `set` changes only what it is given: options left out keep their current
  values (their defaults the first time, when `endpoint` is needed). `headers`
  are stored encrypted and never returned: `get()` lists their names. Left out
  of a later `set`, they stay while the endpoint keeps its origin, and are
  dropped when it moves; `{}` removes them. `protocol` is `http/protobuf`
  (default) or `http/json`, `sampleRate` (`sample_rate=`) the share of runs
  traced (default 1), and `include: { content: true }` (`include_content=True`)
  also exports prompts, replies and tool arguments and results.
- `get()` is the settings with `status: { lastExportAt, lastError, lastErrorAt }`,
  or `null` (`None`) when none are set. `clear()` stops export: `{ deleted }`,
  false when nothing was set. `test()` is `{ ok, status?, error?, traceId, spanId }`.
- `traceparent` is also taken by `client.prompt`, `client.request`, and
  `createAgent` / `upsertAgent` (`create_agent` / `upsert_agent`) for their
  first `prompt`. A run's record (`client.requestStatus(id)`, typed as
  `RequestRecord`) carries `trace: { traceId, spanId, parentSpanId?, sampled }`
  while the tenant exports telemetry.

### Events, reconnects and replay

An eager client (and a lazy one, while something listens) holds one SSE stream
per agent (`GET /clients/:id/events`) and reconnects with backoff. A lazy client
without a listener holds none: each request it is waiting on asks for its own
outcome, a long poll of up to 25 s at a time, and a refusal for good (401, 403,
404, 410) fails it. When a listener comes (`agent.stream()`), the client
connects before sending the run, so the listener sees it from its start, and
lets the stream go once the last listener is gone; the next stream starts from a
snapshot, as a new client does. The runtime numbers events and replays them from memory
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
A connection that closes (`close()`) first POSTs a
`notifications/agent-runtime/draining` notification: the runtime sends it no new
calls, and it answers those it has before it disconnects. A connection replaced
by a takeover likewise stays open, up to 30 seconds, until its calls are
answered, then hears it was replaced.

A connection whose tools differ from those the agent was last given (the ready
event's `toolsHash`) declares them, between the agent's turns (`syncTools:
false` to leave them). One connection at a time serves an agent's tools. A second is refused with
`APPLICATION_CONNECTED` unless it asks to take over (`takeover`), or the one
serving them is closing; the SDK names
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
idempotent requests (with a W3C `traceparent` header, the run continues that trace); `POST /clients/:id/mcp` carries the application's MCP
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

## Unreleased

- A stream the runtime closes on purpose (`event: reconnect`: a drain, or the agent moved) is reconnected at
  once, resuming with `Last-Event-ID`; other closes keep their backoff. All the SDKs' event readers do this.
- `run`, `stream` and `client.prompt` take `history: "none"` (Python `history="none"`): the run sees the
  agent's instructions and its own message only, for many independent questions to one agent without an
  agent create each. `upsert` takes `codeMode: false` (`code_mode=False`, definitions too): no `js_exec`,
  and a tool-less agent's system prompt shrinks to its instructions and a sender note.
- `agent.configHash` (`config_hash`) from `upsert` and `get`, and `configHash` on `listAgents()`: an upsert
  of the configuration an agent has is not counted as an agent create.
- Agent handles connect lazily: `new Agents()` (`Agents()`) handles hold their
  event stream only while `agent.stream()` reads a run, instead of from
  `upsert`/`get` until `close()`, so a server with many agents holds no idle
  connections. Handles that serve tools or have `onEvent`, `onInput` or
  `onConnection` are unchanged. `connection: "eager"` (Python `connection="eager"`)
  on `Agents` or a single call keeps the old behaviour; the lower-level
  `connectAgent` / `connect_agent` take `connection: "lazy"` to opt in. A lazy
  handle's `upsert`/`get` no longer waits for a connection, so an unreachable
  stream shows up at the first run rather than there.

- Telemetry: `runtime.telemetry.get()`, `set(…)`, `test()` and `clear()` manage the
  tenant's OpenTelemetry trace export, and a `traceparent` option (Python
  `traceparent=`) on `run`, `stream`, `prompt`, `request` and a create's first prompt
  continues your trace. See [Telemetry](#telemetry). TypeScript exports
  `RequestRecord`, `TelemetrySettings`, `TelemetryInput` and `TelemetryTestResult`;
  Python's `create_agent` takes `prompt=`.
- CLI: `camelrun telemetry get|set|test|clear`, and `run --traceparent`.
- Stateless runs: `agents.run({ instructions, input, output })` (Python
  `agents.run(input, …)`) runs once with nothing carried over and no agent made;
  `agents.runs` creates, reads, streams, aborts and deletes them. See
  [Stateless runs](../guides/stateless-runs.md). CLI: `camelrun run --stateless`,
  `camelrun runs get <runId>`.

## 0.15.0 (TypeScript) / 0.11.0 (Python), 2026-10-03

Needs runtime 0.4.0 or later (run.camelai.com has it).

- Sub-agents: `delegate` settings on `upsert` / definitions (`delegate: { agents, instructions?, maxDepth?,
  maxParallel? }`, Python `delegate=`) turn on the `delegate` built-in. `subagents: true` on `stream` / `watch`
  (Python `subagents=True`) relays `subagent_start` / `subagent_event` / `subagent_end`; `run.toolCalls[].agentId`
  names the sub-agent, and `run.usage.subagentCostUsd` its spend. `@camelai/run-react`'s chat shows a sub-agent's
  transcript under its delegate call (`watch: { subagents: true }`). CLI manifests take `delegate`.

## 0.14.0 (TypeScript) / 0.10.0 (Python), 2026-10-03

Needs runtime 0.3.0 or later (run.camelai.com has it).

- Forking: `agent.fork({ key?, name?, atMessage? })` (Python `fork(...)`), `agents.fork(...)` and
  `runtime.forkAgent(...)` (`fork_agent`) copy an agent's configuration, committed history and workspace
  into a new agent; the result carries `forkedFrom` (`forked_from`). CLI `camelrun agents fork`.
- `agents.get(keyOrId, { tools, ... })` returns an existing agent's handle without changing its configuration
  (`runtime.agentCredentials()` / `agent_credentials()`).
- OpenTelemetry: `runtime.telemetry.get / set / clear / test` configures trace export, and a `traceparent`
  option on `run`, `stream`, `prompt`, `request` and create continues your trace. CLI `camelrun telemetry`
  (header values from `@env:VAR` or `@stdin`) and `run --traceparent`.
- Stream `tool_call` / `tool_result` parts also carry `tool` and `toolCallId` (`tool_call_id`), the names
  `run.toolCalls` uses; `name` and `id` stay.
- `RunError.status` is documented as 0 for run failures: branch on `code`.

## 0.13.0 (TypeScript) / 0.9.0 (Python), 2026-10-03

- Run limits: an agent or definition may set `runLimits: { maxResponses, maxSeconds }`
  (Python `run_limits=`), at most the runtime's maximums. A run that reaches one ends
  `stopped: "turn_limit"`; send another message to continue.
- A run whose model has no key, or whose key the provider refused, is `failed` with
  code `model_key_missing` / `model_key_invalid` and says what to do; `RunError`
  carries both.
- Compaction events may carry `background: true` (summaries now run in the
  background before a conversation reaches its limit); `compaction_end.skipped` is a
  string.
- `createAgentHandler`'s waited `send` returns `status`.
- The 409 for unconnected tools names each SDK's call (`connectAgent` /
  `connect_agent`).
- Python: `camelai-run[pydantic]` installs pydantic for output schemas, and
  `camelai_run.__version__`.
- CLI: reads the runtime's URL from `CAMELAI_BASE_URL` (as the SDKs do; `CAMELAI_URL`
  still works). `create-run-app` has a real `--help` and takes the key from the
  environment.

## 0.12.0 (TypeScript) / 0.8.0 (Python), 2026-10-01

- Structured output: `run(text, { output })` (`run(text, output=)`) takes a
  zod (4.2+), TypeBox or JSON Schema object schema (Python: a pydantic model
  class or a JSON Schema dict), and `run.output` is the answer, typed and
  parsed. A run that ends without one fails with `output_missing`; one the
  schema's own checks reject, with `output_invalid`. See
  [Structured output](../guides/structured-output.md). Needs a runtime with
  structured output (run.camelai.com has it).
- `run.toolCalls` (`run.tool_calls`): the tool calls a run made, each
  `{ tool, toolCallId?, innerCallId?, ok, code? }`, the first 100.
- `client.requestStatus(id, { wait })` (`request_status(id, wait=)`) waits up
  to 25 s for the request to settle. `createAgentHandler`'s `send` takes `wait`
  (`true` or 1–25 seconds) and returns the reply when the run ends, and a new
  `wait` action asks about an earlier message without sending it again.
- `close()` drains: it tells the runtime it is shutting down, finishes the tool
  calls it is running for up to 25 s (`drainMs` / `drain=`), then disconnects,
  so a deploy that closes on SIGTERM loses no call. `drainMs: 0` (`drain=0`)
  closes at once, as before; `destroy()` never waits.
- A confirmation (`context.confirm`) is answered with `answer(true)` /
  `answer(True)` or `false`, as the docs show.
- Python: the package ships `py.typed` and `__all__`, and its missing-key error
  names `CAMELAI_API_KEY`.
- `camelrun mcp`: `list_agents` reports `loaded` and `toolsConnected`, its
  errors no longer suggest CLI commands, and `add_schedule` is marked
  open-world.

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
