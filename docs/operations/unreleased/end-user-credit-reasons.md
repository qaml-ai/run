### End-user credit: one reason code on every path

- A refusal or stop for an end user's credit says why the same way everywhere: `reason` (`balance`, `daily_limit`,
  `bucket_limit`), `bucket` and `endUser`, defined once in [Errors](../reference/errors.md#end-user-credit-reasons).
- A run refused as it comes to start in the queue now fails with a coded result, as one stopped mid-way does:
  `code: "end_user_credit"`, `stopped: "spend_limit"`, `limit: "end_user"`, `reason`, `bucket`, `endUser` (it was
  `outcome.error` text alone, `runtime_error` in the SDKs). The agent's or tenant's spend limit and spent prepaid
  credit refusing a queued run likewise give `code: "spend_limit"` with `limit` (`agent`, `tenant`, `credit`).
- A run stopped mid-way carries `bucket` and `endUser` too; a sub-agent's notification refused for credit as it lands
  ends its turn as `end_user_credit` with its reason (it read as the agent's own `spend_limit`).
- `run.failed` carries `limit`, `reason`, `bucket` and `endUser` with its `code`. `voice.session.ended` adds `bucket`
  beside `endUserReason`, which is now one of the reasons. `GET /v1/runs/{id}`'s error carries them as well.
- The account's prepaid-credit 402s say `INSUFFICIENT_CREDIT` (they said `PAYMENT_REQUIRED`).
- OpenAPI: the `Error` body declares `endUser`, `bucket`, `reason` and `refundable`; `END_USER_CREDIT` and
  `INSUFFICIENT_BALANCE` are listed codes; `end_user.balance.low` and `end_user.credit.exhausted` are documented events.
- SDKs: `AgentError` has `reason`, `bucket` and `endUser` (Python `end_user`) from any 402 (runs, stateless runs,
  transcriptions, speech, images, voice sessions); a run's error has `limit`, `reason`, `bucket`, `endUser`;
  `CREDIT_REASONS`, and `endUserCredit()` (Python `end_user_credit()`) to read them from an error or a run in one shape.
