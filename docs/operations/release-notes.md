# Release notes

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
