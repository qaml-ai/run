# Stateless runs

A stateless run is one call: a configuration and an input in, the result out.
Nothing carries over between runs and no agent is kept, so fifty runs with the
same configuration are fifty independent answers, not one conversation.

```ts
import { Agents } from "@camelai/run";
import { z } from "zod";

const agents = new Agents(); // CAMELAI_API_KEY
const run = await agents.run({
  instructions: "You review release plans. Vote yes or no, with one reason.",
  input: "Ship the billing migration on Friday afternoon?",
  output: z.object({ vote: z.enum(["yes", "no"]), reason: z.string() }),
});
run.output; // { vote: "no", reason: "…" }
```

```python
from camelai_run import Agents
from pydantic import BaseModel
from typing import Literal

class Vote(BaseModel):
    vote: Literal["yes", "no"]
    reason: str

async with Agents() as agents:
    run = await agents.run("Ship the billing migration on Friday afternoon?",
                           instructions="You review release plans. Vote yes or no, with one reason.", output=Vote)
    print(run.output.vote)
```

```bash
curl -s https://run.camelai.com/v1/runs -H "Authorization: Bearer $CAMELAI_API_KEY" \
  -H "Content-Type: application/json" -d '{
    "systemPrompt": "You review release plans. Vote yes or no, with one reason.",
    "input": "Ship the billing migration on Friday afternoon?",
    "wait": true
  }'
# 200 with the ended run, or 202 with it still running: GET /v1/runs/<id>?wait=25 for the rest.
```

## Runs or agents

| | Stateless run (`POST /v1/runs`) | Agent (`POST /v1/agents`, `agents.upsert`) |
| --- | --- | --- |
| History | None: each run starts empty | Kept: each run continues the conversation |
| Lifetime | Its result is kept for a retention window (a day by default), then deleted | Until you delete it (keyed) |
| Tools | Built-ins (`web_fetch`, `web_search`, `delegate`), its own MCP servers, a definition's MCP servers and OpenAPI specs, `js_exec` | Also tools served by your process (`tools`), schedules and human input |
| Listed in `GET /v1/agents` | No | Yes |
| Use it for | Classify, extract, vote, judge, summarize: one answer per input | Chats, assistants, anything that remembers |

Use a run when the answer depends only on what you send. Use an agent when it
should remember, wait on a person, or call tools that run in your process.

## What a run takes

The fields an agent takes, plus the input:

- `input`: a string, or parts: `[{ "type": "text", "text": "…" }, { "type": "file", "name": "a.pdf", "data": "<base64>" }]`.
  Files (at most 4 MiB in all) give the run a workspace volume to hold them.
- `definition`: a definition's key or id, so the configuration is not sent each
  time. Fields given alongside override it, as for an agent.
- `model`, `systemPrompt`, `systemPromptAppend`, `thinkingLevel`, `maxOutputTokens`,
  `temperature` (see [Output length and temperature](models-and-keys.md#output-length-and-temperature)), `builtins`
  (`web_fetch`, `web_search`, `delegate`), `delegate`, `keyScope`, `modelHeaders`,
  `runLimits`, `subject`, `context`.
- `mcpServers`: MCP servers of its own, as an agent's: no credentials, only
  `"auth": {"type": "runtime"}` (identity tokens) or none. See
  [An agent's own MCP servers](tools.md#an-agents-own-mcp-servers).
- `output`: a schema for a structured answer (see [Structured output](structured-output.md)).
- `spendLimit`: the run's budget in USD.
- `fileTools: true`: a workspace and file tools. Without files or this, a run has
  no volume at all.
- `codeMode`: whether the model gets `js_exec`. A run with no tools at all (no
  definition, `builtins`, `delegate`, `mcpServers`, files or mounts) gets neither `js_exec` nor
  file tools, so its model sees only your instructions and the input: right for a
  classifier or a vote. A run with tools keeps `js_exec`. Set `codeMode` (or
  `fileTools`) to have it otherwise; what you set wins.
- `actor`, `from`, `metadata`: who sent it, and your own data, kept on the run.
- `retentionSeconds`: how long its result, events and messages are kept once it
  ends (60 to 604800; the runtime's default is a day).
- `wait`: `true` (up to 60 seconds) or a number of seconds to wait for the end.

The SDKs take the same configuration with their usual names (`instructions`,
`output` as zod, TypeBox or pydantic).

## Following a run

| | |
| --- | --- |
| `GET /v1/runs/{id}` | The run: `status` (`running`, `completed`, `failed`, `input_required`), `text`, `output`, `error`, `usage`, `toolCalls`, `toolErrors`. `?wait=25` waits for its end first |
| `GET /v1/runs/{id}/events` | Its events as server-sent events, ending with its `response`. Reconnect with `Last-Event-ID` and the stream picks up after it |
| `GET /v1/runs/{id}/messages` | Its messages: the input, the model's turns, tool results |
| `POST /v1/runs/{id}/abort` | Stop it: it ends `failed`, code `aborted` |
| `DELETE /v1/runs/{id}` | Delete it now, before its retention ends |

```ts
const stream = await agents.runs.stream({ instructions: "…", input: "…" });
for await (const part of stream) if (part.type === "text") process.stdout.write(part.text);
const run = await stream.result();

await agents.runs.get(run.id);       // as it ended
await agents.runs.abort(run.id);     // a running one
await agents.runs.messages(run.id);  // within its retention
```

**Events are replayable only for a short while.** A run's event stream replays
what it holds after `Last-Event-ID` while the run is going and for about five
minutes after it ends (while its node still holds it). After that, `/events`
answers with the run's `response` frame alone, and the record of what happened is
`/messages` (and `GET /v1/runs/{id}`), kept for the whole retention window.

## Idempotency

Send an `Idempotency-Key` (the SDKs' `idempotencyKey`, `idempotency_key`) and
the same key with the same body is the same run, while it is kept: a retry after
a lost response never starts a second one. The same key with another body is a
409 `IDEMPOTENCY_CONFLICT`. Without a key every create is a new run (the SDKs
make one up per call, so their own retries are safe).

## Durability

A run is as durable as an agent's run, within itself. If the node running it
dies, or a deploy retires it, the run goes on on another node from its last
completed step:

- A node that retires (a deploy) lets the step in flight finish, then hands the
  run to another node at that step boundary. Nothing is lost and nothing runs
  twice (`handoffs` lists them).
- A node that dies: another node resumes the run from its transcript, at most
  twice (`resumes`). A tool call that completed is not made again. A model call
  that was in flight is simply asked again. A tool call that was in flight when
  the node died has an unknown outcome, which the model is told, as for an agent.
  As for an agent, a run resumed after its node died reports in `usage` and
  `toolCalls` only what happened on the node that finished it; its messages have
  every step.
- A model that stalls (no first token within `runLimits.firstTokenSeconds`, or
  silent mid-answer for `runLimits.idleSeconds`) is retried, then the run ends
  `failed` with code `model_stream_stalled`: it never hangs.

## Limits and billing

A run counts as an agent's run does: against runs per minute, and against busy
agents while it runs (concurrency is what a run costs). It is not an agent create,
so creating runs does not count against agent creates, and it takes no place among
your agents. Model usage, agent time and web tools are billed as for agents. The
run's id is the `requestId` in usage webhooks and traces.

A run that cannot start (busy agents at their limit, runs per minute, no credit)
is refused with the same errors as an agent's prompt, and leaves nothing behind.
Busy agents and runs per minute are checked before anything is made, so a burst
past either is turned away cheaply (429 `BUSY_AGENT_LIMIT` or `RATE_LIMITED`, with
`Retry-After`).

## Notes

- **A run cannot wait on people.** `ask_user` and `schedule` are not among its
  built-ins. A tool that asks for approval or input (a definition's approval
  policy, an MCP server's elicitation) ends the run with status
  `input_required`, and for a run that is final: there is no way to answer it
  and resume. Use an agent for work that needs a person's go-ahead.
- **Servers with credentials, and OpenAPI specs, come through a definition.**
  A run's own `mcpServers` take no token or headers; name a definition with
  `definition` for those. Tools served by your process
  (`tools`, an attached MCP server) need an agent: a run has no process connected.
  Serve them over HTTP (`serveTools`) and name them in a definition instead.
- The CLI runs one with `camelrun run --stateless "…" [--definition key]`.
