### Agent usage and run logs

Add groupBy=agent to GET /v1/usage for per-agent usage. Combine agent,
definition, endUser, model, and day with commas. rollup=true attributes
children to their root agent. GET /v1/agents/{id}/usage filters one agent;
with rollup it includes that root's descendants. Costs are USD. Platform cost
includes funding costs. Attribution starts with migration 124; older account
totals remain available through the unchanged default usage response.
Workspace filters still apply. Definitions are attributed to the agent making
the call; rollup changes only the agent dimension. Unknown dimensions are null.
Usage includes signed provider reconciliation adjustments.

GET /v1/runs/{id}/log returns the run result, elapsed execution time and ordered
durable message events, including tool calls and tool results. The result includes
usage, tool errors and run errors. Event times are milliseconds or null when the
stored message has no timestamp. This is a reconstruction from retained messages,
not a trace of transient streaming events. It expires with the run's retention.

TypeScript: agents.usage({ groupBy: ["agent"], rollup: true }),
agents.agentUsage(id) and agents.runs.log(id).
Python: agents.usage(group_by=["agent"], rollup=True) and
agents.runs.log(id); pass agent=id to filter usage.
CLI: camelrun usage --by agent,model --rollup and camelrun run-log <runId>.
