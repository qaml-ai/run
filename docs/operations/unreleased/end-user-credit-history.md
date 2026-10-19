### End-user credits: credit history and per-day totals

A tenant's credit page no longer has to read usage rows
([guide](../guides/end-user-credits.md#the-ledger)):

- `GET /v1/end-users/{id}/ledger` takes `kind` (comma-separated: `grant`, `refund`, `adjustment`, `usage`), `from` and
  `to` (a range on `createdAt`, `to` exclusive), `bucket` and `moved=true` (only entries that moved the balance),
  combined with each other and with `before`/`limit`. Bad values are a 400.
- `GET /v1/end-users/{id}/days?from=&to=&bucket=&limit=`: a person's UTC days, newest first, paged by `next` (pass as
  `to`): per bucket, what allowances paid (`freeRaw`, raw cost) and what the balance paid (`paidCharged`, with the
  markup), and per day what the tenant's grants, refunds and adjustments moved. One query over the per-day spend rows and
  the person's own entries.
- SDKs: `endUsers.ledger(id, { kind, from, to, bucket, moved })` and `endUsers.days(id, { from, to, bucket, limit })`;
  Python `end_users.ledger(id, kind=, from_=, to=, bucket=, moved=)` and `end_users.days(id, from_=, to=, bucket=, limit=)`.

No migration.
