### Fetched credentials for tool servers

- An MCP server in a definition takes `auth: {"type": "exchange", "url", "audience"?}`: the runtime fetches the
  server's credential from an endpoint of yours, asking with an identity token it signs (audience the endpoint's URL,
  and an `exchange` claim naming the server), and calls the server with `Authorization: Bearer <token>`. The endpoint
  answers `{"token", "expiresAt"}` or `{"token", "expiresIn"}`. So a GitHub App installation token, an STS token or
  an OAuth access token can be used where only a long-lived personal token could. See
  [Tools](../guides/tools.md#fetched-credentials-auth-exchange), with a GitHub App as the worked example.
- A credential is kept in memory only, per agent and per node: never stored, logged, returned by an API or shown to a
  model. It is fetched again before it expires, calls made at once share one fetch, and a server that answers 401 or
  403 gets one request more with a new credential before the tool call fails.
- An exchange that is down, slow or answers wrongly makes its source unavailable for that call (`source_unavailable`,
  with what the endpoint did), and the turn goes on. Saving a definition asks for a credential as the definition, to
  list the server's tools: an endpoint that refuses or answers wrongly is a 400, one that is down is not.
- A `tool_credential_exchange` log line and metric (`CredentialExchanges`, `CredentialExchangeMs`, by `Outcome` and
  `Tenant`) for each fetch. `SourceAuth` in the TypeScript SDK has the new type.
