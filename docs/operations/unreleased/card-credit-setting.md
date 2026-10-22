### Configure card-verification credit separately

`AGENT_CARD_CREDIT_USD` sets the free credit for verifying a card. Unset, it follows
`AGENT_CREDIT_GRANT_USD` (default $5). Set it to `0` to hide the console offer and
refuse new checks with HTTP 409 (`CARD_CREDIT_UNAVAILABLE`). Pending checks still
settle and are recorded without granting credit. GitHub starting grants and credit
already granted are unchanged. Terraform exposes this as `agent_card_credit_usd`;
its default empty string leaves the environment setting unset. See [Billing](billing.md).
