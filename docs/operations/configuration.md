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
| `AGENT_PUBLIC_ALIASES` | other origins the runtime also answers at, comma-separated (e.g. an earlier domain kept working): everything is served on them, an MCP endpoint's protected-resource metadata names the resource at the origin a client reached, and the console, `/` and `/oauth/authorize` redirect to `AGENT_PUBLIC_URL`, where sign-in cookies and OAuth callbacks belong |
| `AGENT_ISSUER` | what identity tokens' `iss` and the OAuth issuer name: `AGENT_PUBLIC_URL` unless set, and otherwise one of `AGENT_PUBLIC_ALIASES`. Set it to the old URL when `AGENT_PUBLIC_URL` moves, so tool servers checking the issuer keep working |
| `AGENT_BROWSER_URL` | where browsers reach the runtime, as browser tokens' `url` says: `AGENT_PUBLIC_URL` unless set; empty for none, for a private runtime browsers read through the application ([Self-hosting](self-host.md#networking)) |
| `AGENT_S3_ENDPOINT`, `AGENT_S3_FORCE_PATH_STYLE` | an S3-compatible service instead of AWS S3 (R2, SeaweedFS), and `true` for path-style requests; it must support conditional writes (`If-None-Match`) |
| `AGENT_NODE_URL` | this node's address for forwarding between nodes; unset on ECS, it is `http://<task private IPv4>:<PORT>` from `ECS_CONTAINER_METADATA_URI_V4`, and elsewhere `http://127.0.0.1:<PORT>` |
| `AGENT_LEASE_TTL_MS` | node heartbeat lifetime (default 90000): the longest database outage a node rides out, and how long a crashed node's actors wait for a new owner |
| `AGENT_GC_ENABLED`, `AGENT_GC_DRY_RUN` | storage garbage collection: `true` to run it (default off), and `true` to only log what it would delete (see [Storage garbage collection](persistence.md#storage-garbage-collection)) |
| `AGENT_GC_GRACE_MS`, `AGENT_GC_INTERVAL_MS`, `AGENT_GC_POLL_MS` | how long a chunk must stay unreferenced before it is deleted (default 86400000, a day), how often each tenant is collected (default 21600000, 6 h), and how often a node looks for a tenant due (default 60000) |
| `AGENT_MAX_RUN_RESPONSES`, `AGENT_MAX_RUN_SECONDS` | the most one run may take: model responses (default 1000) and seconds from when it began (default 7200); agents' and definitions' `runLimits` may only lower them. They apply to self-serve tenants; a tenant's own `maxRunResponses` and `maxRunSeconds` (tenants-file entry, or `PUT /v1/tenants/{id}/limits`) replace them, and admin tenants have none unless their entry sets them. At either, the turn stops with `stopped: "turn_limit"` |
| `AGENT_DRAIN_TIMEOUT_MS` | how long SIGTERM waits for running turns before handing them off (default 100000; see [Draining](architecture.md#draining)) |
| `AGENT_ECS_SERVICE`, `AGENT_ECS_CLUSTER` | the ECS service this task belongs to, for retirement (see [Deploys](architecture.md#deploys)); the cluster defaults to the task's own; without the service, tasks never retire |
| `AGENT_RETIRE_WAIT_MS` | how long a superseded task waits for the new deployment to run all its tasks before retiring anyway, once a peer has joined (default 600000, 10 min) |
| `AGENT_RETIRE_MAX_MS` | how long a retiring task keeps protection for running turns (default 21600000, 6 h) |
| `AGENT_ECS_POLL_MS`, `AGENT_PROTECTION_IDLE_MS` | how often to check the service's deployment (default 30000), and how long without work before task protection is cleared (default 30000) |
| `AGENT_TENANTS_FILE` | tenants JSON (`{tenants: {<id>: {tokenSha256, apiKeys, github?, githubId?, maxAgents?, maxWatchers?, maxMonthlyCost?, maxDiscordServers?, maxStorageGb?, maxAgentCreatesPerMinute?, maxRunsPerMinute?, maxRunResponses?, maxRunSeconds?, codeCpuMs?, codeMaxTimeoutMs?, codeConcurrency?, billing?, platformKeys?, modelEndpoints?}}, platformKeys?}`), re-read on SIGHUP; the top-level `platformKeys` are the platform's provider keys, which a tenant without a key of its own falls back to: prepaid tenants (charged) and admin tenants (unbilled, recorded as platform usage), unless an unbilled tenant's entry sets `"platformKeys": false` (a prepaid one cannot); see [Billing](billing.md) for `billing` and `platformKeys`, and [A tenant's own model endpoint](../guides/models-and-keys.md#your-own-model-endpoint) (pass-through). `github` is a GitHub login that signs in to the console as the tenant: the first account to sign in with it is bound to the tenant by its numeric id, and only that account signs in as it from then on (renamed, it still does; whoever takes the freed login does not). Set `githubId` (the account's numeric id, from `https://api.github.com/users/<login>`) to name the account up front instead; changing `github` rebinds the tenant to the next account to sign in with the new login |
| `AGENT_TENANTS_JSON` | the tenants file's JSON inline, instead of `AGENT_TENANTS_FILE` |
| `AGENT_TENANT`, `AGENT_OPERATOR_TOKEN`, `AGENT_TENANT_API_KEYS` | instead of a tenants file, one tenant: its id, its operator token (at least 24 characters) and optionally its provider keys as JSON (`{"anthropic": "sk-ant-..."}`); see [Self-hosting](self-host.md) |
| `AGENT_TENANTS_SECRET_ARN` | instead of a file: a Secrets Manager secret holding the same JSON, read at startup and every minute and on SIGHUP; a bad value is rejected and the last good tenants stay |
| `AGENT_SESSION_SECRET`, `AGENT_SECRETS_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | plain values, for development |
| `AGENT_SESSION_SECRET_ARN`, `AGENT_SECRETS_KEY_ARN`, `AGENT_GITHUB_OAUTH_SECRET_ARN` | instead of the plain values (not both): Secrets Manager secrets read once at startup, the last holding `{clientId, clientSecret}`. On ECS only these are set, so no secret value is in the process environment, which any other process running as the same uid could read from `/proc` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe, for credit purchases (development; see [Billing](billing.md)) |
| `AGENT_STRIPE_PORTAL_CONFIGURATION` | Product-specific `bpc_` configuration for Stripe-hosted cards and invoices; see [Billing](billing.md) |
| `AGENT_STRIPE_SECRET_ARN` | instead: a Secrets Manager secret holding `{secretKey, webhookSecret}`, read at startup; while it has no value, purchases are off |
| `GITHUB_ORG` | console GitHub sign-in admits active members of this organization (default `qaml-ai`) |
| `AGENT_OPEN_SIGNUP` | `true` admits any GitHub account instead, and allows Google sign-in and, with account mail, email sign-up (see [Billing](billing.md)) |
| `AGENT_DISCORD_MANAGED_ENABLED` | `true` enables the hosted Camel Discord integration; off by default. Requires the platform application settings below; see [Managed Discord](managed-discord.md) |
| `AGENT_DISCORD_MANAGED_APPLICATION_ID` | the Discord application's ID |
| `AGENT_DISCORD_MANAGED_BOT_TOKEN`, `AGENT_DISCORD_MANAGED_CLIENT_SECRET` | platform bot token and OAuth client secret, server-side only; never customer channel credentials. Restart after rotating them |
| `AGENT_DISCORD_MANAGED_SECRET_ARN` | instead of the three plain managed Discord values: Secrets Manager JSON `{botToken, applicationId, clientSecret}` (other fields are ignored), read at startup; do not set both forms. A secret with no value, or invalid values, leaves the integration off (`discord_managed_not_configured`) |
| `AGENT_DISCORD_MANAGED_SERVERS`, `AGENT_DISCORD_MANAGED_FREE_SERVERS` | Discord servers an account may connect to the managed bot (default 10), and while on free credit (default 1); a tenant's `maxDiscordServers` overrides both |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | optional: console sign-in with Google (a Google Cloud OAuth client of type Web application, redirect URI `<AGENT_PUBLIC_URL>/console/auth/google/callback`, scopes `openid email profile`). Off unless set; needs `AGENT_OPEN_SIGNUP=true`, since it admits any Google account with a verified address. Development values |
| `AGENT_GOOGLE_OAUTH_SECRET_ARN` | instead: a Secrets Manager secret holding `{clientId, clientSecret}`, read at startup; while it has no value, Google sign-in is off |
| `AGENT_SIGNUP_MIN_ACCOUNT_DAYS` | private signup eligibility policy; required when GitHub starting credit is enabled, supplied through deployment configuration |
| `AGENT_EMAIL_DOMAIN` | the domain SES receives mail for (e.g. `in.agents.camelai.dev`); set, it offers `email` channels, each with an address on it (see [Email](../guides/channels.md#email)). `infra/terraform/email.tf` sets these four |
| `AGENT_EMAIL_SNS_TOPICS` | SNS topic ARNs (comma-separated) whose notifications `/channels/email/inbound` accepts; with none, no mail is received |
| `AGENT_EMAIL_BUCKET` | the bucket an SES S3 receipt action stores mail in (the runtime reads messages and their attachments from it, under the task role); without it, only mail SES puts in the SNS notification itself (up to 150 KB) arrives |
| `AGENT_EMAIL_REGION` | SES and S3's region (default `AWS_REGION`) |
| `AGENT_ACCOUNT_EMAIL_FROM` | optional sender of account mail: with it, people sign up with an email and password (with `AGENT_OPEN_SIGNUP=true`), reset a forgotten password, and add a password to a GitHub or Google account, each through a link mailed to the address. Unset (the default): none of these is offered, and passwords are the operator's to set. See [Account email](account-email.md) |
| `AGENT_ACCOUNT_EMAIL_PROVIDER` | `ses` (default): Amazon SES's API, with the runtime's AWS credentials and `AWS_REGION`; the sender must be a verified SES identity and the credentials allowed `ses:SendEmail` as it. `log`: no mail; each link and its address are written to the log for the operator to pass on. `log` is refused with `AGENT_OPEN_SIGNUP=true` unless `AGENT_PUBLIC_URL` is a loopback address, so a public runtime never logs a sign-up link |
| `AGENT_ACCOUNT_EMAIL_NAME`, `AGENT_ACCOUNT_EMAIL_CONFIGURATION_SET` | optional: the sender's display name (default `camelRun`), and an SES configuration set to send with |
| `AGENT_RATE_LIMIT_EMAIL_REQUESTS_PER_IP`, `AGENT_RATE_LIMIT_EMAILS_PER_ADDRESS` | requests that mail a link (sign-up, password reset, adding a password) per client address an hour (default 10, on by default only with `AGENT_TRUST_CF_CONNECTING_IP=true`), and such mails per email address a UTC day (default 5, on everywhere). Counted whether or not the address has an account; a refused password counts nothing; 0 turns one off |
| `AGENT_BILLING_EMAIL_FROM` | optional verified sender for billing confirmation and balance alerts; unset disables billing email |
| `AGENT_BILLING_EMAIL_NAME` | sender display name, default `camelRun Billing`; the FROM setting remains the bare verified address |
| `AGENT_BILLING_EMAIL_PROVIDER` | `ses`, the default and only provider (the Cloudflare Worker provider is gone); requires `AGENT_PUBLIC_URL` and `AGENT_SECRETS_KEY` |
| `AGENT_BILLING_EMAIL_CONFIGURATION_SET`, `AGENT_BILLING_EMAIL_SNS_TOPICS` | required only for SES: configuration set publishing bounce/complaint feedback and comma-separated SNS topic ARNs; also requires SES access in `AWS_REGION`. See [Billing email](billing.md#configuring-delivery) |
| `AGENT_SUPPORT_EMAIL`, `AGENT_SUPPORT_EMAIL_FROM` | the support inbox and its verified sender for the console's Get Help; both unset (the default) hides it, so a self-hosted runtime never mails camelAI. Replies go to one of the tenant's verified billing addresses when it has any, and otherwise to an address typed in the form. Sent through SES with billing's configuration set, from an address other than `AGENT_BILLING_EMAIL_FROM` |
| `AGENT_SUPPORT_EMAIL_NAME` | Get Help sender display name, default `camelRun` |
| `AGENT_SUPPORT_LOG_GROUP`, `AGENT_RELEASE` | optional: the log group and release (image tag) named in Get Help's support email, for investigating |
| `AGENT_TRUST_CF_CONNECTING_IP` | `true` takes each client's address from `CF-Connecting-IP`, for per-address rate limits and Get Help. Only for a runtime nothing but Cloudflare can reach (camelRun's ALB admits only Cloudflare's addresses), since anyone else could send the header. Default `false`: the load balancer's last `X-Forwarded-For` entry, else the connection's address |
| `AGENT_RATE_LIMIT_API_PER_IP`, `AGENT_RATE_LIMIT_AUTH_PER_IP`, `AGENT_RATE_LIMIT_SIGNUPS_PER_IP` | per client address: requests a minute to `/v1/*` (default 600), requests a minute to `/console/auth/*` and `/oauth/*` (default 20), and new accounts a UTC day (default 5). On by default only with `AGENT_TRUST_CF_CONNECTING_IP=true`; otherwise 0 (none) unless set, because the address may be a shared proxy's. 0 turns one off. See [Limits](../reference/limits.md#rate-limits) |
| `AGENT_RATE_LIMIT_PASSWORD_FAILURES_PER_EMAIL`, `AGENT_RATE_LIMIT_PASSWORD_FAILURES_PER_IP` | failed email and password sign-ins in 15 minutes per email address (default 10, on everywhere) and per client address (default 20, on by default only with `AGENT_TRUST_CF_CONNECTING_IP=true`). Past either, sign-in answers 429 until the window turns over; 0 turns one off |
| `AGENT_RATE_LIMIT_AGENT_CREATES`, `AGENT_RATE_LIMIT_FREE_AGENT_CREATES` | agents a tenant may create a minute (default 60), and on free credit (default 10); an admin tenant's `maxAgentCreatesPerMinute`, or a self-serve tenant's `agentCreatesPerMinute` (`PUT /v1/tenants/{id}/limits`), overrides both; 0: no limit. Admin tenants (in the tenants file) have no per-tenant limits unless their entry sets one, and their /v1 requests are not counted per address |
| `AGENT_RATE_LIMIT_RUNS`, `AGENT_RATE_LIMIT_FREE_RUNS` | runs (prompt, continue, execute) a tenant may start a minute (default 600), and on free credit (default 60); an admin tenant's `maxRunsPerMinute`, or a self-serve tenant's `runsPerMinute`, overrides both; 0: no limit |
| `AGENT_RATE_LIMIT_EXEMPT` | client keys no per-address limit applies to, comma-separated: an address, an IPv6 `/64` as `2001:db8:1:2::/64`, or `worker:<zone>` for a Cloudflare Worker's requests (Workers share one address, so they are told apart by their zone) |
| `AGENT_BILLING_ADMINS` | tenants (comma-separated) whose operator tokens may adjust any tenant's credit, and act on other tenants (`/v1/tenants`: create, limits, passwords, export, deletion) |
| `AGENT_ADMIN_HOST` | hostname of the team's admin site (platform stats: sign-ups, activation, usage per day, the latest sign-ups), behind Cloudflare Access; requests for it are answered by the site only (`src/admin-site.ts`). Set with the next two, or none |
| `AGENT_ADMIN_ACCESS_TEAM` | the Access team's origin, e.g. `https://<team>.cloudflareaccess.com`: each request's `Cf-Access-Jwt-Assertion` must be signed by its keys and name it as issuer |
| `AGENT_ADMIN_ACCESS_AUD` | the admin site's Access application AUD tag, which each token must name as audience |
| `AGENT_OPENAI_APPS_CHALLENGE` | the domain-verification token ChatGPT's plugin directory issues, served as plain text at `/.well-known/openai-apps-challenge` (404 while unset) |
| `AGENT_OPENROUTER_CREDIT_MULTIPLIER` | actual dollars paid per dollar of platform OpenRouter credits (default `1.055`, Standard card funding); use `1` for a fee waiver, or the effective ratio from purchases when discounts, minimum fees or non-recoverable taxes apply. Independent of the checkout fee. |
| `AGENT_PRICE_AGENT_HOUR_USD`, `AGENT_PRICE_STORAGE_GB_MONTH_USD`, `AGENT_CREDIT_FEE_PERCENT`, `AGENT_CREDIT_MIN_PURCHASE_USD`, `AGENT_CREDIT_MAX_PURCHASE_USD`, `AGENT_CREDIT_GRANT_USD`, `AGENT_FREE_HOURLY_SPEND_USD`, `AGENT_MAX_STORAGE_GB`, `AGENT_FREE_MAX_STORAGE_GB` | prepaid rates and limits (defaults 0.01, 0.10, 5.5, 5, 1000, 5, 1, 100, 1; see `src/pricing.ts` and [Billing](billing.md)) |
| `AGENT_USAGE_TIERS` | prepaid tenants' usage tiers, as JSON: `[{"name": "Free", "paidUsd": 0, "busyAgents": 8}, {"name": "Tier 1", "paidUsd": 5, "busyAgents": 25}, ...]`, by ascending `paidUsd`, the first at 0. A tenant is in the highest tier whose `paidUsd` it has paid for credit in total (net of refunds), and may have that tier's `busyAgents` busy at once across the fleet. Default: Free 8, $5 25, $50 100, $250 250, $1,000 1,000 ([limits](../reference/limits.md#usage-tiers)). Replaces `AGENT_FREE_MAX_AGENTS`, which now fails the start |
| `AGENT_PRICE_WEB_SEARCH_EXA_USD`, `AGENT_PRICE_WEB_SEARCH_BRAVE_USD`, `AGENT_PRICE_WEB_SEARCH_PARALLEL_USD`, `AGENT_PRICE_WEB_RENDER_USD` | per platform-key `web_search` by the provider that answered, and per page `web_fetch` has Firecrawl render (defaults 0.007, 0.005, 0.001, 0.00083); `AGENT_PRICE_WEB_SEARCH_USD` sets all three search prices at once |
| `AGENT_WEB_SEARCH_PROVIDERS` | the providers `web_search` tries, in order (default `exa,brave,parallel`) |
| `AGENT_WEB_SEARCH_TIMEOUT_MS` | how long each search provider gets before the next is tried (default 5000) |
| `AGENT_EXA_SEARCH_URL`, `AGENT_BRAVE_SEARCH_URL`, `AGENT_PARALLEL_SEARCH_URL`, `AGENT_FIRECRAWL_SCRAPE_URL` | the providers' endpoints (default their own; tests point them at local servers) |
| `AGENT_BILLING_INTERVAL_MS` | how often a node checks whether today's storage charge has run (default 3600000) |
| `AGENT_STORAGE_RECONCILE_DAYS` | how often the storage charge first corrects tracked storage by listing Storage (default 7; 0: only the first time; see [Billing](billing.md)) |
| `AGENT_SERVICE_NAME` | the `ServiceName` dimension on the `node_load` metrics (none when unset) |
| `AGENT_HOSTING` | `process` (one Node process per awake agent) or `inline` (many agents per process) |
| `AGENT_CODE_WORKERS_MAX` | at most how many js_exec executions tenants with a concurrency limit (`codeConcurrency`; self-serve ones by default) run at once on a node, together. By default what 40% of the process's memory (its cgroup limit in a container) affords at 128 MiB an execution, from 2 to 32 (6 on a 2 GB task); this only lowers it. Executions beyond it, or beyond their tenant's limit, wait their turn within their own timeout. Admin tenants without one are bounded only by `AGENT_V8_MAX` |
| `AGENT_V8_PRESPAWN` | v8-exec processes each sandbox process keeps started ahead (default 2; none in the runtime process without sandbox processes) |
| `AGENT_V8_MAX` | v8-exec processes running at once on a node, shared among its sandbox processes (default 64); more wait their turn |
| `AGENT_V8_JITLESS` | `false` lets V8 use its JIT compilers (default on: interpreted, no executable memory) |
| `AGENT_V8_EXEC` | the v8-exec binary, which runs every js_exec (default `/usr/local/bin/v8-exec`, as the image has it, else the checkout's `npm run build:v8-exec` build). The runtime does not start if js_exec does not run |
| `AGENT_SANDBOX_PROCESSES` | read by `agent-launcher` (the image's entrypoint): how many [sandbox processes](sandbox.md) run js_exec (default 2, at most 16; 0 runs it in the runtime process) |
| `AGENT_SANDBOX_REQUIRED` | `1` (the image's default) refuses to start without sandbox processes |
| `AGENT_OUTBOUND_ALLOW_HTTP` | `true` lets MCP servers, `web_fetch` and tenants' model endpoints (key scopes' `baseUrl`) use `http://` URLs (tests and development only) |
| `AGENT_OUTBOUND_BLOCK_CIDRS` | ranges no tool source may reach, on top of the built-in private and reserved ranges, e.g. the VPC's CIDR (see [Outbound calls](../guides/tools.md#outbound-calls)) |
| `AGENT_OUTBOUND_ALLOW_CIDRS` | exceptions to the built-in ranges, e.g. `127.0.0.1/32` for a local test server; never set in production |
| `AGENT_OUTBOUND_ALLOW_ORIGINS` | exact origins (`scheme://host:port`, comma-separated) reachable despite the built-in ranges, over `http` too: an operator's own services, e.g. `http://app:3000` for a self-hosted runtime's application. Only that scheme, host and port; checked at each connection, and `AGENT_OUTBOUND_BLOCK_CIDRS` still applies. MCP servers, HTTP tools, model providers and webhooks may use them; `web_fetch`, `web_search` and renders never do ([Self-hosting](self-host.md#networking)) |
| `AGENT_SANDBOX_SOCKETS` | set by `agent-launcher`: the sandbox processes' sockets. Without it, the runtime process runs js_exec in v8-exec processes of its own, as in development on macOS; the `listening` log line's `sandbox` field says which |

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
export AGENT_MODEL=claude-sonnet-5-5
export AGENT_DATA_DIR=/absolute/path/to/agent-data
npm run build:v8-exec   # once: js_exec's engine (needs Rust)
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
