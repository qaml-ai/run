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
Reserved environment variable names are refused, including `PATH`, `HOME`,
`SSL_CERT_FILE`, `NODE_OPTIONS`, `LD_*` and names already set by the runtime.
An empty list grants no egress. The outbound address guard also checks DNS.

The default `locations` is `["header"]`. Opt into `"query"` or `"body"` only for
an API that requires it. Secret values contain 8–8192 single-line characters.
The gateway substitutes placeholders only in attached references, rechecks the
destination, sends with redirects disabled, and masks values in textual responses
and their headers. Binary responses pass through unchanged. Secret values never
enter the computer's environment or disk.

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
its policy. Body substitution also requires `inBody: true` on the attached
reference; otherwise request bodies stream unchanged. Only body substitution
requests have an 8 MiB cap. `computer.egress` can also set `auth` to a vault reference; that
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
Web targets and remote tool sources check the network policy too. Host-managed
search and rendering provider endpoints are exempt; the page requested by
`web_fetch` is still checked. Children inherit the parent's restrictions and can
use only vault secrets granted to the parent. Existing delegation targets that
exceed those restrictions are refused.

Node's Sprites backend cannot enforce this computer boundary. It refuses
`networking.type: "limited"`; use Workers for limited computers. Node supports
the vault API and vault-backed remote tool credentials, but has no native
computer credential gateway or `computer.secrets` support.

Existing GitHub-App and exchange references remain accepted on computer egress.
They use the same forwarding boundary. Only vault credentials are response-masked;
GitHub App git traffic and binary responses pass through unchanged.

## Verify a deployed pilot

Use an existing Container agent with a GitHub App grant, limited networking and
access to a private repository. This script reads configuration, runs
`git ls-remote` and checks that an unlisted host receives 403. It creates no
agents, changes no configuration and writes no repository files. Known production
origins are refused; supply only a pilot URL.

```sh
CAMELAI_API_KEY=... node --experimental-strip-types scripts/verify-egress.mjs \
  --pilot https://your-pilot.example.com --agent AGENT_ID \
  --repo https://github.com/owner/private-repo.git --blocked-host example.com
```
