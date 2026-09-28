# Configuration

| Variable | Meaning |
| --- | --- |
| `AGENT_DATABASE_URL` | Postgres for development and tests (`sslmode` and `sslrootcert` in the URL are honoured) |
| `AGENT_DATABASE_HOST`, `AGENT_DATABASE_SECRET_ARN` | production instead of a URL: the login is read from the Secrets Manager secret (`{username, password}`, rotated by RDS), cached, and re-read every 10 minutes and whenever a connection fails authentication; `AGENT_DATABASE_NAME` (default `agent_runtime`), `AGENT_DATABASE_PORT` (default 5432), `AWS_REGION` |
| `AGENT_DATABASE_LISTEN_HOST` | where each node's one listening connection goes (notifications that another node loaded an agent), instead of `AGENT_DATABASE_HOST`: the database instance when the pool goes through RDS Proxy, which does not carry LISTEN reliably |
| `AGENT_DATABASE_CA` | PEM bundle the server's certificate must chain to (e.g. `/etc/ssl/rds-global-bundle.pem`); TLS settings in a URL are then ignored |
| `AGENT_DATABASE_POOL_SIZE` | connections per node (default 10) |
| `AGENT_DATABASE_QUERY_TIMEOUT_MS` | how long a query may take before it fails and its connection is replaced (default 30000; 0 for none), so a connection that went dark in a failover cannot hang a request |
| `AGENT_TOOL_SEARCH` | ranking by meaning for `tools.search` after keywords: `keyword` (default, none), `embeddings`, or `embeddings,jev` (Jev also drops irrelevant tools); with the platform's OpenRouter key or `AGENT_TOOL_SEARCH_API_KEY`, `AGENT_TOOL_SEARCH_URL` (default OpenRouter) and `AGENT_TOOL_SEARCH_EMBEDDINGS_MODEL` / `_JEV_MODEL` (see [Tool search](../guides/tools.md#tool-search)) |
| `AGENT_PROVIDER`, `AGENT_MODEL` | the default model, for agents that name none (e.g. `anthropic` and `claude-sonnet-5-5`); `AGENT_BASE_URL` overrides its endpoint |
| `AGENT_MODEL_FALLBACKS` | the defaults after it, as `provider/model` references, comma-separated (default Claude Sonnet 5.5 on Anthropic, OpenRouter and Bedrock's global profile, then `openrouter/openai/gpt-6-luna`; empty for none): an agent that names no model gets the first its tenant or key scope has a key for |
| `AGENT_STORAGE` | `file` (default; one node only), `shared-file` (several processes on one filesystem), or `s3` (`AGENT_S3_BUCKET`, `AGENT_S3_PREFIX`) |
| `AGENT_NODE_URL` | this node's address for forwarding between nodes; unset on ECS, it is `http://<task private IPv4>:<PORT>` from `ECS_CONTAINER_METADATA_URI_V4`, and elsewhere `http://127.0.0.1:<PORT>` |
| `AGENT_LEASE_TTL_MS` | node heartbeat lifetime (default 90000): the longest database outage a node rides out, and how long a crashed node's actors wait for a new owner |
| `AGENT_GC_ENABLED`, `AGENT_GC_DRY_RUN` | storage garbage collection: `true` to run it (default off), and `true` to only log what it would delete (see [Storage garbage collection](persistence.md#storage-garbage-collection)) |
| `AGENT_GC_GRACE_MS`, `AGENT_GC_INTERVAL_MS`, `AGENT_GC_POLL_MS` | how long a chunk must stay unreferenced before it is deleted (default 86400000, a day), how often each tenant is collected (default 21600000, 6 h), and how often a node looks for a tenant due (default 60000) |
| `AGENT_DRAIN_TIMEOUT_MS` | how long SIGTERM waits for running turns before handing them off (default 100000; see [Draining](architecture.md#draining)) |
| `AGENT_ECS_SERVICE`, `AGENT_ECS_CLUSTER` | the ECS service this task belongs to, for retirement (see [Deploys](architecture.md#deploys)); the cluster defaults to the task's own; without the service, tasks never retire |
| `AGENT_RETIRE_WAIT_MS` | how long a superseded task waits for the new deployment to run all its tasks before retiring anyway, once a peer has joined (default 600000, 10 min) |
| `AGENT_RETIRE_MAX_MS` | how long a retiring task keeps protection for running turns (default 21600000, 6 h) |
| `AGENT_ECS_POLL_MS`, `AGENT_PROTECTION_IDLE_MS` | how often to check the service's deployment (default 30000), and how long without work before task protection is cleared (default 30000) |
| `AGENT_TENANTS_FILE` | tenants JSON (`{tenants: {<id>: {tokenSha256, apiKeys, github?, maxAgents?, maxWatchers?, maxMonthlyCost?, billing?, modelEndpoints?}}, platformKeys?}`), re-read on SIGHUP; see [Billing](billing.md) for `billing` and `platformKeys`, and [A tenant's own model endpoint](../guides/models-and-keys.md#your-own-model-endpoint) (pass-through) |
| `AGENT_TENANTS_SECRET_ARN` | instead of a file: a Secrets Manager secret holding the same JSON, read at startup and every minute and on SIGHUP; a bad value is rejected and the last good tenants stay |
| `AGENT_SESSION_SECRET`, `AGENT_SECRETS_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | plain values, for development |
| `AGENT_SESSION_SECRET_ARN`, `AGENT_SECRETS_KEY_ARN`, `AGENT_GITHUB_OAUTH_SECRET_ARN` | instead of the plain values (not both): Secrets Manager secrets read once at startup, the last holding `{clientId, clientSecret}`. On ECS only these are set, so no secret value is in the process environment, which any other process running as the same uid could read from `/proc` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe, for credit purchases (development; see [Billing](billing.md)) |
| `AGENT_STRIPE_SECRET_ARN` | instead: a Secrets Manager secret holding `{secretKey, webhookSecret}`, read at startup; while it has no value, purchases are off |
| `GITHUB_ORG` | console GitHub sign-in admits active members of this organization (default `qaml-ai`) |
| `AGENT_OPEN_SIGNUP` | `true` admits any GitHub account instead (see [Billing](billing.md)) |
| `AGENT_SIGNUP_MIN_ACCOUNT_DAYS` | how old a GitHub account must be for a new tenant's starting credit (default 30) |
| `AGENT_BILLING_ADMINS` | tenants (comma-separated) whose operator tokens may adjust any tenant's credit |
| `AGENT_PRICE_AGENT_HOUR_USD`, `AGENT_PRICE_STORAGE_GB_MONTH_USD`, `AGENT_CREDIT_FEE_PERCENT`, `AGENT_CREDIT_MIN_PURCHASE_USD`, `AGENT_CREDIT_MAX_PURCHASE_USD`, `AGENT_CREDIT_GRANT_USD`, `AGENT_FREE_MAX_AGENTS`, `AGENT_FREE_HOURLY_SPEND_USD` | prepaid rates and limits (defaults 0.01, 0.10, 5.5, 5, 1000, 5, 2, 1; see `src/pricing.ts`) |
| `AGENT_PRICE_WEB_SEARCH_EXA_USD`, `AGENT_PRICE_WEB_SEARCH_BRAVE_USD`, `AGENT_PRICE_WEB_SEARCH_PARALLEL_USD`, `AGENT_PRICE_WEB_RENDER_USD` | per platform-key `web_search` by the provider that answered, and per page `web_fetch` has Firecrawl render (defaults 0.007, 0.005, 0.001, 0.00083); `AGENT_PRICE_WEB_SEARCH_USD` sets all three search prices at once |
| `AGENT_WEB_SEARCH_PROVIDERS` | the providers `web_search` tries, in order (default `exa,brave,parallel`) |
| `AGENT_WEB_SEARCH_TIMEOUT_MS` | how long each search provider gets before the next is tried (default 5000) |
| `AGENT_EXA_SEARCH_URL`, `AGENT_BRAVE_SEARCH_URL`, `AGENT_PARALLEL_SEARCH_URL`, `AGENT_FIRECRAWL_SCRAPE_URL` | the providers' endpoints (default their own; tests point them at local servers) |
| `AGENT_BILLING_INTERVAL_MS` | how often a node checks whether today's storage charge has run (default 3600000) |
| `AGENT_STORAGE_RECONCILE_DAYS` | how often the storage charge first corrects tracked storage by listing Storage (default 7; 0: only the first time; see [Billing](billing.md)) |
| `AGENT_SERVICE_NAME` | the `ServiceName` dimension on the `node_load` metrics (none when unset) |
| `AGENT_HOSTING` | `process` (one Node process per awake agent) or `inline` (many agents per process) |
| `AGENT_CODE_WORKERS_MIN`, `AGENT_CODE_WORKERS_MAX` | codemode worker threads kept warm (default min(4, cores); none in each agent process under `process` hosting, which starts one on demand) and the most there may be (default 32); workers beyond the minimum stop after 30 s idle, and executions beyond the maximum queue within their own timeout. With sandbox processes, the totals are shared among them |
| `AGENT_SANDBOX_PROCESSES` | read by `agent-launcher` (the image's entrypoint): how many [sandbox processes](sandbox.md) run js_exec (default 2, at most 16; 0 runs it in the runtime process) |
| `AGENT_SANDBOX_REQUIRED` | `1` (the image's default) refuses to start without sandbox processes |
| `AGENT_OUTBOUND_ALLOW_HTTP` | `true` lets MCP servers, `web_fetch` and tenants' model endpoints (key scopes' `baseUrl`) use `http://` URLs (tests and development only) |
| `AGENT_OUTBOUND_BLOCK_CIDRS` | ranges no tool source may reach, on top of the built-in private and reserved ranges, e.g. the VPC's CIDR (see [Outbound calls](../guides/tools.md#outbound-calls)) |
| `AGENT_OUTBOUND_ALLOW_CIDRS` | exceptions to the built-in ranges, e.g. `127.0.0.1/32` for a local test server; never set in production |
| `AGENT_SANDBOX_SOCKETS` | set by `agent-launcher`: the sandbox processes' sockets. Without it, js_exec runs on worker threads in the runtime process, as in development on macOS; the `listening` log line's `sandbox` field says which |

Start a runtime on a VM using a trusted terminal. It always reads its tenants
from `AGENT_TENANTS_FILE` or `AGENT_TENANTS_SECRET_ARN`, and does not start
without one:

```sh
export TOKEN="$(openssl rand -hex 32)"
printf '{"tenants":{"me":{"tokenSha256":"%s","apiKeys":{"anthropic":"your-provider-key"}}}}' \
  "$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)" > tenants.json
export AGENT_TENANTS_FILE="$PWD/tenants.json"
export AGENT_SESSION_SECRET="$(openssl rand -hex 32)"
export AGENT_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
export AGENT_PROVIDER=anthropic
export AGENT_MODEL=claude-sonnet-4-5
export AGENT_DATA_DIR=/absolute/path/to/agent-data
npm start
```

This starts on `127.0.0.1:8790`. `HOST`/`PORT` are configurable. Use a private
network and TLS termination before exposing the control plane remotely; the
token is the tenant's operator credential, with control of its agents and their
approved tools. `AGENT_BASE_URL` optionally overrides the selected Pi model's
provider endpoint. Model keys are sent to the agent over IPC, not passed on argv
or persisted in session files.

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"demo"}' http://127.0.0.1:8790/v1/agents
```
