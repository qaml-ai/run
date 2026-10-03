# Concepts

## Agents are durable and keyed

An agent is a conversation that lasts: its history, its files, its configuration
(model, instructions, tools) and its pending work live in the runtime, not in
your process. Most agents are asleep at any moment and cost nothing; a message
wakes one on whichever node has room, and it picks up where it was.

You name an agent with a **key**, your own id for it: `support-triage`,
`user-123`, `thread-9f2c`. Keys are 1 to 80 letters, digits, `_` and `-`.

```ts
const agent = await agents.upsert("user-123", { model, instructions, tools });
```

- The same key is the same agent, from any process, for as long as you keep it.
  A keyed agent lives until you delete it (`agent.delete()`).
- `upsert` makes the agent when there is none, and otherwise brings it to the
  configuration you pass: a changed model, instructions or tool list is applied
  between its turns, and its history carries over. Who the agent acts for
  (`subject`, `context`), its definition and its mounts are fixed when it is
  made; changing them is a 409 that names the field. Delete it and upsert again
  to start over.
- A deleted key makes a fresh agent the next time, with a new id and token.
- Over REST, the key is the `Idempotency-Key` of `POST /v1/agents`.

Every agent also has an **id** (`client_…`), which is safe to log and store, and
a **token**, which lets its holder run it and nothing else. The SDKs keep the
token out of logs; you rarely need it, because upserting by key gives you the
agent again.

Agents made without a key are scratch agents: they expire after a day unless you
set `ttlSeconds`.

## Runs

A message to an agent starts a **run**: the model loop, with every tool call it
makes, until the model answers or something stops it. One run at a time: a
message sent while a run is going waits for it (`whileRunning: "queue"`, the
default) or joins it (`whileRunning: "steer"`: the running turn reads it after its
current step).

```ts
const run = await agent.run("Summarize ticket 123", { user: "alice" });
```

A `Run` has:

| field | |
| --- | --- |
| `id` | the run's id; pass `idempotencyKey` to choose it, and sending the same key again returns the same run instead of starting another |
| `status` | `completed`, `input_required` (it waits on a person: see `inputs`), or `failed` |
| `text` | the final reply |
| `output` | with `output: schema`, the answer in that shape ([Structured output](guides/structured-output.md)) |
| `inputs` | what it waits on, each with `answer()` |
| `error` | `{code, message, uncertain?}` when it failed |
| `toolErrors` | tool calls that did not complete (timed out, connection lost, no process serving the tools); the model was told and carried on |
| `toolCalls` | every tool call the run made (the first 100), calls from `js_exec`'s code included: `{tool, toolCallId, innerCallId?, ok, code?}`. Arguments and results are in history |
| `files` | files the run wrote |
| `usage` | what its model calls used, where the runtime reports it |

`run()` has no timeout: runs can take minutes, and a run waiting on a person can
wait for days. Pass an `AbortSignal` (Python: `timeout=`) to stop waiting; the
run itself goes on, and `agent.abort()` stops it. A failed run throws a
`RunError` carrying the run, unless you pass `throwOnError: false`.

### Long conversations

An agent's history can outgrow its model's context window, so the runtime
**compacts** it: older messages are summarized, and the model sees the summary
followed by the recent messages. History keeps every message (`/history`); only
what the model is sent changes.

Compaction runs in the background. Once the context comes within a margin of
its limit (32k tokens, or 15% of a smaller window, before the window less a
reserve for the reply), the summary is made after the run ends, or between
model requests, while the agent goes on: the next run starts at once with the
whole context, and the summary takes over when it is written. Only a run whose
context would not fit waits, for the summary being made or, if none is, for one
of its own. A provider that rejects a request as too long also gets a summary
and the request again. Summaries are billed like model responses (`kind:
"compaction"` in usage) and count against spend limits; one made between runs
belongs to no run. An agent compacts one summary at a time.

## The result is the truth; events are for display

An agent's **events** stream every step: text as the model writes it, tool
calls and their progress, inputs asked and answered. Use them to show the agent
working. Do not use them to decide what happened.

- The run's result (`run()`, the webhook `run.completed`, or `GET
  /v1/agents/:id/requests/:id`) is recorded durably and always arrives, even if
  your process restarts or the connection drops.
- The stream is replayed from memory on reconnect, as far as it goes. Where it
  cannot replay (a restarted node, a long disconnection), the SDK gets a
  snapshot of the running turn instead; streamed deltas in between are gone.

So reply to your user from the run, and render the stream as progress. See the
[event reference](reference/events.md).

## Tools: where they run

An agent's tools come from four kinds of place. Pick by where your code runs:

| Your situation | Use | How |
| --- | --- | --- |
| A long-lived server or worker, and the tools touch its state | **Attached tools** | `tools` on `upsert`; the SDK holds a connection and the runtime calls your functions over it. One process serves an agent's tools at a time; closing it on SIGTERM finishes its calls, so deploys lose none |
| Serverless functions, several instances, or one backend serving many users' agents | **Served tools** | `serveTools(tools)` on an HTTPS endpoint of yours, named in a **definition** with `auth: { type: "runtime" }`; the runtime calls it with a signed token saying who each call is for. Safe through your deploys and restarts |
| A third-party API | **OpenAPI** or **MCP** sources in a definition | the runtime calls the API itself, with credentials it stores sealed |
| Web search, fetching pages, scheduling, asking the user | **Built-ins**, on the agent or in its definition | `builtins: ["web_search", "web_fetch", "schedule", "ask_user"]` |

The same `tool({...})` definitions work attached and served, so you can start
attached and move to served without changing a tool (see [Several processes,
workers and deploys](guides/tools.md#several-processes-workers-and-deploys)). Every agent also has file
tools over its [files](guides/files.md), and `js_exec`, a sandbox where the model
writes code that calls all of its tools. See [Tools](guides/tools.md).

## Processes and connections

A process that has an agent's tools **attaches** to it: it holds the agent's
event stream and answers its tool calls. One process at a time does, so a tool
call never lands in the wrong process. A second process that tries gets
`APPLICATION_CONNECTED`, unless it passes `takeover: true`; the one it replaces
hears `APPLICATION_REPLACED` and goes on without serving the tools.

Any number of processes can **run** an agent without serving its tools: an
agent upserted without local tools, or with `attach: false`, follows the
agent's stream read-only. That is how serverless functions, webhook handlers and
second services run agents whose tools are served elsewhere.

A run of an agent with attached tools while no process serves them is refused
up front, with `APPLICATION_NOT_CONNECTED` (after a few seconds' grace for a
process reconnecting), rather than running without them. Pass
`allowDisconnected: true` to run anyway: calls to those tools then fail, and the
run lists them in `toolErrors` with code `not_connected`. Schedules, channels and
resumed runs are never refused, so agents that must work with nobody attached
should use served tools.

A process that connects with tools other than those the agent was last given
(it was restarted with changed code) declares its own, between the agent's
turns. `upsert` declares them anyway.

## People in the loop

A run can stop and wait for a person: the model asks a question (`ask_user`), a
tool needs approval before it runs, or a tool asks for a form or a setup step.
The run ends with `status: "input_required"` and its `inputs`; the agent sleeps,
for days if need be; answering the last input resumes it.

```ts
if (run.status === "input_required") run = await run.inputs[0].answer(true, { from: "alice" });
```

See [Human input](guides/human-input.md).

## Idempotency

Everything that changes something can be retried safely:

- `upsert` by key, and `run` / `POST /v1/agents/:id/prompt` by `idempotencyKey`
  (the request id): the same key returns the same agent or run.
- Every other POST takes an `Idempotency-Key` header: a retry with the same key,
  path and body gets the first answer again (for a day); the same key with a
  different body is a 409.
- Every tool call carries `context.idempotencyKey`, the same for every attempt
  of that call: a retry after a lost connection, or the call run again after a
  person answered. Key your side effects by it. (`context.callId` is new each
  attempt.)

A tool call whose answer was lost (the connection dropped, or its deadline
passed) is never sent again: the model is told its outcome is unknown, so it can
check before repeating anything.

## Waking later

An agent can be woken by a schedule (`agent.client.schedule({ text, inSeconds |
at, everySeconds })`, or the `schedule` built-in for the agent to set its own), by
a [channel](guides/channels.md) (Slack, Telegram, Discord), or by your own code
from a [webhook](guides/webhooks.md).

## Definitions

A **definition** is a reusable configuration: model, instructions, tool sources
(MCP servers, OpenAPI specs, built-ins), limits and mounts. Make agents from one
(`definition: "def_…"` on `upsert`), and roll a change out to all of them with
`apply: "all"`. See [Definitions](guides/definitions.md).
