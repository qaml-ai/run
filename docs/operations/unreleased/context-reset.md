### Reset an agent's context: `POST /v1/agents/{id}/context/reset`

An agent whose runs fail with `context_too_large` can run again. `POST /v1/agents/{id}/context/reset` with `{ summary?, keepMessages? }` writes a new Pi head marker at the journal's tail: the agent's current system message, a summary (the one given, or a note that the operator reset it on that date), and its last `keepMessages` history messages (0 to 20, default 0, never starting on a tool result whose call is not kept). It reads the system message in SQL and never loads the old context range, so it works on an agent no node can start. History (`GET /v1/agents/{id}/history`), the history index, files and configuration are unchanged. It is refused with 409 `AGENT_BUSY` while a run is active or queued (or when the agent started while it was being reset), and with 409 `context_too_large` if the new context would itself be past `AGENT_CONTEXT_RANGE_MAX_BYTES`. Repeating it is safe.

The SDKs have `agent.resetContext()` / `runtime.resetContext(agentId)` (TypeScript) and `reset_context()` (Python); the CLI has `camelrun agents reset-context <agent> [--summary text] [--keep n]`.

The system-message read stops on the database after 120 s (`statement_timeout`), so a reset the client gave up on does not keep scanning, and it is not retried.
