# Vault and network access

Store API credentials once in the tenant vault. Values are write-only, sealed with
`AGENT_SECRETS_KEY`, and opened only for an allowed destination. Lists return names.
Deleting or rotating a value takes effect on the next request; vault values are not cached.

```http
POST /v1/secrets/STRIPE_KEY
Content-Type: application/json

{"value":"your-api-key","allowedHosts":["api.stripe.com"]}
```

Use `PATCH /v1/secrets/STRIPE_KEY` to rotate the value or replace its policy,
`DELETE` to remove it, and `GET /v1/secrets` to list names. Workspace-scoped
secrets use `/v1/workspaces/{workspace}/secrets` instead. Both scopes belong to the
API token's tenant. OAuth tokens cannot manage the vault.

`allowedHosts` takes exact public DNS names or `*.example.com`. A wildcard matches
subdomains, not the apex. Public suffixes (including private suffixes such as
`github.io`), IP literals, private names, ports and URL syntax are refused.
An empty list grants no egress. The outbound address guard also checks DNS.

The default `locations` is `["header"]`. Opt into `"query"` or `"body"` only for
an API that requires it. Secret values contain 4–8192 single-line characters.
The gateway substitutes placeholders only in attached references, rechecks the
destination, sends with redirects disabled, and masks values in response bytes
and headers. Secret values never enter the computer's environment or disk.

## MCP and OpenAPI

A definition can refer to a vault value as its server's bearer credential:

```json
{"name":"payments","mcpServers":[{"name":"stripe","url":"https://mcp.stripe.com/mcp","auth":{"type":"vault","name":"STRIPE_KEY"}}]}
```

Allow the actual MCP server host in the secret's policy. Add `workspace` to the
reference for a workspace-scoped secret. Credentials are resolved on each HTTP
request. Vault-backed MCP requires streamable HTTP; legacy SSE is refused.

## Native computers on Workers

Attach references in the definition's `computer.secrets`. Processes receive a
variable for each name, containing `camel-vault-NAME-placeholder`. Use that
variable in headers, or in query parameters or bodies explicitly permitted by
its policy. `computer.egress` can also set `auth` to a vault reference; that
host's requests then receive the bearer credential automatically.

```json
{
  "name":"billing",
  "computer":{"secrets":[{"type":"vault","name":"STRIPE_KEY"}]},
  "networking":{"type":"limited","allowedHosts":["api.stripe.com"],"allowPackageManagers":false,"allowMcpServers":false}
}
```

`networking` belongs to a definition or agent. The default is unrestricted.
Limited Workers computers start with internet access disabled and route HTTPS
through the gateway, which enforces `allowedHosts`. Other ports and plain HTTP
are blocked. `allowPackageManagers` adds npm, Yarn, PyPI and crates.io registry
and download hosts; it does not permit arbitrary package install scripts to
access the internet. `allowMcpServers` additionally permits configured MCP hosts.
Web tools and remote tool sources check the network policy too.

Node's Sprites backend cannot enforce this computer boundary. It refuses
`networking.type: "limited"`; use Workers for limited computers. Node supports
the vault API and vault-backed remote tool credentials, but has no native
computer credential gateway or `computer.secrets` support.

Existing GitHub-App and exchange references remain accepted on computer egress.
They use the same forwarding and response masking boundary as vault credentials.
