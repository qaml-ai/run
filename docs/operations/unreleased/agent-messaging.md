### Background sub-agents: messages and stopping

- `send_message` (with the `agents` builtin, and for any sub-agent the runtime made): a parent messages its sub-agent,
  which takes it in its running turn or starts a turn that keeps its history (a finished one works again and notifies
  again), and a sub-agent messages its parent (`to: "parent"`), which reads it as an `<agent_message>` block. The
  parent's stream has `subagent_message`. Message turns count against `AGENT_WAKES_PER_HOUR`; a turn sends at most 20.
  See [Messages](../guides/multi-agent.md#messages).
- `interrupt_agent` aborts one of the agent's sub-agents. Aborting a parent aborts its running background sub-agents
  unless `children: "keep"` (REST and the SDKs), and deleting it deletes the sub-agents the runtime made.
- A sub-agent that waits on a person notifies with `input_required`, and again when it resumes and ends.
- Browser tokens take a `children` scope: the agent's sub-agents' events, state, history and inputs.
- A notification or message turn refused at the wake cap or a spend limit stays refused on another node if its node is
  lost as the message lands. Migration 062 extends `agent_children`.
