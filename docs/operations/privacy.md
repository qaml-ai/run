# Account data: export, deletion and retention

What the runtime keeps about an account, how a tenant takes a copy of it or deletes it, and how
support handles those requests when they arrive by email.

## Export

`GET /v1/account/export` (the console's **Account → Export data**) answers with a zip, written as it
is read (`src/account-export.ts`, `src/zip.ts`), so an export of any size holds only a history page
or a file chunk in memory at a time:

- `account.json`: the tenant id, the GitHub login or Google address it signs in with, the address it signs in with a password (`email`), when it was made
- `agents/<id>/agent.json`: each live agent's configuration (as `GET /v1/agents/:id` shows it) and schedules
- `agents/<id>/history/<index>.json`: its whole history, a page of whole turns per file, named by the page's first message index
- `definitions.json`, `channels.json`, `webhooks.json`, `telemetry.json`, `tokens.json`, `keys.json`, `oauth-grants.json`: as the API lists them,
  so secrets, keys and tokens are left out (keys show their last four characters)
- `discord.json`: managed server bindings, installation names and states, allowed channels, the Discord IDs of
  the administrators who added Camel, and pending setup expiry times; never OAuth tokens or session/state hashes
- `volumes/<id>/volume.json` and `volumes/<id>/files/...`: every volume's files (agents' workspaces included)
- `billing/ledger.jsonl` (newest first) and `billing/usage.json` (per day and model)
- `analytics/`: only for an account [journey events](#journey-events) ever knew, what this runtime and the operator's store hold of its journey

Any token of the tenant can export (not a browser token). Entries are deflated and the archive uses
ZIP64 only when it needs it (over 65,535 files or 4 GiB). A platform operator exports any tenant with
`GET /v1/tenants/{id}/export`.

An export is whole or it fails. Each agent's history is read from the node that serves it (only that
node holds its newest turns), and an agent's pages must add up to its message count. A history that
cannot be read (its node unreachable, a chunk missing) ends the export with the zip cut off before its
central directory, so no zip reader takes it as complete; the node logs `account_export_failed`. Retry
the export.

## Email addresses and account mail

The runtime keeps an email address where someone signs in with it: the Google address of a Google sign-in
(`tenants.google_email`), and the address of a password (`tenant_passwords.email`), lowercased. Where account
mail is configured ([Account email](account-email.md)), it also keeps, for each link it mails, the address it
went to, the SHA-256 of the link's token (never the token) and, for a sign-up or an added password, the
password's scrypt hash (`account_email_links`); a link lasts a day (a reset link an hour) and is deleted when
used, replaced or swept after it expires. An address that never verifies leaves nothing else behind.

Account mail (and, once `ses_mail_enabled` is on, billing and Get Help mail) goes through Amazon SES (camelRun's AWS account, us-west-2): the address, the subject and the
link travel to SES, which keeps its own sending records and, for addresses that bounce or complain, the
account-level suppression list. The runtime sends only what a person asked for (a sign-up, a reset, adding a
password, or a note that the address already has an account); no marketing. Logs name the tenant and the
kind of mail, never an address, a link or a password (`tests/log-privacy.test.ts`, `tests/email-signup.test.ts`).
On a self-hosted runtime with the `log` provider, each link and its address are written to the log for the
operator to pass on.

## Deletion

A signed-in person deletes their account from the console (**Account → Delete account**, typing
`delete my account`; the dialog shows the purchased and free credit the deletion forfeits, counting
free credit as spent first, and points to support@camelai.com), which calls `DELETE /v1/account` with `{"confirm": "<tenant id>"}`. Only a
console session (signed in with GitHub, Google or a password) can: an API or OAuth token cannot. A platform operator (an operator token of a tenant
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
5. The remaining rows go in one transaction: the password and its address, mailed links, API tokens, OAuth grants and tokens, provider keys, key
   scopes, custom providers, definitions, webhooks and their deliveries, trace export settings, idempotency answers, billing
   contacts, settings and events, Get Help requests, managed Discord bindings and setup attempts,
   storage and collection rows, and the tenant row. Platform Discord installation metadata remains independently
   of account deletion; it no longer names the deleted tenant or its administrator.

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
id), with no starting credit: its GitHub id's decision, or its card's check, is still recorded. The same
email address may sign up again as a new, empty tenant.

## Retention

| Data | Kept |
|---|---|
| A deleted agent's data | purged within about a minute (`AGENT_PURGE_INTERVAL_MS`); its tombstone keeps only its id |
| An expired agent's data | the same, once its TTL passes |
| Email thread metadata (addresses, subjects, Message-IDs) | until its agent or channel is deleted |
| Inbound mail stored in S3 (large messages) | 7 days (`email.tf` lifecycle) |
| A deleted volume's files | until storage collection's grace period passes (`AGENT_GC_GRACE_MS`, a day), once collection is enabled; at once on account deletion |
| Runtime logs (`/ecs/camelai-agent-runtime`) | 30 days; ids, sizes and error classes only (see "What logs hold" in [architecture](architecture.md)) |
| Other log groups | see [infra/terraform/README.md](../../infra/terraform/README.md#log-retention) |
| Rate limit counters (`rate_limits`: tenant ids, and client addresses and email addresses as keyed hashes) | until their window (a minute, 15 minutes, an hour, or a UTC day) ends, then swept within an hour; per-node request counts are in memory only |
| Mailed links (`account_email_links`: the address, the token's hash, a sign-up's password hash) | until used or replaced, else a day after mailing (a reset link, an hour), then swept; a tenant's go with its account |
| Account mail at Amazon SES | SES's sending records; addresses that bounce or complain stay on the account's suppression list until removed |
| Ledger, usage, payment and starting-credit records | kept after deletion, as above |
| Trace export settings (`telemetry_exporters`: endpoint, sealed headers) | until the tenant clears them, or its account is deleted |
| Journey events waiting to be sent (`journey_outbox`), where configured | until the operator's store takes them, 30 days at most; an account's go when it is deleted |
| Spans waiting to be exported | in each node's memory only, seconds; dropped when they cannot be sent |

## Trace export

A tenant that sets `PUT /v1/telemetry` has its agents' runs sent as OpenTelemetry spans to the endpoint it
chose (`src/telemetry.ts`; [Observability](../guides/observability.md)). By default spans carry ids, names,
models, token counts, costs, durations and outcomes, with error *classes* rather than messages. Prompts,
replies, tool arguments and results, input questions, metadata and error messages go only when the tenant
sets `include.content: true`; `tests/telemetry.test.ts` checks both. The endpoint's headers (its API key)
are sealed under `AGENT_SECRETS_KEY` like provider keys, are never returned by the API, the export or the
logs, and are dropped when the endpoint moves to another origin. Exports go through the outbound guard
(public addresses only). A failed export logs `telemetry_export_failed` with the tenant, a span count and
`safeError` (class and status), never a span or header. The account export holds `telemetry.json`
(header names only), and deletion removes the settings.

## Journey events

Off unless the operator sets `AGENT_JOURNEY_URL` (see [configuration](configuration.md)); a self-hosted
runtime sends none, and its console is served exactly as before. With it set, the runtime tells the
operator's own analytics store (`src/journey.ts`), so a visit to the operator's website can be followed to
an account and what it did:

- when a browser arrives at the console from elsewhere (`run_arrived`: how it came, and the route it landed on);
- which console pages a browser sees (`page_viewed`, from the console itself, `console/web/lib/journey.ts`);
- when a sign-in is started, and when an account is made (by a GitHub or Google sign-in, by finishing an email sign-up, or by an operator through the API), signed in to, signed out of, mints an API token or is deleted;
- when an agent is made through the API (not one its key already had, a delegate's child or a channel's), with how (`console`, `api` or `mcp`);
- that an account ran an agent on a UTC day (`run_active_day`: one mark a day, no count of runs and nothing of any run), and its first run to end with its answer (`run_first_execution_completed`);
- an account's payments: a card check that granted starting credit, a Checkout session started (the credit asked for), credit paid for by Checkout or an automatic top-up (the credit in cents, the fee aside, and Stripe's id for the payment), and automatic top-up switched on. A purchase is told of in the transaction that adds it to the ledger, so only on Stripe's word that it was paid, and once.

An event carries its name, a time, a few listed properties (the sign-in method, whether a token or an agent
was the account's first, the day), an `account_ref`, a `visitor_id`, and for a page its host and route, and
nothing else: no tenant id, login, address, token, agent id or name, prompt, answer or query string. What an
account did "first" is known for accounts made while journey events were on; an older account has no first
run told, and its first token or agent is one made when it had no other. A page is its route (`/console/agents/:agent_id`),
never the address with an id in it; an address that is no known route is `/console/*`. `account_ref` is a
random id kept in `journey_accounts`, because a tenant id can be a GitHub login. `visitor_id` is the UUID in
the cookie `AGENT_JOURNEY_VISITOR_COOKIE` names; a value that is not a UUID is ignored. Who an event is
about comes from the request (its cookie, its session), never from what the console sends. A source may report
120 console pages a minute to each node; past that it is answered 429 and nothing is written.
`tests/journey.test.ts` and `tests/journey-server.test.ts` check what an event holds and that nothing is
written without the setting.

**Cookies.** The visitor cookie is normally set by the operator's website. A browser that reaches the
console first, from another site or by a link carrying `camel_handoff`, and that agreed to be measured, is
given one here (90 days, HttpOnly, `AGENT_JOURNEY_VISITOR_COOKIE_DOMAIN`), and where it came from (the other
site's host, and the campaign its link named: `utm_*` and Google's click ids, nothing else of the query) is
sent to the store as its touch. Programs and pages loaded ahead of time are not arrivals. The runtime also
reads Google Analytics' `_ga` cookie where there is one, and passes its id along (`ga_client_id`); it keeps
the id of an account's last browser that agreed (`journey_accounts.ga_client_id`) to send with what the
account does away from a browser (a payment, a run), and forgets it when a browser of the account refuses.
It reads no Google session cookie and sends no session id.

**Consent.** A browser is recorded only if it agreed: its `AGENT_JOURNEY_CONSENT_COOKIE` says `granted`.
One that says `denied`, or sends Global Privacy Control, never is, and is given no cookie; one that has not
answered is only where the operator set `AGENT_JOURNEY_COLLECT_UNKNOWN=true`. Each event says which it was
(`analytics_consent`: `granted` or `unknown`). An account keeps what its browser last said
(`journey_accounts.consent`), for what it does away from a browser: after a refusal, a token minted with a
token is not recorded either. Signing up and signing in never depend on the answer.

A refusal is itself told to the store, as a control and not an event (`/api/journey/consent-controls`: the
`account_ref`, the refusing browser's visitor id if it has one, and the time), so the store withdraws what it
had queued for Google of that account or browser. It is told when an account turns to refusing (at a sign-in,
or the first console page a signed-in browser reports after refusing) and at each sign-in that still refuses.
Like a deletion it waits in the outbox until the store takes it, however long. That a browser agreed is never
told separately: each event says what its browser said.

**Delivery.** Events and touches wait in `journey_outbox` and are POSTed to
`<AGENT_JOURNEY_URL>/api/journey/server-events` and `/api/marketing-attribution/resolve`, signed per
Standard Webhooks, until the store's answer names what it took (30 days at most, then dropped with
`journey_events_dropped`; a deletion is never dropped). They are never sent to a tenant's webhooks. A failed
delivery logs `journey_delivery_failed` with the event's name, id and the HTTP status; one the store
refuses as invalid (`journey_event_rejected`) is offered again once a day.

**What can be lost.** Writing an event never fails what it describes, so a fault writing one loses it
(`journey_event_failed`). An account's making is found again: when its event cannot be written, what it
takes to send it late is noted aside (`journey_lost_signups`: what the browser said about being measured,
and its visitor only if it agreed), and every ten minutes accounts made since journey events were first on
and unknown to `journey_accounts` are given their `run_account_created`, at the time they were made, as
that note allows (`journey_accounts_reconciled`). An account with no note is counted and never sent: its
browser may have refused.

**Deletion.** Deleting an account removes its `journey_accounts` row, its milestones, any note of a lost
sign-up and its undelivered events in the deletion's last transaction, and queues one `run_account_deleted`
naming only the `account_ref`, so the store deletes its copy. That event waits until the store takes it,
however long, and is queued even on a runtime whose journey events have since been switched off (it is
sent when they are on again).

**Reports.** The team's admin site (`AGENT_ADMIN_HOST`, see [configuration](configuration.md)) can ask the store
what it holds: sign-ups, first runs and payments by day, the accounts active in a range, and one account's
events, each account named by its `account_ref` and nothing else. The runtime asks on the viewer's behalf
(`src/admin-report.ts`), signed with a secret of its own (`AGENT_JOURNEY_REPORT_SECRET_ARN`), which never
reaches the browser and cannot sign an event or a deletion; only someone Cloudflare Access signed in, and
listed in `AGENT_ADMIN_EMAILS` where that is set, is answered, and each report asked for is logged with who
asked (`admin_report_viewed`). An erased account is in none of them.

**Export.** An account journey ever knew has `analytics/` in its export (see [Export](#export)): `account.json`,
what this runtime keeps of it (its `account_ref`, its sign-up visitor id, what its browser last said, what it
has done once, and events still to be sent); and, where journey events are configured, what the store holds,
asked for with the same signature: `summary.json` (how the store says the account was acquired),
`events-*.json` and `touches-*.json`, a page a file, and `google-copies-*.json`, what the store prepared or
sent to Google Analytics of those events. `summary.json` also says when the account last refused, if it has. The store is asked for the account this runtime
authenticated, never one a request names. If the store cannot be asked the export fails, as for any part it
cannot read whole.

## Runbook: a deletion or export request by email

1. **Find the account.** Ask for the GitHub login, Google address or password address they sign in with, then
   `curl -G -H "Authorization: Bearer $OPERATOR" --data-urlencode "login=<login or address>" "$RUNTIME/v1/tenants"`.
   No match: tell them there is no account for that identity.
2. **Verify the requester.** Reply only to the address on the account (`googleEmail` or `email`), or, for a
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
