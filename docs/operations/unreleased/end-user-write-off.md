### End-user credits: costs past a call's hold are written off, never charged past a limit

A call that cost more than it held used to be charged in full to its end user's balance, past the bucket's paid limit
(a bot at `0` too), past the daily limit, and below zero. Settlement now charges at most what is left for the call (the
balance, the daily limit and the bucket's limit, less what other calls in flight hold), on the day its cost posts to.
The rest is written off: the tenant bears it, and the person is never charged it later
([guide](../guides/end-user-credits.md#costs-past-a-calls-hold-written-off)).

- `writtenOff` (raw micro-USD) on usage ledger entries, per bucket in `GET /v1/end-users/{id}` (`today.buckets`) and
  per bucket and day in `GET /v1/end-users/{id}/days`.
- A correction down takes back the write-off first, then refunds the balance, then the allowance; one up is capped the
  same way.
- The limit that capped a charge fires `end_user.credit.exhausted` once per day, as a refused call would (a bucket
  limit of `0` now fires `bucket_limit`). Each write-off logs `end_user_written_off`.
- Web searches, page fetches, tool searches, transcriptions and images settle the same way.

Migration `074_end_user_written_off.sql` adds three columns with a default of 0.
