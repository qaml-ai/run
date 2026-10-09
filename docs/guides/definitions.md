# Definitions

A definition is a reusable agent configuration: name, model, system prompt,
thinking level, tool sources (built-ins, remote MCP servers and OpenAPI specs),
limits (`ttlSeconds`), run limits (`runLimits`, see [Run limits](models-and-keys.md#run-limits)) and mounts. Manage them with the SDKs
(`agents.runtime.upsertDefinition`, `createDefinition`, `updateDefinition`,
`definition(s)`, `deleteDefinition`; `upsert_definition` and so on in Python),
`/v1/definitions`, or the console's Definitions page, and make agents from one.
`upsertDefinition(key, …)` (`POST /v1/definitions` with an `Idempotency-Key`) is
the one to run at every deploy: the same key is the same definition, set to what
you send (fields left out are cleared), with a new revision only when that
changes it. `createDefinition` makes a new one each time.

```ts
const definition = await agents.runtime.upsertDefinition("support", {
  name: "Support", model: "anthropic/claude-sonnet-5-5", systemPrompt: "You answer support tickets.",
  builtins: ["web_search", "ask_user"],
  mcpServers: [{ name: "app", url: "https://app.example.com/mcp", auth: { type: "runtime" } }],
});
const agent = await agents.upsert(`ticket-${ticket.id}`, { definition: definition.id, subject: ticket.customerId });
```

Saving a definition lists its MCP servers: credentials a server refuses are a
400 that says so, and the answer's `toolSources` shows what each offers.

A definition is where a source's credentials go: they are sealed once, for all
its agents. An agent without a definition, or a stateless run, can list MCP
servers of its own, but without credentials (identity tokens or none); see
[An agent's own MCP servers](tools.md#an-agents-own-mcp-servers). An agent made
from a definition has only its definition's sources.

Each MCP server and OpenAPI source takes `exposure`: `"direct"` (the model calls
its tools itself), `"codemode"` (only from code in `js_exec`) or `"both"`. Left
out, a source of up to 10 tools is `both` and a larger one `codemode`, so by
default the model can call them from `js_exec`. Set `"direct"` on a source whose
tools must never be called from code; see
[Keeping tools out of js_exec](tools.md#keeping-tools-out-of-js_exec).

A `description` (1–1,000 characters) says what its agents are for; models see it
as the description of each agent's [MCP tool](mcp-server.md), and as what it is
for when another definition can delegate to it.

`delegate`, with its builtin, lets its agents hand tasks to sub-agents:
`"builtins": ["delegate"], "delegate": {"agents": ["researcher"]}`. It may name
definitions not saved yet, so two can name each other. See
[Multi-agent](multi-agent.md).

The definition supplies the model, prompt, thinking level, `maxOutputTokens`,
`temperature` and tool sources;
`name`, `ttlSeconds`, `mounts` and `initialMessages` given alongside it override
its defaults, and tools of your process (`tools`) are added as its attached
server.

An agent can also have configuration of its own, which applying its definition
leaves alone:

```json
{"definition": "def_…", "model": "anthropic/claude-opus-5", "thinkingLevel": "low",
 "systemPromptAppend": "Thread thr_123 in workspace ws_9."}
```

- `model`, `thinkingLevel`, `maxOutputTokens`, `temperature` and `runLimits` given
  at creation, or later through `PATCH /v1/agents/:id/configuration`, and
  `fileTools` given at creation, are the agent's own: an apply changes every other
  field and keeps them. `null` set through configuration is the agent's own too.
  An agent's own temperature that the definition's new model or thinking level
  cannot take is left out of its calls (see
  [Output length and temperature](models-and-keys.md#output-length-and-temperature)).
- `systemPromptAppend` is text the model reads after the definition's prompt
  (after the runtime's default prompt without one), e.g. per-conversation
  context. An apply replaces the prompt and keeps the addition; configuring
  `systemPromptAppend` changes it, and `""` removes it. Agents not made from a
  definition can have one too.
- `systemPrompt` cannot be given with a definition: the definition owns the
  prompt, so an apply would silently replace it. A `systemPrompt` configured
  on one agent later lasts until the next apply.

Every change is a new revision (`PATCH` replaces the fields given; `null`
removes one; `revision` makes it conditional). An agent records the definition
and revision it was made from (`definition` in `GET /v1/agents/:id`), and keeps
that configuration when the definition changes: only new agents get the new
revision. `PATCH … {"apply": "all"}` also reconfigures every live agent made
from the definition, through each agent's `configure` request, queued behind its
runs so it lands between turns; the application's attached tools are kept. Only
the tenant can apply a definition, never an agent's own token. `GET
/v1/definitions/:id/agents` lists the agents and the revision each has. Deleting
a definition leaves its agents as they are; a definition a channel uses cannot
be deleted.

To have every change reach live agents without asking each time, save the
definition with `applyOnUpdate: true`: every save that makes a new revision (an
upsert that changes it, or a `PATCH`) then applies it as `apply: "all"` does,
and answers with `applied`. An upsert that changes nothing, as at most deploys,
applies nothing. It suits definitions whose agents must all run the same tools
and prompt, such as one whose MCP server moved:

```ts
const definition = await agents.runtime.upsertDefinition("builder", {
  name: "Builder", systemPrompt: "You build bots.", applyOnUpdate: true,
  mcpServers: [{ name: "builder", url: "https://bots.example.com/builder/mcp", auth: { type: "runtime" } }],
});
// definition.applied: every live agent asked to take the new revision, when this deploy changed it
```

The response's `applied` lists each agent with its `requestId` and `status`:
`updated` (it has the revision), `queued` (it takes it after its current turn;
poll `GET /v1/agents/:id/requests/:requestId` for the outcome) or `failed`, with
an `error`. On the console's Channels page, **Model & prompt** opens a channel's
definition with apply selected.

`PATCH /v1/agents/:id/configuration` changes one agent's `model`,
`systemPrompt`, `systemPromptAppend`, `thinkingLevel`, `maxOutputTokens`, `temperature`, `keyScope`, `spendLimit` or `modelHeaders` without touching its definition or history:

```http
PATCH /v1/agents/client_…/configuration
Authorization: Bearer <API token>
Content-Type: application/json

{"requestId": "model-change-1", "model": "openrouter/openai/gpt-6-luna"}
```

It answers `202` with the request, which is queued like an applied definition
and survives a restart; poll it for the outcome, and reuse `requestId` to retry.
A model must be in `GET /v1/models`, and the tenant must have a key for its
provider, or the change is refused with `400`. So is a `temperature` the agent's
model or thinking level, after the change, cannot take. An agent that is not running
takes the change when it next starts.
