# Email channels

Email channels give each channel an address on the runtime's own mail domain (`support@<email_domain>`), received
through Amazon SES. How a tenant uses them (addresses, allowlists, threads, reply modes, forwarders) is in
[Channels: Email](../guides/channels.md#email); this page is turning them on and operating them. They are separate
from the runtime's own outgoing mail (sign-up, billing), which is [Account email](account-email.md).

## What enabling them takes

Everything is in `infra/terraform/email.tf`, created only when the Terraform variable `email_domain` is set (it is
empty by default, which turns email channels off):

- an SES domain identity for `email_domain` with Easy DKIM, and its three DKIM CNAMEs, an MX record
  (`inbound-smtp.<region>.amazonaws.com`) and a DMARC `p=reject` record in the Cloudflare zone (`cloudflare_zone_id`,
  so the domain must be in that zone, e.g. `in.agents.camelai.dev`);
- a receipt rule set, made the region's **active** one, whose rule scans for spam and viruses and stores each message
  in the bucket `<name>-email-<account>` under `inbound/` (kept 7 days), then notifies the SNS topic
  `<name>-email-inbound`;
- that topic's HTTPS subscription to `https://<hostname>/channels/email/inbound` (on `hostname`, the first one, which
  never changes), which the runtime confirms itself;
- the task role's permission to read the bucket and send as the domain, and the task's `AGENT_EMAIL_DOMAIN`,
  `AGENT_EMAIL_SNS_TOPICS`, `AGENT_EMAIL_BUCKET` and `AGENT_EMAIL_REGION`.

Before the first apply:

- The AWS account must be out of the SES sandbox in the region (`aws sesv2 get-account --region us-west-2 --query
  ProductionAccessEnabled`), or replies reach only verified addresses.
- A region has one active receipt rule set, and this one replaces it. Check that nothing else receives mail there:
  `aws ses describe-active-receipt-rule-set --region us-west-2`.

## Rolling out in two steps

The subscription is confirmed by the runtime answering SNS's handshake, so tasks that serve the route with this
environment must be running before the subscription exists:

1. Set `email_domain` in `prod.auto.tfvars` (and upload the file back, [Deploys](deploys.md#applying-terraform)). Plan
   and apply only the task definition, which brings the topic and the bucket it names:
   `tofu plan -target=aws_ecs_task_definition.runtime -out=tfplan`, read it, `tofu apply tfplan`. Then ship it:
   `infra/ecs-deploy.sh <running tag>`, and wait for the new tasks.
2. Plan and apply everything else (`tofu plan -out=tfplan`, `tofu apply tfplan`): the identity, DNS records, receipt
   rules and the subscription.

Then check:

```sh
aws sns list-subscriptions-by-topic --region us-west-2 \
  --topic-arn arn:aws:sns:us-west-2:<account>:camelai-agent-runtime-email-inbound \
  --query 'Subscriptions[].SubscriptionArn'        # an ARN, not PendingConfirmation
aws sesv2 get-email-identity --region us-west-2 --email-identity <email_domain> \
  --query 'DkimAttributes.Status'                  # SUCCESS once DNS has propagated
```

Make a channel with a test tenant ([Channels: Email](../guides/channels.md#email)), mail it from an allowed address,
and look for `email_inbound` in the logs with `accepted: "direct"`.

## Operating them

- **Logs.** `email_inbound` records each message's decision (`accepted: "direct"` or `"forwarded"`, or `dropped` with a
  reason such as failed DMARC, spam, bulk or auto-submitted mail, a sender not allowed), `verified: "reply_to"` when a
  fixed reply address proves itself; `email_outbound` records replies not sent (`skipped` with a reason). They carry ids,
  never addresses, subjects or bodies. A tenant asking why a message never arrived: find its `email_inbound` line by
  time and channel.
- **Reply modes** (`settings.replies`, since PR #148): `"sender"` (the default) answers whoever wrote last; `"none"`
  mails nobody, and the agent's reply is read from its history; `{"to": "<address>"}` sends everything to one address,
  which must first write to the channel's address once with a From that SES proves (the channel then shows
  `account.verifiedReplyTo`). Nothing changes for existing channels.
- **Forwarders** (`settings.forwarders`, addresses or `@domain`): a support mailbox forwarding into a channel. A
  forward is accepted on proof of the forwarder only (SES's SPF verdict for an envelope sender at a listed domain),
  never on headers; `access.allow` is asked about the forwarder, and the original sender reaches the agent marked
  unverified and is never mailed. So a channel with forwarders must use `replies` `"none"` or `{"to"}`, or opt in with
  `settings.replyToForwarded: true`. Google Groups' mail is dropped as bulk (`Precedence: list`): forward from a
  mailbox instead. Migration `068_email_thread_forwarded.sql` added the column these need.
- **Sending reputation.** Replies go out through the same SES account as the runtime's other mail, so the
  `-ses-bounce-rate` and `-ses-complaint-rate` alarms cover them ([Alarms](alarms.md#mail)).
- **Turning them off.** Set `email_domain` back to empty and apply: it removes the identity, the DNS records, the
  receipt rules, the subscription and the environment. The bucket must be empty to be deleted.
