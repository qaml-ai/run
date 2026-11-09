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


Migration 125 aggregates repeated usage into one row per day and attribution
tuple. Details are retained for 400 UTC days, excluded when expired, and removed
in batches during maintenance. Grouped reports take limit (1 to 500, default
100) and cursor (the prior page's next). Totals cover every filtered group.
Deleted agents' retained usage remains readable by their own tenant.

Run logs take limit (1 to 100, default 50) and cursor. Pages are at most 256 KiB;
messages are at most 16 KiB, and run summaries at most 32 KiB. Oversized values
are replaced with a truncated marker, their original byte count and a preview.
Tool arguments and results can include sensitive data echoed by tools.
CLI usage without --by keeps the legacy daily response.
