### End-user credits: spends and descriptions

`POST /v1/end-users/{id}/entries` takes `kind: "spend"` (`endUsers.spend` in the SDKs): credit a person spends on
something you sell other than metered usage, such as a month of a feature. A spend takes at most the balance calls in
flight don't hold (409 `INSUFFICIENT_BALANCE` with `available` otherwise), is a debit for `end_user.balance.low` and
`end_user.credit.exhausted`, and fires `end_user.credit.spent`. Each day of `GET /v1/end-users/{id}/days` has `spent`.
Every entry you post may carry `description` (1–200 characters), your words for it in the person's credit history; the
ledger and the entry webhooks return it.
