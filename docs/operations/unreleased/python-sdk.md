### Python SDK

- `camelai_run.sync`: a synchronous client with the same names (`Agents`, `Agent`, `AgentRuntime`, `Runs`) for
  scripts, Django and Flask views and Celery tasks: upsert, get, fork, run, stream, steer, answer inputs, stateless
  runs. It holds no connection, so it does not serve tools from its own process and has no `on_event` or `on_input`;
  it also has no volumes, no `create_agent` and no `client.steer` (use the async client for those). See [the synchronous client](../reference/sdk.md#the-synchronous-client-python).
- `camelai_run.sync.serve_tools` serves tools as a WSGI app (Django, Flask), plain functions in the request's thread;
  `camelai_run.sync.verify_runtime_token` and `TestRuntime` are its synchronous token check and test runtime.
- `verify_webhook(body, headers, secret)` verifies a webhook request (Standard Webhooks signature, constant-time,
  within 5 minutes) and returns its event.
- `initial_messages=` on `agents.upsert` and `create_agent`: the history an agent begins with.
- `mcp_servers=` on `agents.upsert` (async and sync), `create_agent`, `upsert_agent` and `agents.run`: MCP servers
  of the agent's or run's own, without credentials.
- `max_output_tokens=` and `temperature=` on `agents.upsert`, `create_agent`, `agents.run` and `configure` (`None`
  removes either there); definitions take `maxOutputTokens` and `temperature` as fields.
- `AgentRuntime` manages key scopes (`set_scope_key`, `key_scope`, `set_scope_provider`, ...), API tokens
  (`tokens`, `create_token`, `revoke_token`), usage (`usage`), webhook endpoints (`create_webhook`, `webhooks`,
  `update_webhook`, `delete_webhook`, `rotate_webhook_secret`) and agent tokens (`rotate_agent_credentials`).
