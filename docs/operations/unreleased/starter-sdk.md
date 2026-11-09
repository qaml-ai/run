### Starter authentication, existing agents and inbox SDK

The 0.23.0 SDK train adds explicit existing-agent mode to createAgentHandler. It obtains credentials
without changing configuration. Passing agent still opts into upsert; passing neither now throws.
The starter replaces demo cookies with GitHub organization OAuth and OIDC recipes, signed expiring
sessions and fail-closed setup. Its Cloudflare option generates OpenNext, runtime bindings and webpack
build configuration. The SDK package includes the frontend guide.

CAMELRUN_API_KEY and CAMELRUN_URL take precedence over the older CAMELAI names in the SDK, CLI and
starter. Inbox `id` now equals `inputId` on both backends. On Workers, `id` changes from the
global inbox row id to the answerable agent input id; use `(agent, id)` for row identity. `answerInbox`
posts it, and the React kit includes InboxList. AgentChat accepts a top-level subagents prop.

No database migration. camel-bots passes agent explicitly and explicit credentials, so needs no change.
