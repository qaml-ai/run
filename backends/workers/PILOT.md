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
| Computer objects | `COMPUTER_CONTAINERS` / `ContainerComputer` | One container per agent through `ctx.container` (`durable_object` scheduling policy, `standard-1`); image `workspace` from `computers/Dockerfile` |
| Code-mode binding | `CODEMODE_SANDBOX` | External `CodemodeSandbox` class on `camelrun-pilot-codemode` |
| Sandbox objects | `SANDBOX` / `CodemodeSandbox` | Local binding in the sandbox Worker |
| Static assets | `PUBLIC_ASSETS` | Bundled API documentation and console assets |
| Hyperdrive | `3e6d68e844ec480589e766119f52dead` | PlanetScale `camelrun-proto`; caching disabled |
| R2 | `camelrun-pilot-files` / `BUCKET` | Files, images, stored derivatives |
| Queue | `camelrun-pilot-delivery` / `WEBHOOKS` | Delivery and retry; consumed by API Worker |
| Images | `IMAGES` | Stored image derivatives |
| Analytics Engine | `camelrun_pilot` / `METRICS` | Runtime metrics |
| Email Sending | `EMAIL` | Sender restricted to `camelrun@staging.camelai.dev` |
| Cron | `*/5 * * * *` | Maintenance and outbox repair |
| Inbox cron (configured for the next deploy) | `* * * * *` | Reconcile at most 100 stale human-input mirrors; other maintenance stays on the five-minute cron |
| Model secret | `PILOT_OPENROUTER_KEY` | Account secret `CAMELRUN_PILOT_OPENROUTER_KEY`, store `c8c66b0210e64900864182073dcd5e09` |
| Runtime secrets | `API_TOKEN`, `FILE_SIGNING_SECRET`, `AGENT_SECRETS_KEY` | Stable authentication, signing and encryption keys; values never displayed |

The verified API version is `e19b0ab2-743b-4f63-80ca-3998c1deda77`.
The sandbox version is `23b3d532-733f-4637-9456-a1ccc0f0a3d1`; the fake
provider version is `da870c3e-d37c-4fcb-a787-b9ae9c81e17e`.

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
Wrangler uploads may run on the operator's laptop.

The deploy script first brings the pilot Postgres up to the checkout's
`migrations/`, before any Worker is deployed. It lists the pending migrations,
then applies them through a short-lived Worker (`scripts/pilot-migrate.mjs`)
whose only binding is the pilot Hyperdrive. That Worker runs
`scripts/migrate.mjs` (the same `schema_migrations` bookkeeping as the
template-database tests) over the SQL files bundled into it. Its bearer stays in
the deploying process's memory; the Worker holds only its hash, expires after
one hour and is deleted in `finally`. No database password is handled. It
returns only migration names (and, on a failure, the failing name and its
SQLSTATE). A failed migration is rolled back and stops the deploy.

Migrations are tracked by file name only; no checksum is kept. Never edit a
migration after it is merged: add a new one. The script refuses to migrate or
deploy when the database has applied a name this checkout lacks, that is, when
it is ahead of the commit being deployed or a file was renamed. Keep migrations
additive, so the running version keeps working on the new schema until its
replacement is live.

```sh
scripts/pilot-deploy --dry-run           # list pending migrations; change nothing
scripts/pilot-deploy --migrations-only   # apply pending migrations; deploy no Worker
```

The deploy script then creates
missing named R2/Queue resources, deploys the sandbox and fake model before the
API, and creates missing signing/encryption secrets without displaying values.
Repeat deploys preserve those secrets and set the measured Hyperdrive limit to
16 connections. `PILOT_ORIGIN_CONNECTION_LIMIT` overrides that value after an
operator reviews database capacity. Never rotate `AGENT_SECRETS_KEY` casually:
it encrypts stored provider credentials. Never put secrets in `vars`.

The CTO subsequently approved a larger pilot database and a 100-connection
Hyperdrive origin limit, as measured below. An approved redeploy must set
`PILOT_ORIGIN_CONNECTION_LIMIT=100` to preserve that setting; the script's
default remains 16. The larger-database measurement did not redeploy the API.

The platform model secret was created by the CTO on 2026-11-06. Deployments
now require the real Secrets Store binding. No fallback manifest is used.
Cloudflare rejects a binding to a nonexistent secret (error 10182).

## Operator key and model key

The secret already exists. For a fresh setup, create it yourself; Wrangler
prompts privately for its value in the pinned pilot account:

```sh
cd backends/workers
node_modules/.bin/wrangler secrets-store secret create c8c66b0210e64900864182073dcd5e09 -c wrangler.pilot.jsonc \
  --name CAMELRUN_PILOT_OPENROUTER_KEY --scopes workers --remote
cd ../..
scripts/pilot-deploy
node backends/workers/scripts/pilot-admin-key.mjs
```

The secret already exists; skip its creation on repeat deployments. The names-only check is:

```sh
backends/workers/node_modules/.bin/wrangler secrets-store secret list \
  c8c66b0210e64900864182073dcd5e09 -c backends/workers/wrangler.pilot.jsonc --per-page 100 --remote
```

The admin command must run in your interactive terminal. It creates `pilot-admin`
and an API key through the application's tenant/token paths, grants $25 of
internal test credit, deletes its temporary bootstrap Worker, then displays the
key once. It writes no credential to the repository. Store that key in your own
password manager. Running it again mints a fresh key for the existing tenant;
it does not recover or revoke older keys. The initial credit grant is
idempotent. If the grant fails, the script revokes its unreported new key and
keeps the tenant so a later run can retry.

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

Modal was dropped from the Workers computer providers by CTO decision. New
Modal connections and stored Modal connections cannot invoke a provider gateway.
The Node runtime's provider list is unchanged.

The hardening comparison before the scaling work passed **507/524 Workers HTTP
cases**, with **17 accepted differences, 66 SDK-only passes and zero failures**. Node passed all
524 HTTP and 66 SDK-only cases, including the original assertions for every
accepted difference. These are local workerd/Node contract results on Sprites;
deployed-pilot results follow below. `PARITY.md` records the exact tested
revisions and later helper-only validation.

The starting baseline was 519/524 Workers HTTP passes and five differences:
three ECS-specific recovery/history checks, V8 versus QuickJS code mode, and
ECS load-balancer keep-alive/drain behavior. Twelve exact SSE cases were added
by the CTO decision. See `tests/contract/accepted-differences.mjs`.

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

Workers live streams prefer the hibernatable WebSocket: the SDKs' default
capability offer selects one. A client that asks for SSE (no capability offer, no
upgrade) gets SSE from the stateless front Worker, which opens the same
hibernatable WebSocket to the agent's Durable Object and writes each frame as an
SSE event (`src/sse-bridge.ts`), with Node's ids, `Last-Event-ID` resume,
a heartbeat comment every 10 s, and a `reconnect` frame after 5 idle minutes.
The object never holds an SSE response, so it still hibernates while idle; the
Worker is billed CPU, not wall time (`measurements/sse-bridge.json`). Bounded
JSON event polling remains available.
MCP retains its specification-defined SSE transport. Its stateless endpoint
returns HTTP 405 for a standalone GET, so there is no idle listening stream;
an active POST response stream ends with the call.

The real-model check submits one run with `gpt-4o-mini` and a 16-token output
limit. It records API usage, cost in USD, and durable model-attempt counters
before deleting the throwaway tenant. Do not manually retry a failed real call:
inspect those counters first, since the runtime can retry upstream requests.

The twelve SSE-dependent cases once registered as accepted differences (direct
SSE attachment, CORS content type, SSE proxies and explicit SSE watchers) pass
on Workers through the bridge; five accepted differences remain.

The final deployed fake-provider smoke passed **10/10** checks on
2026-11-06: TypeScript create/message/history and WebSocket streaming, human
input, schedule alarms, files, image streaming, code mode, delegation, Python
message/stream/history, and the default SDK idle connection. Separate public
probes confirmed agent SSE watch fails with HTTP 406 and `WEBSOCKET_REQUIRED`,
and standalone MCP GET fails with HTTP 405. The connection stayed open for
180,002 ms with no frames and received a wake turn over the same socket.
Cloudflare reported **0 GB-s** of duration and no activity in both complete
idle minutes, 02:49 and 02:50 UTC. Nonzero 02:48 and 02:51 buckets bracket the
idle interval and confirm ingestion; their whole durations are not attributed
to idle. See `measurements/pilot-smoke.json` and `pilot-hibernation.json` for the
exact object ID, interval and metrics.

That run made 15 settled synthetic model attempts, with no provider charge and
$0.000123 of tenant active-time charges. Its temporary tenant, agent rows, API
keys, providers, volumes and outstanding holds were removed; accounting audit
records remain. A separate live browser-token check reached clean stream EOF
after 4.876 seconds for a five-second token and then received HTTP 401 on a
protected read. It made no model calls and cleaned up its tenant.

The single real-model check also passed: `openrouter/openai/gpt-4o-mini`,
7.237 seconds, 167 input tokens and four output tokens. It submitted one run
and recorded exactly one settled model attempt, with no retry or pending hold.
The API reported $0.00002745 of model usage and a 29-microdollar platform-model
charge; the total tenant debit, including active time, was $0.000042. Its tenant
and key were revoked and deleted afterward. See `measurements/pilot-real-model.json`
and `pilot-browser-expiry.json` for the recorded evidence.

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
the stage, 249/250 model attempts were settled, with one still pending. Those
settlement counts do not imply 83 backend execution failures.
The peak was 240 simultaneous end-user credit holds, proving actual concurrent
reserves through Hyperdrive. Cumulative tenant active-time charges before
cleanup were $0.057711; this is neither a provider charge nor a Cloudflare
invoice. The original cleanup hit the 30-second post-response lifetime of
background work. A scoped foreground operator recovered it: all 20 tenants,
2,000 agents, volumes, end users, provider settings and API keys were removed,
with no credit holds remaining. See `measurements/pilot-load-full-recovery.json`.
That repeat used the foreground path directly. The scaling change below replaces
it with durable Queue passes and status polling.

One zero-charge accounting audit from the original ramp remains pending. It has
no end-user hold or customer context. The normal five-minute Cron reconciler
marks stale custom-provider attempts settled without a provider lookup or a
live tenant; its default stale threshold is two hours and two minutes. This
record was not manually settled. See `measurements/pilot-load-pending-audit.json`.

During the 250-turn stage, the IAD Hyperdrive pool had two connections, averaged
96.9 waiting clients and peaked at 157. Completed uncached queries averaged
1,094 ms connection latency and 1,099 ms query latency. Transactions averaged
3,599 ms connection latency and 4 ms query latency. This supports the diagnosis
of pool saturation. That window recorded no Durable
Object CPU-limit, memory-limit or fatal internal errors. Logs also showed long
`camel-wake` dispatch warnings, so pool saturation is not assumed to explain
every timeout.
See `measurements/pilot-load-telemetry.json`.

The bounded repeat at **16 connections** used the same 20-tenant distribution,
15-second fake-model delay and 40-second status-read timeout. At 250 concurrent
turns, 239 completed successfully and 11 failed (4.4%): eight model failures
classified by runtime telemetry as `other`, two HTTP 503 status reads classified
as timeouts, and one unclassified HTTP 500 status read. No client timeout was
recorded. Throughput was **3.325 turns/second**; completed-turn p50/p95/p99 were
**69.632/70.914/71.088 seconds**. All 250 end-user holds overlapped and all 250
attempts settled. This is below the stop threshold but is not an error-free
250-turn result. Higher stages were not repeated; the highest observed
zero-error concurrency remains 100.

The retuned IAD pool used three connections, averaged 81.56 waiting clients and
peaked at 150. Completed uncached queries averaged 610 ms connection latency
and 614 ms query latency; transactions averaged 2,413 ms and 4 ms respectively.
No Hyperdrive error-status query group was returned. Durable Object invocation
telemetry recorded 3,743 successes and 54 `clientDisconnected` results in this
window. These disconnections are not a count of failed turns. See
`measurements/pilot-load-hd16-telemetry.json`.

The repeat's foreground cleanup removed all 20 tenants and 250 agents, verified
all 20 credentials rejected with HTTP 401, and left no user data, holds or pending
attempts. Its tenant active-time charge was $0.033961. The two main load runs
therefore charged $0.091672 of synthetic tenant credit; fake-provider cost was
zero. See `measurements/pilot-load-hd16-retry.json` and
`measurements/pilot-load-hd16-application-errors.json`. These internal charges
are separate from Cloudflare spend.

The image transport now uses the B path for R2-backed image references: request
scoped markers pass through Pi and expand directly into a known-length streamed
model request inside the agent. OpenAI-compatible endpoints (including
OpenRouter), Anthropic and Google use it. Native Bedrock and Workers AI retain
the bounded materialization path. Existing limits remain 40 images and 20 MiB of
base64 image data per model request.

## Observed cost

For 01:35–03:04 UTC on 2026-11-06, the recorded pilot meters have an approximate
**$0.80 linear value at paid overage rates**, before included allowances and
billable-unit rounding. This is an estimate, not an invoice: the billing API
rejects this OAuth token. The largest components are 640,818 SQLite row writes
($0.641) and 9,811.12 Durable Object GB-s ($0.123). The estimate also includes
SQLite reads, available DO request counts, the three Workers' requests and CPU,
and a conservative value for all returned observability events. The complete
four-namespace duration metrics report zero CPU-limit, memory-limit and fatal
internal errors.

Volume-namespace request telemetry was rate limited. Temporary bootstrap
Workers, R2, Images, Queue, Analytics Engine, storage and existing plan charges
are not itemized. Included account allowances may absorb these meters; invoice
rounding and shared-account allocation prevent deriving an exact incremental
bill here. See `measurements/pilot-cost.json` and Cloudflare's
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
and [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
Fake-model provider cost was zero. The one real-model call reported $0.00002745
of model usage; its total internal tenant debit was $0.000042.

## Verified source checks

- Workers and pilot SDK typechecks pass on Sprites.
- 15 image-stream/fake-provider unit checks pass, including missing objects,
  nonce isolation, bounded chunks, retries, abort and early HTTP failure.
- Eight workerd image/file integration checks pass.
- Five secret/credential policy checks pass.
- Cold-object account deletion and agent spend regression checks pass. A second
  regression covers recovery of an already-revoked, partially purged agent.
- Documentation build and both `llms.txt` checks pass.

## Database scaling measurements

The scaling branch profiles PostgreSQL calls with `PILOT_DB_PROFILE=1`. Each
`pg.query` invocation counts once, including transaction control and failed
statements. Transaction hold time runs from the successful `BEGIN` response to
the `COMMIT` or `ROLLBACK` response. Connection acquisition is measured separately.
The profile contains counts, durations and allowlisted schema labels, never query
text, parameters or credentials. The switch is enabled only in the pilot config.
[`turn-db-profile.json`](https://github.com/qaml-ai/run/blob/962e764c37f25477aedea47b21ed09fc6242f914/backends/workers/measurements/turn-db-profile.json) (archived) records the phase
breakdown and limitations.

Credit settlement still runs in PostgreSQL transactions. The changes combine
credit-room reads, reuse an already locked end-user row while repeating expiry
after hold release, reuse the same daily totals for notices, and return a newly
inserted attempt's identity without a second read. Duplicate attempts still read
and validate the existing identity. Ledger writes, lot allocation, expiry,
idempotency and attribution remain in the same transaction. Webhook intents are
batched into the durable outbox and its delivery scan uses one statement.
Credit leasing was not introduced: PostgreSQL still owns every reservation and
charge. The 15-second fake turns already require no hold-renewal queries.

Active turns retain a one-second durable watchdog. A live object that still owns
its result waiters checks live limits (up to three PostgreSQL reads per tick)
without repeating computer cleanup and the rest of the maintenance scan. Real
deadlines, a cold start, lost waiters, delegation, notifications and cancellation
still take the full recovery path. Plan generation checks prevent an older
asynchronous planner from replacing a newer deadline. Deleted agents continue
retrying unacknowledged financial receipts.

Account deletion now uses the existing delivery Queue. The request persists its
intent and enqueues work before returning HTTP 202. Each consumer pass revokes
up to 25 live agents and purges up to 25 revoked journals. It enqueues the next
pass before acknowledging the current message. PostgreSQL leases serialize
duplicate deliveries; the five-minute
Cron repairs a lost enqueue or exhausted delivery retries. Accounting records
remain retained. A workerd test created 2,001 agents through the API, interrupted
the process during deletion, and verified all agents removed across 81 persisted
passes, with the original balance and ledger preserved and the token rejected.
The deletion portion took 531.905 seconds on the Sprite test database.
The Queue delivers one message per invocation, so independent accounts do not
wait behind a batch of long deletion passes. This setting was reduced from ten
after the first optimized load stages. The final repeat used one message per
invocation throughout.

The load orchestrator pins both the temporary operator helper and the Sprite
runner to one commit. Its temporary checkout contains source and dependency
links; credentials still travel only through the pipe and kernel FIFO. Cleanup
posts one deletion request, polls its durable status and checks token revocation.

The comparison uses 20 tenants, the same 15-second fake model and the same load
runner at 100, 250 and 500 concurrent turns. All measured stages used a Hyperdrive
origin limit of 16 and a database with 25 connection slots. The baseline API
revision is `247cc940`; the final optimized revision is `76f56096`, including
the merged hardening modules. It was deployed once at 04:55 UTC, after the
earlier load's cleanup removed all 20 accounts and 500 agents. Neither AWS nor
the production runtime was changed. The first optimized sample at `f5dac260`
is archived in [`turn-db-after-initial-load.json`](https://github.com/qaml-ai/run/blob/962e764c37f25477aedea47b21ed09fc6242f914/backends/workers/measurements/turn-db-after-initial-load.json).

| Concurrent turns | Version | Client errors | Successful turns/s | p50 / p95 / p99 |
| --- | --- | --- | --- | --- |
| 100 | Before | 0/100 | 2.607 | 36.436 / 37.712 / 37.869 s |
| 100 | After | 0/100 | 2.808 | 32.378 / 34.233 / 34.725 s |
| 250 | Before | 2/250 (0.8%) | 3.598 | 65.368 / 66.717 / 66.921 s |
| 250 | After | 1/250 (0.4%) | 4.131 | 55.469 / 58.412 / 58.774 s |
| 500 | Before | 313/500 (62.6%) | 1.331 | 115.439 / 120.151 / 121.184 s |
| 500 | After | 280/500 (56.0%) | 2.036 | 92.735 / 103.700 / 105.272 s |

Latencies include the fake model delay and describe observed completed turns.
Client failures do not imply the same number of failed model attempts. All
281 final client errors were timeouts; there were no HTTP 500 or 503 responses.
The final 500-turn window created 500 model-attempt records and observed 499 settle,
about 4.62 settlements per second, with one financial tail still pending at the
snapshot. That is separate from successful-client throughput. The raw reports
retain admission, HTTP-error and financial counters. A scoped check at
05:03:21 UTC found all 850 attempts settled and no remaining credit holds.
Durable cleanup completed at 05:13:35 UTC. An independent check at 05:13:58
confirmed all 20 accounts deleted and no remaining agents, volumes, end users,
API tokens, deletion claims, pending attempts or credit holds. Retained
accounting records still contain all 850 settled attempts and the original
ledger totals. See `measurements/turn-db-after-cleanup.json`.

For this scaling run, Cloudflare meters from 03:30 through 05:14:30 UTC have a
linear value of about $1.17 at paid overage rates. Rounding each measured meter
up to its billing unit and adding a $2 reserve gives a conservative $15.98
budget scenario, below the $30 task limit. This is not an invoice or a guaranteed
upper bound: included allowances, shared-account allocation, unitemized services
and billing rounding affect the charge. See
`measurements/turn-db-cost-telemetry.json`.

The 100-turn samples had no detected object recreation. Observed PostgreSQL
round trips per requested turn fell **24.13%**, from **288.97 to 219.23**:

| Phase | Before | After |
| --- | ---: | ---: |
| Admission | 26.00 | 24.00 |
| Hold | 14.00 | 12.00 |
| Renew | 0 | 0 |
| Settle | 47.70 | 36.38 |
| Usage | 3.00 | 3.00 |
| Webhooks | 14.32 | 7.23 |
| History | 0 | 0 |
| Other, including live limit checks | 175.10 | 129.45 |
| Public API authentication and lookup | 8.85 | 7.17 |

The complete 100-turn samples' transaction hold p95 values were:

| Transaction phase | Before | After |
| --- | ---: | ---: |
| Admission | 100 ms | 99 ms |
| Hold | 427 ms | 382 ms |
| Settle | 1,146 ms | 944 ms |
| Other | 107 ms | 101 ms |

The runner does not request history; Workers history uses DO SQLite. The baseline
500-turn profile lost counters when 499 objects were recreated. The optimized
250-turn profile detected one recreation, and its 500-turn snapshot still had
one pending attempt. Those profiles are partial. Counts are observed query
dispatches, not a proof that every operation completed inside the snapshot:
in-flight SQL can also understate the recorded timing at reset boundaries.

The largest remaining group is live limits: each tick verifies ownership,
refreshes the agent spend counter and reads tenant caps. Financial writes remain
in PostgreSQL. The measured IAD Hyperdrive pool had three connections despite
the configured global limit of 16. The results still reject 500 concurrent turns
on this database.

For a next CTO-approved capacity trial, about 64 origin connections backed by
80–100 database slots is a reasonable starting point. That is a rough fourfold
capacity hypothesis for the 250-turn load. At 500 concurrent turns, matching the
15-second fake-model delay requires 33.3 turns/s, about eight times the measured
peak client throughput. If scaling were linear, that suggests roughly 128
origin connections and 160–200 database slots for that target. Neither estimate is a measured
guarantee: regional pool allocation, query cost, locking and database CPU need
validation. The initial run did not resize the database or change the origin
limit. After its cleanup, the CTO started a separate upgrade from PS-5 to PS-80
ARM single-node (one vCPU, 8 GB). The completed upgrade and follow-up are recorded
below; they do not change the conditions of the initial comparison.

### Bigger database

After the CTO completed the upgrade, the follow-up used PS-80 ARM single-node
(one vCPU, 8 GB), `max_connections=150` and Hyperdrive origin limit 100 with
caching disabled. The API stayed on `76f56096`, version
`e19b0ab2-743b-4f63-80ca-3998c1deda77`; no API redeploy was needed. The runner
and temporary operator used `18daa03f`. The workload still used 20 accounts,
the 15-second fake model and simultaneous admission of every turn in a stage.

The runner gained an opt-in stop when actual errors exceed 5%. It aborts
unfinished and late-accepted turns, records harness cancellations separately,
and marks stopped-stage timing as censored. All three stages stayed below that
threshold, so no early stop or harness cancellation occurred. Three focused
runner tests passed on a Sprite, including the stop boundary, late admission,
body-read cancellation and durable cleanup. Five-second target connection
sampling added two observer SQL statements per sample; the recorded intervals
include observer latency.

| Concurrent turns | Client errors | Successful turns/s | p50 / p95 / p99 |
| --- | --- | --- | --- |
| 250 | 0/250 | 8.356 | 26.714 / 28.173 / 28.805 s |
| 500 | 0/500 | 12.554 | 35.114 / 37.143 / 38.092 s |
| 1,000 | 5/1,000 (0.5%) | 16.020 | 55.335 / 61.016 / 61.418 s |

The five errors were client timeouts. All 1,750 model attempts settled with no
pending attempts or credit holds after the stages. The 250- and 500-turn
profiles were complete, at 216.532 and 213.878 PostgreSQL queries per turn.
The 1,000-turn profile detected 135 object recreations and is a lower bound.
Observed client latency and throughput do not depend on those profile counters.

All 1,000 prompts were accepted, so the five timeouts occurred during the
40-second status-poll requests. They did not leave five unfinished model turns.
PostgreSQL samples peaked at 102 client backends against the 150-connection
setting in every stage. Active-backend peaks were 73, 63 and 73; idle-in-transaction
peaks were 20, 67 and 75. These peaks occurred in different samples and must not
be added together. Application names can survive Hyperdrive connection reuse,
so they do not identify which pool owns a backend.

The settled Hyperdrive aggregates for the exact stage windows were:

| Concurrent turns | IAD waiting clients, average / maximum | Maximum IAD pool |
| --- | --- | --- |
| 250 | 16.67 / 106 | 20 |
| 500 | 75.00 / 268 | 20 |
| 1,000 | 241.50 / 287 | 20 |

The 1,000-turn window averaged zero available IAD slots. These are sampled
regional aggregates, not a complete per-second series. The global origin limit
of 100 does not mean 100 connections were available to this regional pool.

The coordinator's PlanetScale export reports primary CPU samples of 15.85%,
23.02%, 92.65% and 100% for the 05:28, 05:29, 05:30 and 05:31 UTC minute bins.
The exact stage windows were 05:28:48.676–05:29:18.594 for 250,
05:29:25.870–05:30:05.699 for 500 and 05:30:20.076–05:31:22.187 for 1,000.
These one-minute bins overlap adjacent stages, profiling and cleanup; they
are not exclusive stage averages or instantaneous peaks. The queueing and CPU
pressure are consistent with the longer 1,000-turn latency, but do not identify
the cause of each of the five timeouts. The export is retained in
`measurements/planetscale-cpu-bigger-db.json`; aligned metrics and limitations
are in `measurements/turn-db-bigger-telemetry.json`.

Durable cleanup ran from 05:31:30.790 to 05:46:12.762 UTC. The independent
05:46:36.756 check confirmed all 20 benchmark accounts and 1,000 agents removed,
with zero API tokens, providers, volumes, end users, holds, pending attempts or
deletion claims. All 1,750 settled accounting attempts remain. A names-only
check at 05:47:05.932 found no temporary operator helpers and verified the same
API version and Hyperdrive settings. See the archived raw
[`turn-db-ps80-load.json`](https://github.com/qaml-ai/run/blob/962e764c37f25477aedea47b21ed09fc6242f914/backends/workers/measurements/turn-db-ps80-load.json), and
`measurements/turn-db-ps80-profile.json` and `turn-db-ps80-cleanup.json`.

Cloudflare meters for 05:22:22–05:48:00 UTC, including cleanup and helper
removal, have an estimated $0.70 linear value at paid overage rates. Rounding
each measured meter up to its billing unit and adding a $2 reserve gives a
$15.974 budget scenario, below the $20 follow-up limit. This is an estimate,
not an invoice or a guaranteed upper bound. Included allowances, shared-account
allocation and unitemized services still apply. The window recorded zero
Durable Object CPU-limit, memory-limit or fatal errors and zero Worker errors.

### Scaling validation after the harness rebase

The branch was rebased onto `codex/workers-parity` at `9de3ed55`, including
PR #668's fixture startup, Python wheel integrity, cancellation and WebSocket
completion fixes. The modular watchdog, billing and durable deletion changes
were preserved. This validation did not redeploy the pilot or rerun load; the
measurements above still describe the deployed API at `76f56096`.

One full parity invocation ran on six newly created Sprites, with source frozen
at `e6e9a8a7` and automatic retries disabled. It completed in 586.654 seconds:
Node passed 590 cases (524 HTTP and 66 SDK); Workers passed 573 (507 HTTP and
66 SDK), with 17 accepted differences and zero failures. Both reports retain
380 existing scope exclusions. All 12 raw shard reports agree with the
canonical reports. See `PARITY.md` and `measurements/workers-rebase-parity.json`.

The Workers unit suite passed all 518 tests. Ten runner and contract-harness
checks also passed, along with root and Workers typechecking. A workerd
integration case created 2,001 agents and verified deletion across 81 durable
passes after a forced process interruption. Deletion took 502.415 seconds;
the entire case, including setup and creation, took 815.238 seconds. It checked
token revocation, spend-limit removal and unchanged balance and ledger.
The complete integration results are in
`measurements/workers-rebase-suites.json`.

The native Docker computer case had an explicit skip on Sprites at the time,
and forcing it failed on that same assertion on both `e6e9a8a7` and upstream
`9de3ed55` (the Sprites then had no Docker at all: `docker` exited 127). The
Ubuntu Workers integration CI job requires Docker and does not allow a skip.
That Sprite result is not evidence that the native Docker case passed. Since
2026-11-06 the skip is gone: `scripts/sprite-test` sets Docker up on every pool
sprite and the case passes there with `WORKERS_REQUIRE_DOCKER=1`; see
[README.md, "Docker on a sprite"](README.md#docker-on-a-sprite) for what that
takes (runc 1.1, and a sidecar without the kernel's missing `xt_socket`).

The previous full comparison on `76f56096` had 25 Workers failures: three
JavaScript timeouts and 22 Python missing-result or timeout failures. None
recurred after this rebase. The earlier non-reproducing timing probes and
failure classifications remain in `measurements/workers-startup-trace.json`
and `measurements/workers-parity-diagnostics.json`. No competing fixture fix
or weakened assertion was added here.

The broader source suite also reproduced its existing UI gzip budget failure
on base `20443b49`: 9,729 bytes exceeds 9,216. No UI source changed in this work.

## Limits and rollback

The native computer is on: `COMPUTER_CONTAINERS` binds `ContainerComputer`
(migration `v2`), one container per agent that its Durable Object starts, execs
into, snapshots and stops through `ctx.container` under Cloudflare's
`durable_object` scheduling policy. The code picks the image (`COMPUTER_IMAGE`,
the `workspace` entry of the `images` map, which a deploy builds from
`computers/Dockerfile` and pins by digest) and the size (`COMPUTER_INSTANCE`,
`standard-1`) at each start; a container stops after 60 s idle. Agents with code
mode see the `computer` tool; its container time is charged as platform usage
(`computer` kind, `cloudflare/standard-1`, at cost: about $0.038 an hour idle, $0.074 busy).
A deploy needs Docker on the deploying machine. A
new image digest makes earlier snapshots unusable (they are refused, not
restored); snapshots expire 30 days after creation or their latest restore.
Managed computers (`/v1/computers` with runtime credentials), external computer
provider credentials and the PDF parser container stay off. To turn the native
computer off, remove the binding and container entry and add a migration with
`"deleted_classes": ["ContainerComputer"]`. Channels and voice transport
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
no Durable Object bindings, no `containers`, no routes, no cron triggers, and no
queue bindings. Retain their existing migrations (`v1`, and the API's `v2`) and
append these migrations respectively:

```json
{ "tag": "pilot-teardown-v3", "deleted_classes": ["CamelAgent", "TenantAdmission", "Volume", "ContainerComputer"] }
```

```json
{ "tag": "pilot-teardown-v2", "deleted_classes": ["CodemodeSandbox"] }
```

Remove the class exports from those temporary entry points as well. Deploy the
API teardown configuration first: this removes its external binding to
`camelrun-pilot-codemode`. Then deploy the sandbox teardown configuration. These
[deletion migrations](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/)
permanently remove all five namespaces and their stored data. Delete the
computer's container application and its image repository too (`wrangler
containers list`, `wrangler containers delete`, `wrangler containers images
list` and `delete`): computer snapshots are `rootfs-snapshot-*` tags in that
repository and go with it. Verify success
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
