### Sub-agents report progress without interrupting their parent

A sub-agent the runtime made (a `spawn_agent` or `delegate` child) has `report_progress({ text })`: its latest status,
at most 500 characters, latest wins. It never starts a turn and does not count against `AGENT_WAKES_PER_HOUR`. A
background sub-agent's parent sees the reports it has not seen yet with its next tool result, as an `<agent_updates>`
block the runtime writes (in history, a part of that result with `agentUpdates: true`), and as `progress` and
`progressAt` in `list_agents` and `wait_agent`; a sub-agent's ending supersedes its reports. Watchers asking for
sub-agents (`?subagents=1`) get `subagent_progress`, and a delegate sub-agent's report is also its call's
`tool_execution_update`, which `<AgentChat>` shows under the call. The SDKs leave the block out of a tool result's
`output` and of the chat's `ToolPart.result` (`agentUpdates` has it). Migration 098 adds `progress`, `progress_seq`
and `progress_at` to `agent_children`. See [Progress](../guides/multi-agent.md#progress).
