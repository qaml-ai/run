### Sub-agents that finish together are heard in one turn

When a background sub-agent's notification lands, every other sub-agent that has ended but whose ending has not reached
the parent yet now rides in the same turn, as an `<agent_notification>` block of its own, on Node and Workers alike.
Before, a lead whose three workers finished together took three turns, one notification at a time. The landing
message's `metadata.batch` lists what it carried, and each carried ending's own request ends with `result.skipped`. A
person's message keeps its own turn. Exactly once: no migration; Node marks a carried row's notice `batchedInto`, and
Workers stores the batch with the outbox entry it rides in, so a landing retried after a lost node carries the same
endings. See `docs/guides/multi-agent.md`.
