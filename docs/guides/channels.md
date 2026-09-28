# Channels

A channel lets people talk to agents from a messaging service: Telegram, Slack,
Discord or email. Tenants manage channels with `/v1/channels` or the console's Channels page:

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"telegram","credentials":{"botToken":"<from @BotFather>"},
       "definition":"def_…","access":{"allow":["@ada","123456789"]}}' \
  https://agents.camelai.dev/v1/channels
```

Each conversation's agent is made from the channel's `definition`. A channel
created without one gets an empty definition of its own, which is deleted with
the channel.

| Service | Credentials | Messages arrive | A conversation (one agent) is |
| --- | --- | --- | --- |
| `telegram` | `botToken` | webhook, registered for you | a chat |
| `slack` | `botToken` (`xoxb-…`), `signingSecret` | webhook, pasted into the app | a thread started by an @mention, or a DM |
| `discord` | `botToken` | the Gateway (a WebSocket) | a DM, or a channel or thread where the bot is @mentioned |
| `email` | none | SES, on the runtime's domain | an email thread |

Creating a channel checks its credentials with the service. Credentials and a
random webhook secret are stored encrypted; the API returns only masked values.

- **Telegram.** `https://agents.camelai.dev/channels/telegram/<id>` is registered as the
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

What all three share:

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
  attached)`. A message with only files reads `(sent a file)`.
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

## Email

An email channel is an address on the runtime's own domain, which it receives
mail for through Amazon SES (on a runtime with `AGENT_EMAIL_DOMAIN`; see
[Configuration](../operations/configuration.md)). It takes no credentials:

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"email","settings":{"address":"support","fromName":"Acme Support"},
       "definition":"def_…","access":{"allow":["ada@example.com","@acme.com"]}}' \
  https://agents.camelai.dev/v1/channels
```

- **Address.** `settings.address` is the part before the `@` (or the whole
  address on the domain), unique across the runtime and case-insensitive; the
  channel's id is its address until one is chosen. Taken addresses answer 409;
  role addresses (`postmaster`, `abuse`, `noreply`…) and `ch_…` are reserved.
  Changing it frees the old one, and mail to it is then dropped. Replies come
  from the same address, under `settings.fromName` if set.
- **Who may write.** The allowlist holds addresses and `@domain` entries for
  everyone at a domain. A sender counts only when SES proves the From address:
  DMARC passed, or SPF passed for the From domain (or one above it), or SES's
  own `Authentication-Results` shows a DKIM signature from it. Mail that fails
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
