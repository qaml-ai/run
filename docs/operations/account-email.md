# Account email: sign-up, password reset and adding a password

With account mail configured (`AGENT_ACCOUNT_EMAIL_FROM`), people sign up with an email address and a password,
reset a forgotten password, and add a password to an account that signs in with GitHub or Google, each through
a link mailed to the address (`src/email-accounts.ts`, `src/account-mail.ts`). Without it none of these is
offered: the console's sign-in page and the MCP consent page show sign-in alone, as before, and passwords are
the operator's to set (`PUT /v1/tenants/{id}/password`, `infra/tenant.sh set-password`).

## What people see

- **Sign up** (`/console/signup`, and a form on the consent page), only with `AGENT_OPEN_SIGNUP=true`, the switch
  GitHub and Google sign-up use: an address and a password of 12 to 256 characters that is not one of the
  most common (`src/common-passwords.txt`) nor the address; no rules on its characters. The answer is always
  "check your email". A new address gets a link; following it and entering the password chosen makes the
  account and signs in, and from the consent page returns there to connect the application.
- **Forgot password** (`/console/reset`, linked from both sign-in pages): a link to choose a new password,
  which signs in and ends every other session signed in with the old one. The same answer whether or not the
  address has an account.
- **Account page**: the account's address. An account without a password adds one: its own Google address
  at once, any other address through a link confirmed with that password.

## How it is safe

- **Unverified sign-ups have no account.** The link holds the chosen password's scrypt hash; the tenant is
  made, with its password, only when the link is followed and that password entered. Until then nothing signs
  in. Asking for the password at the link means someone who signs up with another person's address cannot
  finish without that mailbox, and the mailbox's owner cannot, by clicking, finish an account whose password
  someone else chose.
- **No account enumeration.** Sign-up, reset and adding an address answer the same whatever the address, and
  take as long: the password is checked and hashed first, and mail goes out in the background. What differs is
  only the mail: an address with an account is told someone tried to sign up (or to add it elsewhere); a Google
  account's address is told to sign in with Google; an unknown address asking for a reset gets nothing.
- **Links**: 32 random bytes, kept only as their SHA-256 (`account_email_links`, migration 055), in the URL's
  fragment (`/console/verify#…`, `/console/reset#…`), which never reaches server logs or referrers. A link
  works once; a sign-up's or added address's lasts 24 hours, a reset's an hour, and only the newest reset link
  works. Expired, used and tampered links all say "This link has expired or was already used".
- **No merging or takeover.** An email sign-up never joins an existing GitHub or Google account. An address a
  Google account signed up with gets no second account: its owner is mailed to sign in with Google and add a
  password on the Account page. GitHub addresses are not known to the runtime, so an email sign-up with one is
  an account of its own. An address that already signs in to one account cannot be added to another.
- **Credit**: an email sign-up is prepaid like a Google one, with no automatic starting credit; a card check
  unlocks it ([Billing](billing.md)). Only GitHub sign-ups get it automatically, on account age.
- **Limits** ([Limits](../reference/limits.md#rate-limits)): requests that mail a link, per client address an
  hour (`AGENT_RATE_LIMIT_EMAIL_REQUESTS_PER_IP`, 10 behind Cloudflare), and mails per address a day
  (`AGENT_RATE_LIMIT_EMAILS_PER_ADDRESS`, 5), whether or not the address has an account; a refused password
  counts nothing. Verifying counts as a new account against `signups` (5 per client address a day), and a wrong
  password at a link as a failed sign-in. Addresses are compared lowercased and trimmed; Gmail's dots and
  `+tags` are kept, so they are different addresses.
- **Logs** name the tenant and the kind of mail (`email_signup_verified`, `password_added`, `password_reset`,
  `account_mail_failed` with `kind`), never an address, link or password.

## Providers

- **`ses`** (default): Amazon SES's API, with the runtime's AWS credentials and `AWS_REGION`. The sender must
  be a verified SES identity (best a domain with DKIM), the credentials allowed `ses:SendEmail` as it, and the
  account out of the SES sandbox to mail anyone. Bounces and complaints go on SES's account-level suppression
  list, which SES then never sends to.
- **`log`**, for a runtime of one's own: no mail; each link and its address are written to the log
  (`account_mail_link`) for the operator to pass on. Refused with `AGENT_OPEN_SIGNUP=true` unless
  `AGENT_PUBLIC_URL` is a loopback address, so a public runtime never logs a sign-up link. With sign-up
  closed it is a way to hand out password resets.

## Runbook: all camelRun mail through SES

camelRun sends all its mail through Amazon SES in us-west-2, where the account is out of the sandbox (production
access; 50,000 a day, 14 a second, checked 2026-10-05): billing (`billing@mail.camelai.com`), Get Help
(`no-reply@mail.camelai.com`) and account mail (`accounts@mail.camelai.com`), from the SES domain identity
`mail.camelai.com` that `infra/terraform/ses-mail.tf` makes, through one configuration set
(`camelai-agent-runtime-mail`) whose bounces and complaints go to an SNS topic subscribed to the runtime's
`/v1/billing/email/feedback` (each message's signature checked with `verifySns`): billing contacts that bounce or
complain are suppressed, and SES's account-level suppression list keeps every sender off them. Until stage 3,
billing and Get Help mail keep going through the Cloudflare Worker (`infra/billing-email`), and no sign-up is
offered. The guarded script `apply-ses-mail.sh` runs each stage, allowing only its own changes.

1. **SES resources** (`ses_mail_domain = "mail.camelai.com"`): identity with Easy DKIM, MAIL FROM
   `bounce.mail.camelai.com`, configuration set, topic and its policy, the bounce/complaint event destination, and
   the task role's `ses:SendEmail` on the identity and configuration set, only as those three senders. The
   runtime's environment does not change.
2. **DNS**, by hand in Cloudflare, zone `camelai.com`, DNS only (grey cloud): three DKIM CNAMEs
   `<token>._domainkey.mail.camelai.com` → `<token>.dkim.amazonses.com` (`tofu output ses_mail_dns_records`
   has the tokens), and for `bounce.mail.camelai.com` an MX `10 feedback-smtp.us-west-2.amazonses.com` and a TXT
   `v=spf1 include:amazonses.com ~all`. `_dmarc.mail.camelai.com` (`p=reject`) stays: SES's DKIM aligns with it;
   Cloudflare's own records for the domain stay too. Wait until `aws sesv2 get-email-identity --email-identity
   mail.camelai.com` shows `VerifiedForSendingStatus: true`, DKIM `SUCCESS` and MAIL FROM `SUCCESS`.
3. **Switch** (`ses_mail_enabled = true`, refused by the script until step 2 verified): the task gets
   `AGENT_BILLING_EMAIL_PROVIDER=ses` with the configuration set and topic, Get Help's sender, and
   `AGENT_ACCOUNT_EMAIL_FROM`; deploy. Billing, Get Help and account mail now go through SES, and
   `/console/auth/methods` says `signup: true, reset: true`.
4. **Feedback** (`ses_mail_feedback = true`): the topic's HTTPS subscription, which the runtime confirms.
5. **Check**: from a test account, add a billing contact (Billing → alerts) with an address you read, and confirm it
   from the mail; sign up at `/console/signup`, follow the link, sign in, and reset that password; send a Get Help
   request. Then retire the Worker (below).

Back out of stage 3 by setting `ses_mail_enabled = false` and applying: billing returns to the Worker, and sign-up
and reset disappear on the next deploy (links already mailed stop working).

### Retiring the Cloudflare billing Worker, once SES mail is live

Nothing in the runtime calls the Worker once stage 3 is deployed. Then, with an authorized Cloudflare login, from
`infra/billing-email`:

```sh
npx --yes wrangler@4.144.0 queues subscription list camelrun-billing-email-feedback   # its id
npx --yes wrangler@4.144.0 queues subscription delete camelrun-billing-email-feedback --id <subscription id>
npx --yes wrangler@4.144.0 delete --name camelrun-billing-email
npx --yes wrangler@4.144.0 queues delete camelrun-billing-email-feedback
npx --yes wrangler@4.144.0 queues delete camelrun-billing-email-feedback-dlq   # once nothing in it needs review
aws secretsmanager delete-secret --region us-west-2 --secret-id camelai/agent-runtime/billing-email --recovery-window-in-days 7
```

Before deleting the secret, remove `billing-email` from `infra/terraform/secrets.tf` (and the task policy's read of it)
with the code change that drops the `cloudflare` billing provider, `billing_email_worker_url` and
`infra/billing-email/`, so Terraform does not recreate it. Leave `mail.camelai.com` enabled for Email Sending in
Cloudflare if camelStream still sends from it.

## Runbook: self-hosted

With an AWS account: verify a domain (or a single address) in SES, allow the runtime's credentials
`ses:SendEmail` on that identity, ask AWS for production access if the account is in the SES sandbox, then set
`AGENT_ACCOUNT_EMAIL_FROM`, `AWS_REGION` and the credentials (`AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY`, or an instance role). With `AGENT_OPEN_SIGNUP=true` anyone who reaches the runtime
can then make an account. Without SES, `AGENT_ACCOUNT_EMAIL_PROVIDER=log` (sign-up closed, or on
`localhost`) offers resets whose links you read from `docker compose logs` and pass on.

## Investigating

- Someone got no mail: `account_mail_failed` in the logs (with the kind and the error's class); the
  address's daily limit (429 `emails`); or SES's suppression list:
  `aws sesv2 get-suppressed-destination --email-address <address>` (remove it with
  `delete-suppressed-destination` once they confirm the address works).
- Find an account by its address: `GET /v1/tenants?login=<address>` (platform operator) also matches the
  password address (`email`).
