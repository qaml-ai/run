### A workflow's children roll up into the agent that owns it

`GET /v1/agents/{id}/usage?rollup=true` (and `/v1/usage?rollup=true`, grouped by agent) now includes the usage of the sub-agents in the workflows that agent started, and of those sub-agents' own sub-agents. Each child records its owner agent as its usage root (`usageRoot` in its place); the workflow stays its owner.

Children made before this change still roll up under the workflow's id.
