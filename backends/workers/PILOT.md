# Workers pilot

The internal API is **https://run-pilot.camelai.dev**. This is a persistent,
team-only experiment in Cloudflare account `85bbd288051330fb51ee1c86031a299b`.
It is independent of production camelRun on AWS. Do not point it at production
Postgres or use customer credentials. All dates below are UTC.

## Deployment

| Resource | Name or ID | Purpose |
| --- | --- | --- |
| API Worker | `camelrun-pilot` | Public API, SDK transport, queue consumer, maintenance |
| Sandbox Worker | `camelrun-pilot-codemode` | One `CodemodeSandbox` SQLite object per session; existing per-VM cap |
| Fake model Worker | `camelrun-pilot-fakemodel` | Deterministic, no upstream model calls |
| Custom domain | `run-pilot.camelai.dev` | `camelai.dev` zone `3180d911f20372a279a4ea408aebc765` |
| Agent objects | `AGENTS` / `CamelAgent` | Durable journal, runs, schedules, human input, hibernatable sockets |
| Tenant objects | `TENANTS` / `TenantAdmission` | Admission and counters |
| Volume objects | `VOLUMES` / `Volume` | Ordered file metadata |
| Hyperdrive | `3e6d68e844ec480589e766119f52dead` | PlanetScale `camelrun-proto`; caching disabled |
| R2 | `camelrun-pilot-files` / `BUCKET` | Files, images, stored derivatives |
| Queue | `camelrun-pilot-delivery` / `WEBHOOKS` | Delivery and retry; consumed by API Worker |
| Images | `IMAGES` | Stored image derivatives |
| Analytics Engine | `camelrun_pilot` / `METRICS` | Runtime metrics |
| Email Sending | `EMAIL` | Sender restricted to `camelrun@staging.camelai.dev` |
| Cron | `*/5 * * * *` | Maintenance and outbox repair |
| Model secret | `PILOT_OPENROUTER_KEY` | Account secret `CAMELRUN_PILOT_OPENROUTER_KEY`, store `c8c66b0210e64900864182073dcd5e09` |

All three Workers enable persistent logs and traces, with query strings redacted.
The API uses Smart Placement. The database origin is PlanetScale in AWS us-east-1;
this does not authorize access to the production camelRun AWS account or database.

From the repository root, install the pinned dependencies if needed, then deploy:

```sh
(cd backends/workers && npm ci)
scripts/pilot-deploy
```

Run heavy dependency installs, typechecking, builds and tests on the Sprites pool.
Wrangler uploads may run on the operator's laptop. The deploy script creates
missing named R2/Queue resources, deploys the sandbox and fake model before the
API, and creates missing signing/encryption secrets without displaying values.
Repeat deploys preserve those secrets and set the measured Hyperdrive limit to
12 connections. `PILOT_ORIGIN_CONNECTION_LIMIT` overrides that value after an
operator reviews database capacity. Never rotate `AGENT_SECRETS_KEY` casually:
it encrypts stored provider credentials. Never put secrets in `vars`.

The platform model secret was created by the CTO on 2026-11-06. Deployments
now require the real Secrets Store binding. No fallback manifest is used.
Cloudflare rejects a binding to a nonexistent secret (error 10182).

## Operator key and model key

Create the account secret yourself; Wrangler prompts privately for its value:

```sh
cd backends/workers
node_modules/.bin/wrangler secrets-store secret create c8c66b0210e64900864182073dcd5e09 \
  --name CAMELRUN_PILOT_OPENROUTER_KEY --scopes workers --remote
cd ../..
scripts/pilot-deploy
node backends/workers/scripts/pilot-admin-key.mjs
```

The secret already exists; skip its creation on repeat deployments. The names-only check is:

```sh
backends/workers/node_modules/.bin/wrangler secrets-store secret list \
  c8c66b0210e64900864182073dcd5e09 --per-page 100 --remote
```

The admin command must run in your interactive terminal. It creates `pilot-admin`
and an API key through the application's tenant/token paths, grants $25 of
internal test credit, deletes its temporary bootstrap Worker, then displays the
key once. It writes no credential to the repository. Store that key in your own
password manager. Running it again does not recover the original key.

The key is a normal tenant API key, with read-only admin visibility via
`ADMIN_TENANTS=pilot-admin`. Tenant provisioning and grants require the short-lived
bootstrap helper, not a permanent public operator endpoint. The helper has an
in-memory bearer credential, a hash in its deployed source, an explicit tenant
allowlist, no request logging, and a one-hour expiry. It is deleted in `finally`.
If interrupted, delete the named `camelrun-pilot-bootstrap-*` Worker.

Example API use (set `PILOT_API_KEY` privately in your shell):

```sh
curl https://run-pilot.camelai.dev/v1/agents \
  -H "Authorization: Bearer $PILOT_API_KEY"
```

## Validation

The baseline remains 519/524 Workers HTTP passes, five reviewed differences,
zero failures, and 66 SDK-only passes. It is a local workerd contract result,
not a deployed-pilot result. See `PARITY.md` and
`tests/contract/accepted-differences.mjs` for the five cases: three ECS-specific
recovery/history checks, V8 versus QuickJS code mode, and ECS load-balancer
keep-alive/drain behavior.

Run disposable deployed validation:

```sh
PILOT_FAKE_URL=https://camelrun-pilot-fakemodel.miguel-85b.workers.dev \
  node --experimental-strip-types backends/workers/scripts/pilot-validate.mjs
# Add --real-model only after the platform secret is bound.
PILOT_FAKE_URL=https://camelrun-pilot-fakemodel.miguel-85b.workers.dev \
  node backends/workers/scripts/pilot-load-run.mjs
```

Workers live streams are WebSocket-only by CTO decision on 2026-11-05. The SDKs'
default capability offer selects a hibernatable WebSocket. A live request without
that capability or a WebSocket upgrade fails with HTTP 406, code
`WEBSOCKET_REQUIRED`, and a message directing the caller to WebSocket. Bounded
JSON event polling remains available. The Node runtime retains SSE, and the SDKs
retain their Node compatibility. The pilot idle check uses the default SDK path.

Twelve exact SSE-dependent cases have been added to the accepted-differences
registry (17 total). They cover direct SSE attachment, CORS content type, HTTP
response-body lifetime instrumentation, SSE proxies and explicit SSE watchers.
SDK-only tests of Node-compatible SSE still run. Shared contract stream helpers
negotiate through the existing SDK without changing assertions; Node still runs
every accepted-difference case.

The load driver leases a Sprite through `scripts/sprite-test`; credentials travel
through stdin and a kernel FIFO, never in command arguments, reports or regular
files. It ramps through 1, 10, 50, 100, 250, 500, 1,000 and 2,000 metered agents,
stops advancing if a stage exceeds 5% errors, and records percentile latency,
throughput and financial state. Override `PILOT_LOAD_STAGES=1,10` for a short probe.
Fake model calls cost no provider money. Custom provider calls settle tenant
active-time charges; enabled end-user metering exercises nonzero reservation and
settlement through Hyperdrive. They do not reserve platform model-token credit.

The first 1/10-agent warmup at the original 20-connection Hyperdrive limit
passed one turn, then completed 8/10 turns (20% errors), and stopped as required.
The error included PostgreSQL `53300` (too many connections). Live origin
inspection found `max_connections=25`, three reserved slots, and 18 application
connections plus Hyperdrive/database-internal connections. The pilot Hyperdrive
limit was lowered to **12**, not raised; caching remains disabled. Raising it
would exceed this database's headroom. Larger capacity needs an independently
reviewed PlanetScale resize. Subsequent results are recorded below.

The image transport now uses the B path for R2-backed image references: request
scoped markers pass through Pi and expand directly into a known-length streamed
model request inside the agent. OpenAI-compatible endpoints (including
OpenRouter), Anthropic and Google use it. Native Bedrock and Workers AI retain
the bounded materialization path. Existing limits remain 40 images and 20 MiB of
base64 image data per model request.

## Verified source checks

- Workers and pilot SDK typechecks pass on Sprites.
- 15 image-stream/fake-provider unit checks pass, including missing objects,
  nonce isolation, bounded chunks, retries, abort and early HTTP failure.
- Eight workerd image/file integration checks pass.
- Five secret/credential policy checks pass.
- Cold-object account deletion and agent spend regression checks pass. A second
  regression covers recovery of an already-revoked, partially purged agent.
- Documentation build and both `llms.txt` checks pass.

## Limits and rollback

Computers, Containers and the PDF parser container are off. No computer provider
credentials or container bindings are provisioned. Channels and voice transport
remain outside this port's parity scope. The fake provider is public and has no
upstream credentials; never use it as a real model proxy.

List versions and roll back API code:

```sh
cd backends/workers
node_modules/.bin/wrangler deployments list -c wrangler.pilot.jsonc
node_modules/.bin/wrangler rollback VERSION_ID -c wrangler.pilot.jsonc
# Repeat with -c codemode/wrangler.pilot.jsonc if the sandbox changed.
```

A code rollback does not roll back Postgres, R2, DO storage, queue messages or
migrations. Keep compatible schemas. Use `scripts/pilot-deploy` to roll forward
from a verified commit. Pilot limits allow 2,100 agents for the bounded load test;
the $100 model-key cap is a separate spend limit, not an API capacity limit.

## Teardown

Stop clients and schedules first. Delete pilot tenants through the application's
account deletion path and wait for `state=deleted`. This revokes keys, deletes
agents, end-user records and user files, and purges DO content. Accounting audit
records are retained by application policy; do not describe them as erased.

After reviewing the names, remove the three pilot Workers, their custom domain,
the `camelrun-pilot-delivery` queue and the `camelrun-pilot-files` bucket. Drain
or delete queue messages and remove bucket objects before deleting the bucket.
Delete only pilot objects from Analytics Engine if supported, or let retention
expire. Delete the pilot model secret only if no longer used. Do not delete the
shared Secrets Store. Hyperdrive and PlanetScale were pre-existing test resources:
remove them only after separately checking they have no remaining users. Never
include AWS or production camelRun resources in teardown.
