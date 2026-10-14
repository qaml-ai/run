# Fetched tool credentials

An MCP server in a definition can take `auth: {"type": "exchange", "url", "audience"?}` (PR #147): the runtime asks
the tenant's endpoint for the server's credential with an identity token it signs, and calls the server with
`Authorization: Bearer <token>`. How tenants set it up is in
[Tools: fetched credentials](../guides/tools.md#fetched-credentials-auth-exchange). For operators:

- **Nothing to configure.** It needs no secret or setting: the identity token is signed with the runtime's identity
  key, the same as for `auth: {"type": "runtime"}`, and verified by the tenant's endpoint against
  `/.well-known/jwks.json`. The issuer stays `https://agents.camelai.dev`.
- **Never stored.** Credentials are held in memory per agent and per node, refetched before they expire, and never
  written, logged or returned. A node restart or a turn moved to another node fetches again.
- **Outbound rules apply.** The endpoint's URL is checked like every tool URL: `https://`, a public address, no
  redirects; a private address is refused (`blocked`).
- **Logs and metrics.** Each fetch writes a `tool_credential_exchange` line with `Outcome` (`fetched`, `unreachable`,
  `blocked`, `timeout`, `unavailable`, `refused`, `invalid_response`, `expired`, or `rejected` when the tool server
  refused a credential), `Tenant`, the agent, the server's name, the endpoint's host, attempts and the status, and
  the metrics `CredentialExchanges` and `CredentialExchangeMs` by `Outcome` and `Tenant`. Failures:
  `filter type = "tool_credential_exchange" and Outcome != "fetched" | stats count() by Tenant, host, Outcome`.
- **A failing endpoint is the tenant's.** It makes that tool source unavailable for the call
  (`source_unavailable`, with what the endpoint did) and the turn goes on; no alarm watches it. Point the tenant at
  the outcome and status in the logs.
