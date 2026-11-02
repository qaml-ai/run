### The team's operations MCP server

`/ops/mcp` is a read-only MCP endpoint for the platform's own operations data: sign-ups, activation, agents, model
usage, the credit ledger, balances, storage and OAuth grants, as rows a dashboard charts. It signs in with the runtime's
OAuth server for a scope of its own (`ops`), so a token for it does not work on `/mcp` or the API, and the other way
round. Only tenants listed in the new `AGENT_OPS_ADMINS` may connect; unset, nobody can. Each request re-checks the
list, and the consent page refuses anyone off it. See
[Operations MCP server](ops-mcp.md).

Rollout: migration `063_oauth_resource.sql` adds `oauth_grants.resource` (default `'agents'`, so every existing grant
keeps working at `/mcp`). Nodes on the previous release ignore the column, so a rolling deploy needs nothing else; set
`AGENT_OPS_ADMINS` on every node, since a request may reach any of them.
