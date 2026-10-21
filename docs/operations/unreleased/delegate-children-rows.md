### Delegate sub-agents are tracked in the database

A `delegate` call's sub-agent now has a row in `agent_children` (kind `delegate`, migration 083), written before its
prompt is sent. Aborting, stopping or deleting the parent reaches it from any node, also after the node that made it
was lost and before the parent's run resumes; deleting the parent deletes the sub-agents the runtime made for it. An
abort answers once the parent's delegate sub-agents have ended (at most 10 seconds, then `subagent_stop_timeout` is
logged), and what they spent counts in the aborted run's `usage.subagentCostUsd` and against the parent's spend limit.
A sub-agent whose parent's run ended without its answer is aborted by the child sweep, which charges what it spent to
the parent's spend limit (`subagent_late_ending`).
