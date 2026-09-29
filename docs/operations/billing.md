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

**Buying credit.** `POST /v1/billing/checkout {amountUsd, requestId?}` ($5 to $1000, whole
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

Sessions and explicitly tagged charges from other products are acknowledged and
ignored. A refund with no known purchase is retained by charge/payment-intent ID,
amount, currency and cumulative refunded amount, without changing any balance.
When its purchase arrives, the purchase and all known refunds are appended in the
same transaction and move the balance together. This handles Stripe's
[out-of-order event delivery](https://docs.stripe.com/webhooks#event-ordering).
Older cumulative refund totals cannot reverse newer ones; a refund never removes
more credit than its purchase supplied. Refund records without a product tag are
kept because an older Checkout event can still arrive later.

New Checkouts create a paid invoice as well as a receipt. Before the Stripe call,
`billing_checkouts` stores the tenant, environment, customer, amount, fee, currency,
API version and complete request parameters. Supply a UUID `requestId` and reuse it
for retries of the same purchase; changing its amount returns 409. The console
keeps the same ID while retrying an amount in its open purchase dialog. Callers
that omit the ID create a fresh purchase on each request.

The saved parameters and Stripe idempotency key survive restarts and price changes.
An ambiguous Checkout create is never retried after 23 hours (Stripe can prune keys after 24
hours). It returns 409 and logs `billing_reconciliation_required`; reconcile the
existing object in Stripe before taking further action. A known session is
retrieved, not re-created. Fulfillment checks the recorded customer, environment,
currency, total and session/order IDs. Metadata cannot change the credit or tenant.
`invoice.paid` does not credit a second time; manual purchases are fulfilled only
from paid Checkout events. Purchase, early refunds and the order's paid marker
commit together.

Migration 036 records a cutover timestamp. **Drain older Checkout creators before
migrating, then replace all old billing webhook handlers before accepting new
purchases.** Only unregistered sessions created at or before cutover use legacy
metadata fulfillment. Historical sessions remain payable; new unregistered ones
are rejected. Test and live customers have separate durable rows. An abandoned Customer placeholder older than 23 hours gets a fresh, fenced creation key; an empty duplicate Customer cannot charge anyone. Existing
customers are adopted only after Stripe confirms their environment and the
product/tenant tags used by the previous integration.

`POST /v1/billing/portal {flow: "manage"}` opens Stripe's billing portal for an
existing customer. `flow: "payment_method"` creates the customer if needed and
opens Stripe's focused card-update flow, which sets the customer's default payment
method. Both use a fixed console return URL and accept no customer ID or caller
return URL. Saving a card does not enable auto top-up or authorize a charge.
`GET /v1/billing/payment-method` reads the default card from Stripe and returns only
brand, last four digits and expiry. No card number, fingerprint or payment-method
ID is exposed. OAuth agents cannot create Checkout or portal sessions.

Set `AGENT_STRIPE_PORTAL_CONFIGURATION` to a dedicated configuration with metadata
`purpose=agent-runtime-credit`, invoice history and payment-method updates enabled,
and subscription cancellation/updates disabled. The server verifies these settings
and the environment before opening the portal. The Billing page shows **Manage
billing** once the tenant has a Stripe customer and the portal is configured.
Portal customer emails are independent of the confirmed billing-alert recipients.

Setup: in Stripe's restricted-key Dashboard, set **Customers**, **Checkout
Sessions** and **Customer Portal** to **Write**. The Customer Portal permission
covers session creation and configuration reads. Invoice creation
must be enabled for these one-time purchases. Pin the webhook endpoint to
`2026-08-26.dahlia`, matching the request `Stripe-Version`, and subscribe to
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, and
`charge.refunded`. Keep the key and signing secret in `AGENT_STRIPE_SECRET_ARN`
(or the development environment variables). Use a separate Stripe sandbox for
integration validation before live rollout. The local suite uses an isolated
Postgres database and an HTTP Stripe fake; it does not verify account permissions,
portal branding, hosted pages, or live invoice generation.

Tax is not enabled by this change. Confirm applicable registrations and the tax
setup before adding Stripe Tax; turning on `automatic_tax` alone is insufficient.
See [Stripe Tax for Checkout](https://docs.stripe.com/tax/checkout).


## Balance notices and billing email

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
address. Signed provider feedback suppresses addresses after permanent bounces or
complaints, including across tenants.

Recipient and preference mutations lock the balance row first, so they serialize
with ledger writes. Delivery claims re-check consent and suppression, have one-minute
leases, and require the lease to acknowledge/retry. Delivery is at least once: a
process can lose the acknowledgement after its provider accepts an email. A send
already in flight cannot be recalled when a recipient opts out. Consumers must
start sends within the lease and limit concurrency accordingly.

The console's **Billing → Alerts** editor manages the threshold and up to five
recipients. Recipient and checkbox changes save immediately; the threshold saves
on blur, Enter, or Done. Invalid thresholds keep the dialog open with an error.
These routes require an authenticated prepaid tenant. OAuth tokens with the MCP
agents scope cannot mutate billing settings or start a checkout:

| Route | Purpose |
| --- | --- |
| `GET /v1/billing/alerts` | Threshold, recipients and whether email sending is configured |
| `PUT /v1/billing/alerts` | Set `thresholdUsd` ($0.01–$500, whole cents) |
| `POST /v1/billing/alerts/recipients` | Add an `email`, with optional `events` choices |
| `PUT /v1/billing/alerts/recipients/{id}` | Replace all four `events` choices |
| `DELETE /v1/billing/alerts/recipients/{id}` | Remove a recipient and cancel queued mail |
| `POST /v1/billing/alerts/recipients/{id}/resend` | Send a new confirmation, subject to rate limits |

Confirmation links open `/console/billing/confirm` with the token in the URL
fragment, which is not sent in the page request. The page submits it in a JSON body
to `POST /v1/billing/alerts/confirmation/inspect` for a read-only preview. Only the
explicit **Confirm** button calls `POST /v1/billing/alerts/confirmation/confirm`.
Neither route requires sign-in or creates a session. Opening the link, including
an email scanner's GET, does not subscribe the address. Invalid, expired, removed
and suppressed recipients all receive the same unavailable state.

Every billing email also includes **Stop these alerts**, usable without an account.
Its landing page requires an explicit button press; it never unsubscribes on GET.
An independent random per-recipient token is hashed for lookup and encrypted for
reuse in future mail. Opt-out sets the recipient to `unsubscribed`, invalidates its
old confirmation, and cancels queued mail. Other accounts at the same address are
unaffected. Checkbox edits cannot restore consent: **Request confirmation** sends
a new confirmation link before alerts can resume. Removing and re-adding a row
also requires a new confirmation.

The emails carry `List-Unsubscribe` and `List-Unsubscribe-Post`. The public
`POST /v1/billing/alerts/one-click/{token}` accepts the RFC 8058
`List-Unsubscribe=One-Click` form in URL-encoded or multipart format, without
cookies or authentication, and returns 204 without redirects. The token in this
specific endpoint's URL only permits opt-out; omit/redact it in proxy access logs.
For email clients to offer their one-click action, verify that the sender's DKIM
signature covers both headers, as required by
[RFC 8058](https://www.rfc-editor.org/info/rfc8058/). Browser preview checks do not
verify a provider's delivered DKIM signature.

Confirming or enabling an alert while the balance is already low queues the current
state. Repeated off/on changes cannot send that same kind to the same recipient
more than once in 24 hours. Genuine later balance crossings are independent of
this current-state cooldown.

### Configuring delivery

Email is optional. Without `AGENT_BILLING_EMAIL_FROM`, no worker starts and adding
or resending recipients returns 503; balance events and threshold editing still
work. To enable sending, configure:

- `AGENT_BILLING_EMAIL_FROM`: a verified SES sender address.
- `AGENT_BILLING_EMAIL_NAME`: optional display name, default `camelRun Billing`.
  The sender address remains separate; feedback compares the address only.
- `AGENT_BILLING_EMAIL_CONFIGURATION_SET`: an SES configuration set that publishes
  bounce and complaint events to SNS.
- `AGENT_BILLING_EMAIL_SNS_TOPICS`: the comma-separated topic ARNs allowed to send
  feedback to `POST /v1/billing/email/feedback`.
- `AGENT_PUBLIC_URL`: the public HTTPS origin for console links and email images
  (HTTP is accepted only for local development).
- `AGENT_SECRETS_KEY` (or its Secrets Manager setting) and `AWS_REGION`; the runtime
  role must be allowed to call SES `SendEmail` for the configured sender.

Subscribe that HTTPS feedback URL to the configured SNS topics. The handler
validates SNS signatures and topic allowlisting, confirms matching signed
subscription requests, and correlates feedback with this product's delivery tags
and recipient. Transient bounces do not suppress the address. Configure the SES
event destination as described in [SES event publishing](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html).
No AWS resources are provisioned by this application change.

The worker polls every five seconds, claims at most five deliveries, and sends
them concurrently with a 15-second request deadline and no SDK retries. The outbox
owns retries. Emails include recipient confirmation, low balance, out of credit,
automatic top-up problems and receipts. Mail is multipart HTML/text and uses public assets under
`/console/email/`. Its table layout and branding follow camelStream's existing
email design; the animated banner was rendered from the console's `DitherLiquid`.

## Automatic top-up

Migration 037 adds off-by-default automatic top-up. The worker starts only when
Stripe is configured. An authenticated prepaid account must save a quote and
explicitly accept its current version before any automatic purchase can be
reserved. Billing recipients are optional and do not gate activation.

- `POST /v1/billing/auto-topup/quote` takes `{thresholdUsd, amountUsd, monthlyLimitUsd}`.
  Threshold is $1–$500; credit uses the configured purchase bounds; the monthly
  limit includes the fee, must cover one purchase, and is capped at $100,000.
- `GET /v1/billing/auto-topup/quote?id=<uuid>` returns that saved draft, the current
  default card and a confirmation version. Omitting `id` retrieves the latest
  draft for the authenticated tenant. Drafts expire after 24 hours.
- `POST /v1/billing/auto-topup/enable` takes `{quoteId, version, consent:true}`.
  A changed default card, settings version, month, current reservations, usage of
  the cap, or immediate-charge condition requires reviewing a fresh preview.
  Acceptance, settings and an immediately due reservation commit together.
- `POST /v1/billing/auto-topup/disable` stops new reservations and cancels an
  unsubmitted reservation. Declined or missing-card attempts enter `cancelling`:
  the worker checks Stripe, voids the unpaid invoice, then releases the hold.
  A payment already settling is fulfilled if successful. Bank confirmation stays
  available for 24 hours from its first action-required observation, then the
  worker voids it if still unpaid and enters `paused_expired`. The pause persists
  until the customer accepts a fresh quote; the console’s Retry top-up action
  reviews current terms and authorizes a new invoice. A portal return alone
  never resumes it. The UI discloses that an in-progress payment may finish.
- `POST /v1/billing/auto-topup/retry` takes `{attemptId}` and retries a declined
  payment against the same invoice, using the current default card. It creates
  neither another invoice nor another cap reservation.
- `POST /v1/billing/auto-topup/refresh` wakes existing waiting work after a portal
  return. It does not retry a declined payment or grant new consent.
- `GET /v1/billing/auto-topup` returns settings, effective state, used and held
  amounts, reset time and any unresolved attempt. OAuth agents cannot mutate
  these endpoints.

Card setup uses `POST /v1/billing/portal` with
`{flow:"payment_method", resumeAutoTopup:true}`. Stripe returns to
`/console/billing?payment_method=updated&resume=auto-topup`. Reopen the saved quote,
show the current card and exact terms, and obtain consent; returning from Stripe
is never consent by itself. A card changed in the portal becomes the card for
future top-ups. The worker snapshots the selected card before each pay operation.

The monthly limit is **all-in automatic purchases initiated in the UTC month**,
including unresolved holds. Manual purchases do not count. Refunds do not reopen
the cap. At $20 credit plus a $1.10 fee, a $200 limit permits nine purchases
($189.90). One unresolved attempt per tenant/environment is enforced by a unique
index, even across month changes, preventing another charge while a prior result
is uncertain. Settings changes do not rewrite an existing attempt's quote.

Each durable attempt advances through invoice creation, the explicit credit and
fee items, finalization, default-card selection, payment, and observation. Each
mutation has its own stable Stripe idempotency key and saved step start time.
The worker claims one-minute leases, renews each ready step, and advances without
waiting for the next timer tick. Network calls stay outside database transactions.
Enabled tenant scans are claimed across nodes; healthy balances make no Stripe
requests. Migration 039 also checks the monthly cap before reading a card;
capped accounts skip scans until their UTC reset or newly consented terms. A
committed usage flush wakes eligible low-balance scanning. Waiting declined,
missing-card and bank-confirmation attempts are checked hourly; invoice webhooks,
explicit retry and authenticated portal returns can wake them sooner. Invoice `auto_advance` is false, pending items are excluded,
inherited discounts are cleared, automatic tax is disabled, and each line is attached to the
specific invoice. The worker owns retries; Stripe's automatic collection is not
used. Standalone invoice creation omits `default_tax_rates`: Stripe rejects an
empty string for that parameter. The ledger uses one purchase key per automatic attempt.

A paid invoice is not sufficient proof of payment: the worker retrieves its
Invoice Payment and expanded PaymentIntent and verifies the customer,
environment, currency, amount, paid allocation, successful status and amount
received. Fulfillment and any early refunds commit atomically with the paid
attempt marker and receipt event. Out-of-band, altered, split or otherwise
unrecognized payments go to `reconcile`; they do not grant credit automatically.

States are `off`, `on`, `processing`, `cancelling`, `action_required`, `paused_declined`,
`paused_no_card`, `paused_expired`, `limit_reached`, and `reconcile`. Missing cards resume when a
new default exists; declined cards require an explicit retry. Bank confirmation
uses the hosted invoice URL. Expiry cancellation persists its reason before
calling Stripe and pauses settings atomically with releasing the verified void
hold. A settling payment retains the hold and is fulfilled if successful.
An ambiguous create/item/pay past 23 hours retains
its hold and emits `billing_reconciliation_required`; a known successful invoice
can still be reconciled without another charge. Operators must inspect the Stripe
invoice and the saved attempt before resolving these cases.

Route `billing_reconciliation_required` logs to the operations pager. The customer
email explains the temporary pause and offers manual credit; it does not ask the
customer to reconcile records. Operator procedure: disable auto top-up, identify
its saved attempt/customer/environment and inspect the invoice plus all invoice
payments in Stripe. A fully verified paid invoice can be requeued at `observe`
with a cleared lease; fulfillment is idempotent. A confirmed unpaid invoice must
be voided before marking its attempt cancelled and releasing the reservation.
Never clear a hold merely because an HTTP response timed out, and never manually
insert another purchase for the same PaymentIntent. Multiple allocations,
out-of-band payments, or an unknown create require investigation before any
state change. Keep the original attempt, Stripe IDs and an incident record.
No pager destination or production routing is configured by this change.

Subscribe the existing signed Stripe endpoint to `invoice.paid`,
`invoice.payment_failed`, `invoice.payment_action_required`, and `invoice.voided`
as well as the existing Checkout/refund events. Invoice events wake observation;
periodic polling recovers missed or reordered events. For automatic top-up,
add these Dashboard permissions to the restricted key:

| Resource | Permission |
| --- | --- |
| Invoices | Write |
| Payment Intents | Read |
| Payment Methods | Read |

Invoices includes invoice-item creation, finalization, payment, voiding and
Invoice Payment reads. All other resources and Connect permissions can remain
None. These six combined scopes passed test-mode acceptance on
`2026-08-26.dahlia`: Checkout creation/retrieval, both portal flows, automatic
refill and invoice reconciliation, including recovery without webhook forwarding.
Verify the deployed key and hosted flows in the intended Stripe environment
before live rollout; this check did not provision production credentials.

Events `billing.topup.receipt`, `.declined`, `.action_required`, `.no_card`,
`.limit`, and `.reconcile` feed the existing signed webhook and email outboxes.
Receipts follow the recipient's receipts preference; all other top-up events use
the problems preference. Resolved and superseded payment warnings are checked
again before sending. Hosted invoice URLs are stored for Activity links; the
console does not have to retrieve invoices. Stripe owns the actual invoice and
card forms. Taxes remain disabled pending applicable registrations and a separate
tax configuration decision.
