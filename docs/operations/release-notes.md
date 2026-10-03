# Release notes

Each runtime release is a `runtime-v<version>` tag, and the image `ghcr.io/qaml-ai/run:<version>`
(`latest` is the newest). Upgrade a self-hosted runtime by changing `AGENT_RUNTIME_IMAGE` and running
`docker compose up -d` (see [Self-hosting](self-host.md#upgrade)); read the notes for every version
between yours and the new one first.

## Unreleased

Changes on main since the last tag.

## 0.3.0 (runtime-v0.3.0, 2026-10-03)

### Forking, OpenTelemetry export, agent credentials

- `POST /v1/agents/{id}/fork`: a new agent with the source's configuration, its committed history up to a
  turn boundary (`atMessage`), and a fork of its workspace volume. Files the copied history refers to stay
  pinned for the fork. See [Concepts](../concepts.md).
- OpenTelemetry trace export per tenant (`/v1/telemetry`): run, model, tool, compaction and human-input spans
  over OTLP/HTTP (protobuf or JSON), GenAI attributes, content off unless `include.content`. Inbound W3C
  `traceparent` continues a caller's trace. A self-hosted runtime sending to a private collector needs it in
  `AGENT_OUTBOUND_ALLOW_ORIGINS`. See [Observability](../guides/observability.md).
- `GET /v1/agents/{keyOrId}/credentials`, behind the SDKs' `agents.get()`.
- `GET /v1/models?available=true` sends an `X-Camelrun-Hint` header when it is empty, and a self-hosted
  runtime's `model_key_missing` names `AGENT_TENANT_API_KEYS`.
- Account exports read each agent's history from the node that serves it and fail rather than leave one out;
  agents a crashed node held read their whole history.
- Migrations 045-048 run on start (busy agents, tenant limits, dropping a retired Discord table, rate limits).

## 0.2.0 (runtime-v0.2.0, 2026-10-03)

### Agents without a model key, and runs that say why they failed

- Agents are made before any model key is set (0.1.0 refused with 400). A run without a key fails with
  `model_key_missing`, and one whose key the provider refuses with `model_key_invalid`; both say what to set.
- Request records carry `status` (`completed`, `input_required`, `failed`) beside `state`.
- `/docs/operations/*` is served with the other docs.

### Background compaction, Pi 1.0

Compaction no longer holds up the next run. Once an agent's context comes within 32k tokens (15% of a
smaller window) of its compaction threshold, the summary is made in the background, after a run or
between model requests, and runs go on with the whole context until it is written. Only a run whose
context would not fit waits for it, or compacts first when none is running. One compaction runs at a
time per agent. Its events carry `background: true` and reach the agent's stream outside any run
(`requestId` empty); its usage is billed as `compaction`, with no `requestId`, and counts against
spend limits as before. Measured on gpt-4o-mini with 110k tokens of history, the run that crossed the
threshold started its reply in 1.1 s instead of 12.6 s (6.3 s when it was sent straight after the
previous run, while the summary was still being made).

Context estimates no longer count usage that a response reported before the latest summary: it
measured the context the summary replaced, and could start a second compaction straight after the first.

The runtime runs on Pi 1.0 (`@earendil-works/pi-agent-core` and `pi-ai`). Transcripts written by
earlier releases load unchanged. A tool result an MCP server or OpenAPI operation returns with
`isError` keeps its content and structured content in history.

### Rate limits

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
### Busy agents across the fleet, and usage tiers

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

### Structured output

A prompt takes `output: {schema}` (a JSON Schema for an object). The agent ends the run by calling a
`final_output` tool with that schema, which a system prompt section tells it to call. The runtime
checks the call and hands one that does not fit back to the model. A model that answers in text is
asked once more, with a reminder. The outcome's `result.output` is the answer. A run that still ends
without one fails with `code: "output_missing"`. The SDKs take zod, TypeBox and JSON Schema (TypeScript) or a pydantic model
(Python) as `run(text, { output })`, and return the parsed answer as `run.output`. There is no
migration: the tool is declared in the agent's transcript. During a rollout, a structured turn that
resumes on a node without this release loses the tool and ends as a plain run, without `output`. See
[structured output](../guides/structured-output.md).

### Account export and deletion

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

### Public URL aliases

`AGENT_PUBLIC_ALIASES` lists other origins the runtime answers at, such as an
earlier domain kept working after `AGENT_PUBLIC_URL` moves, and `AGENT_ISSUER`
keeps identity tokens' `iss` and the OAuth issuer where they were. On an alias,
MCP protected-resource metadata and `WWW-Authenticate` challenges name the
origin the client reached; the console, `/` and `/oauth/authorize` redirect to
`AGENT_PUBLIC_URL`. Existing OAuth grants and tokens work at every origin. See
[configuration](configuration.md).

## 0.1.0 (runtime-v0.1.0, 2026-09-30)

### Usage and billing

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
