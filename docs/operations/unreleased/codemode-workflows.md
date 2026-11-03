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

Waiting on `delegate` is not on a script's clock, and a waiting script holds
none of its account's code slots: a child may take longer than the script's
time limit, and children can run code while their parents wait. A script makes
at most 256 tool calls; at most 32 are out at once, and a `Promise.all` over
more starts the rest as earlier ones answer (the 257th call fails the script,
saying so). Unfinished children are also left running when the agent's process
exits, for its resumed script to find.

A script resumes only in the sandbox it started in: one in flight (or waiting
on a child) across a deploy that changes v8-exec, or the account's code limits,
ends with "the sandbox changed since it started", and the model can run it
again. The Python SDK's `workflow=` argument was removed and is now a
`TypeError`; the TypeScript SDK's `workflow` field is gone from its types.
