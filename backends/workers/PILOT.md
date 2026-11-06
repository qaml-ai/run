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

The API enables structured runtime logs. Automatic invocation logs and traces
are disabled because Cloudflare does not guarantee redaction of the bearer
credential in a WebSocket subprotocol. The sandbox and fake model Workers enable
logs and traces. Query strings are redacted.
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
16 connections. `PILOT_ORIGIN_CONNECTION_LIMIT` overrides that value after an
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
  PILOT_AGENT_NAMESPACE_ID=b7a05e64caac4a9dbd59df0956a89a5c \
  PILOT_IDLE_MS=180000 \
  node --experimental-strip-types backends/workers/scripts/pilot-validate.mjs
PILOT_FAKE_URL=https://camelrun-pilot-fakemodel.miguel-85b.workers.dev \
  node backends/workers/scripts/pilot-load-run.mjs
# After fake smoke and load results, submit one cheap real-model run.
PILOT_FAKE_URL=https://camelrun-pilot-fakemodel.miguel-85b.workers.dev \
  node --experimental-strip-types backends/workers/scripts/pilot-validate.mjs --real-model-only
```

Workers live streams are WebSocket-only by CTO decision on 2026-11-05. The SDKs'
default capability offer selects a hibernatable WebSocket. A live request without
that capability or a WebSocket upgrade fails with HTTP 406, code
`WEBSOCKET_REQUIRED`, and a message directing the caller to WebSocket. Bounded
JSON event polling remains available. The Node runtime retains SSE, and the SDKs
retain their Node compatibility. The pilot idle check uses the default SDK path.
MCP retains its specification-defined SSE transport. Its stateless endpoint
returns HTTP 405 for a standalone GET, so there is no idle listening stream;
an active POST response stream ends with the call.

The real-model check submits one run with `gpt-4o-mini` and a 16-token output
limit. It records API usage, cost in USD, and durable model-attempt counters
before deleting the throwaway tenant. Do not manually retry a failed real call:
inspect those counters first, since the runtime can retry upstream requests.

Twelve exact SSE-dependent cases have been added to the accepted-differences
registry (17 total). They cover direct SSE attachment, CORS content type, HTTP
response-body lifetime instrumentation, SSE proxies and explicit SSE watchers.
SDK-only tests of Node-compatible SSE still run. Shared contract stream helpers
negotiate through the existing SDK without changing assertions; Node still runs
every accepted-difference case.

The first complete deployed fake-provider smoke passed **10/10** checks on
2026-11-06: TypeScript create/message/history and WebSocket streaming, human
input, schedule alarms, files, image streaming, code mode, delegation, Python
message/stream/history, and the default SDK idle connection. Separate public
probes confirmed agent SSE watch fails with HTTP 406 and `WEBSOCKET_REQUIRED`,
and standalone MCP GET fails with HTTP 405. The connection stayed open for
90,001 ms with no frames and received a wake turn over the same socket.
This establishes behavior; it does not isolate billed duration from Cloudflare's
minute buckets. The final repeat uses 180 seconds to include complete idle
minutes. See `measurements/pilot-smoke-90s.json` for the first run and object ID.

That run made 15 settled synthetic model attempts, with no provider charge and
$0.000147 of tenant active-time charges. Its temporary tenant, agent rows, API
keys, providers, volumes and outstanding holds were removed; accounting audit
records remain. Final deployment verification and the single real-model call
are pending the remaining transport fixes.

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
limit was initially lowered to **12**; caching remains disabled. After the load
test demonstrated a saturated regional pool, it was raised to **16** and
verified live. Returning to 20 would leave too little room for the database's
other connections. Review origin capacity before any further increase.

At the 12-connection limit after the pool fixes, all **2,000 agents were created**, and the
1-, 10-, 50- and 100-concurrent-turn stages completed without errors. The
250-turn stage crossed the 5% stop threshold, so the 500-, 1,000- and 2,000-turn
stages were not run. This proves provisioning at 2,000 agents and an error-free
100-concurrent-turn sample; it does not prove 2,000 concurrent turns.

| Concurrent turns | Observed completed | Errors | Turns/second | p50 / p95 / p99 |
| --- | --- | --- | --- | --- |
| 1 | 1 | 0 | 0.04349 | 21.711 / 21.711 / 21.711 s |
| 10 | 10 | 0 | 0.37023 | 24.328 / 25.279 / 25.279 s |
| 50 | 50 | 0 | 1.423 | 32.70 / 33.55 / 33.69 s |
| 100 | 100 | 0 | 2.062 | 46.41 / 47.56 / 47.71 s |
| 250 | 167 | 83 (33.2%) | 1.690 | 94.46 / 96.07 / 96.92 s |

The fake provider adds a fixed 15-second delay; these latencies include it and
the client round trips. Percentiles describe observed completed turns. At 250,
all prompts were accepted (p95 acceptance 16.73 seconds). There were 79 client
status-read timeouts at 40 seconds and four HTTP 500 responses. By the end of
the stage, 249/250 model attempts were settled, with one still pending. Client
observation failures therefore exceed the number of failed backend turns.
The peak was 240 simultaneous end-user credit holds, proving actual concurrent
reserves through Hyperdrive. Cumulative tenant active-time charges before
cleanup were $0.057711; this is neither a provider charge nor a Cloudflare
invoice. Final cleanup of the 20 load tenants is pending.

During the 250-turn stage, the IAD Hyperdrive pool had two connections, averaged
96.9 waiting clients and peaked at 157. Completed uncached queries averaged
1,094 ms waiting for a connection versus about 4 ms of query execution; this
supports the diagnosis of pool saturation. That window recorded no Durable
Object CPU-limit, memory-limit or fatal internal errors. Logs also showed long
`camel-wake` dispatch warnings, so pool saturation is not assumed to explain
every timeout. The 16-connection setting has not passed a repeat of this ramp.
See `measurements/pilot-load-telemetry.json`.

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

Deleting a Worker alone does not delete its Durable Object storage. Before
deleting the Workers, remove any temporary `camelrun-pilot-bootstrap-*` Workers
and any other external bindings to the pilot's classes. Prepare temporary copies
of the API and sandbox Wrangler configurations with a no-op Worker entry point,
no Durable Object bindings, no routes, no cron triggers, and no queue bindings.
Retain their existing `v1` migrations and append these migrations respectively:

```json
{ "tag": "pilot-teardown-v2", "deleted_classes": ["CamelAgent", "TenantAdmission", "Volume"] }
```

```json
{ "tag": "pilot-teardown-v2", "deleted_classes": ["CodemodeSandbox"] }
```

Remove the class exports from those temporary entry points as well. Deploy the
API teardown configuration first: this removes its external binding to
`camelrun-pilot-codemode`. Then deploy the sandbox teardown configuration. These
[deletion migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)
permanently remove all four namespaces and their stored data. Verify success
before deleting either Worker. Do not run `scripts/pilot-deploy` afterward;
the original configuration is for an active pilot, not a retired deployment.

For temporary config copies saved beside the original files, run from the repo
root after reviewing their contents:

```sh
backends/workers/node_modules/.bin/wrangler deploy -c backends/workers/wrangler.pilot-teardown.jsonc
backends/workers/node_modules/.bin/wrangler deploy -c backends/workers/codemode/wrangler.pilot-teardown.jsonc
backends/workers/node_modules/.bin/wrangler delete camelrun-pilot -c backends/workers/wrangler.pilot-teardown.jsonc
backends/workers/node_modules/.bin/wrangler delete camelrun-pilot-codemode -c backends/workers/codemode/wrangler.pilot-teardown.jsonc
backends/workers/node_modules/.bin/wrangler delete camelrun-pilot-fakemodel -c backends/workers/pilot-fakemodel/wrangler.jsonc
backends/workers/node_modules/.bin/wrangler queues delete camelrun-pilot-delivery -c backends/workers/wrangler.pilot-teardown.jsonc
backends/workers/node_modules/.bin/wrangler r2 bucket delete camelrun-pilot-files -c backends/workers/wrangler.pilot-teardown.jsonc
```

Verify the `run-pilot.camelai.dev` custom domain and its DNS record are removed
in the Cloudflare dashboard. Drain or purge the queue first. Empty the R2 bucket
before its deletion command, using the dashboard's **Empty bucket** action or
the S3 API with the operator's existing R2 authentication; the command refuses a
nonempty bucket. Remove the temporary config copies and entry points afterward.
Delete only pilot objects from Analytics Engine if supported, or let retention
expire. Delete the pilot model secret only if no longer used. Do not delete the
shared Secrets Store. Hyperdrive and PlanetScale were pre-existing test resources:
remove them only after separately checking they have no remaining users. Never
include AWS or production camelRun resources in teardown.
