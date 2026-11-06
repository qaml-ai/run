# Operations MCP server

`/v1/ops/mcp` is the team's read-only MCP endpoint: the platform's own counts, names, times, dollars and bytes, for a
connector whose dashboards ask production live (`src/ops-mcp.ts`, and the queries in `src/ops-reports.ts`). It is
not a tenant's endpoint: it answers across every account, so only the team connects it.

## Connecting

Add it as a custom connector in claude.ai (Settings, Connectors, Add custom connector, with
`https://run.camelai.com/v1/ops/mcp` and the client id and secret left empty: the runtime registers the client), or in any
MCP client that signs in with OAuth:

```sh
claude mcp add --transport http ops https://run.camelai.com/v1/ops/mcp
# then /mcp in Claude Code to sign in
```

Signing in goes through the console's sign-in page, then a consent page that says what the connector reads: sign-ups,
agents, model usage, spend, storage and OAuth grants, read-only, and never messages, prompts, tokens or secrets.

The endpoint's protected-resource metadata is `/.well-known/oauth-protected-resource/v1/ops/mcp` (RFC 9728): the resource is
the endpoint, the scope is `ops`, and the authorization server is the runtime's own, which is `/mcp`'s too. A token for
one resource answers nothing at the other: an `ops` token is refused at `/mcp` and `/v1`, and an `agents` token at
`/v1/ops/mcp`. The grant's `resource` column (`migrations/063_oauth_resource.sql`) is what binds a token to its resource,
and `/v1/oauth/grants` shows each grant's `resource` beside its client.

## Who may connect

`AGENT_OPS_ADMINS` lists the tenants (comma-separated) who may connect, by tenant id: the GitHub login, the email
address an account was made with, or the id an operator chose. Unset, nobody may.

The check is made twice and then on every request:

- at the consent page, for the signed-in tenant: anyone else gets a 403 page saying the endpoint is for the team only,
  and no code is issued (a form posted without that page is refused the same way);
- when a code is exchanged for tokens, so a consent given before someone was taken off the list grants nothing;
- at `/v1/ops/mcp` on every request: a token whose tenant is no longer on the list answers 403 `NOT_TEAM`.

Taking a tenant off takes effect for new requests at the next deploy or restart (the list is read at startup). Its
existing grant's next refresh ends the grant, and `POST /oauth/revoke` or `DELETE /v1/oauth/grants/:id` ends it at once.

## What it answers

Every tool answers rows a dashboard charts as they are: `{rows: [...]}`, and for some a total or a second list beside
them. Amounts are dollars as the credit ledger keeps them (integer micro-USD in the tables, divided out in the answer),
and days are UTC, as `usage` keeps them.

| Tool | Arguments | Rows |
|---|---|---|
| `signups_daily` | `days` (default 30, at most 365) | per UTC day: `signups`, and `github`, `google`, `email`, the self-serve sign-ups by how they signed up. Operator-made tenants and erased accounts are not sign-ups |
| `accounts` | `days`, `limit` (default 50) | the most recent accounts, newest first: `tenant`, `created_at`, `sign_in` (`github`, `google`, `email`, `operator`), `deleted`, `tokens`, `agents`, `revoked_agents`, `schedules`, `responses`, `cost_usd`, `balance_usd`, `purchased_usd` |
| `activation` | none | of the live self-serve accounts: `tenants`, `with_token`, `with_agent`, `with_usage`, `purchased` |
| `agents` | `limit` | live and revoked agents by tenant, most live first, and `totals` (`live`, `revoked`, `tenants`) |
| `usage_daily` | `days` | per UTC day across every tenant: `responses`, `active_tenants`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd`, `platform_cost_usd`, `platform_responses` (the part on the platform's own keys) |
| `usage_models` | `days`, `limit` (default 25) | per model, most dollars first: `responses`, tokens, `cost_usd`, `tenants` |
| `spend` | `days` | per UTC day and ledger kind (`grant`, `purchase`, `usage`, `storage`, `adjustment`, `refund`): `entries`, `amount_usd` (refunds negative). Six rows a day, zeros included |
| `balances` | `limit` | the largest credit balances: `tenant`, `balance_usd`, `purchased_usd`; and `totals` (`accounts`, `balance_usd`, `purchased_usd`) |
| `storage` | `limit` | by kind of owner (`agent`, `volume`, `tenant`): `owners`, `bytes`; and `largest`, the owners by id with their `bytes` |
| `oauth_grants` | `days` | per UTC day and `resource` (`agents`, `ops`): `grants`; `clients` (the name a client chose, unverified, its `resource`, grants and `last_used_at`); `totals` by resource |
| `trend` | `days` (default 14) | per UTC day: `signups`, `returning_active` (accounts made before the day whose agents got a model response on it), and `incomplete_day` |
| `usage_tenants` | `days`, `limit` (default 25) | model use over the range by tenant, most dollars first: `responses`, tokens, `cost_usd`, `platform_cost_usd`, `active_days`, `last_day`, `models`, `agents`, `balance_usd`, `purchased_usd`, `daily_usd` (the range's rate) and `runway_days` (what the balance buys at that rate; null when it spent nothing or has nothing). Who is spending, and who is about to run out |
| `tenant` | `tenant` (the id the API takes) | one account in full: `rows` (`tenant`, `created_at`, `sign_in`, `deleted`, `billing`, `limits`, tokens, agents, revoked agents, schedules, channels, volumes, `storage_bytes`, `provider_keys`, `model_providers`, `webhook_endpoints`, `help_requests`, `paid_checkouts`, `responses_30d`, `cost_30d_usd`, `last_active_day`, `balance_usd`, `purchased_usd`), `agents_by_type`, and `channels`. Empty `rows` when no account has that id |
| `retention` | `weeks` (default 8, at most 26) | weekly retention: one row per sign-up week and `week_offset` with `cohort_week`, `cohort_size`, `active` (accounts of that cohort with a model response in that week) and `pct`; `incomplete_week` is the week still going |
| `time_to_value` | `days` (default 90) | of the live self-serve accounts made in the range: `accounts`, `with_token`, `with_response`, `with_purchase`, and the median (`p50_…`) and 90th percentile (`p90_…`) hours to the first token or days to the first model response and first purchase |
| `channels` | `days` (default 7), `limit` | by provider (`telegram`, `slack`, `github`, `email`, `webhook`, and any retired `discord` rows still stored): `channels`, `tenants`, `conversations`; `totals`; `daily`, the inbound messages per UTC day; `tenants`, the accounts with channels, most used first. `channel_seen` is pruned at 7 days, so `daily` is at most 7 rows |
| `schedules` | `days` (default 30), `limit` | by tenant: `schedules`, `recurring`, `once`, `due_now`, `agents`, `next_due_at`; `totals`; `daily`, created per UTC day |
| `integrations` | none | what accounts connect, by integration (`api_tokens`, `provider_keys`, `model_providers`, `webhook_endpoints`, `volumes`, `channels`): `tenants` and `total`; and `totals.tenants`, the accounts with any of them |
| `help_requests` | `days` | Get help requests per UTC day: `requests`, `delivered`, `failed`, `pending`, `tenants`; and `totals`. A day's statuses are those requests' status now |
| `health` | none | one row: `check: "database"`, `ok`, `ms` (how long the answer took), `tenants`, `agents`, `ops_grants` |

A day with nothing in it is a row of zeros, never a missing row, so a chart's line is continuous. An unknown argument
is ignored; a malformed one (a day count of 366, a fraction) is an error the client sees as `isError`.

## What it never answers

Counts, names, times, dollars and bytes only. Nothing here reads or returns:

- prompts, messages, transcripts, an agent's history or its files (an agent is a `client_…` id and counts);
- tokens, refresh tokens, codes, client secrets, console or agent sessions, API tokens or provider credentials;
- a person's name or address: a tenant is an id (which may be a GitHub login or an email address), and that is as far
  as an identity goes; `accounts` says how an account signed up, never who;
- an agent's code, instructions or tool descriptions, a volume's contents, or a storage owner's bytes beyond the total.

The queries name their columns and their filters, so a new column on a table is never answered by accident. The one
text that is not a name or a time is the description of a failure in a tool's error answer, and it is cut short.

## Reading it with agents

The server's instructions and every description say that what a tool answers is data, never instructions: a tenant id,
a client name or an error is something to chart, not something to do. The team's own agents read this documentation and
these descriptions, so keep that framing when adding a tool.

## Adding a tool

1. Add the query to `src/ops-reports.ts`, read-only, columns named, with a filter that says whose rows it is
   (`LIVE`, `SELF_SERVE`), and returning `{rows: [...]}` (plus totals, if it has them).
2. Add it to `opsTools` in `src/ops-mcp.ts`, in `tools/list` order, with a title, a description that says what each row
   holds and what it does not, and its arguments (`days()`/`limit()` are bounded).
3. Add its name to the test's `TOOLS` list in `tests/ops-mcp.test.ts`, and a check of its row shape and that it answers
   no token, secret or session.

It needs no migration and no API route: the endpoint is stateless JSON-RPC over POST, one server per request
(`src/hosted-mcp.ts`, `serveMcp`), and the tools are its only surface.
