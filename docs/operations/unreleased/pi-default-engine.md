### Pi is the default engine

`AGENT_ENGINE` now defaults to `pi-durable`, matching production since 2026-10-21. Self-hosted
nodes that set nothing run Pi; existing sessions migrate lazily when they next open, as before.
`AGENT_ENGINE=legacy` remains the operator rollback until the legacy engine is removed.
