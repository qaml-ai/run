# Agents for many users

Most applications give each user, or each conversation, an agent of its own, and
serve every agent's tools from one backend. This guide puts the pieces
together: keys, identity, served tools, per-user limits and keys.

## One agent per user or conversation

Key agents by your own ids, and upsert on each request:

```ts
const agent = await agents.upsert(`thread-${thread.id}`, {
  definition: SUPPORT_DEFINITION,         // tools served by your backend, see below
  subject: thread.ownerId,                // whom the agent acts for
  context: { org: thread.orgId },         // claims your tools authorize against
});
const run = await agent.run(message, { user: currentUser.id });
```

- `subject` and `context` are set when the agent is made, with your API key; the
  agent's own token cannot change them, and nor can the model. Your tools get them
  as `identity.subject` and `identity.context`.
- `user` names who sent this message. The model sees who sent it (in a block only
  the runtime can write), and tools get it as `identity.actor` (and
  `identity.user`). Use `user: { id, name }` to give the model a display name too;
  names are the sender's own and never proof of anything, which the runtime tells
  the model.
- An agent shared by several people (a team channel) shares its whole
  conversation with all of them: keep private data in agents of one person each.

## Serve the tools from your backend

A multi-user backend runs many instances, so its tools are served over HTTP,
not attached to one process. Each call carries a signed token saying which agent
it is for and who is acting, so one endpoint answers every user's agents safely:

```ts
const tools = {
  list_todos: tool({
    description: "The current user's to-dos", input: schema.Object({}),
    execute: (_args, { identity }) => db.todos({ user: identity!.user, org: identity!.context.org }),
  }),
};
// tenant: yours (GET /v1/me). Other tenants' agents can reach this URL too, claiming any user: their tokens are refused.
export default { fetch: serveTools(tools, { runtime: "https://run.camelai.com", tenant: "acme" }) };
```

```ts
const definition = await agents.runtime.upsertDefinition("support", {
  name: "Support",
  mcpServers: [{ name: "app", url: "https://app.example.com/mcp", auth: { type: "runtime" } }],
});
```

Authorize every call as `identity.user` within `identity.context`, never from
the model's arguments. That identity is only meaningful within your own tenant,
which is why `serveTools` requires `tenant`. See [Tools](tools.md#served-tools-over-http-for-serverless-and-many-users)
and [Identity](tools.md#identity-who-a-call-is-for).

Your request handlers can be serverless: an agent upserted without local tools
follows its stream read-only, so any number of instances run agents at once.

## Showing each user their agent

Mint a browser token per user and let the browser read the agent directly; send
messages through your server. See [Showing an agent in a browser](browser.md).

## Spend: limits and keys per user

- `spendLimit: { usd }` caps what one agent may spend on model calls from now on
  (set it on upsert, or `PATCH /v1/agents/:id/configuration`). Setting it starts
  counting from zero, so you can set the remaining allowance before each run. An
  agent at its limit gets 402 for new runs, and a running turn ends with the run
  failed as `spend_limit`.
- A **key scope** per customer holds that customer's own provider keys, so their
  agents call providers with them: `PUT /v1/key-scopes/:scope/providers/:provider`,
  then `keyScope` on upsert. See [Models and keys](models-and-keys.md).
- `modelHeaders` label each model call, e.g. for a gateway's per-conversation logs.
- The `usage.recorded` [webhook](webhooks.md) reports each model response's cost
  with the agent's `subject`, `context`, `actor` and `keyScope`, to meter per user.

## Matching messages to your records

`run(text, { metadata })` attaches your own key-value data to the message (at
most 16 string values): the stored message and its run carry it, in history,
events and webhooks; the model never sees it. Pass `idempotencyKey` to choose the
run's id, so a retried request never runs twice, and to find the run later.

## Bringing in existing conversations

A conversation that began elsewhere continues on an agent made with its history:
`initialMessages` on `POST /v1/agents` (`createAgent({ initialMessages })`, or an
upsert's first create; Python `agents.upsert(key, initial_messages=[…])`). They
are [Pi](https://github.com/earendil-works/pi) messages, kept as they are, with
what a message leaves out filled in (a timestamp; an assistant message's `usage`,
zero, and `stopReason`; a tool result's `isError`, false):

- `user` (content a string, or text, image and file blocks), `assistant` (text,
  thinking and `toolCall` blocks, with its `usage`, `provider` and `model` if you
  have them) and `toolResult` (`toolCallId`, `toolName`, content).
- `compactionSummary` (`summary`, `tokensBefore`): the model then sees this
  summary instead of every message before it, and those that follow. Put it just
  before the first message it keeps; only the last counts. History still shows
  every message, so a long conversation need not be summarized again.

History is imported only when the agent is made: an agent that has one keeps it,
and an upsert with the same key makes the agent once. `GET …/history` shows it at
once. Thinking from another model reaches the model as text; a tool call with no
result gets one saying so; tools the old conversation called need not exist.
When what is imported is more than the model's context holds, the first run
compacts it before calling the model, charged as any compaction.

A refused import makes no agent: `INVALID_HISTORY` (400) names the message and
what it lacks, and past 16 MB of JSON it is `HISTORY_TOO_LARGE` (413). Send the
most recent messages that fit, after a `compactionSummary` of the rest; upload
images as files first to keep them out of those 16 MB.
