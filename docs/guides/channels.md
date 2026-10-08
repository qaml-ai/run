# Channels

A channel lets people talk to agents from a messaging service (Telegram, Slack,
Discord or email), or has agents answer activity on GitHub. A `webhook` channel lets any service that sends webhooks (Sentry,
Linear, Stripe, your own) start agents; see [Generic webhooks](#generic-webhooks). Tenants manage channels with `/v1/channels` or the console's Channels page:

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"telegram","credentials":{"botToken":"<from @BotFather>"},
       "definition":"def_…","access":{"allow":["@ada","123456789"]}}' \
  https://run.camelai.com/v1/channels
```

Each conversation's agent is made from the channel's `definition`. A channel
created without one gets an empty definition of its own, which is deleted with
the channel.

| Service | Credentials | Messages arrive | A conversation (one agent) is |
| --- | --- | --- | --- |
| `telegram` | `botToken` | webhook, registered for you | a chat |
| `slack` | `botToken` (`xoxb-…`), `signingSecret` | webhook, pasted into the app | a thread started by an @mention, or a DM |
| `discord` | `botToken` | the Gateway (a WebSocket) | a DM, or a channel or thread where the bot is @mentioned |
| `discord-managed` | none from the customer; one Discord authorization from the console | Camel's shared Gateway | an allowed server channel or thread where Camel is @mentioned |
| `github` | `appId`, `privateKey`, `webhookSecret` | webhook, pasted into the GitHub App | a pull request or issue |
| `webhook` | `secret`, optional `replyUrl` | webhook, pasted into the sending service | whatever the `key` template names (one agent by default) |
| `email` | none | SES, on the runtime's domain | an email thread |

Creating a channel checks its credentials with the service. Credentials and a
random webhook secret are stored encrypted; the API returns only masked values.

- **Telegram.** `https://run.camelai.com/channels/telegram/<id>` is registered as the
  bot's webhook with the random secret, which each delivery must echo (compared
  in constant time). Deleting the channel removes the webhook. `/start` gets the
  channel's `greeting` without a model call.
- **Slack.** Create an app with the bot scopes `app_mentions:read`, `chat:write`,
  `im:history`, `channels:history` (and `groups:history` for private channels),
  `files:read` (attachments in) and `files:write` (files out), and install it. Slack has no API to set an app's event URL,
  so paste the channel's `webhookUrl` into Event Subscriptions and subscribe to
  `app_mention`, `message.im` and `message.channels`. Deliveries must carry a
  valid `X-Slack-Signature` from the signing secret, at most five minutes old; the
  URL check is answered once it verifies. A mention starts a thread and replies go
  there; later messages in that thread reach its agent without a mention. The
  same message sent as both `app_mention` and `message` is handled once. Slack has
  no typing indicator for bots.
- **Discord.** Create an application, add a bot, and invite it with View
  Channel, Send Messages, Send Messages in Threads, Attach Files and Read
  Message History.
  There is no webhook for ordinary messages: the runtime keeps the bot's Gateway
  connection itself, reconnecting and resuming as needed. A token Discord rejects
  is retried every five minutes. The bot needs no privileged intents: it
  answers only DMs and messages that mention the bot user. A mention of a role
  with the bot's name does not count: in autocomplete, pick the entry with the
  App badge. Replies never ping anyone (`allowed_mentions` is empty). The health
  log counts messages received, accepted and ignored by reason, and a message
  ignored as a role mention (`role_mention_without_bot_mention`) or as empty is
  logged with its id. Once the token is saved, the console shows an invite link
  and a test mention to paste into Discord.

- **GitHub.** Create a GitHub App with the repository permissions Pull requests
  (read and write), Issues (read and write), Contents (read) and Metadata (read),
  subscribe it to Pull request, Issue comment, Pull request review comment (and
  Issues, if you choose `issues.opened`), generate a private key, set a webhook
  secret, and install it on the repositories it should see. Create the channel
  with the App ID, the private key (PEM) and the secret, which the runtime checks
  by calling `GET /app` with a JWT the key signs; then paste the channel's
  `webhookUrl` into the app's Webhook URL. Deliveries must carry a valid
  `X-Hub-Signature-256` and are deduplicated by `X-GitHub-Delivery`; pings are
  answered. Each pull request or issue gets its own agent. The prompt describes
  the event (marked `[From GitHub]`) and a pull request's current diff is
  attached as `pr-<n>.diff`. The reply is a comment on the pull request or issue,
  posted with an installation token scoped to the app's installation; files are
  sent as links. Nothing the app does itself (its comments, pushes by its token)
  starts a turn. The channel's `settings` choose what does:

  | Setting | Default | Meaning |
  | --- | --- | --- |
  | `events` | all but `issues.opened` | Some of `pull_request.opened`, `pull_request.reopened`, `pull_request.ready_for_review`, `pull_request.synchronize` (new commits), `issue_comment` and `pull_request_review_comment` (comments that @mention the app), `issues.opened` |
  | `repos` | every repository the app is installed on | `owner/repo` or `owner/*` |
  | `ignoreDrafts` | `true` | Draft pull requests start nothing until marked ready |
  | `reply` | `comment` | `none`: replies and `send_message` are not posted; the agent acts through its tools (a GitHub MCP server in its definition, say) |
  | `authors` | `allowlist` | `members`: repository owners, members and collaborators need no allowlist entry |
  | `debounceSeconds` | `30` | New commits wait this long for more; a burst of pushes starts one turn, on the latest |

  The allowlist takes GitHub logins. Pull requests, issues and comments are
  written by whoever can open them, which on a public repository is anyone: treat
  them as untrusted input (prompt injection), keep `access.public` off, and give
  the agent's tools no more than the conversation needs.

## Add the Camel Discord bot

When the runtime operator enables the managed Discord integration, the console's
Channels page offers **Add Camel to Discord** alongside the existing channel
setup. It opens Discord, where you choose a server you own or have Manage Server
in and authorize Camel; that single step adds the bot and connects the server to
your camelRun account. You do not need to create a Discord application or copy a
bot token. Back in the console, the server's settings open. One server belongs to
one camelRun account at a time.

Choose an existing definition, or create one with the prompt, model and tools
you want. Select allowed channels explicitly, then choose which members may
interact: a Discord user-ID allowlist or all members. Saving activates the
server; until then Camel does not answer there. Each channel or thread has its
own persistent agent, with history shared by the people using that
conversation. Every new turn requires a direct mention of the Camel bot user; a
same-named role mention does not count. Direct messages are ignored.

Members who can interact may invoke the definition's tools using your camelRun
account's credentials. Select tools and allowed members accordingly. Usage is
billed to the connected account, with its normal credit and spending controls.
The managed integration offers per-sender rate limits and a daily turn limit;
it does not yet offer an aggregate dollar budget across a server's agents. A
definition with the `schedule` builtin cannot serve a server (any member could
have the agent wake itself up outside those limits), and turns you start through
the API count against the server's daily limit. An account connects at most 10
servers, or one while on free credit, which also caps each server at 500 turns a
day.

Use **Configure** to edit the selected definition, including tools, and apply it to
existing conversations; the console reports updated, queued or failed outcomes
using the normal [definition revision mechanism](definitions.md).

Pause stops new routing and pending sends; resume requires Camel to be in the
server. Disconnect retains conversation history and stops routing; it does not
remove Camel from Discord. Removing Camel from the server disconnects it, and
adding it again requires explicit reactivation. A temporary Discord server
outage is tracked separately from removal. A successful configuration save is
not proof that Discord delivered a reply: test with a fresh mention in an
allowed channel.

A server's administrators decide who runs Camel there. To move a server to
another camelRun account, remove Camel from the server, then add it again from
that account. The previous account keeps its past conversations but sees no new
ones. If Camel finds itself in a server nobody added through camelRun, it leaves
when mentioned.

Managed channels are created through console setup, rather than generic
`POST /v1/channels`. The existing `discord` provider and customer-owned bot flow
remain available. Operators can find the platform setup and pilot boundaries in
[Managed Discord operations](../operations/managed-discord.md).

## Shared channel behavior

What they all share:

- Each external conversation gets its own agent, made on first contact from
  the channel's definition, at its revision then.
- Senders must be on the allowlist unless the channel sets `access.public`:
  Telegram and Discord user ids or @usernames, Slack member ids (`U0123ABCD`).
  Each sender is rate limited (`limits.perSenderPerMinute`, default 10) and the
  channel has a daily turn cap (`limits.turnsPerDay`, default 1000).
- Each message carries its sender as `from` (see [Who sent a message](multi-user.md#one-agent-per-user-or-conversation)), and tool calls carry a runtime-set `origin`
  (`{channel, conversationId, sender}`, `context.origin` in the SDKs) that
  tools can authorize against.
- Attachments of any type (Telegram photos, documents, audio, voice notes,
  videos and animations; Slack files; Discord attachments) are streamed into the
  agent's workspace at `uploads/<requestId>/<name>` and the prompt refers to
  them by path (`files: [{path}]`), as in [Attaching files](files.md#attaching-files-to-a-message).
  Up to 10 files and 25 MiB each (20 MB on Telegram, the most a bot may
  download), 100 MiB per message. Downloads go only to the service's file host
  (Slack's with the bot token, Discord's CDN, Telegram's file API), never follow
  redirects, and have 60 seconds each. A file too large or that fails to
  download is left out, and the prompt says so: `(file big.zip too large, not
  attached)`. A message with only files reads `(sent a file)`. Audio (voice
  notes, audio files) is transcribed for the model as it arrives: see
  [Voice and audio](voice.md).
- The turn's final answer is sent back when the turn ends, split to the
  service's limit (4,096 characters on Telegram, 4,000 on Slack, 2,000 on
  Discord), with a typing indicator meanwhile where the service has one. Channel
  agents also get a `send_message` tool for updates mid-turn, which takes
  `files` too: paths in the agent's mounts, each checked and pinned to its
  current version when the tool is called.
- Files the turn presents (`present_file`, the run's `result.presented`) follow
  the reply's text, each with its caption: on Telegram images (JPEG, PNG, WebP,
  up to 10 MB) as photos and anything else as documents (up to 50 MB); on Slack
  through the external upload (`files.getUploadURLExternal`, the bytes, then
  `files.completeUploadExternal` into the thread; up to 100 MiB); on Discord as
  a multipart attachment (up to 10 MiB, the limit in servers without boosts). A
  file over the service's limit is sent as a [signed link](files.md#signed-links) that
  works for 24 hours, the longest a link may last.
- A message is recorded durably before it is acknowledged, and duplicates
  (provider retries, a Gateway resume) are dropped by message id for seven days.
  Replies go through a durable outbox: a failed send is retried with backoff,
  each message is sent once, and a permanent failure
  (the bot was removed from the chat) is not retried. Each part of the text and
  each file is a step recorded as it is sent, so a retry resumes after the last
  one sent rather than sending the reply again.

## Generic webhooks

A `webhook` channel turns each delivery from any service into a prompt. Give it
the secret the service signs with (or make one up and give it to the service),
then point the service at the channel's `webhookUrl`:

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"webhook","credentials":{"secret":"<the signing secret>"},"definition":"def_…",
       "settings":{"signature":{"type":"hmac-sha256","header":"Sentry-Hook-Signature"},
                   "key":"sentry-{{data.issue.id}}",
                   "filter":[{"path":"action","in":["created"]}],
                   "prompt":"Sentry issue {{data.issue.title}} ({{data.issue.web_url}}) was created. Triage it."}}' \
  https://run.camelai.com/v1/channels
```

- **`signature`** is how a delivery proves itself; unsigned or wrongly signed
  ones get 401:
  - `{"type":"standard"}` (the default): [Standard Webhooks](https://www.standardwebhooks.com/)
    `webhook-id`, `webhook-timestamp` (at most five minutes old) and
    `webhook-signature` (any of several). A `whsec_` secret is base64 after the
    prefix, as the spec says; any other secret is used as it is.
  - `{"type":"hmac-sha256","header":"X-Hub-Signature-256","prefix":"sha256="}`: the
    header holds the HMAC-SHA256 of the raw body, in hex (or `"encoding":"base64"`),
    after the optional prefix. This covers GitHub, Sentry, Linear
    (`Linear-Signature`), Shopify (`X-Shopify-Hmac-Sha256`, base64) and most others.
  - `{"type":"token","header":"X-Gitlab-Token"}`: the header must equal the secret.
- **`key`** picks the conversation, and so the agent: deliveries that render to the
  same key go to the same agent, which keeps its history. Without a key the
  channel has one agent. A key that has characters other than letters, digits,
  `_`, `.` and `-`, or is longer than 64, is cleaned up and given a hash suffix.
- **`prompt`** is what the agent is told. By default it is the payload itself,
  pretty-printed (cut off past 8,000 characters). Either way the whole payload is
  attached as `payload.json` in the agent's workspace.
- **`sender`** names who a delivery is from, for the message's `from` and the
  per-sender rate limit (default `webhook`); for example `{{actor.email}}`.
- **`filter`** is a list of conditions that must all hold, or the delivery is
  acknowledged and ignored. Each has a `path` and one or more of `in` (a list of
  values), `equals` (a value) and `exists` (`true` or `false`). Values are compared as text.
- **`idPath`** or **`idHeader`** names where a delivery's id is, so a retry is
  dropped. Without either, the id is the first of the headers `webhook-id`,
  `X-Request-Id`, `X-Delivery-Id`, `X-GitHub-Delivery`, `Linear-Delivery` and
  `Idempotency-Key`, else a hash of the body.

Templates are `{{path}}`: a dotted path into the JSON payload (`data.items.0.id`
reaches into arrays), `{{headers.<name>}}` for a request header, and
`{{body.<path>}}` for a payload field named `headers`. A missing value renders as
nothing; an object renders as JSON. Bodies must be JSON, up to 1 MiB.

A webhook channel is public (`access.public: true`) and allows 60 deliveries a
minute per sender: the signature is what keeps others out. It still has the daily
turn cap, and `access` and `limits` can be set as for any channel.

There is no conversation to answer, so the agent acts through its tools, and the
turn's end reaches you as a [`run.completed`](webhooks.md) event. To have the
reply too, give `credentials.replyUrl`: each reply (and each `send_message`) is
POSTed there as `{"type":"message","conversationId","text"}`, signed per Standard
Webhooks with the channel's secret, and retried like any channel's messages.
Files are sent there as a link.

## Email

An email channel is an address on the runtime's own domain, which it receives
mail for through Amazon SES (on a runtime with `AGENT_EMAIL_DOMAIN`; see
[Configuration](../operations/configuration.md)). It takes no credentials:

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"email","settings":{"address":"support","fromName":"Acme Support"},
       "definition":"def_…","access":{"allow":["ada@example.com","@acme.com"]}}' \
  https://run.camelai.com/v1/channels
```

- **Address.** `settings.address` is the part before the `@` (or the whole
  address on the domain), unique across the runtime and case-insensitive; the
  channel's id is its address until one is chosen. Taken addresses answer 409;
  role addresses (`postmaster`, `abuse`, `noreply`…) and `ch_…` are reserved.
  Changing it frees the old one, and mail to it is then dropped. Replies come
  from the same address, under `settings.fromName` if set.
- **Who may write.** The allowlist holds addresses and `@domain` entries for
  everyone at a domain. A sender counts only when SES proves the From address:
  DMARC passed, or SPF passed for the From domain (or one above it). DKIM alone
  does not count, since SES does not say which domain signed. Mail that fails
  DMARC, is spam or carries a virus is dropped, as is mail an agent should not
  answer: `Auto-Submitted` other than `no`, `Precedence: bulk`, `list` or `junk`,
  bounces (`mailer-daemon`, `postmaster`), and mail from the runtime's own domain.
  Drops are logged (`email_inbound`, with a reason), never answered.
- **Threads.** A conversation is a thread: its root Message-ID (the first in
  `References`, else `In-Reply-To`), or the thread of any message of ours a reply
  names, so a client that keeps only `In-Reply-To` stays in its thread. A new
  message without either starts a new conversation. The agent is named after
  the subject, and gets `Subject: …` and the new text of each message, with
  quoted history (`On … wrote:` and what follows, `>` lines, `Original Message`
  blocks) left out; an HTML-only message is read as text. Attachments are saved
  like other channels' (images an HTML body shows inline are not).
- **Replies** go to whoever wrote last in the thread, with `Re: <subject>`,
  `In-Reply-To` the last message and `References` the thread's root and recent
  messages, so mail clients thread them, and `Auto-Submitted: auto-replied`, so
  other systems do not answer them. Each `send_message` and presented file is an
  email of its own; files up to 10 MiB are attached, larger ones sent as links.
- **Receiving.** SES stores each message in S3 and notifies an SNS topic, whose
  HTTPS subscription is `/channels/email/inbound` for every channel. The runtime
  accepts only messages SNS signed (the certificate from SNS's own host) for its
  configured topics, less than a day old, confirms the subscription itself, and
  hands a message to each channel it is addressed to (To, Cc or Bcc). SNS
  retries what fails; a message is recorded once by Message-ID.
