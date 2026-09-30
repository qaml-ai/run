# Billing email deployment

This Worker uses the same native Cloudflare Email Sending binding as camelStream.
It is a narrow authenticated adapter for the Node runtime, which runs on AWS.
It only sends as `billing@mail.camelai.com`. It accepts one recipient, HTML and
plain text, and the two unsubscribe headers. It cannot send attachments or use
arbitrary sender addresses. Secrets and message content are never logged.
Workers Logs (`[observability]`) keep what it logs for 7 days on the Workers Paid
plan; Cloudflare does not let the retention be changed.

The sender domain `mail.camelai.com` is already enabled in the camelAI account
`85bbd288051330fb51ee1c86031a299b`, zone `28430f60fad05000f54916dd3b0b0596`.
The documented Cloudflare Workers API, custom headers and event subscriptions
are at <https://developers.cloudflare.com/email-service/>.

Run these commands from this directory with an authorized Cloudflare login:

```sh
npx --yes wrangler@4.144.0 queues create camelrun-billing-email-feedback
npx --yes wrangler@4.144.0 queues create camelrun-billing-email-feedback-dlq
npx --yes wrangler@4.144.0 deploy
npx --yes wrangler@4.144.0 secret put MAIL_SECRET
npx --yes wrangler@4.144.0 queues subscription create camelrun-billing-email-feedback \
  --source email.sending --events message.bounced,message.complained,message.rejected \
  --zone-id 28430f60fad05000f54916dd3b0b0596 --domain mail.camelai.com \
  --name camelrun-billing-email-feedback
```

Create each queue/subscription only once. `MAIL_SECRET` must be 64 lowercase hex
characters generated cryptographically. Store the identical value in the
`camelai/agent-runtime/billing-email` Secrets Manager string outside Terraform.
Never put it in source, a command argument, Terraform variables/state, or logs.
Without the secret the Worker refuses all sends.

Set Terraform variables `billing_email_worker_url` to the deployed HTTPS `/send`
URL, `billing_stripe_portal_configuration` to the dedicated live Stripe portal,
`signup_min_account_days` to the private existing policy, and
`billing_slack_team_id`/`billing_slack_channel_id` to the authorized billing channel.
The app reads secret values at startup. Apply with the intended current image tag;
do not let a stale `runtime_image_tag` put an old image into the new task definition.

The queue retries failed feedback at five-minute intervals, up to 50 times, then
retains it in `camelrun-billing-email-feedback-dlq`. Investigate any
`billing_mail_feedback_failed` Worker log or nonempty dead-letter queue. Once the
runtime is healthy, replay retained feedback; do not purge unreviewed messages.
Only a successful runtime response acknowledges a relevant event. The source
subscription covers the domain, but the consumer ignores other senders and does
not modify camelStream's recipients.

## Get Help (support mail)

The console's Get Help (`src/help.ts`) sends through this Worker too, as
`SUPPORT_FROM` (`no-reply@mail.camelai.com`, display name `camelRun`, as
camelStream sends its support mail). The Worker accepts such mail only
when the `SUPPORT_TO` inbox (`support@camelai.com`) is a recipient, with at most
one other address (the user, copied on the shared thread) and a Reply-To of that
inbox only. Billing mail keeps its single recipient, and bounce feedback for the
support sender is ignored: the runtime only suppresses billing recipients.

To turn it on, in this order:

1. Confirm `no-reply@mail.camelai.com` can send from this Worker in Cloudflare
   Email Sending (camelStream already sends as it on the `mail.camelai.com` domain).
2. Deploy this Worker (`npx --yes wrangler@4.144.0 deploy`): `wrangler.toml` adds
   the sender to `allowed_sender_addresses` and sets `SUPPORT_FROM`/`SUPPORT_TO`.
   Billing mail is unaffected.
3. Deploy a runtime image containing the Get Help implementation and
   `migrations/041_help_requests.sql`. The runtime applies migrations at startup;
   the button stays hidden while the support settings are unset.
4. Set the Terraform variable `support_email = "support@camelai.com"` and apply
   with the intended image tag. The runtime then shows Get Help in the console.
   Until step 2, sends fail and the console asks the user to retry.
5. Accept delivery once from the console: both messages reach the inbox with the
   same reference, the thread copies the submitting address, and replying all
   from the inbox reaches the user.

Cloudflare takes a single Reply-To address, so replies go to the support inbox;
support answers the user with **Reply all** on the shared thread.

Only verified, unsuppressed billing-alert addresses count as emails on file.
Users choose among those addresses when any exist; a typed reply address is
allowed only when none exist. A typed address is not promoted to an account
email. Delivery is at least once: retries skip each message once its acceptance
is recorded, but a provider acceptance followed by a crash before that write
can still produce a duplicate. The console retains a pending submission in
memory while the page stays open; it does not recover that draft after reload.

## Launch order

1. Prepare the Cloudflare Worker/queues and secrets, the dedicated Stripe portal,
   and a **disabled** Stripe webhook on API `2026-08-26.dahlia` with the seven
   events listed in the billing runbook. Keep the old webhook active until cutover.
2. Review the infrastructure plan. Configure the billing Slack destination and
   verify a test alarm is delivered. Configure the new runtime environment/secrets.
3. Arrange an explicit maintenance window before a cutover that stops the whole
   service. Do not put all console/API traffic behind a blanket 503 for a billing
   change. Keep the ALB's default forwarding action associated with the ECS
   target group; use narrowly scoped routing gates where possible. Stop old
   application workers and prevent autoscaling from restarting them.
   Apply the new migrations and start the new image without old sign-in, mail,
   checkout or automatic payment handlers running alongside it. This is a
   one-time billing migration cutover, not a normal overlapping ECS rollout.
4. Disable the old Stripe webhook and enable the new one matching the runtime's
   signing secret. Restore traffic and the normal service scaling bounds.
5. Verify production health, confirmed-recipient delivery and unsubscribe, and
   provider feedback without making real-money test payments. Run purchase,
   automatic refill, recovery and refund acceptance in staging with Stripe test
   mode or a sandbox, and reconcile its ledger against Stripe's test amounts.
   Do not use live cards for acceptance tests or turn on automatic refill for a
   real account without its consent.

The dedicated billing CloudWatch alarms report new reconciliation failures and
repeated mail/refill worker failures to Slack. An alarm returning to OK only
means no new failure was logged in that interval; it does not resolve an
outstanding payment. Use `docs/operations/billing.md` to reconcile it.

## Delivery acceptance

Send a test through the deployed Worker using Node fetch and the private secret.
Check the recipient's actual message headers: SPF/DKIM/DMARC must pass, and the
aligned DKIM `h=` field must include `List-Unsubscribe` and
`List-Unsubscribe-Post`. Verify an unauthenticated `/send` is refused. The durable
outbox still owns retries; delivery is at least once, as with SES.
