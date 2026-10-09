### TypeScript SDK

- `maxOutputTokens` and `temperature` on `agents.upsert`, `agents.run`, definitions and `agent.configure` (`null`
  removes either there).
- `mcpServers` on `agents.upsert`, `createAgent`/`upsertAgent` and `agents.run` (`InlineMcpServer`: no credentials).
