### Discord channels removed

The `discord` and `discord-managed` channel types are gone: Discord bots live in camelBots (https://bots.camelai.com).
Discord was the only channel that held a persistent Gateway connection, so with it go the per-channel Gateway
connections, the shared Camel Discord application and its console setup (`/console/discord/*`, **Add Camel to
Discord**, the Get started Discord path), the managed-server guards, and `maxDiscordServers`. Voice sessions on
Discord (`/v1/voice/sessions`, which camelBots uses) are unchanged.

`POST /v1/channels` with `type` `discord` or `discord-managed` answers 400 `CHANNEL_TYPE_RETIRED`, naming camelBots.
Existing Discord channel rows, and the managed bindings' tables, are left in the database untouched: `GET
/v1/channels` lists such a channel with `disabled: true`, it answers nothing (work it had queued is dropped and logged
as `channel_item_fenced`), `PATCH` refuses it, and `DELETE` removes it. Account export and deletion still cover the
old managed-binding rows. A later migration can drop them.

Operators: `AGENT_DISCORD_MANAGED_*` and `AGENT_DISCORD_API_URL` are no longer read. The Terraform
`discord_managed_enabled` variable, its environment and the `discord-managed` secret can be removed in a later infra
change; until then they do nothing.
