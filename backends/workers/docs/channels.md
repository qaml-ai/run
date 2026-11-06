# Channels on Workers

Experimental, like the rest of this backend. The channel types are the ones ECS serves: `telegram`, `slack`
(Events API), `github` (GitHub App webhooks), `webhook` (generic signed webhooks) and `email`. Discord channels are
retired on both backends (400 `CHANNEL_TYPE_RETIRED`). The public contract is ECS's, described in
[docs/guides/channels.md](../../../docs/guides/channels.md); the channel cases in `tests/contract/areas/channels*.contract.test.ts`
run the same assertions on both backends.

## One copy of the logic

`src/core/channels/` holds what both backends run:

- `channels.ts`: the `Channels` class. Channel CRUD (credentials checked with the service, sealed with the account
  key, masked in every answer), inbound handling (signature, allowlist, rate limits, the filter, the conversation's
  agent made on first contact, attachments into its workspace), the durable item state machine in Postgres
  (`channel_items`, `channel_seen`, `channel_counts`, ...), replies, `send_message`, inputs asked and answered as
  messages. A host interface (`ChannelsHost`) supplies the database, sealing, agents, files and decisions.
- `telegram.ts`, `slack.ts`, `github.ts`, `webhook.ts`, `email.ts`: the providers, on WebCrypto (HMAC-SHA256
  signatures, RS256 GitHub App JWTs from PKCS#1 or PKCS#8 keys) and the host's `fetch`.
- `filter.ts`: the channel filter's question and state. `dkim.ts`: DKIM verification for raw mail.

ECS keeps its own host in `src/channels*.ts`: the 5-second scan, the node lease and agent claims, SES and SNS.

## Inbound: verify, dedupe, route

A service's webhook (`POST /channels/:type/:id`) reaches the front Worker before any authentication. It reads the
channel from Postgres, verifies the delivery (the channel's secret, or the service's signature), parses it, and
records it: the seen marker (the service's message, update or delivery id) and the item commit in one transaction,
so a retried delivery is dropped. The answer goes back then; the message is advanced in the request's `waitUntil`:

1. rate limit and daily-turn counters, the filter (a decision billed as `POST /v1/decisions`),
2. the conversation's agent: created on first contact with key `<type>-<channel>-<conversation>[-generation]`,
   so its id is known (and bound) before it starts,
3. attachments streamed into the agent's workspace volume (`/workspace/uploads/<item id>/...`),
4. the prompt submitted to the agent's Durable Object under the item's id.

At least once in, exactly once into a turn: a lost `waitUntil` leaves the item claimed for 60 s, then it is retaken
and resubmitted under the same id, which the agent's object answers with the run it already has.

## Outbound: from the agent's turn

The agent's object sees its run start and end (`agent-channels.ts`). While a turn runs, Telegram's typing indicator
is refreshed every 4 s. When it ends, the object settles the reply: the item moves to `sending` and each part (text
chunks, then files) is sent through the service's API, the progress written after each part, so a retry resumes after
the last one sent. `send_message` (a tool only channel agents have) queues and sends the same way, mid-turn.

## No idle cost

Nothing runs between messages: no connection to any service, no object kept awake for a channel. Work that comes due
later (a retry after a failed send, GitHub's debounce of pushes, a submitted message whose turn end was not seen)
schedules a scan through the queue (`kind: "channels"`, delayed until it is due, at most 12 hours). The five-minute
cron scans too, as a backstop for a lost wake.

## Email

### Receiving: Cloudflare Email Routing to the Email Worker

Email Routing hands each message for the channel domain to the Worker's `email()` handler
(`src/channel-email.ts`). The handler:

- reads the raw message (Email Routing's limit is 25 MiB) and parses it with postal-mime,
- drops automatic mail (Auto-Submitted, Precedence: bulk, bounces) and mail from the runtime's own domain,
- proves the sender with DKIM (`src/core/channels/dkim.ts`): a valid RSA-SHA256 or Ed25519-SHA256 signature by the
  From's domain, or one above it, proves the From address. Email Routing gives a Worker no SPF or DMARC verdicts, so
  mail from a domain that does not sign is dropped as unauthenticated. Keys come from DNS over HTTPS
  (cloudflare-dns.com). A message with two From headers proves nothing; `l=` (a partial body) is refused,
- proves a forwarder the same way: the envelope sender (the forwarder's own address after a forward rewrites it, as
  Google's `+caf_` addresses and SRS do) signed for by its domain,
- keeps the raw message in R2 (`channel-mail/<hash>`) when an attachment is over 256 KiB, to read those back when
  the message is processed; smaller attachments ride in the item,
- hands the message to `receiveEmail` (shared): the channel by its address, the thread by Message-ID, In-Reply-To
  and References, allowlists, forwarders and the filter, as on ECS.

A throw makes Email Routing refuse the message with a temporary failure, so the sending server retries; the retry is
deduplicated by its Message-ID.

### Replying: Cloudflare Email Service

Replies go through the `send_email` binding (`EMAIL`) with Email Service's message builder: From is the channel's
address (and `fromName`), To is whoever wrote last (or the channel's fixed `replies.to`), Subject is `Re: <subject>`,
In-Reply-To is the last message received and References the thread's root and its most recent messages, plus
`Auto-Submitted: auto-replied`. Email Service sends to any recipient once the account's sending is out of its
verified-addresses-only start, which the `send_email` binding's `allowed_sender_addresses` must also allow.

Differences from SES:

- Email Service sets the Message-ID itself. The runtime records the id `send()` answers with, so a reply to it finds
  its thread. Whether that id is the header's value is not documented; replies that carry References (every common
  client) thread by the root either way. Check it once on the pilot (setup step 6).
- One message is at most 5 MiB to arbitrary recipients: files up to 3 MiB are attached, larger ones sent as links
  (ECS: 10 MiB).
- Email Service refuses a send with a disallowed header; replies use only In-Reply-To, References, Auto-Submitted
  and X- headers.

## Setup for the pilot (Miguel runs these; nothing here was changed)

Email Routing allows catch-all rules only on a zone's apex, not on a subdomain such as `in.camelai.dev`. Two ways:

- **A zone of its own (recommended for production):** a domain used only for channel mail (for example
  `camelmail.dev`), its apex catch-all routed to the Worker.
- **A subdomain with literal rules (the pilot):** `in.camelai.dev`, one routing rule per channel address. Fine for a
  handful of test channels; production would need the runtime to create and delete rules through the Email Routing API
  when channels change (not built).

Steps, for `in.camelai.dev` on the pilot account:

1. **Receiving domain.** Dashboard: Compute > Email Service > Email Routing > `camelai.dev` > Settings > Subdomains:
   add `in.camelai.dev`. Cloudflare adds its records: MX `in.camelai.dev` to `route1.mx.cloudflare.net`,
   `route2.mx.cloudflare.net`, `route3.mx.cloudflare.net` (priorities it assigns), TXT `in.camelai.dev`
   `v=spf1 include:_spf.mx.cloudflare.net ~all`, and its DKIM key at `cf2024-1._domainkey.in.camelai.dev`.
   Check nothing else at `in.camelai.dev` conflicts first.
2. **Routing.** Email Routing > Routing rules > Create: custom address `<address>@in.camelai.dev`, action
   "Send to a Worker", Worker `camelrun-pilot` (the API Worker, which now exports `email()`). One rule per channel
   address (a channel's address is `settings.address`, by default its id).
   On an apex zone instead: Catch-all address > Edit > "Send to a Worker" > the same Worker > Enable.
3. **Sending domain.** Compute > Email Service > Email Sending > Onboard Domain > `in.camelai.dev` (or `camelai.dev`).
   It adds, under `cf-bounce.<domain>`: MX to `route1/2/3.mx.cloudflare.net`, TXT
   `v=spf1 include:_spf.mx.cloudflare.net ~all`, DKIM TXT `cf-bounce._domainkey.<domain>`, and DMARC TXT
   `_dmarc.<domain>` (`v=DMARC1; p=none;` to start, as Cloudflare recommends for new setups). Sending to arbitrary
   recipients needs the account past Email Service's verified-recipients start (a paid plan).
4. **Worker configuration** (`wrangler.pilot.jsonc`), then deploy as usual:
   - `vars.AGENT_EMAIL_DOMAIN = "in.camelai.dev"`;
   - the `send_email` binding `EMAIL` must allow the channel addresses as senders: drop `allowed_sender_addresses`
     (it lists only `camelrun@staging.camelai.dev` today) or add a second binding without it, for channel replies;
   - nothing else: the files bucket (`BUCKET`) holds stored mail under `channel-mail/`, and the queue (`WEBHOOKS`)
     carries channel wakes. A lifecycle rule deleting `channel-mail/` after 14 days keeps stored mail no longer than a
     filtered message can be delivered.
5. **Webhook channels.** Nothing to set up: `POST /channels/:type/:id` is on the API Worker's route, and each channel's
   `webhookUrl` says where to point the service (Telegram's is set at create).
6. **Check.** Create an email channel with `settings.address` matching the routing rule, send it a message from a
   DKIM-signing mailbox (Gmail is), read the reply, and answer it with a client that sends only In-Reply-To: the
   answer must reach the same agent (`GET /v1/agents` shows one agent for the thread). Then compare the reply's
   Message-ID header with the `email_messages` row the runtime wrote.

## ECS inbound through the same Email Worker (a sketch, not built)

Production ECS has no inbound mail. The Email Worker could be its ingress too:

1. A small Email Worker (or this one with an `AGENT_EMAIL_FORWARD_URL`) receives the domain's mail as above, checks
   DKIM with `src/core/channels/dkim.ts`, and posts the raw message to ECS at
   `POST /channels/email/forwarded`, with the envelope (`from`, `to`) and its verdict (`direct`, `forwarder`), signed
   as a Standard Webhook with a shared secret (the `signed()` helper in `src/core/channels/webhook.ts`; ECS verifies
   with `verifySignature`), 5-minute skew, `webhook-id` the message's hash.
2. ECS's route verifies the signature, parses the raw message, and calls the same `receiveEmail` the SNS route calls,
   with the Worker's proof in place of SES's verdicts. Dedup and threading are unchanged.
3. Large messages: the Worker puts the raw message in R2 and sends a presigned GET in place of the body; ECS's
   `stored()` reads it back as it reads S3 today.
4. A non-2xx from ECS makes the Worker throw, so Email Routing tempfails and the sender retries.

Replies would stay on SES (ECS's verified domain), or move to Email Service through the same Worker if the domain
moves; the From must be on a domain the sending service has verified.
