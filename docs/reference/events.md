# Events

An agent's event stream says what it is doing as it does it: text as the model
writes it, tool calls and their progress, questions it waits on, files it
presents. Use it for display. **A run's result is the truth; events are for
display**: a stream can drop events (a restart, a slow reader, a frame too
large), and every SDK settles a run from its outcome, never from its events.

- [Reading the stream](#reading-the-stream): endpoints, framing, cursors, snapshots
- [Frames](#frames): `event`, `response`, `snapshot`, `mcp`
- [Event types](#event-types): every `event.type`
- [Run outcomes](#run-outcomes): what a `response` frame carries
- [Webhook events](#webhook-events)

## Reading the stream

| Endpoint | Who | Mode |
| --- | --- | --- |
| `GET /clients/:id/events` | the agent's own token (the SDKs) | the application's connection: it also carries the runtime's MCP calls to the application's tools (`mcp` frames) |
| `GET /clients/:id/events?watch=1` | the agent's own token | a read-only watcher: every event, no MCP calls, holds nothing |
| `GET /v1/agents/:id/events` | an API key, or a [browser token](../guides/browser.md) | always a read-only watcher |

Query parameters and headers:

| | |
| --- | --- |
| `Last-Event-ID: <cursor>` | resume after this event id. Absent or `0` takes everything still buffered. |
| `?snapshot=1` | where the stream cannot replay what you missed (a first connect, or a cursor behind the buffer), send a [`snapshot`](#snapshot) of the running turn first instead of a 409. Watchers and polls (`?watch=1`, `?poll=1`, `/v1/agents/:id/events`) get one by default (`?snapshot=0` opts out); the application's connection only when it asks, as the SDKs do. |
| `?poll=1&wait=N` | answer once, as JSON, instead of streaming: `{cursor, events: [{id, data}]}`, where `data` is a frame. With `wait` (seconds, at most 25) and nothing buffered, it answers when the next event arrives or the wait ends. Poll again with `Last-Event-ID: <cursor>`. For clients that cannot hold a stream open. |
| `?request=<id>` | only that request's events, and its `response` frame: one run's progress, for a caller that sent it with `POST …/prompt` and wants nothing else. `ready`, `snapshot` and other frames that are not a request's still come. |
| `?subagents=1` | also send the agent's sub-agents' progress, from its `delegate` calls: [`subagent_start`, `subagent_event` and `subagent_end`](#sub-agents). Without it, none of them. The SDKs: `subagents: true` |
| `?takeover=true` | (application connection only) replace the process serving the agent's tools now. See [One application at a time](#one-application-at-a-time). |
| `X-Agent-Connection: <connection>` | (application connection only) reconnecting: the `connection` the last `ready` named, so the runtime knows it is the same application coming back. |

The response is `text/event-stream`. Each frame is `data:` JSON; most have an
`id:` line, the cursor. A comment line (`: heartbeat`) arrives about every
5 seconds, so a stream that delivers nothing for much longer than that is dead:
reconnect with the last cursor.

```text
event: ready
data: {"version":5,"agentId":"client_…","connection":"…"}

id: 1727520000000123
data: {"type":"event","requestId":"8c1…","event":{"type":"agent_start"}}
```

### `event: ready`

The first frame of every stream: `{version, agentId, connection?, watch?}`.
`connection` (the application's connection only) names this connection: the
application's MCP answers (`POST /clients/:id/mcp`) must carry it as
`X-Agent-Connection`, and a reconnect sends it back. `watch: true` on a watcher.

### `event: closed`

`{"reason": "replaced"}`: another process took over this agent's tools
(`?takeover=true`), and this stream ends. Do not take them back: to keep
following the agent, reconnect as a watcher (`?watch=1`), as the SDKs do (they
report `APPLICATION_REPLACED` to `onError`).

### `event: reconnect`

```text
event: reconnect
retry: 0
data: {"type": "reconnect", "reason": "drain", "retryMs": 0}
```

The last frame of a stream the runtime closes on purpose: its node is leaving
(`drain`: a deploy, a scale-in, a retiring task) or the agent is now served by
another node (`moved`). Reconnect at once, with `Last-Event-ID` set to the last
event id you took, and the stream goes on from there on the agent's next owner:
no backoff, nothing missed. The frame has no `id` (it is not an event and moves
no cursor), and `retry: 0` tells an `EventSource` to reconnect without waiting.
A stream that ends without it, or is cut off, is a failure: reconnect with your
usual backoff. The SDKs (TypeScript, Python, the browser watcher, chat and the
AI SDK adapter) do this. A long poll (`?poll=1`) is answered at once instead,
with what it has; poll again straight away.

### Cursors and gaps

Event ids rise, and an id is never reused, even after the agent moves to another
node. The runtime buffers each agent's recent events in memory (the
last 512, at most 2 MiB) for replay. A `Last-Event-ID` behind that buffer (after
a long disconnect, or after the agent moved to another node) cannot be replayed:
without a snapshot (the application's connection without `?snapshot=1`, or a
watcher with `?snapshot=0`) the stream answers **409 `REPLAY_GAP: recover from
session state`**; otherwise it starts with a `snapshot`. Recover what settled from
`GET …/state` (each request's outcome) and `GET …/history`. Nothing durable is
lost in a gap: only display events are.

### One application at a time

One process at a time serves an agent's tools (the application connection that
answered MCP's `initialize`). Another application connection is refused with
**409 `APPLICATION_CONNECTED`**, unless it asks `?takeover=true` (the one serving
gets `event: closed`) or names the connection it held
(`X-Agent-Connection`, reconnecting). Watchers and a connection that serves no
tools hold nothing. See [Concepts](../concepts.md) and [Errors](errors.md).

## Frames

### `event`

```json
{ "type": "event", "requestId": "…", "event": { "type": "message_update", … } }
```

One [event](#event-types). `requestId` is the run it belongs to (the id you sent
the prompt with, or the SDK's). It is `""` for events of no run: `turn_resumed`
and `turn_recovered`, and a file presented or a tool's progress when no run had
begun.

### `response`

```json
{ "type": "response", "id": "<requestId>", "outcome": { "result": { … } } }
{ "type": "response", "id": "<requestId>", "outcome": { "error": "…", "uncertain": true } }
```

A request settled. `outcome.result` is what it produced ([run
outcomes](#run-outcomes) for prompts); `outcome.error` means the runtime could not
carry it out, and `uncertain: true` that nobody can tell whether its work took
effect (a restart cut it short). The same outcome is at
`GET …/requests/:requestId` and in `GET …/state`, which is what to trust. There,
an ended request (`state: "completed"`) also carries `status` (`completed`,
`input_required` or `failed`), `error` (the runtime's, or the model's from
`result.error`) and `stopped` on top, so a failed run reads as failed without
looking inside `result`. `GET …/requests/:requestId?wait=<seconds>` (at most 25)
waits for a running request: it answers as soon as the request settles, or when
the wait ends with it still `running` (ask again), so a caller without the stream
gets the outcome in one call instead of polling.

A browser token sees an outcome only as `{id, outcome: {stopped?, error?}}`, its
`error` the model's too.

### `snapshot`

```json
{ "type": "snapshot", "cursor": 1727…, "requestId": "…" | null,
  "turn": { "start": 42, "count": 3, "messages": [ … ], "partial": { … } | null, "truncated": true } | null }
```

Sent (with `?snapshot=1`) in place of what the stream could not replay: the
running turn as a subscriber that saw every event since it began would have it.
`turn` is null when no turn runs. `messages` are the messages the turn finished,
in order; `partial` the assistant message streaming now. `start` is the index its
first message has in the agent's history (null if unknown), and `count` how many
it finished; the next message takes index `start + count`. `truncated`: the
messages were too large to send (over about 1 MB), so read them from history.
A snapshot restarts the stream at its `cursor`, even one below yours.

A browser token that neither reads `history` nor gets `message_end` sees
`turn: null`; one that does not get `message_update` sees no `partial`.

### `mcp`

```json
{ "type": "mcp", "message": { "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { … } } }
```

The application connection only: the runtime's JSON-RPC messages to the
application's tools (`initialize`, `ping`, `tools/list`, `tools/call`,
`notifications/cancelled`). They have no `id:` line and are never replayed. The
application answers each with `POST /clients/:id/mcp` (and may send
`notifications/progress` there). The SDKs do all of this; see
[Tools](../guides/tools.md).

## Event types

The model loop's events, then the runtime's. New types may be added: ignore
those you do not know. Marked *internal* are the runtime's own, which a browser
token does not receive unless it lists them in `events`.

### Runs and turns

| Type | Fields | When |
| --- | --- | --- |
| `turn_opened` | `index` | a model run (prompt, continue, resume) begins: `index` is where its first message will sit in the agent's history |
| `agent_start` | | the model loop starts |
| `turn_start` | | a model round starts (one response and its tool calls) |
| `turn_end` | `message`, `toolResults` | a round ends |
| `agent_end` | `messages` | the model loop ends: the messages it added |
| `turn_resumed` | `reason`, `handoff?` | the node running this turn was lost; it continues here, with unresolved tool calls marked unknown. With `handoff` (`retire`, `drain`): the node left the cluster at a step boundary, and the turn continues here with nothing lost; a `turn_opened` follows, and no `agent_end` came before it (`requestId` is `""`) |
| `turn_recovered` | `reason` | the runtime restarted during a turn; unresolved tool calls were marked unknown (`requestId` is `""`) |

### Messages

| Type | Fields | When |
| --- | --- | --- |
| `message_start` | `message` | a message begins: the user's, an assistant response (empty so far), a tool result |
| `message_update` | `assistantMessageEvent` | the assistant message streaming grew. The delta **alone**, without the message it updates: fold it into the message from its `message_start` (see below) |
| `message_end` | `message` | a message finished: this is the message as history keeps it |
| `message_retracted` | `index` | a response taken back (before a retry, or a compaction on overflow): the message at `index` is gone, and the next takes its place |
| `event_omitted` | `reason`, `was?` | an event was too large for the stream (over the transport limit, 1.1 MB). `was` is its type; for a `message_end`, the message still takes its place: read it from history |

`assistantMessageEvent` is one of:

| `type` | Fields |
| --- | --- |
| `start` | |
| `text_start`, `thinking_start` | `contentIndex` |
| `text_delta`, `thinking_delta` | `contentIndex`, `delta` (the new text) |
| `text_end`, `thinking_end` | `contentIndex`, `content` (the block's whole text) |
| `toolcall_start` | `contentIndex`, `id?`, `name?` |
| `toolcall_delta` | `contentIndex`, `delta` (more of the arguments' JSON; parse it partially) |
| `toolcall_end` | `contentIndex`, `toolCall` (`{type: "toolCall", id, name, arguments}`) |
| `done`, `error` | `reason?` |

Only `text_delta` is reply text. `thinking_*` is the model's reasoning, and
`toolcall_delta` is JSON. The SDKs' `stream()` yields only reply text, and the
watcher (`@camelai/run/watch`) folds all of them for you.
Not every model streams a tool call's arguments: some send them in one
`toolcall_delta` when the call is complete. `GET /v1/models` says which
(`toolCallStreaming`: `true`, `false` or `"unknown"`); see
[Models and keys](../guides/models-and-keys.md#choosing-a-model).

Messages (`message` fields, and history) are one of:

| `role` | Fields |
| --- | --- |
| `user` | `content`: a string, or `[{type: "text", text} \| {type: "image", data, mimeType}]`; `timestamp`. History also records `from`, `requestId`, `metadata` |
| `assistant` | `content`: `[{type: "text", text} \| {type: "thinking", thinking} \| {type: "toolCall", id, name, arguments}]`; `provider`, `model`, `usage`, `stopReason` (`stop`, `length`, `toolUse`, `error`, `aborted`), `errorMessage?`, `timestamp` (when the request started), `durationMs?` (how long the response took; absent on older messages) |
| `toolResult` | `toolCallId`, `toolName`, `content` (text and image blocks), `details?`, `isError`, `timestamp`, `durationMs?` (how long the tool ran) |
| `system` | `content`: instructions the runtime added (a changed configuration, a compaction summary) |

### Tools

| Type | Fields | When |
| --- | --- | --- |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | a tool call starts |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` | progress. A tool's own progress (MCP `notifications/progress`, `context.progress()`) arrives as `partialResult: {content: [{type: "text", text}], details: {type: "progress", tool, innerCallId?, progress, total?, message?}}`, at most every 250 ms per call. A call from js_exec code reports on js_exec's `toolCallId`, with `innerCallId` |
| `tool_execution_end` | `toolCallId`, `toolName`, `result` (`{content, details}`), `isError` | a tool call finished. A call that waits on a person ends first with a placeholder (`result.details.inputRequired`); when its turn resumes (the input answered, declined or closed) it gets its own `tool_execution_start` and `tool_execution_end` again, in the resume's run, before its `toolResult` message |
| `codemode` *internal* | `toolCallId`, `event: {type: "output", text}` | js_exec's code printed `text` (`console.log`, `text()`), as it runs |
| `output` | `text` | an `execute` request's code printed `text` (not a model run: no `codemode` wrapper) |
| `file_presented` | `file` (`{type: "file", path, volume, version, size, contentType, caption?, …}`), `url?`, `expiresAt?` | the agent presented a file to the user (`present_file`): `url` is a signed download link |

### People

| Type | Fields | When |
| --- | --- | --- |
| `input_required` | `input` | the turn waits on a person: a question, an approval, a form or a URL step. `input`: `{id, agent, requestId, toolCallId, kind: "question" \| "approval" \| "form" \| "url", message, detail, responders: {audience?}, state, createdAt, expiresAt}`; `detail` by kind: question `{questions}`, approval `{tool, source, arguments, argumentsHash, reason?}` (`arguments` an object, as in the call; past 4,000 characters of JSON, `argumentsPreview` instead), form `{requestedSchema}`, url `{url, origin}`. See [Human input](../guides/human-input.md) |
| `input_resolved` | `id`, `state` (`answered`, `declined`, `cancelled`, `expired`, `superseded`), `by?` | an input settled |

### Sub-agents

See [Multi-agent](../guides/multi-agent.md). The `subagent_*` events reach only streams that ask for them (`?subagents=1`).

| Type | Fields | When |
| --- | --- | --- |
| `subagent_start` | `toolCallId`, `agentId`, `requestId`, `name`, `depth` | a `delegate` call started (or, on a resumed turn, found) its sub-agent `agentId`, running request `requestId` |
| `subagent_event` | `toolCallId`, `agentId`, `event` | one of the sub-agent's events, as its own stream has it, its streamed text (`message_update`) left out. A sub-agent's own `subagent_*` events arrive nested in its `subagent_event`s. Relayed while the sub-agent runs on its parent's node; its own stream has them all |
| `subagent_end` | `toolCallId`, `agentId`, `requestId`, `status` (`completed`, `input_required`, `failed`), `error?` | the sub-agent's run ended, or its parent stopped waiting for it |

### The runtime

| Type | Fields | When |
| --- | --- | --- |
| `auto_retry_start` | `attempt`, `maxAttempts`, `delayMs`, `errorMessage` | a transient provider failure (overload, rate limit, 5xx, dropped stream) is being retried; the failed response was retracted |
| `auto_retry_end` | `success`, `attempt`, `finalError?` | retrying ended |
| `model_stream_stalled` | `phase` (`first_token`, `idle`), `ms`, `provider`, `model` | the model's stream went quiet (nothing before its first token for `runLimits.firstTokenSeconds`, or nothing mid-response for `idleSeconds`), so the runtime ended the request; it is retried like any transient failure, and when retries run out the run fails with code `model_stream_stalled`. Provider keep-alives do not count as an answer |
| `steer_taken` | `steeredInto` | a prompt sent with `whileRunning: "steer"` (its id is the frame's `requestId`) was read by the running turn `steeredInto`: the model has it, and its request has completed |
| `run_cancelled` | `reason` (`stopped`) | a run queued behind the running one was cancelled by a stop (`POST /v1/agents/:id/abort`) before it began; its `response` follows, with code `cancelled` |
| `compaction_start` | `reason`, `background?` | the conversation is being summarized to fit the model's context. With `background: true` it is made between or alongside runs, outside any run's request (`requestId` is empty), and nothing waits for it |
| `compaction_end` | `reason`, `background?`, and `skipped`, or `tokensBefore`, `summarizedMessages`, `keptMessages`, or `error` | summarizing ended |
| `compaction_usage` *internal* | `provider`, `model`, `usage`, `timestamp`, `background?` | what the summary's model call used |
| `context_trimmed` | `retainedMessages`, `omittedMessages` | older messages were left out of a model request to fit it |
| `spend_limit_reached` *internal* | `message` | the agent (or tenant) reached its spend limit; the turn stops after this response's tool calls |
| `turn_limit_reached` *internal* | `message` | the run reached its limit of model responses or time (`runLimits`); the turn stops after this response's tool calls |

## Run outcomes

A prompt's `response.outcome.result` (and `GET …/requests/:id`'s `outcome`):

| Field | |
| --- | --- |
| `reply` | the final assistant message's text; absent when it said nothing |
| `output` | a prompt sent with `output`: the answer, which fits its schema. See [Structured output](../guides/structured-output.md) |
| `replyIndex` | that message's index in the agent's history |
| `messages` | how many messages the agent's history holds after the run |
| `error` | the model's error (a provider refusal after retries), or `null` |
| `code` | a stable name for `error`, where the runtime gives one: `model_key_missing` (no key for the agent's model), `model_key_invalid` (the provider refused the key), `output_missing` (a structured run ended without its output), `model_stream_stalled` (the model stopped answering mid-request, past every retry), `aborted` (the agent was stopped while the run went), `cancelled` (a stop cancelled the run before it began), `spend_limit`, `turn_limit` |
| `stopped` | why the run stopped early: `input_required` (it waits on `inputs`), `spend_limit` or `turn_limit` (its model responses or time, see [run limits](../guides/models-and-keys.md#run-limits)), with the reason in `error` |
| `inputs` | when `stopped` is `input_required`: the pending inputs (as `input_required` carries them) |
| `files` | files the run wrote (at most 100): `{path, version, size, contentType, …}` |
| `presented` | files the run presented to the user (at most 20) |
| `toolErrors` | tool calls that did not complete (the model was told): `{tool, toolCallId?, innerCallId?, code, outcomeUnknown?, message}`; `code` is `timeout`, `connection_lost`, `not_connected`, `source_unavailable` or `failed`. See [Errors](errors.md#tool-errors) |
| `toolCalls` | every tool call the run made, in order, the first 100: `{tool, toolCallId?, innerCallId?, ok, code?, agentId?}`; `agentId` is the sub-agent a `delegate` call ran. A call from `js_exec`'s code has js_exec's `toolCallId` and its own `innerCallId`; `js_exec` itself is not listed. `code`, when `ok` is false: a `toolErrors` code, `tool_error` (the tool answered with an error), `input_required` (it waits on a person; the run that resumes it lists it again) or `aborted`. Arguments and results are left out: read them from history (`GET /v1/agents/:id/history`) by `toolCallId` |
| `sourceErrors` | tool sources (MCP servers, OpenAPI specs) that could not be listed, so the model went without their tools: `{kind, source, message}` |
| `usage` | what its model responses used: `{responses, input, output, cacheRead, cacheWrite, costUsd}`, and `subagentCostUsd` when its sub-agents spent something (theirs, apart from `costUsd`) |

An `execute` request's result is `{output: string[], truncated}` (plus `files`,
`presented`, `toolErrors`, `toolCalls`, `sourceErrors` as above). A steered prompt's request
completes as soon as the running turn reads its message, with `{steeredInto}` as its result and on
its record: the turn's own request has the turn's outcome. Its 202 says how it was taken at once
(`steer`: `accepted` by the running turn, or `queued` as a turn of its own).

The SDKs turn this into a typed `Run`: `status` (`completed`, `input_required`,
`failed`), `text`, `output`, `inputs`, `error: {code, message, uncertain?}`, `files`,
`toolErrors`, `toolCalls`, `sourceErrors`. A browser token never sees a run's
result, `toolCalls` included: only whether and why it stopped.

## Webhook events

A tenant's webhook endpoints (`POST /v1/webhooks {url, events}`) receive
signed events (Standard Webhooks) in an envelope `{id, type, created, data}`;
dedupe by `id`. See [Webhooks](../guides/webhooks.md).

| Type | `data` |
| --- | --- |
| `run.started` | `agentId`, `requestId`, `method` (`prompt`, `continue`, `resume`, `execute`), `actor?`, `metadata?`, `resumes?` |
| `run.completed` | the above, `usage` (`{responses, input, output, cacheRead, cacheWrite, costUsd}` or null), `stopped?`, `inputIds?`, `replyIndex?`, `messageCount?`, `steeredInto?` |
| `run.failed` | the above, `usage`, `error`, `code?` (the outcome's code: `cancelled`, `aborted`, `model_stream_stalled`, `turn_limit`…), `uncertain?`, `steeredInto?` |
| `input.requested` | `agentId`, `requestId`, `inputId`, `toolCallId`, `kind`, `expiresAt` |
| `input.resolved` | `agentId`, `requestId`, `inputId`, `state` |
| `usage.recorded` | `agentId` (null for a [transcription](../guides/voice.md) made alone), `requestId`, `subject`, `actor`, `context`, `keyScope`, `provider`, `model`, `kind` (`response`, `compaction`, `transcription`), `input`, `output`, `cacheRead`, `cacheWrite`, `reasoning?`, `audioSeconds?` (a transcription's), `cost: {usd, source}`, `at` |
