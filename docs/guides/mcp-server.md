# Agents as MCP servers

Every agent is also an MCP server, at `https://run.camelai.com/v1/agents/<agent id>/mcp`
(Streamable HTTP). Connect Claude, Cursor or any MCP client to it, and the model
there can talk to your agent. It has one tool, `message`: it sends the agent a
message and returns the agent's reply. The agent's own tools stay its own.

Claude Code:

```sh
claude mcp add --transport http support https://run.camelai.com/v1/agents/client_…/mcp
# then /mcp in Claude Code to sign in; or skip signing in with a token from your environment:
claude mcp add --scope project --transport http support https://run.camelai.com/v1/agents/client_…/mcp \
  --header 'Authorization: Bearer ${SUPPORT_AGENT_TOKEN}'
```

The single quotes keep the variable as written, so the project's `.mcp.json`
names it and Claude Code reads its value from the environment. Never write a
token's value into an MCP config: they are often committed (see
[Keys stay out of MCP configs](../reference/cli.md#keys-stay-out-of-mcp-configs)).

Claude (claude.ai and the desktop app): Settings, Connectors, Add custom
connector, with the agent's URL. Cursor and other clients configured with JSON:

```json
{ "mcpServers": { "support": { "url": "https://run.camelai.com/v1/agents/client_…/mcp" } } }
```

- **One conversation.** A message joins the agent's history exactly as a prompt
  (`POST /v1/agents/:id/prompt`) does, next to messages from the API, the
  console and channels. There are no threads per caller; to give each caller a
  conversation of its own, give each an agent. Each message is a run, limited
  and billed as a prompt is.
- **Who may call it.** Whatever may prompt the agent: its own token (the
  `token` it was created with), an API token of its tenant, or an OAuth sign-in.
  A `401` names the agent's protected-resource metadata
  (`/.well-known/oauth-protected-resource/v1/agents/<id>/mcp`), so clients sign
  in [as with the hosted MCP server](../reference/cli.md#hosted-mcp-server).
  Other tenants' tokens get `404`.
- **The tool's description** names the agent and, when the agent is made from a
  [definition](definitions.md) with a `description`, says what it is for:
  `"description": "Answers questions about orders and refunds."` (1–1,000
  characters). Its system prompt is never shown.
- **Long turns.** A call lasts as long as the turn. It sends progress
  notifications as the agent works (its text as it streams, each tool it uses,
  and a heartbeat every 20 seconds), so clients that reset their timeout on
  progress keep waiting. A caller that goes away does not stop the turn.
- **Retries.** Pass `requestId`: sending the same text with the same id again is
  the same message, never sent twice, and the call returns its reply (waiting
  for it if it is still running). A call your client sends again in the same
  session is recognized without one.
- **A busy agent.** A message to an agent that is working queues behind its
  current turn, as a prompt does. Once 32 requests are open, the call fails:
  `The agent is busy: …`.
- **Human input.** When the turn [waits on a person](human-input.md) and the
  client supports elicitation, the question, approval, form or page comes up in
  the client, and the answer resumes the turn. Otherwise the call ends with a
  result listing what the agent waits on (`structuredContent.status` is
  `input_required`) and how to answer it; once answered, the same call again
  (same text and `requestId`) returns the reply. A new message instead sets the
  inputs aside.
- **Errors** (a failed run, a spend limit, a model error, a refused request)
  come back as tool errors carrying the runtime's message.
