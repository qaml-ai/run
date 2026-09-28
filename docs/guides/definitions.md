# Definitions

A definition is a reusable agent configuration: name, model, system prompt,
thinking level, tool sources (built-ins, remote MCP servers and OpenAPI specs),
limits (`ttlSeconds`) and mounts. Manage them with the SDKs
(`agents.runtime.createDefinition`, `updateDefinition`, `definition(s)`,
`deleteDefinition`; `create_definition` and so on in Python), `/v1/definitions`,
or the console's Definitions page, and make agents from one:

```ts
const definition = await agents.runtime.createDefinition({
  name: "Support", model: "anthropic/claude-sonnet-5", systemPrompt: "You answer support tickets.",
  builtins: ["web_search", "ask_user"],
  mcpServers: [{ name: "app", url: "https://app.example.com/mcp", auth: { type: "runtime" } }],
});
const agent = await agents.upsert(`ticket-${ticket.id}`, { definition: definition.id, subject: ticket.customerId });
```

The definition supplies the model, prompt, thinking level and tool sources;
`name`, `ttlSeconds`, `mounts` and `initialMessages` given alongside it override
its defaults, and tools of your process (`tools`) are added as its attached
server.

An agent can also have configuration of its own, which applying its definition
leaves alone:

```json
{"definition": "def_…", "model": "anthropic/claude-opus-5", "thinkingLevel": "low",
 "systemPromptAppend": "Thread thr_123 in workspace ws_9."}
```

- `model` and `thinkingLevel` given at creation, or later through
  `PATCH /v1/agents/:id/configuration`, and `fileTools` given at creation, are
  the agent's own: an apply changes every other field and keeps them.
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

The response's `applied` lists each agent with its `requestId` and `status`:
`updated` (it has the revision), `queued` (it takes it after its current turn;
poll `GET /v1/agents/:id/requests/:requestId` for the outcome) or `failed`, with
an `error`. On the console's Channels page, **Model & prompt** opens a channel's
definition with apply selected.

`PATCH /v1/agents/:id/configuration` changes one agent's `model`,
`systemPrompt`, `systemPromptAppend`, `thinkingLevel`, `keyScope`, `spendLimit` or `modelHeaders` without touching its definition or history:

```http
PATCH /v1/agents/client_…/configuration
Authorization: Bearer <API token>
Content-Type: application/json

{"requestId": "model-change-1", "model": "openrouter/openai/gpt-6-luna"}
```

It answers `202` with the request, which is queued like an applied definition
and survives a restart; poll it for the outcome, and reuse `requestId` to retry.
A model must be in `GET /v1/models`, and the tenant must have a key for its
provider, or the change is refused with `400`. An agent that is not running
takes the change when it next starts.
