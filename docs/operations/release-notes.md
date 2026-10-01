# Release notes

## Unreleased — rate limits

The API answers 429 `RATE_LIMITED` with `Retry-After` and the limit reached (`limit: {name, scope, max,
windowSeconds}`) past a rate limit: per account, agent creates (60 a minute, 10 on free credit) and
runs started (600 a minute, 60 on free credit); per client address, `/v1/*` requests (600 a minute),
sign-in and OAuth requests (20 a minute) and new accounts (5 a UTC day). The per-address limits are on
by default only with `AGENT_TRUST_CF_CONNECTING_IP=true`, for a runtime only Cloudflare reaches; a
self-hosted runtime sets them itself. Every value is an `AGENT_RATE_LIMIT_*` setting, and admin
tenants are exempt (their per-address /v1 traffic too) unless they set `maxAgentCreatesPerMinute` or
`maxRunsPerMinute`. See [limits](../reference/limits.md#rate-limits).

Migration 048 adds `rate_limits`. Nodes without this release count nothing, so limits hold fully once
the rollout ends.
## Unreleased — busy agents across the fleet, and usage tiers

A tenant's busy-agent limit now holds across every node together, not per node: an agent is
busy while it has a run open (running or queued), and a run past the limit gets 429
`BUSY_AGENT_LIMIT` with `busyAgents: {busy, limit, source, tier?, paid?, next?}` in the body.
Prepaid tenants get their limit from a usage tier by what they have paid for credit (Free 8,
$5 25, $50 100, $250 250, $1,000 1,000; `AGENT_USAGE_TIERS`), applied as soon as a payment
posts. A tenant's `maxAgents` still wins, and now counts across the fleet too, as does
`AGENT_MAX_AGENTS_PER_TENANT` for tenants that are not prepaid. `GET /v1/billing` and the
console's Billing page show the tier. `AGENT_FREE_MAX_AGENTS` is replaced by the first tier's
`busyAgents`; a node with it set refuses to start. Rejections at a tier's limit log
`busy_limit_reached`; at a `maxAgents` or default limit, `quota_rejected` as before.

Migration 045 adds `busy_agents`. During a rollout, older nodes neither write nor count rows,
so a tenant's runs on them are limited per node as before.

## Unreleased — structured output

A prompt takes `output: {schema}` (a JSON Schema for an object). The agent ends the run by calling a
`final_output` tool with that schema, which a system prompt section tells it to call. The runtime
checks the call and hands one that does not fit back to the model. A model that answers in text is
asked once more, with a reminder. The outcome's `result.output` is the answer. A run that still ends
without one fails with `code: "output_missing"`. The SDKs take zod, TypeBox and JSON Schema (TypeScript) or a pydantic model
(Python) as `run(text, { output })`, and return the parsed answer as `run.output`. There is no
migration: the tool is declared in the agent's transcript. During a rollout, a structured turn that
resumes on a node without this release loses the tool and ends as a plain run, without `output`. See
[structured output](../guides/structured-output.md).

## Unreleased — account export and deletion

`GET /v1/account/export` streams a zip of everything an account stores, and the console's
Account page offers it and **Delete account** (`DELETE /v1/account`, console sessions only).
Platform operators (`AGENT_BILLING_ADMINS`) look tenants up, export and delete them with
`GET /v1/tenants?login=`, `GET /v1/tenants/{id}/export`, `DELETE /v1/tenants/{id}` and
`GET /v1/tenants/{id}/deletion`. See [account data](privacy.md).
`POST /v1/tenants` makes a prepaid tenant with an API token and no sign-in identity, for
test and review accounts (see [billing](billing.md)).

Migration 043 adds `account_deletions`, reduces existing purged agents' tombstones to their id,
and deletes email thread metadata left by agents and channels deleted before. Older nodes still
authenticate a tenant being deleted until they are replaced, and purge agents into the old,
fuller tombstone: finish the rollout before acting on a deletion request.

## Unreleased — public URL aliases

`AGENT_PUBLIC_ALIASES` lists other origins the runtime answers at, such as an
earlier domain kept working after `AGENT_PUBLIC_URL` moves, and `AGENT_ISSUER`
keeps identity tokens' `iss` and the OAuth issuer where they were. On an alias,
MCP protected-resource metadata and `WWW-Authenticate` challenges name the
origin the client reached; the console, `/` and `/oauth/authorize` redirect to
`AGENT_PUBLIC_URL`. Existing OAuth grants and tokens work at every origin. See
[configuration](configuration.md).

## Unreleased — usage and billing

GitHub starting-credit eligibility is decided once, at signup. Before deploying
migration 031, set `AGENT_SIGNUP_MIN_ACCOUNT_DAYS` to the existing private policy
when GitHub sign-in and a positive starting grant are enabled. Startup now rejects
a missing policy. A disabled starting-credit program needs no policy and produces
no eligibility notice.

Replace or drain all older sign-in handlers during this rollout: they can still
re-evaluate eligibility at later sign-ins. Migration preserves existing awards; it
does not issue catch-up grants. Support exceptions use the billing-admin endpoint
`POST /v1/billing/starting-credit/grant` with `amountUsd` (whole cents, $1–$100).
See [billing operations](billing.md) for correction and audit procedures.

Migrations 034–035 add recipient opt-out and durable refund reconciliation.
Replace or drain older billing-email workers before enabling opt-out, because
their claimed sends do not perform the new final consent check. Verify that the
SES sender's DKIM signature covers both unsubscribe headers before relying on
email clients' one-click controls. The web opt-out remains available independently.

Replace older Stripe webhook handlers during this rollout: they still ignore
refunds that arrive before a purchase. The new handler persists those refunds and
applies them atomically when the purchase arrives. Previously ignored refunds
are not recreated by migration; replay their signed Stripe events through the
updated handler or reconcile them through the existing audited correction flow.

Migrations 036–039 add durable Stripe purchases, hosted billing, automatic top-up
and recovery pauses. Drain older billing and automatic top-up workers before
cutover: an older worker does not honor expired-confirmation pauses. Apply all
migrations in order, then start the updated API, webhook and worker code together.
The runtime applies pending migrations at startup; do not run older binaries
against the upgraded billing schema. Automatic top-up stays off until a customer
explicitly consents. An expired bank confirmation now voids the unpaid invoice
and stays paused until fresh consent; it cannot generate daily charge attempts.

Automatic invoice creation no longer sends an empty `default_tax_rates` value,
which Stripe rejects. It explicitly disables automatic tax and continues to
clear inherited discounts, keeping the invoice equal to the customer's quote.

Before rollout, exercise the full Stripe flow in a separate sandbox using the
pinned API version and restricted key. Check decline/retry with a changed default
card (including InvoicePayment allocation count), 3DS confirmation, invoices,
portal configuration and refunds. Configure and test billing SES/SNS feedback and
route `billing_reconciliation_required` to the operations pager. See
[billing operations](billing.md) for exact configuration and recovery procedures.
