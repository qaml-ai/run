### Oversized agent contexts fail without loading the range

An agent whose Pi journal range since its latest compaction exceeds 256 MiB now fails its run with code `context_too_large` before the host loads it. Interrupted runs fail with the same code instead of repeatedly resuming. History reads and abort remain available.

Live runs check before their first model request and every 20 requests, stopping with `stopped: "turn_limit"` and code `context_too_large` when the range exceeds the bound. Operators can set `AGENT_CONTEXT_RANGE_MAX_BYTES` to a positive byte count. Use a new agent with a summary of the history, or raise the bound with enough heap capacity.
