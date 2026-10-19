### End-user credits: per-bucket limits, refunds and fixes

- `bucketLimits` (the tenant's in `/v1/end-user-settings`, and each person's own in `PATCH /v1/end-users/{id}`), keyed
  as allowances are (`"bot:*"`), cap what one bucket may charge a person's balance per UTC day, holds included; 0 keeps
  a bucket to its free allowance. Past it, work is refused with reason `bucket_limit`, and `end_user.credit.exhausted`
  says so once per person, bucket and day (with `bucketLimit`). `GET /v1/end-users/{id}` shows each bucket's
  `paidLimit`. `PATCH /v1/end-user-settings` merges allowances and bucket limits key by key (SDK `endUsers.amend`). Migration 072.
- A refund entry returns at most the balance calls in flight do not hold (409 `INSUFFICIENT_BALANCE`, with
  `refundable`); a lowered cost is refunded at the rate it was paid, never more. A refund crosses the balance-low and
  out-of-credit thresholds silently.
- A model with no price is never free to end users: it holds and settles at the catalog's price, else a mid-range one,
  and logs `end_user_unpriced_model`. The markup applies over what a call costs the tenant on the platform's key.
- A queued run's start is checked against its own bucket, and runs that name no bucket (a schedule's, a notification's)
  spend from the agent's last one, not `default` (#167, #179).
- Holds size by what a call is likely to cost (cached input included), are renewed while a reply streams slowly, and a
  call that began before midnight UTC spends from the day it began (#182).
