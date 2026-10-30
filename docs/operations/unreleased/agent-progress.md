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

### A waiting parent can watch its sub-agents' progress

`wait_agent({ untilProgress: true })` also returns when a sub-agent it waits on reports progress the parent has not
seen, with `updated` naming whose and each one's latest `progress`, so the model can correct a sub-agent that went off
track while it works. It answers no sooner than `AGENT_PROGRESS_WAIT_MS` (default 15 seconds) into the wait, so a
sub-agent reporting each step costs its parent at most one model call per that long. Without it, a report never ends
a wait.

### Starting a sub-agent and messaging it in one response

`wait_agent`, `send_message`, `list_agents` and `interrupt_agent` called in the same response as `spawn_agent` now run
once the sub-agent has started: `send_message` found no agent, and `wait_agent` recorded the sub-agent as failed while
it went on to run. A message to a sub-agent whose turn has not begun yet waits up to 10 seconds for it and joins it,
instead of queuing behind the whole task.

### A steer sent just after a prompt joins its turn

A `whileRunning: "steer"` prompt (a person's, or a sub-agent's message) that arrives while a turn has begun but its
host has not yet opened it now waits up to 5 seconds for it to open and joins it, instead of answering `steer: "queued"`
and running after the whole turn.

### Sub-agents of the model's own design require their instructions

With `delegate: { instructions: true }` and no `agents`, `delegate` and `spawn_agent` now list `instructions` as
required, as the runtime already demanded: models sent only a `task`, were refused, and wrote every call again. A call
without it says which field is missing (`Give instructions too: the sub-agent's system prompt …`).

### wait_agent waits for a sub-agent's latest turn

A message to a sub-agent that had already answered starts a turn of its own; `wait_agent` now waits for that turn's
answer, instead of returning the earlier one at once. The earlier answer still comes as its notification. The
`instructions` and `task` descriptions now tell the model to put the work (data, rules, steps) in `task`: a message can
amend a task, but models hold to a system prompt over later messages.
