### Workflows in code mode

The `delegate` tool is callable from code mode. Scripts can fan out with
`Promise.all`, chain tasks in loops, and return one result to the model. Pi
journals each nested call: a resumed script reuses finished delegate calls.
Unfinished children are stopped when their script ends, except during handoff.

The `workflow` builtin, its settings and `run_workflow` were removed. New input
using them gets a 400 explaining how to use `tools.delegate`. Stored settings
are ignored. See `docs/guides/multi-agent.md`.

The legacy script engine and its V8 execute protocol are gone. V8 accepts only
Pi code mode; process isolation, CPU and memory limits, seccomp and fingerprint
checks remain.
