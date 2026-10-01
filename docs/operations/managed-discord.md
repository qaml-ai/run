# Managed Discord bot

The `discord-managed` provider uses one operator-owned Discord application for
all configured servers. A signed-in customer adds it to a server with one Discord
authorization, then configures that server in the console. Each installation has
at most one tenant binding, with explicit allowed channels and the existing
channel conversation pipeline. The customer-owned
`discord` provider continues to use a separate bot token and Gateway connection.

This integration is disabled by default. The initial release is a pilot with one
Gateway shard. It refuses to connect if Discord recommends more than one shard
or its session-start allowance is exhausted. Multi-shard identify coordination
and an aggregate server dollar budget remain follow-up work. The existing tenant
credit and spending controls still apply, as do the managed server's daily turn
limit and per-sender rate limit. Until the budget exists, interim caps hold: an
account connects at most 10 servers (1 on free credit; `AGENT_DISCORD_MANAGED_SERVERS`,
`AGENT_DISCORD_MANAGED_FREE_SERVERS`, or a tenant's `maxDiscordServers`), free
credit allows at most 500 turns per server per day, API and scheduled turns count
against a server's daily turns, and a definition with the `schedule` builtin
cannot serve a server.

Outbound sends are fair between servers on each runtime node, and nodes send in
parallel. Only a global Discord rate limit (`global: true`) pauses every server,
through a cooldown row all nodes read; a route's own 429 delays just the message
that met it. Typing indicators refresh every 30 seconds and are skipped while a
node has sends waiting. Start with a small pilot and monitor Discord 429
responses (`channel_send_failed` with `HTTP 429`).

### Gateway ownership and failover

One node holds the Gateway, under the ownership claim
`discord-managed:<applicationId>:shard:0`; every other node retries the claim
every 10 seconds. A draining node releases it, so a deploy hands over within
about 10 seconds. A node that dies holds it until its lease lapses
(`AGENT_LEASE_TTL_MS`, 90 s in production), so a crash leaves Camel deaf for up
to about 100 seconds. Discord does not replay messages to a new session:
mentions sent in that gap are not answered. Replies already queued are not lost;
they are delivered by whichever node drains the channel queue. Two Gateways
never answer one message twice: a node fences itself before its lease expires,
and each message is recorded once by its ID.

## Create the platform application

Create separate development and production applications in the
[Discord Developer Portal](https://discord.com/developers/applications), owned by
the Camel team. Record the application ID from General Information, the OAuth
client secret, and the bot token. Keep secret values in the deployment's secret
store, rather than tenant channels or source files.

- **Bot:** leave the privileged Message Content, Server Members and Presence
  intents off. Turn on **Requires OAuth2 Code Grant**: the bot then joins a
  server only when the runtime exchanges the authorization code, so an invite
  that skips the console cannot add it.
- **OAuth2:** register the redirect URI exactly as
  `<AGENT_PUBLIC_URL>/console/discord/callback`.
- **Installation:** Guild Install only. While Public Bot is off, set Install Link
  to None.
- Leave the **Interactions Endpoint URL** empty, and register no application
  commands: Camel has none.

### How adding Camel works

**Add Camel to Discord** in the console opens `/console/discord/install`, which
records a single-use state (stored hashed, bound to the console session and
account, valid ten minutes) and redirects to Discord's authorization with scopes
`bot identify`, permissions `274878008320` (View Channel, Send Messages, Send
Messages in Threads, Attach Files and Read Message History; never
Administrator), and `response_type=code`. The user picks a server there;
Discord offers only servers where they have Manage Server.

The callback checks the state, exchanges the code, and takes the server from the
token response's `guild`: Discord added the bot there for a user allowed to, which
is the proof of administration. The response's `scope` string is not checked; it
need not list every scope asked for. Without a `guild`, the redirect's `guild_id`
is only a hint: the callback then requires that the user owns that server or holds
Administrator or Manage Server there, read from the server's roles with the bot
token. It reads the user's ID (`identify`), confirms the bot's membership with the
bot token (retrying briefly, since the bot joins as the code is exchanged), and
binds the server to the account in one transaction, paused and without channels.
Adding Camel to a server it is already in works the same way. The console then
opens that server's settings, where choosing a definition and allowed channels
activates it. The runtime keeps no Discord user token. A failed install logs
`discord_managed_install_failed` with the reason, the token response's field
names and scope string, whether it had a guild and the redirect a `guild_id`, and
the exchange's HTTP status; never a token or code.

A server bound to another account is refused unless that binding is
disconnected; removing Camel from a server disconnects it. So a server's
administrators move it to a new account by removing Camel and adding it again
from that account. The previous account keeps its past conversations and sees no
new ones. An install refused by the server cap, or a mention in a server with no
binding (an invite made outside the console), makes Camel leave that server.

`/console/discord/install` also works signed out: it sends the visitor through
console sign-in or signup and then on to Discord. `?guild_id=<id>` preselects a
server.

### Public launch

1. Turn **Public Bot** on.
2. Under Installation, set **Install Link** to Custom URL
   `<AGENT_PUBLIC_URL>/console/discord/install`, so Discord's own Add App button
   goes through camelRun sign-in and setup.
3. Complete Discord's application verification before Camel nears 100 servers.

The Gateway requests `GUILDS` and `GUILD_MESSAGES`. Direct bot-user mentions
supply message content without the Message Content intent; direct messages are
ignored. See [Discord OAuth2](https://docs.discord.com/developers/topics/oauth2)
and [Discord Gateway](https://docs.discord.com/developers/events/gateway).

## Configure runtime secrets

In production, Terraform provides both (below). Elsewhere, set
`AGENT_DISCORD_MANAGED_ENABLED=true` and `AGENT_DISCORD_MANAGED_SECRET_ARN` to a
Secrets Manager secret containing:

```json
{
  "applicationId": "<Discord application ID>",
  "botToken": "<Discord bot token>",
  "clientSecret": "<Discord OAuth client secret>"
}
```

Other fields, such as an older secret's `publicKey`, are ignored. For
development, use the three corresponding plain
`AGENT_DISCORD_MANAGED_APPLICATION_ID`, `_BOT_TOKEN` and `_CLIENT_SECRET`
variables instead. Do not use them in production: a sandbox child
running as the same user can read the environment. Do not mix plain values with
the ARN. The runtime also needs console authentication, an encryption key for
channels, a public URL, and Postgres. Startup applies the additive managed
Discord migration whether or not the integration is enabled.
See [Configuration](configuration.md).

A secret with no value, or with invalid values, leaves the integration off and
logs `discord_managed_not_configured`; the runtime still starts. A secret the
task cannot read (AccessDenied) still stops startup, like every other secret.

### Terraform

`infra/terraform` creates the empty `discord-managed` secret container and
grants the task role `GetSecretValue` on it whether or not the integration is
on. The variable `discord_managed_enabled` (default `false`) adds
`AGENT_DISCORD_MANAGED_ENABLED` and `AGENT_DISCORD_MANAGED_SECRET_ARN` to the task
definition. Enable it in this order, so the permission exists before any task
reads the secret:

1. Apply Terraform with `discord_managed_enabled = false` (the default). This
   creates the secret container and the IAM permission, and changes nothing the
   runtime does.
2. Store the application's JSON in the secret:

   ```sh
   aws secretsmanager put-secret-value --region us-west-2 \
     --secret-id camelai/agent-runtime/discord-managed --secret-string file://discord.json
   ```

3. Set `discord_managed_enabled = true` in the deployment's tfvars, plan, read the
   plan (it should change only the task definition's environment), and apply.
4. Terraform registers a task definition revision but the service keeps the
   running one: deploy the running tag (`infra/ecs-deploy.sh <tag>`), or let the
   next CI deploy pick up the revision.
5. Watch for `discord_managed_gateway_ready` from one node.

To turn it off, set the variable back to `false`, apply and deploy. Bindings
stay in the database and resume when it is enabled again.

Restart all runtime nodes after credential rotation. Rotating the bot token
invalidates existing connections; update the platform secret and restart the
fleet so the new Gateway owner connects with the replacement token. Rotating the
client secret only affects installs in progress.

## Pilot checks

Use two test servers and two camelRun accounts. Add Camel to one server from the
console, and to the other from `/console/discord/install` while signed out. Each
should land on that server's settings, paused until configured. Select one test
channel per server, configure distinct prompts and tools, then verify actual
mentions, attachments, tool execution and account usage attribution.

Confirm adding Camel to the first server from the second account is refused
while it is bound, that removing Camel from the server and adding it again from
the second account moves it (the first account sees no new conversation), and
that reloading a used callback URL binds nothing. Check that the account can
pause its server, a thread of an allowed channel, a disallowed channel, a role
mention, and a direct message (ignored). Pausing or disconnecting should stop
pending sends; removing the bot disconnects the server, while a temporary
unavailable guild should recover without being treated as removal. Adding Camel
again requires explicit reactivation. Deploy during a conversation: replies
already queued must still arrive. An already accepted agent turn may finish and
incur usage after pause or removal; its managed Discord reply is suppressed.
Pause does not abort active agent turns.

For a closed pilot, leave **Public Bot** off: only the application's team can
then add it to a server.

Review `discord_managed_*` events for Gateway ownership, retries, routing errors
and installation changes, plus existing channel delivery failures. Saved
configuration and a connected Gateway are separate from a delivered reply.
Before broad rollout, validate shard coordination and cross-node rate-limit
behavior, and complete Discord's current application verification requirements.
