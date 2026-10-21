### The legacy engine is removed

The pi-agent-core loop that ran agents before Pi durable is gone, with its host
compaction, the `AGENT_ENGINE` switch, the Pi canary allowlists and the rollback
from Pi to it. A node with `AGENT_ENGINE`, `AGENT_PI_CANARY_AGENTS` or
`AGENT_PI_CANARY_TENANTS` set still starts, ignores them and logs
`settings_ignored` once.

A session still in the legacy format is imported the first time a host opens it,
whatever it holds: a turn its node lost mid-run (recovered on Pi as any interrupted
turn), a tool waiting on a person (still waiting, now on Pi), a context Pi orders
its own way, and sessions an earlier release rolled back to the legacy engine.
One past the import's 64 MiB / 200,000-record budget keeps its archive in its
legacy log, which its history reads first, instead of staying on the legacy
engine. Nothing writes a legacy log after its import. See
[Pi durable sessions](pi-durable.md#importing-legacy-sessions).
