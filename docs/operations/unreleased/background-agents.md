### Background sub-agents

- The `agents` builtin gives the model `spawn_agent`, `wait_agent` and `list_agents`, with the same `delegate` settings
  (targets, `maxDepth`, `maxParallel`). `spawn_agent` starts a sub-agent and returns `{ agentId, name }` at once. When
  the child's run ends (completed, failed, aborted or waiting on a person), its answer reaches the parent once, as a
  user message with `source: { kind: "agent", agentId, name }` that the model reads in an `<agent_notification>` block,
  and starts a turn or queues behind the running one. `wait_agent` waits for children instead, and answers their
  endings itself. See [Background sub-agents](../guides/multi-agent.md#background-sub-agents).
- Delivery is exactly once across node loss: each child has a row in the new `agent_children` table (migration 061),
  its notification has request id `child_<request>`, and every node sweeps for undelivered endings every
  `AGENT_CHILD_SWEEP_MS` (default 15 s).
- A child's spend is charged to its parent's spend limit when its notification lands. A parent at its spend limit, or a
  chain past `AGENT_WAKES_PER_HOUR` (default 100) turns started by notifications this hour, gets the notification in
  history without a turn: `stopped: "spend_limit"` or `"agent_loop_limit"`.
- Identity tokens of a sub-agent's run (from `delegate` or `spawn_agent`) carry `par` (its parent agent) and `root` (its
  chain's first agent); the SDKs read them as `identity.parentAgentId` and `identity.rootAgentId`
  (`parent_agent_id`, `root_agent_id` in Python).
