### Event streams go through your own fetch

A TypeScript `AgentRuntime`/`Agents` client, or a `watchAgent` watcher, given its own `fetch` now asks for an SSE event stream through that fetch, instead of a WebSocket that would go around it (your HTTP stack, an auth proxy, instrumentation). Pass `transport: "auto"` to a watcher to prefer a WebSocket anyway. Clients on the default fetch are unchanged, and so is any client of the Node runtime, which always answers SSE.
