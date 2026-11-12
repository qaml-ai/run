### A workflow's ending reaches its owner as a child's

An agent's workflow is now a background child of the agent that started it. Its endings go through the same durable
outbox and notification path as a sub-agent's:

- `workflow_start` adds the workflow to the agent's children (it shows in `list_agents`) before the workflow is made.
- When the workflow ends, or stops for its budget or its payer's credit, it writes its ending in the same transaction as
  its status. Its alarm then delivers the ending to the owner until the owner takes it, and the owner takes it once.
- The owner hears it as a `<workflow_notification workflow= name= status=>` block. The block holds a line (`Workflow
  port completed.`, `Workflow port failed (<code>): <message>`, `Workflow port was aborted.`, or a stop with what it
  waits for), then the facts as JSON: status, result or fault, counts, spend and budget. The block no longer has an
  `event` attribute.
- These notifications batch with sub-agent endings in one turn. They charge nothing, because the workflow's own children
  already billed what it spent.
- A stop and the ending after it are two attempts of one child. A person's pause, a capacity wait, finished phases and
  opened gates no longer send a notification; `workflow_status` shows them.
- A workflow keeps running when its owner's turn is stopped or the owner is deleted. `workflow_abort` (or
  `interrupt_agent` on the workflow) stops it.
- `workflow_status` gives `next` only for a spent budget ("raise it with workflow_budget") and for a fault ("abort it and
  start a new workflow: finished results are reused").

At the deploy: a workflow started before it has no child row on its owner, so the owner refuses its ending. For that
answer only, the workflow sends the ending once the old way (a `<workflow_notification>` message with an `event`
attribute). Notices the earlier build had not delivered still go: endings and budget or payer stops are delivered,
and phases, gates and other pauses are dropped and logged `workflow_notice_dropped reason=retired`. A workflow that
ended before the deploy, and whose owner was never told, is told on its next wake. The old notice code, its
`workflow_notice_state` and `workflow_notices` tables, and the old block are removed in the next release.
