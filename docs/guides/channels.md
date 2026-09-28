# Channels

A channel lets people talk to agents from a messaging service: Telegram, Slack or
Discord. A `webhook` channel lets any service that sends webhooks (Sentry,
Linear, Stripe, your own) start agents; see [Generic webhooks](#generic-webhooks). Tenants manage channels with `/v1/channels` or the console's Channels page:

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
  https://agents.camelai.dev/v1/channels
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
