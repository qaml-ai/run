### A sub-agent prompted through the API still reaches its parent

A sub-agent's parent came only from the signed metadata of the run its parent started, so a run an application started
(`POST /v1/agents/{child}/prompt`, as camelCode does for a PR comment routed to a worker) had none: `send_message` to
`"parent"` answered `This run has no parent` (Node: `You have no parent agent to message`) and the answer went nowhere the
lead saw. Both backends now fall back to the parent that made the agent, recorded when it was made (Node:
`header.parent` and the parent's `agent_children` row; Workers: the agent header's `parentAgentId`, and now
`parentRootId`). `report_progress` in such a run says the parent did not start it and points at `send_message`. Depth
and the signed chain of runs a parent starts are unchanged.
