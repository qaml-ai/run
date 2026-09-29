# Billing

Tenants created by console sign-in pay from **prepaid credit**, like OpenRouter;
admin tenants from the tenants file are unbilled unless their entry sets
`"billing": "prepaid"` (the default is `"none"`). Tenants that signed up before
billing existed stay unbilled. A prepaid tenant without a provider key of its own
runs on the platform's keys, the tenants file's top-level `platformKeys`
(`{"anthropic": "...", "openrouter": "..."}`, like a tenant's `apiKeys`: one key
per provider, never a `*` wildcard), and pays for:

- **Model usage** on the platform's keys, at the provider's reported cost, or the
  model catalog's estimate when no cost is reported, turns and compaction alike.
  Provider credit funding costs are passed through too, with no runtime markup.
  Responses on the tenant's own key cost no credit. For model calls, `/v1/usage`
  reports raw usage `cost` and `platformCost` including provider credit funding
  costs. Tool-ranking costs already include their funding in both totals.
- **Agent time**, $0.01 per hour an agent spends in a run (model calls and tool
  execution, not idle loaded time), metered continuously, with or without its own key.
- **Web searches and page renders** on the platform's keys (`platformKeys.exa`,
  `.brave`, `.parallel`, `.firecrawl`), at the answering provider's price per
  search ($0.007, $0.005, $0.001) and $0.00083 per page `web_fetch` has Firecrawl
  render. The hour's usage entry counts them (`searches`, `renders`, and their
  cost as `web`) apart from model tokens: see `web_search` and `web_fetch` under
  [Built-ins](../guides/tools.md#built-ins-a-definition-enables).
- **Storage**, $0.10 per GB-month of what its agents and volumes keep in Storage
  (transcripts, journals, volume trees and snapshots, file chunks, each chunk once
  however many files share it), charged once a UTC day, on one node, for that day.

**OpenRouter funding.** OpenRouter reports usage in provider credits; buying those
credits is a separate expense. `AGENT_OPENROUTER_CREDIT_MULTIPLIER` is the dollars
we pay per dollar of provider credit. Its default, `1.055`, matches the published
Standard card funding fee of 5.5%. Set it to the platform account's actual effective
cost: `1` when funding fees are waived, `1.05` for standard crypto funding, or the
actual amount paid divided by credits received when minimum fees, discounts, or
non-recoverable taxes change that ratio. Do not apply the $0.80 minimum to each
model call: it applies to our credit purchases. The multiplier applies only to
platform OpenRouter model usage and tool ranking through OpenRouter. On OpenRouter
BYOK calls, funding applies only to OpenRouter credits, not to the separately paid
upstream inference. Other model providers and customer-owned keys get no OpenRouter
funding adjustment. The multiplier is independent of our checkout processing fee.
See [OpenRouter's fees](https://openrouter.ai/docs/faq#what-are-the-fees-for-using-openrouter)
and [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting).

Every movement is an entry in `credit_ledger` (grant, purchase, usage, storage,
adjustment, refund), in integer micro-USD, under an idempotency key naming its
cause; the same statement moves the balance in `credit_accounts`, so the ledger
always sums to the balance. Token and time charges ride the usage flush (a few
seconds after a response), each batch in one transaction that a retry after a lost
commit skips. They debit the balance at once but accrue into **one usage entry per
tenant per UTC hour** (key `usage:<tenant>:<hour>`), which each flush in that hour
updates in place, adding to its amount and to its breakdown in `metadata` (`tokens`,
`funding`, `activeMs`, and any other counts); from the next hour on it no longer changes. An hour
keeps the ledger to 24 usage rows per tenant a day (instead of one per flush per node)
while a row is still a useful line of history; spend is also kept by minute for an
hour (`credit_spend_minutes`), for the free-credit limit below. Usage entries from
before hourly accrual are one per flush, and stay as they are. A prepaid tenant at or below
zero gets **402** for new runs, code executions included, with where to add credit;
a running turn ends after the response that spent the last credit, as at the
[monthly spend cap](persistence.md). The balance counts this node's unwritten charges
at once and other nodes' within about five seconds, so the overdraft is about one
response per node running the tenant's turns.

**Metering storage.** Storage is not listed to charge it. Every object Storage
creates or deletes (log segments, snapshots and blobs, volume snapshot file maps,
chunks) is reported with its size, and each node adds these up per owner (an agent, a
volume, or a tenant for its chunks) and writes them to `storage_usage` every few
seconds; a chunk that exists already is not created again, so it counts once. The
daily job charges from that table: agents' logs (not purged agents'), volumes'
objects (deleted volumes' too, since their objects stay) and chunks. Deltas a node
dies holding, deletes that fail halfway and writes by nodes from before metering are
drift, which a full listing corrects: the daily job reconciles when nothing has been
reconciled yet (so tracking starts from one), every `AGENT_STORAGE_RECONCILE_DAYS`
(default 7; 0 for only that first time), and always on single-host `file` storage,
whose logs are appended files and not metered. `npm run reconcile:storage`
(`-- --dry-run` to only report) does it by hand with the runtime's database and
storage settings, printing each tenant whose total changed.

**Sign-up.** Console sign-in with GitHub admits members of `GITHUB_ORG`, or with
`AGENT_OPEN_SIGNUP=true` anyone with a GitHub account (asking only for the public
profile). A self-serve tenant is tied to the GitHub account's numeric id, so a
renamed login keeps its tenant (and a new account that takes an old login gets a
tenant of its own, `<login>-<id>` when the name is taken). Each GitHub account's
first prepaid tenant may receive starting credit, with the amount configured by
`AGENT_CREDIT_GRANT_USD`. Eligibility is decided only when the account is created,
and the decision and any grant commit together. Later sign-ins never award credit,
even if the eligibility policy or grant amount changes. An incomplete profile is
retried before creating the account. People who do not qualify can add credit or
contact support@camelai.com if they believe this was a mistake. Running with an
own provider key still requires credit for agent time. A prepaid tenant that
has never bought credit (grants and adjustments do not count; a full refund puts it
back) is on **free credit**, with tighter limits: at most `AGENT_FREE_MAX_AGENTS` (2)
agents at once per node, unless an admin set its `maxAgents`, and at most
`AGENT_FREE_HOURLY_SPEND_USD` ($1) of usage charges in any hour, past which runs get
429 and a running turn ends as above. Both lift with the first purchase.

`GET /v1/billing` has the balance, this month by kind, recent entries and the
rates and `startingCredit: {status, amount}` (the recorded award, not current
configuration); `GET /v1/billing/ledger?before=<id>` pages through the ledger; the console's
Billing page shows both. An operator of a tenant in `AGENT_BILLING_ADMINS` can
`POST /v1/billing/adjustments` `{tenant, amount (micro-USD), reason, idempotencyKey?}`.

For a support exception to starting-credit eligibility, use
`POST /v1/billing/starting-credit/grant` with `{tenant, amountUsd, reason}` ($1–$100, whole cents)
as a billing-admin operator. It uses the signup award's identity-scoped key;
repeating the same award returns the earlier entry, while a different amount
returns 409. The reason stays in the private decision record, not the public
ledger. Ordinary adjustments are separate and must not be used for the initial
award. To correct an already-issued award, post only the difference through the
operator adjustment endpoint, with a unique correction idempotency key and an
auditable reason; do not delete or rewrite the original award.

Before deploying migration 031, set the existing signup eligibility policy in
deployment configuration: it no longer has a source-code default. Replace/drain
all older sign-in handlers during the rollout; old versions still re-evaluate
eligibility. Migration preserves recorded awards and gives existing unawarded
accounts no automatic catch-up grant. Their status is `not_granted`, without
guessing why the historical grant is absent. Decision records survive tenant
deletion to prevent a recreated identity from receiving another award.

**Buying credit.** `POST /v1/billing/checkout {amountUsd}` ($5 to $1000, whole
cents) creates a Stripe Checkout session (mode `payment`) for the tenant's Stripe
customer, with a 5.5% processing fee as a line of its own ($10 of credit costs
$10.55), and returns its `url`; Stripe returns the buyer to
`/console/billing?checkout=success` (or `cancelled`). Stripe then calls
`POST /v1/billing/stripe/webhook`, authenticated by its `Stripe-Signature` (HMAC-SHA256
of `<t>.<payload>` under the endpoint's signing secret, at most five minutes old):

- `checkout.session.completed` or `checkout.session.async_payment_succeeded`, paid:
  the credit bought, not the fee, is added once per session;
- `charge.refunded`: credit is removed in proportion to the refunded share of the
  charge, once per refunded total.

Sessions and charges the runtime did not create (the Stripe account serves other
products) are acknowledged and ignored. Setup: create a secret or restricted key
(Customers and Checkout Sessions, write) and a webhook endpoint at
`https://<host>/v1/billing/stripe/webhook` for those three events, then run
`infra/stripe.sh` and paste the key and the signing secret; it stores them in the
`stripe` secret and rolls the service.


## Balance notices and recipient storage

Migration 032 records `billing.balance.low` and `billing.balance.depleted` at the
balance-row update. The trigger writes the event, endpoint deliveries and selected
email deliveries in the same transaction. A failed outbox insert rolls the charge
back. Existing balances are not replayed by migration. At the default $2 threshold,
$2.00 is not low; a balance strictly below it is. Zero counts as depleted. A single
charge crossing both boundaries creates both webhook events and only the depleted
email. Purchases or adjustments that restore the balance re-arm later crossings.

`src/billing-alerts.ts` provides the recipient and email-outbox service. Each tenant
can have five addresses, each with separate low, depleted, top-up-problem and receipt
choices. Confirmation is required before billing mail; tokens expire after 24 hours
and resend invalidates the previous token. Only hashes are kept on recipient rows;
outbox tokens are sealed under `AGENT_SECRETS_KEY` and removed after sending.
Confirmation sends are limited across tenants and survive removing/re-adding an
address. Provider-authenticated bounces/complaints must call `suppress`.

Recipient and preference mutations lock the balance row first, so they serialize
with ledger writes. Delivery claims re-check consent and suppression, have one-minute
leases, and require the lease to acknowledge/retry. Delivery is at least once: a
process can lose the acknowledgement after its provider accepts an email. A send
already in flight cannot be recalled when a recipient opts out. Consumers must
start sends within the lease and limit concurrency accordingly.

The recipient HTTP routes, confirmation page, email renderer, provider feedback
handler and sending worker are not connected yet. This service and its outbox are
the foundation for that next slice; this release does not yet send billing emails.
