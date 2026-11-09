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
subdomains, not the apex. Exact hosts in the private section of the Public Suffix
List are allowed, including `httpbin.org`, `postman-echo.com`, `herokuapp.com` and
`foo.herokuapp.com`. ICANN public suffixes such as `com` and `co.uk` are refused.
Wildcards cannot cover an entire ICANN or private suffix: `*.com` and
`*.herokuapp.com` are refused, while `*.foo.herokuapp.com` is allowed. IP literals,
private names, ports and URL syntax are refused.
Reserved environment variable names are refused, including `PATH`, `HOME`,
`SSL_CERT_FILE`, `NODE_OPTIONS`, `LD_*` and the gateway's TLS environment variables.
An empty list grants no egress. The outbound address guard also checks DNS.

The default `locations` is `["header"]`. Opt into `"query"` or `"body"` only for
an API that requires it. Secret values contain 8–8192 single-line characters.
The gateway substitutes placeholders only in attached references, rechecks the
destination, sends with redirects disabled, and masks values in responses
and their headers, including missing content types, octet streams and JavaScript.
Known binary formats and git endpoints pass through unchanged. GitHub App grants
are not vault-masked. Vault-masked bodies stream without length or ETag headers. Secret values never
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
`web_fetch` is still checked. Inline children inherit the parent's network policy and computer secrets and grants.
Definition children and delegation to existing agents use their own definition's
network policy, credentials, sources and grants.

Node's Sprites backend cannot enforce this computer boundary. It refuses
`networking.type: "limited"`; use Workers for limited computers. Node supports
the vault API and vault-backed remote tool credentials, but has no native
computer credential gateway or `computer.secrets` support.

Existing GitHub-App and exchange references remain accepted on computer egress.
They use the same forwarding boundary. Only vault credentials are response-masked;
GitHub App git traffic and binary responses pass through unchanged.

## Verify a deployed pilot

Run only against a pilot. The script refuses known production origins. Supply an
API key for the pilot tenant and an existing Container agent with:

- Limited networking that allows `github.com` and the vault echo host, and blocks
  the hostname passed to `--blocked-host`.
- A GitHub App egress grant for `github.com`, with `contents:write` access to
  `qaml-ai/camelcode-scratch`.
- An attached vault secret whose policy allows the echo host and header injection.
- The `agents` builtin and `delegate.instructions: true`, so it can spawn an
  inline child.

The HTTPS echo endpoint must return the injected Authorization header in its
response body. The script checks that the response contains `[hidden]` and no
vault placeholder.

```sh
CAMELAI_API_KEY=... node --experimental-strip-types scripts/verify-egress.mjs \
  --pilot https://your-pilot.example.com --agent AGENT_ID \
  --vault-name TEST_TOKEN --vault-url https://httpbin.org/headers \
  --blocked-host example.com
```

`--pilot`, `--agent`, `--vault-name` and `--vault-url` are required.
`--blocked-host` defaults to `example.com`. The repository is fixed to
`qaml-ai/camelcode-scratch`; there is no `--repo` flag.

The script checks the parent, an agent fork restored from the parent's computer
snapshot, and a fresh inline child created through a model request. Each runs a
clone, creates an empty commit on a unique scratch branch, pushes it, verifies the
remote ref, and deletes that branch. Each also checks vault substitution and a
403 response from the blocked host. Cleanup deletes the two created agents and
removes the temporary checkout directories. The existing parent's configuration
is unchanged; its prompt history includes the request to spawn the inline child.
