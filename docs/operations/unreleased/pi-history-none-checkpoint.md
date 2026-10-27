### Bounded context for history-none runs

`AGENT_PI_CONTEXT_TENANTS` enables Pi checkpoints for history-none runs, by tenant
id or `*` for all tenants. It defaults to empty, keeping the existing behavior.
Compaction retains the run's first user message. The next normal turn restores
pre-streak context plus a newest-first digest of prompts and final replies within
20k estimated tokens. Full runs remain in API history. Continue and resume use the
same stored context on another node.
