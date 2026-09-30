# Account data: export, deletion and retention

What the runtime keeps about an account, how a tenant takes a copy of it or deletes it, and how
support handles those requests when they arrive by email.

## Export

`GET /v1/account/export` (the console's **Account → Export data**) answers with a zip, written as it
is read (`src/account-export.ts`, `src/zip.ts`), so an export of any size holds only a history page
or a file chunk in memory at a time:

- `account.json`: the tenant id, the GitHub login or Google address it signs in with, when it was made
- `agents/<id>/agent.json`: each live agent's configuration (as `GET /v1/agents/:id` shows it) and schedules
- `agents/<id>/history/<index>.json`: its whole history, a page of whole turns per file, named by the page's first message index
- `definitions.json`, `channels.json`, `webhooks.json`, `tokens.json`, `keys.json`, `oauth-grants.json`: as the API lists them,
  so secrets, keys and tokens are left out (keys show their last four characters)
- `volumes/<id>/volume.json` and `volumes/<id>/files/...`: every volume's files (agents' workspaces included)
- `billing/ledger.jsonl` (newest first) and `billing/usage.json` (per day and model)

Any token of the tenant can export (not a browser token). Entries are deflated and the archive uses
ZIP64 only when it needs it (over 65,535 files or 4 GiB). A platform operator exports any tenant with
`GET /v1/tenants/{id}/export`.

## Deletion

A signed-in person deletes their account from the console (**Account → Delete account**, typing
`delete my account`; the dialog shows the purchased and free credit the deletion forfeits, counting
free credit as spent first, and points to support@camelai.com), which calls `DELETE /v1/account` with `{"confirm": "<tenant id>"}`. Only a
console session can: an API or OAuth token cannot. A platform operator (an operator token of a tenant
in `AGENT_BILLING_ADMINS`) deletes any tenant with `DELETE /v1/tenants/{id}` and follows it with
`GET /v1/tenants/{id}/deletion`. Admin tenants, from the tenants file, are refused (403): remove them
from that file with `infra/tenant.sh remove`, after deleting what they own through the API.

**At once**, in one transaction (`src/account-deletion.ts`): the tenant stops authenticating (tokens,
console sessions, OAuth; other nodes' ten-second token caches lapse), its GitHub and Google identity
columns are cleared so sign-in no longer finds it, and automatic top-up is switched off. A deletion is
refused (409) while an automatic top-up payment is in flight.

**Then**, on whichever node claims it (`account_deletions`, with a five-minute lease, polled every
`AGENT_SCHEDULER_INTERVAL_MS`), in order, each step safe to repeat:

1. Channels are torn down at their provider and deleted, with their queued items and email threads.
2. Every agent is deleted where it runs (`POST /internal/agents/:id/delete` to its owner) and purged
   by the agent sweep: logs, history, local files, chunk pins, schedules, inputs, channel bindings
   and email threads. The deletion waits, polling, until none is left.
3. Volumes are deleted and purged at once (no grace period), and every file chunk under
   `chunks/<tenant>/` is removed.
4. Open Stripe Checkout sessions are expired and the tenant's Stripe customers deleted. Deleting a
   customer detaches its saved cards and cannot be undone; the charges, invoices and refunds stay in
   Stripe, where accounting needs them. That is simpler and more complete than detaching each card.
5. The remaining rows go in one transaction: API tokens, OAuth grants and tokens, provider keys, key
   scopes, custom providers, definitions, webhooks and their deliveries, idempotency answers, billing
   contacts, settings and events, Get Help requests, storage and collection rows, and the tenant row.

A failed step is logged (`account_deletion_failed`, the error's class and status only) and retried a
minute later from the start; a node that dies mid-deletion leaves its lease to lapse.

**Kept, on purpose**, keyed by the deleted tenant's id: the credit ledger and account (`credit_ledger`,
`credit_accounts`), usage totals (`usage`), payment records (`billing_checkouts`,
`billing_auto_attempts`, `billing_auto_quotes`, `billing_stripe_refunds`, `billing_stripe_customers`), and
the starting-credit records (`starting_credit_decisions`, by GitHub id; `card_checks`, by card
fingerprint). They hold amounts, dates, Stripe ids, a paying card's brand, last four digits and expiry
(automatic top-ups and their ledger entries), and those identifiers; no names, addresses or content. For a GitHub
signup the tenant id is the GitHub login (lowercased), so that login stays on those rows. The
`account_deletions` row keeps the id from ever being given to a new tenant, and deleted agents'
tombstones keep only their ids.

**Afterwards** the same GitHub account or Google `sub` signs up as a new, empty tenant (under another
id), with no starting credit: its GitHub id's decision, or its card's check, is still recorded.

## Retention

| Data | Kept |
|---|---|
| A deleted agent's data | purged within about a minute (`AGENT_PURGE_INTERVAL_MS`); its tombstone keeps only its id |
| An expired agent's data | the same, once its TTL passes |
| Email thread metadata (addresses, subjects, Message-IDs) | until its agent or channel is deleted |
| Inbound mail stored in S3 (large messages) | 7 days (`email.tf` lifecycle) |
| A deleted volume's files | until storage collection's grace period passes (`AGENT_GC_GRACE_MS`, a day), once collection is enabled; at once on account deletion |
| Runtime logs (`/ecs/camelai-agent-runtime`) | 30 days; ids, sizes and error classes only (see "What logs hold" in [architecture](architecture.md)) |
| Other log groups, and the billing-email Worker's | see [infra/terraform/README.md](../../infra/terraform/README.md#log-retention) |
| Ledger, usage, payment and starting-credit records | kept after deletion, as above |

## Runbook: a deletion or export request by email

1. **Find the account.** Ask for the GitHub login or Google address they sign in with, then
   `curl -G -H "Authorization: Bearer $OPERATOR" --data-urlencode "login=<login or address>" "$RUNTIME/v1/tenants"`.
   No match: tell them there is no account for that identity.
2. **Verify the requester.** Reply only to the address on the account (`googleEmail`), or, for a
   GitHub account, to the email on their public GitHub profile, and ask them to confirm; or have them
   sign in and do it from the console (Account page), which needs no verification. Never act on a
   request from another address.
3. **Export:** `curl -fH "Authorization: Bearer $OPERATOR" -o export.zip "$RUNTIME/v1/tenants/<tenant>/export"`,
   then share it through an expiring link (never as an attachment), and delete your copy once sent.
4. **Delete:** `curl -X DELETE -H "Authorization: Bearer $OPERATOR" "$RUNTIME/v1/tenants/<tenant>"`,
   then check `GET /v1/tenants/<tenant>/deletion` until `state` is `deleted` (usually under a minute;
   `agents` counts those still being purged). A `deleting` state that does not move: search the logs
   for `account_deletion_failed` with that tenant.
5. Reply that it is done, and that the ledger and payment records are kept for accounting as the
   privacy policy says. Close the ticket without copying their data into it.

`$OPERATOR` is the operator token of a tenant in `AGENT_BILLING_ADMINS` (Secrets Manager,
`<SECRET_PREFIX>/operator-token/<tenant>`). Never run a deletion against a tenant you have not
verified: it cannot be undone.
