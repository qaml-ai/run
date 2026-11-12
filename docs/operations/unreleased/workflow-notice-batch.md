### Workflow notifications wait for the owner and land together

A `<workflow_notification>` no longer takes a slot in its owner agent's request queue, where many workflows could fill
the queue and have their notices refused ("Too many requests queued for this agent"). On the Workers backend, while the
owner is busy, a workflow's notice waits in the owner's own durable outbox. When the owner is free, one notice lands and
brings the others waiting with it, in the same turn:

- one `<workflow_notification>` block per workflow, carrying that workflow's latest notice;
- a workflow's earlier notices are folded into its latest;
- up to 20 workflows per turn, with the rest in the next.

Each turn counts once against the wake budget.
