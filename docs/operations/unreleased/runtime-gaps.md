### Lifetimes, limits and tool servers, for products built on the runtime

- `idleTtlSeconds` on agents and definition `limits`, instead of `ttlSeconds`: the agent lives that long (60 seconds
  to 366 days) from its latest run, so one in use is kept and one left alone expires. With `ttlSeconds` it is a 400.
  Both SDKs: `idleTtlSeconds` / `idle_ttl_seconds=` on `createAgent`.
- `runLimits: {maxResponses?, maxSeconds?}` on `POST /v1/agents/:id/prompt`: that run's own limits, applied only
  where lower than the agent's (or the runtime's). Both SDKs take `runLimits` / `run_limits=` on `run`, `stream`,
  `prompt` and `send`.
- A run stopped by a spend limit says which: `result.limit` is `run`, `agent`, `tenant` (the monthly cap) or
  `credit`.
- Applying a definition (`apply: "all"`, or `applyOnUpdate`) drops the tool lists the runtime holds for its MCP
  servers, so the agents it reaches see a server's new tools at once instead of within the cache's lifetime.
- Identity tokens carry the run's request id (`req`) and the model's tool call id (`tcid`) during a turn: the SDKs'
  `identity.requestId` and `identity.toolCallId` (`request_id`, `tool_call_id`). A tool can tie its work to the run
  that asked for it, or make a tool call idempotent.
- `GET /v1/agents/:id/events?request=<id>` (and `/clients/:id/events`): only that request's events and its response.
- Both SDKs: `agent.send(text, options)` sends a message without waiting for its run (`{id, state}`, the prompt's
  202), and `agent.wait(id)` gives the run later; `AgentClient.submit` / `client.submit` is the same one level down.
- `serveTools` / `serve_tools` take a function of the caller's identity instead of the tools, so each agent can be
  offered its own; a tool it is not given is refused. A `ToolServer`'s `listTools(context)` gets
  `{identity, origin, signal}`.
- The TypeScript SDK's `DefinitionInput` has `runLimits` (the API took it already). The Python SDK's definition
  methods take each field's Python spelling too (`run_limits=`, `system_prompt=`, `mcp_servers=`), besides the REST
  name.
