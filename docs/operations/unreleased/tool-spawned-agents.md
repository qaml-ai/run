### Workers your tools prepare

- A tool from a server with auth "runtime" can start a background sub-agent for the calling agent: its result's
  `_meta["camelrun/spawn"]: { agent, task, name?, output? }` names an agent of the tenant the tool prepared, and the
  model's call answers `{ agentId, name }`; the worker's answer arrives as a notification. A busy worker queues the
  task. The SDKs build it: `spawnAgent(...)` (TypeScript, `@camelai/run/server` too) and `spawn_agent(...)` (Python).
  See [Workers your tools prepare](../guides/multi-agent.md#workers-your-tools-prepare).
- `agentNotice(message)` (Python `agent_notice`) tells sub-agents' notifications and messages apart in history, and
  `<AgentChat>` renders them as notices, not as the user's messages. `subagent_message` is in the SDKs' event types.
