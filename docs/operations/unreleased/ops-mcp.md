### The team's operations MCP server

`/v1/ops/mcp` is a read-only MCP endpoint for the platform's own operations data: sign-ups, activation, agents, model
usage, the credit ledger, balances, storage and OAuth grants, as rows a dashboard charts. It signs in with the runtime's
OAuth server for a scope of its own (`ops`), so a token for it does not work on `/mcp` or the API, and the other way
round. Only tenants listed in the new `AGENT_OPS_ADMINS` may connect; unset, nobody can. Each request re-checks the
list, and the consent page refuses anyone off it. See
[Operations MCP server](ops-mcp.md).

Rollout: migration `063_oauth_resource.sql` adds `oauth_grants.resource` (default `'agents'`, so every existing grant
keeps working at `/mcp`). Nodes on the previous release ignore the column, so a rolling deploy needs nothing else; set
`AGENT_OPS_ADMINS` on every node, since a request may reach any of them.

### Tenants, channels, schedules and support in the operations MCP server

`/ops/mcp` answers more of what the team asks production: eight new tools, all read-only and all with the same rule
(counts, names, times, dollars and bytes; no messages, prompts, tokens, secrets or people). `tenant` takes one account
by the id the API takes and answers it in full: how it signed up and how far it got, its agents by type, schedules,
channels, volumes, storage, its own provider keys and model providers, webhooks, help requests, paid
checkouts, its use over 30 days and what it can spend. `usage_tenants` is the same question across accounts: spend,
active days and models by tenant, with `balance_usd` and `runway_days` at the range's daily rate, so the accounts about
to run out of credit are a sort away. `retention` charts sign-up cohorts by week, `time_to_value` gives the median and
90th percentile hours to a first token and days to a first model response and purchase, `channels` counts channels,
conversations and inbound messages by provider (and answers at last whether anyone uses them), `schedules` counts what
wakes agents and its backlog, `integrations` counts what accounts connect, and `help_requests` counts support load and
where delivery stands. `agents` also breaks its totals down `by_type`. See
[Operations MCP server](ops-mcp.md).

No migration and no configuration: the endpoint is the same stateless `/ops/mcp`, and a client that already signed in
sees the new tools at its next `tools/list`.
