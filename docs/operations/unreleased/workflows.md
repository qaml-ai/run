### Workflows: a script an agent runs to coordinate sub-agents

An agent with the `workflow` builtin gets `run_workflow`: it writes a JavaScript
script that calls `agent()`, `parallel()`, `pipeline()`, `phase()` and `log()`, and
gets back only the script's return value. Each `agent()` makes a real child agent,
with `delegate`'s limits, links, budget and events. The
script runs in the runtime's `v8-exec` sandbox (no Node globals, no filesystem, no
network), holding a sandbox slot for its run, and a turn resumed on another node
replays it against the children it already made rather than running agent work twice.

```ts
const lead = await agents.upsert("migration-lead", { workflow: { agents: ["worker"], maxAgents: 40 } });
```

```python
lead = await agents.upsert("migration-lead", workflow={"agents": ["worker"], "maxAgents": 40})
```

`workflow` takes `agents`, `instructions`, `maxAgents` (256 by default, up to 4,096),
`maxParallel` (16, up to 64) and `maxDepth`; it goes with the builtin, as `delegate`
does, on an agent, a definition and a stateless run. Progress reaches streams that
ask for sub-agents' events (`?subagents=1`): `workflow_start`,
`workflow_progress`, `workflow_end`, beside each child's `subagent_start` and
`subagent_end`. See `docs/guides/workflows.md` and `docs/reference/limits.md`.
