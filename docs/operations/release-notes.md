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
