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

### A sub-agent's message reaches its busy parent at once

`send_message` to `"parent"` now joins the parent's running turn at its next step, as a `whileRunning: "steer"`
prompt does, instead of waiting for that turn to end: it starts no turn (and so counts no wake), and its request ends
`steeredInto` the turn. A parent's `wait_agent` returns as soon as one of its sub-agents messages it, with `messaged`
naming who, so the model reads the message next. An idle parent still gets it as a turn of its own. The call answers
`into: "its running turn"` or `"a new turn of its own"`.
