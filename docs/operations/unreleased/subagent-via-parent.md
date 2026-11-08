### A sub-agent is reached only through its parent

A sub-agent the runtime made (`delegate`, `spawn_agent`) now runs only what its parent sends it. A prompt or steer to it
(`POST /v1/agents/{child}/prompt`, its own token's requests, a channel, an agent MCP client, a run's code) and a
schedule on it (`POST /v1/agents/{child}/schedules`, or its own `schedule` builtin) are refused with 409
`SUBAGENT_VIA_PARENT`: `<id> is a sub-agent: message its parent, which reaches it with send_message`. Its parent's
`delegate`, `spawn_agent`, `send_message`, `wait_agent` and `interrupt_agent` work as before, and so do answering its
inputs, reading it, aborting it and deleting it. Named agents a parent delegates to are not affected.

With no run but its parent's, the fallback for a run its parent did not start is gone on both backends: `send_message`
to `"parent"` resolves only through the run's signed chain again, and Workers no longer records `parentRootId`.
