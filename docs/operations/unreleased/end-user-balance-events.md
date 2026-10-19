### End-user balance events for auto top-up and receipts

- A person's own low-balance threshold: `PATCH /v1/end-users/{id} {"lowBalance"}` (null: the tenant's), shown in
  `GET /v1/end-users/{id}` as `lowBalance` and `overrides.lowBalance`. `GET /v1/end-users?belowLowBalance=true` lists
  the people under theirs. Migration 076 adds columns (nullable, or with constant defaults) and rewrites no rows.
- `end_user.balance.low` and `end_user.credit.exhausted` (`balance`) carry a `cause`: `usage`, `usage_correction`,
  `grant`, `refund`, `adjustment`, `refusal` or `threshold_changed`, with the ledger `entryId` (which orders a
  person's events), the tenant's `entryKey` and the run's `requestId`.
- Re-arm rules, now written down: a grant or a positive adjustment that leaves the balance short re-arms the event,
  so the first debit after a top-up that left someone under their threshold fires `balance.low` again. Setting a
  threshold above someone's balance fires it once (`threshold_changed`). Refunds stay silent. See
  [When balance events fire](../guides/end-user-credits.md#when-balance-events-fire).
- New events: `end_user.credit.granted`, `end_user.credit.refunded`, `end_user.credit.adjusted` (once per entry the
  tenant posts) and `end_user.allowance.low` (spend past the tenant's new `allowanceWarningPercent` of a bucket's daily
  allowance, once per person, bucket and day; off by default).
- A new guide: [Auto top-up on end-user credits](../guides/end-user-auto-top-up.md). The SDKs take `lowBalance` on
  `endUsers.update`, `belowLowBalance` on `list` and `allowanceWarningPercent` on `configure`/`amend`, and type the
  new events.
