### Batching: a burst of prompts to one agent costs one turn

An agent or definition can now set `queue: { mode: "batch", windowMs? }`. The prompts that wait while its turn runs
then run together as its next turn, each its own user message in arrival order, instead of one turn each that re-reads
the whole context. The first waiting prompt's request runs the turn and has its usage, with `batch` listing the
others; each of the others ends with the turn, with its answer and `batchedInto` naming that request, a `batch_taken`
event and a `run.completed` webhook. The turn is charged once. A prompt with an `output` schema, a `spendLimit` or
`runLimits` of its own, another `actor` or `bucket`, delegate calls, and the runtime's notifications and messages
never merge, and sub-agents never batch. `windowMs` (up to 2000) holds a prompt that reaches an idle agent that long
so a burst sent at once merges too. Steers waiting for a step's end are read together there. Agents without `queue`
are unchanged: one turn per prompt. Node and Workers alike; see `docs/operations/batching.md`.
