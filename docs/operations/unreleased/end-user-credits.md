### End-user credits

- Tenants can charge their own users: `PUT /v1/end-user-settings` turns it on, with daily free allowances by bucket
  (`builder`, `bot:*`), a markup and a daily limit on paid spend. Each subject has a balance and a ledger
  (`/v1/end-users/{id}`, `/ledger`, `/entries` for grants, refunds and adjustments, idempotent by key). Agents take a
  `bucket`; so do `POST /v1/runs`, `/v1/transcriptions`, `/v1/images` and prompts sent with the API key.
- Every model call of a subject's work holds its estimate before it is made and as it streams; a run that runs out is
  refused (402 `END_USER_CREDIT`) or stops mid-reply (code `end_user_credit`, `reason` `balance` or `daily_limit`).
  Transcriptions and images hold and settle too; web search, page renders and tool search are charged as recorded.
- Webhooks `end_user.balance.low` and `end_user.credit.exhausted` (`allowance`, `balance`, `daily_limit`).
- Migration 069. SDKs: `agents.endUsers` (TypeScript) and `agents.end_users` (Python), `bucket` on upserts and stateless
  runs. See [End-user credits](../guides/end-user-credits.md).
- The simulator has an end-user scenario (one subject pays for every agent), checked by I22.
