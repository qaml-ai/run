### Tool servers that move

- An MCP server's or OpenAPI source's `audience` (auth `runtime`) may be a name of the tenant's own,
  `urn:camelrun:<tenant>:<name>`, besides a URL on the server's origin: tokens keep naming it when the server moves
  to another URL or domain. Another tenant's name, like another origin's URL, is a 400. `serveTools` and
  `verifyRuntimeToken` (both SDKs) already take a list of audiences, for accepting an old and a new URL while agents
  move. See [A server that moves](../guides/tools.md#a-server-that-moves).
