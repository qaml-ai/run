# Agent runtime

A hosted runtime for long-lived agents. Applications define tools in their own
code with the TypeScript or Python SDK; the runtime runs the model loop, keeps
each agent's durable history (with compaction), and executes model-written code
in a QuickJS/WebAssembly sandbox. Most agents are asleep at any time: an agent's
state lives in Postgres and shared storage (S3 in production), and any node can
load it.

Live at <https://agents.camelai.dev> (REST API under `/v1`, described by
`/v1/openapi.json` and the committed `openapi.json`; console at `/console`).

```text
app (TypeScript / Python SDK, HTTP + SSE)
  -> any runtime node --forwarded to--> the node that owns the agent
      -> agent host (Pi loop, working-set transcript, compaction, retries)
          -> QuickJS/WASM sandbox (a fresh instance per execution, on a pool of worker threads)
              -> JSON tool calls -> back to the app's SDK callbacks
  control plane: Postgres (ownership, headers, accounts, schedules, channels, volume metadata)
  data plane: Storage (append logs and blobs, S3 in production)
```

## Layout

- `src/` server, supervisor, agent host, sessions, scheduler, REST API, sandbox
- `migrations/` Postgres schema, applied at startup
- `shared/` storage backends (file, S3), wire protocol
- `clients/` TypeScript and Python SDKs; `sdk/` publishes `@camelai/agent-runtime`
- `console/` tenant console (React); `studio/` local chat/trace UI
- `infra/` AWS provisioning and deploy scripts; `deploy/smoke.ts` live smoke test
- `tests/` Node test suites (no paid model calls)

## Develop

Requires Node 22.21+, npm and Postgres 14+. The tests expect a disposable
database at `postgres://postgres:test@127.0.0.1:55432/postgres` (override with
`AGENT_TEST_DATABASE_URL`); each test gets its own schema, dropped afterwards:

```sh
docker run -d --name agent-runtime-pg -e POSTGRES_PASSWORD=test -p 127.0.0.1:55432:5432 postgres:16-alpine
```

```sh
npm ci
npm run typecheck
npm test                         # agents in their own processes
AGENT_HOSTING=inline npm test    # agents inline in the server process
npm run test:python              # needs clients/python/requirements.txt
npm run demo                     # sandbox demo, no model credentials
npm run openapi                  # regenerate openapi.json after changing /v1 routes
```

The storage tests also run against S3 with `AGENT_TEST_S3_BUCKET=<bucket>`.
`npm run studio` and `npm run demo:clients` need `AGENT_DATABASE_URL`.

## Architecture

Postgres is the control plane: every piece of small mutable state and all
coordination. Storage is the data plane: bulk data that is appended or written
once. The runtime does not start without a database.

| Postgres (`migrations/`) | Storage (`AGENT_STORAGE`) |
| --- | --- |
| node heartbeats and actor ownership | agent transcripts and request journals (append logs) |
| the recent records of each append log (`log_records`) | |
| agent headers: identity, configuration, mounts; the tenant index | volume trees (append logs) |
| console tenants, sealed provider keys, API tokens, usage | volume chunks and snapshot file maps (blobs, written once) |
| agent definitions (tool credentials sealed) | |
| schedules and their claims | |
| channels, conversations, the outbox, dedupe markers, rate counters | |
| volume headers, snapshots, watchers | |

Migrations are plain SQL files, applied at startup in one transaction under an
advisory lock and recorded in `schema_migrations`, so nodes may start together.
Application times (`createdAt`, `dueAt`, `expiresAt`) are bigint milliseconds;
heartbeats and claims use `timestamptz` on the database clock.

**Ownership.** An agent or volume is an actor, served by one node at a time.
Each node keeps one heartbeat row (`runtime_nodes`: node, session, expiry) and
renews it every sixth of `AGENT_LEASE_TTL_MS` with `now()` (every thirtieth
while renewal fails): one write per node,
however many actors it serves. Each actor has one `actor_owners` row naming a
node's session and an epoch. A node takes an actor in one statement that
succeeds only when the row is released, already names this session, or names a
session whose heartbeat has expired; every acquire advances the epoch. Header
and log writes are conditional on the writer's session and epoch, so a node
that lost an actor cannot write for it. A node
that cannot renew fences itself before its published expiry: it stops every
agent and volume it owns and rejoins under a new session. Requests for an actor
are forwarded to the node that `actor_owners` joined to live heartbeats names.

**Logs.** Journals, transcripts and volume trees are append logs: immutable
segment objects in Storage (`<key>.log/<seq>`, and `snapshot-<seq>` after a
fold) plus a hot tail of rows in `log_records`, since an object write per
durable flush would be most of what the runtime costs. A durable flush is one
multi-row insert, fenced in the statement: it locks the actor's `actor_owners`
row (`FOR SHARE`) and inserts only while that row names the writer's session and
epoch, so a takeover waits for an insert in flight and a stale owner inserts
nothing and fences itself. A record over 64 KiB is stored as a content-addressed
blob beside the segments and the row points to it. Compaction moves the tail into
one segment, or one snapshot if a fold is among the rows: when the actor unloads
(idle, drain, retirement, a stopped agent) and when the tail passes 512 records
or 4 MiB. It holds the ownership lock and a per-log advisory lock throughout,
writes the object, then deletes the rows it covers in the same transaction.
Readers take the tail first, then Storage, then only rows above the highest
sequence Storage covers, so a crash between the object write and the delete
repeats nothing, and a compaction between the two reads loses nothing. A turn
writes nothing to Storage; unloading writes one object per log with new records.
A compaction that would leave more than 8 segments after the latest snapshot, or
segments larger in all than the snapshot (and 4 MiB), writes a snapshot of the
whole log instead and deletes what it replaces, so an agent that wakes often
keeps at most a snapshot and 8 segments per log; reads fetch them 8 at a time.
Tail rows of revoked agents and deleted volumes are dropped with them, and an
hourly sweep drops any a dead node left.

**Deleting agents.** `DELETE /v1/agents/:id` (or `/clients/:id`) revokes the
agent, stops it and unloads it at once. A sweep every node runs
(`AGENT_PURGE_INTERVAL_MS`, default a minute; started at once after a delete)
then purges every revoked or expired agent no live node holds: its journal and
transcript objects (segments, snapshots, blobs), tail rows, local directory,
schedules, channel bindings and volume watches. Nodes claim agents with
`FOR UPDATE SKIP LOCKED` and a five-minute lease, and every step is idempotent,
so a purge that fails or whose node dies is retried. The row stays as a tombstone
holding only the agent's identity: its id and idempotency key are never reused,
`/v1/agents/:id` answers 404 and `/clients/:id` 410. Logs written before the tail existed are
read unchanged: their segments are ordinary segments.

**Database outages.** The default 90-second lease outlasts most of an RDS
Multi-AZ failover (60–120 s direct; shorter through RDS Proxy, which holds
client connections and queues statements while the writer moves). A node
survives an outage of up to about 0.9 × TTL less the time since its last renewal
(between 63 and 78 s at the default). Running turns pause at their next
durable write, whose tail insert is repeated (it is idempotent and fenced) for
up to a lease, and carry on once the database is back. Requests that need the
database answer 503 with `Retry-After`, and the pool replaces broken
connections by itself. A longer outage fences the node, and it takes its actors
back under a higher epoch once the database returns. A longer lease survives longer outages but delays
takeover after a crash; planned stops release explicitly and are unaffected.

Nodes cache an actor's owner for up to 5 seconds, never past the owner's
heartbeat as last read, so forwarding costs no query per request. The cache is
only a hint: a node that no longer owns an actor cannot serve it, and an entry
is dropped when its node answers 503 or cannot be reached.

<a id="draining"></a>**Draining.** On SIGTERM (or SIGINT) a node:

1. fails `GET /healthz` with 503 `{ok:false, draining:true}` (it is 200 `{ok:true}`
   otherwise), and marks its heartbeat row draining so peers stop picking it;
2. takes no new agents or volumes: requests for ones it does not hold are
   forwarded to a live peer that is not draining, or, with none, answered 503
   with `Retry-After: 1`; ones it holds it keeps serving;
3. waits, up to `AGENT_DRAIN_TIMEOUT_MS`, for turns and runs that began (and
   other open requests) to finish; runs that never began stay queued for the
   next owner, which starts them when it loads the agent;
4. stops its agents and hands off what is still running (its next owner resumes
   those turns; see [Turn handoff](#turn-handoff)), releases every agent and
   volume, then closes event streams so clients reconnect to the next owner,
   deletes its heartbeat, and exits 0.

A second signal stops the wait. Every 503 carries `Retry-After`. Give the
container a stop timeout longer than the drain (ECS `stopTimeout` 120 with the
default 100 s).

<a id="deploys"></a>**Deploys and scale-in on ECS.** Fargate stops a task at most 120 s after
SIGTERM, and turns can run far longer, so tasks avoid being stopped mid-turn:

- *Protection.* While any turn runs (a run that began, including its tool calls),
  the task sets ECS task scale-in protection through the agent endpoint
  (`PUT $ECS_AGENT_URI/task-protection/v1/state`, 60 minutes, renewed every 15),
  and clears it after `AGENT_PROTECTION_IDLE_MS` (default 30 s) without work.
  Scale-in and deployments leave protected tasks alone, so scale-in picks idle
  tasks and needs nothing more.
- *Retirement.* Every `AGENT_ECS_POLL_MS` (default 30 s) a task compares itself
  with its service's primary deployment (task metadata and `ecs:DescribeServices`
  on `AGENT_ECS_SERVICE` in `AGENT_ECS_CLUSTER`, else the task's own cluster).
  When that deployment runs another task definition, or was created after the task
  started, the task retires: it takes no new agents or volumes (requests for them
  go to a live peer, as when draining), lets running turns finish for up to
  `AGENT_RETIRE_MAX_MS` (default 6 h), gives up each agent and volume as soon as
  nothing runs on it (closing its event stream so the client reconnects to the new
  owner), and clears protection once idle. ECS then stops it and the drain finds
  nothing to do. `/healthz` stays 200 while retiring: ECS replaces tasks that fail
  their health check, protected or not, so the task keeps the load balancer's
  traffic and hands it on.

<a id="turn-handoff"></a>**Turn handoff.** When a node loads an agent whose last
run began and never finished (its node crashed, was killed, or drained out of
time), the turn resumes there under the same request ID instead of failing: an
answer the model had already finished is taken as the outcome; otherwise any
tool call whose outcome was lost gets an "outcome unknown" result (a call is
never sent again) and the model is called once more to continue. A run is
resumed at most twice, counted in the journal; after that, and for code
executions, the request fails as uncertain. A code execution counts as begun
once it has called a tool: until then it has no effect outside its sandbox, so
one whose node is lost before its first tool call is simply run again (its
start becomes durable before its first tool call is sent anywhere).

**Load.** Every minute each node logs a `node_load` line in CloudWatch Embedded
Metric Format: namespace `AgentRuntime`, metrics `hostedAgents` (agents started
on the node, what `AGENT_MAX_AGENTS` caps), `sessions` (agents loaded on the node,
hosted or not), `agents` (the older name of `hostedAgents`, kept for existing
dashboards), `volumes` (volumes it serves), `runningTurns` and `rssBytes`, with no dimension
or `ServiceName` from `AGENT_SERVICE_NAME`. CloudWatch Logs extracts them
without API calls, so they can drive target-tracking scaling.

Schedules and channel work items are claimed with `FOR UPDATE SKIP LOCKED` and a
claim deadline, so one node delivers each; a crashed node's claims lapse.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AGENT_DATABASE_URL` | Postgres for development and tests (`sslmode` and `sslrootcert` in the URL are honoured) |
| `AGENT_DATABASE_HOST`, `AGENT_DATABASE_SECRET_ARN` | production instead of a URL: the login is read from the Secrets Manager secret (`{username, password}`, rotated by RDS), cached, and re-read every 10 minutes and whenever a connection fails authentication; `AGENT_DATABASE_NAME` (default `agent_runtime`), `AGENT_DATABASE_PORT` (default 5432), `AWS_REGION` |
| `AGENT_DATABASE_CA` | PEM bundle the server's certificate must chain to (e.g. `/etc/ssl/rds-global-bundle.pem`); TLS settings in a URL are then ignored |
| `AGENT_DATABASE_POOL_SIZE` | connections per node (default 10) |
| `AGENT_DATABASE_QUERY_TIMEOUT_MS` | how long a query may take before it fails and its connection is replaced (default 30000; 0 for none), so a connection that went dark in a failover cannot hang a request |
| `AGENT_STORAGE` | `file` (default; one node only), `shared-file` (several processes on one filesystem), or `s3` (`AGENT_S3_BUCKET`, `AGENT_S3_PREFIX`) |
| `AGENT_NODE_URL` | this node's address for forwarding between nodes; unset on ECS, it is `http://<task private IPv4>:<PORT>` from `ECS_CONTAINER_METADATA_URI_V4`, and elsewhere `http://127.0.0.1:<PORT>` |
| `AGENT_LEASE_TTL_MS` | node heartbeat lifetime (default 90000): the longest database outage a node rides out, and how long a crashed node's actors wait for a new owner |
| `AGENT_DRAIN_TIMEOUT_MS` | how long SIGTERM waits for running turns before handing them off (default 100000; see [Draining](#draining)) |
| `AGENT_ECS_SERVICE`, `AGENT_ECS_CLUSTER` | the ECS service this task belongs to, for retirement (see [Deploys](#deploys)); the cluster defaults to the task's own; without the service, tasks never retire |
| `AGENT_RETIRE_MAX_MS` | how long a retiring task keeps protection for running turns (default 21600000, 6 h) |
| `AGENT_ECS_POLL_MS`, `AGENT_PROTECTION_IDLE_MS` | how often to check the service's deployment (default 30000), and how long without work before task protection is cleared (default 30000) |
| `AGENT_TENANTS_FILE` | tenants JSON (`{tenants: {<id>: {tokenSha256, apiKeys, github?, maxAgents?, maxMonthlyCost?, billing?}}, platformKeys?}`), re-read on SIGHUP; see [Billing](#billing) for `billing` and `platformKeys` |
| `AGENT_TENANTS_SECRET_ARN` | instead of a file: a Secrets Manager secret holding the same JSON, read at startup and every minute and on SIGHUP; a bad value is rejected and the last good tenants stay |
| `AGENT_SESSION_SECRET`, `AGENT_SECRETS_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | plain values, for development |
| `AGENT_SESSION_SECRET_ARN`, `AGENT_SECRETS_KEY_ARN`, `AGENT_GITHUB_OAUTH_SECRET_ARN` | instead of the plain values (not both): Secrets Manager secrets read once at startup, the last holding `{clientId, clientSecret}`. On ECS only these are set, so no secret value is in the process environment, which any other process running as the same uid could read from `/proc` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe, for credit purchases (development; see [Billing](#billing)) |
| `AGENT_STRIPE_SECRET_ARN` | instead: a Secrets Manager secret holding `{secretKey, webhookSecret}`, read at startup; while it has no value, purchases are off |
| `GITHUB_ORG` | console GitHub sign-in admits active members of this organization (default `qaml-ai`) |
| `AGENT_OPEN_SIGNUP` | `true` admits any GitHub account instead (see [Billing](#billing)) |
| `AGENT_SIGNUP_MIN_ACCOUNT_DAYS` | how old a GitHub account must be for a new tenant's starting credit (default 30) |
| `AGENT_BILLING_ADMINS` | tenants (comma-separated) whose operator tokens may adjust any tenant's credit |
| `AGENT_PRICE_AGENT_HOUR_USD`, `AGENT_PRICE_STORAGE_GB_MONTH_USD`, `AGENT_PRICE_WEB_SEARCH_USD`, `AGENT_CREDIT_FEE_PERCENT`, `AGENT_CREDIT_MIN_PURCHASE_USD`, `AGENT_CREDIT_MAX_PURCHASE_USD`, `AGENT_CREDIT_GRANT_USD`, `AGENT_FREE_MAX_AGENTS`, `AGENT_FREE_HOURLY_SPEND_USD` | prepaid rates and limits (defaults 0.01, 0.10, 0.005, 5.5, 5, 1000, 5, 2, 1; see `src/pricing.ts`) |
| `AGENT_WEB_SEARCH_PROVIDER`, `AGENT_BRAVE_SEARCH_URL` | the `web_search` API (`brave`, the only one so far) and its endpoint (default Brave's; tests point it at a local server) |
| `AGENT_BILLING_INTERVAL_MS` | how often a node checks whether today's storage charge has run (default 3600000) |
| `AGENT_SERVICE_NAME` | the `ServiceName` dimension on the `node_load` metrics (none when unset) |
| `AGENT_HOSTING` | `process` (one Node process per awake agent) or `inline` (many agents per process) |
| `AGENT_CODE_WORKERS_MIN`, `AGENT_CODE_WORKERS_MAX` | codemode worker threads kept warm (default min(4, cores); none in each agent process under `process` hosting, which starts one on demand) and the most there may be (default 32); workers beyond the minimum stop after 30 s idle, and executions beyond the maximum queue within their own timeout. With sandbox processes, the totals are shared among them |
| `AGENT_SANDBOX_PROCESSES` | read by `agent-launcher` (the image's entrypoint): how many [sandbox processes](#sandbox-boundary-and-remaining-production-work) run js_exec (default 2, at most 16; 0 runs it in the runtime process) |
| `AGENT_SANDBOX_REQUIRED` | `1` (the image's default) refuses to start without sandbox processes |
| `AGENT_OUTBOUND_ALLOW_HTTP` | `true` lets MCP servers and `web_fetch` use `http://` URLs (tests and development only) |
| `AGENT_OUTBOUND_BLOCK_CIDRS` | ranges no tool source may reach, on top of the built-in private and reserved ranges, e.g. the VPC's CIDR (see [Outbound calls](#outbound-calls)) |
| `AGENT_OUTBOUND_ALLOW_CIDRS` | exceptions to the built-in ranges, e.g. `127.0.0.1/32` for a local test server; never set in production |
| `AGENT_SANDBOX_SOCKETS` | set by `agent-launcher`: the sandbox processes' sockets. Without it, js_exec runs on worker threads in the runtime process, as in development on macOS; the `listening` log line's `sandbox` field says which |

Start the HTTP supervisor on a VM using a trusted terminal:

```sh
export AGENT_RUNTIME_TOKEN="$(openssl rand -hex 32)"
export AGENT_API_KEY="your-provider-key"
export AGENT_PROVIDER=anthropic
export AGENT_MODEL=claude-sonnet-4-5
export AGENT_DATA_DIR=/absolute/path/to/agent-data
export AGENT_RUNTIME=node
npm start
```

This starts on `127.0.0.1:8790`. `HOST`/`PORT` are configurable. Use a private
network and TLS termination before exposing the control plane remotely; the
token grants control of every agent and its approved tools on this supervisor.
It is an operator credential, not a tenant-scoped API token. `AGENT_BASE_URL`
optionally overrides the selected Pi model's provider endpoint. Model keys are
sent to the agent over IPC, not passed on argv or persisted in session files.

```sh
curl -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" -X POST \
  http://127.0.0.1:8790/agents/demo

curl -N -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Write hello.txt, read it back, and report the contents."}' \
  http://127.0.0.1:8790/agents/demo/prompt

curl -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" -X POST \
  http://127.0.0.1:8790/agents/demo/abort

curl -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" -X DELETE \
  http://127.0.0.1:8790/agents/demo
```

## Interface and behavior

| Request | Behavior |
| --- | --- |
| `POST /agents/:id` | Start an agent, loading its saved session if present |
| `GET /agents/:id` | PID, busy state, message count |
| `POST /agents/:id/prompt` | `{text}`; stream Pi events and a final result as NDJSON |
| `POST /agents/:id/execute` | `{code, timeoutMs?, maxOutputCharacters?}`; diagnostic codemode execution, outside the Pi transcript |
| `POST /agents/:id/abort` | Abort the current prompt/script and signal pending tools |
| `DELETE /agents/:id` | Stop the agent (killing its process under `process` hosting); keep its saved session/files |

Each agent admits one prompt or diagnostic execution at a time. The supervisor
admits eight agents by default (`maxAgents` in the SDK). There is no request
queue or automatic restart. HTTP errors before streaming use 400, auth failures
401; streamed failures use `{type:"error", error}` records. Disconnecting the
HTTP stream does not cancel the turn; send `abort` explicitly. Slow consumers
are disconnected rather than buffering unbounded events. Event replay is not
implemented for this legacy HTTP control surface. The client SDK SSE surface
supports bounded replay and durable request/tool outcomes (see its guide).

Codemode supports `tools.search(query)`, `tools.describe(name)`,
`tools.<name>(args)`, `text(value)`, `console.log(value)`, top-level `await`, and
`return`. It can compose parallel calls with `Promise.all`. `tools.read`,
`tools.write`, and `tools.ls` are the supplied local adapter; results follow
`{ok:true,data}`. Failed calls reject. No browser, connections, AI media, or
other Worker binding facades are supplied yet.

Scripts default to a 30-second external deadline, capped at 120 seconds. The
QuickJS interrupt handler separately allows 2 seconds spent executing guest code
(elapsed execution time, excluding time waiting for tools). Expensive built-ins
that do not invoke the interrupt handler are still bounded by the external
deadline: a guest that has not unwound 250 ms after it is cancelled has its
worker thread terminated and replaced. Every invocation has fixed 32 MiB WebAssembly memory, a 16 MiB
QuickJS allocation limit and a 256 KiB interpreter stack limit. These are guest
limits; each worker thread's own JavaScript heap is capped at 128 MiB.

Output defaults to 32,000 characters, capped at 128,000 and 1,024 emitted chunks.
Each script permits 256 tool calls with at most 32 in flight; arguments are
limited to 128 KiB JSON, results to 1 MiB JSON and aggregate tool traffic to
8 MiB. Tools are allowlisted and their arguments validated against host-owned
schemas before dispatch. Call results are copied as JSON, never host references.
All tool calls must be awaited; unfinished calls on return are rejected and
pending calls are cancelled. Cancellation cannot undo effects already dispatched.
Guest requests cannot change the executable, memory limits, workspace or tools.
Script failures, timeouts and cancellation leave the agent process available.
Tool RPCs are correlated by unique IDs, so reverse completion order is safe.
External side effects cannot be rolled back by a worker termination or AbortSignal.
Adapters must honor cancellation and must implement idempotency for writes.

## Persistence

Nothing is serialized per streamed delta. Each agent has two append-only logs:

- `transcript.jsonl`: one durable record per finished native Pi message
  (`message_end`), plus turn start/end markers. Messages stay native instead of
  being converted to UI messages. A retried provider error is retracted. The
  supervisor writes it under the agent's ownership claim; an agent in its own
  process sends records over IPC and holds no database connection.
- `<session>.journal.jsonl`: request state changes. It is fsynced only where
  correctness needs it: accepting a request, a run's start (before its first tool
  call can have an effect), and recording outcomes. Tool calls are not journaled:
  the transcript has them. Old settled records are folded away, keeping the most
  recent 256 for idempotent retries.

Streamed events (token deltas, tool progress) are kept in a bounded in-memory
buffer for SSE replay. After a host restart a client's cursor falls outside the
buffer, it receives `REPLAY_GAP`, and it recovers durable state from `/state`
and `/history`. The session header (a row in `agents`) is rewritten only when
configuration or metadata changes.

If the runtime dies mid-turn, the next owner resumes the turn (see
[Turn handoff](#turn-handoff)): tool calls without results get an explicit
"outcome unknown" result so the model neither assumes success nor repeats the
effect blindly, and the model continues from there. A turn that cannot resume
(a code execution, or one resumed twice already) is closed with a runtime notice
and its request completes with an `uncertain` error. Tool calls are never re-sent,
and nothing blocks later requests.

Transient provider failures (overload, rate limits, 5xx, dropped streams) are
retried in the same turn with exponential backoff (3 attempts from 2 s).
Context overflow is not retried.

Sessions load lazily and unload after `AGENT_IDLE_MS` (default 5 minutes)
without activity; the agent's process stops at the same point. When all
`AGENT_MAX_AGENTS` slots are in use (hosted agents per node, processes or inline;
`AGENT_MAX_AGENTS_PER_TENANT` per tenant; the older names `AGENT_MAX_PROCESSES`
and `AGENT_MAX_PROCESSES_PER_TENANT` still work), the least recently active idle
agent is stopped to make room. If none is idle, creating or waking an agent is
refused with 429 (the tenant's limit) or 503 (the node's), with `Retry-After`;
the SDKs retry both. A tenant's entry in the tenants file or secret may set its own
`maxAgents` (a positive integer), which replaces `AGENT_MAX_AGENTS_PER_TENANT` for
it; it applies from the next tenants reload (SIGHUP, or the secret's refresh every
minute) to new starts, and agents already running above a lowered limit keep
running.

A tenant's entry may also set `maxMonthlyCost`, a monthly model spend cap in USD
(`infra/tenant.sh set-spend-limit`; absent means unlimited). Spend is the tenant's
usage cost this UTC month, turns and compaction summaries, cached per node for 5
seconds. A tenant at its cap gets 402 Payment Required for new `prompt` and
`continue` runs (queued runs complete with the same error), and a running turn ends
cleanly after the model response that crossed it: that response's tool calls run
and their results are recorded, then the turn stops before the next model request,
with `stopped: "spend_limit"` and the reason as `error` in its outcome. The
transcript stays valid, so once the cap is raised (at the next tenants reload) the
agent carries on. `execute` makes no model calls and is not limited.

With `AGENT_STORAGE=file`, logs are local files, not
replicated storage, and their writes are not fenced: it is for a single node. A node
with it refuses to start while another node's heartbeat is live in the same database
(after waiting one lease for a peer that just stopped). The whole transcript of an
active agent is still held in memory.

The host provider key is only sent to trusted endpoints: the default model's,
Pi's published endpoint for the requested provider and model, or an entry in
`AGENT_ALLOWED_BASE_URLS` (comma-separated). Scoped credentials can only submit
user messages; assistant and tool-result history is produced by the runtime.

## Agent definitions

A definition is a tenant's reusable agent configuration: name, model, system
prompt, thinking level, tool sources (built-ins, remote MCP servers and OpenAPI specs), limits
(`ttlSeconds`) and optional mounts. Tenants manage them with `/v1/definitions` or the console's
Definitions page, and make agents from one with `POST /v1/agents
{"definition": "def_…"}` (or `createAgent({ definition })` in the SDKs, which also
create and update them: `createDefinition`, `updateDefinition`, `definition(s)`,
`deleteDefinition`, and `create_definition` and so on in Python). The
definition supplies the model, prompt, thinking level and tool sources; `name`,
`type`, `ttlSeconds`, `mounts` and `initialMessages` given alongside it override
its defaults, and an SDK app's tools are added as its attached server.

Every change is a new revision (`PATCH` replaces the fields given; `null`
removes one; `revision` makes it conditional). An agent records the definition
and revision it was made from (`definition` in `GET /v1/agents/:id`), and keeps
that configuration when the definition changes: only new agents get the new
revision. `PATCH … {"apply": "all"}` also reconfigures every live agent made
from the definition, through each agent's `configure` request, queued behind its
runs so it lands between turns; the application's attached tools are kept. Only
the tenant can apply a definition, never an agent's own token. `GET
/v1/definitions/:id/agents` lists the agents and the revision each has. Deleting
a definition leaves its agents as they are; a definition a channel uses cannot
be deleted.

## Tool sources

Every tool an agent has comes from a tool server, and every server answers the
same way, shaped like MCP's `tools/list` and `tools/call` (`src/tool-servers.ts`).
In order of precedence (a name an earlier server lists is left out of later ones):

1. **The channel's**: `send_message`, for agents a channel made.
2. **The application's attached MCP server**: an SDK application serves its
   tools over its connection to the agent (see the [SDK guide](clients/README.md)).
3. **File tools** over the agent's mounts.
4. **The definition's sources**: the built-ins it enables (`builtins`, below),
   its remote MCP servers (`mcpServers`) and its OpenAPI specs (`openApi`),
   which the runtime calls itself.

`js_exec` (the QuickJS sandbox) reaches all of them. Every result is an MCP
result: the model gets its content (text and images) and `isError`; code in
`js_exec` gets its data (`structuredContent`, or its one text block, parsed when
it is JSON), and a tool error throws. Each call gets the turn's `origin` (a
channel, its conversation and sender) so tools can authorize: MCP servers as
`_meta["agent-runtime/origin"]`. Only the attached server needs its application
connected; the rest suit channel agents and anything scheduled. An HTTP API gets
its tools from its OpenAPI spec, or from a remote MCP server.

### Seeing an agent's tools

`GET /v1/agents/:id` returns `toolSources`: every source above, in order of
precedence, with what it offers the model (the console shows it on the agent's
Configuration tab; the SDKs have `runtime.toolSources(agentId)` and
`tool_sources(agent_id)`). Each source has its `kind` (`channel`, `application`,
`files`, `builtin`, `mcp`, `openapi`), `name`, `status` and `tools`; each tool its
name, description and exposure, and `excluded` with the reason when the model
does not get it (an earlier source has its name, or the catalog is full). Input
schemas are left out unless `?schemas=true`. The application source says whether
the application is `connected`.

MCP tool lists are dynamic, so an MCP server shows what the agent's tools were
last built from while it runs (`listedAt`; `status: "error"` with the `error`
when listing failed, so the model has none of its tools). Otherwise it shows the
list this node last fetched for the server, or `status: "unlisted"`: reading an
agent never connects to its servers. `?refresh=true` does: it lists every MCP
server now (and fills the node's cache), which is how to check a server before
the agent runs. A running agent takes a changed list at its next start or
reconfiguration, not at a refresh.

### Built-ins a definition enables

`"builtins": ["web_fetch", "web_search", "schedule"]`:

- `web_fetch` (`{url, maxCharacters?}`) GETs a public URL through the outbound
  guard. An `http://` link is tried as `https://`. Up to five redirects are
  followed, each checked; the deadline is 20 s and the response cap 5 MiB. It
  returns `{url, status, contentType, title?, text, truncated?}`: HTML reduced to
  readable text, other text as is, 20,000 characters by default (at most
  100,000). Other content types are refused.
- `schedule` (`{text, inSeconds | at, everySeconds?}`), `list_schedules` and
  `cancel_schedule` (`{id}`) let an agent manage its own wake-ups in the shared
  scheduler; each one arrives as a new message. They write under the agent's
  claim, so a node that lost the agent mid-turn cannot schedule or cancel for it.
  The limits are those of `/v1/agents/:id/schedules`: 100 per agent, at most a
  year ahead, and repeats at least a minute apart.
- `web_search` (`{query, count?, freshness?}`) asks a web search API and returns
  `{query, results: [{title, url, snippet, date?}]}`: 5 results by default, at
  most 10, plain text (snippets at most 500 characters), `https://`/`http://`
  links only; `freshness` (`day`, `week`, `month`, `year`) keeps recent pages. The
  results are for finding pages: with `web_fetch` enabled too, its description
  tells the model to read a result in full with `web_fetch`, whose `url` it takes
  as is. The API is [Brave Search](https://brave.com/search/api/) (its own index of
  the web, one GET per search, page dates, about $5 per 1,000 searches) behind a
  small `SearchProvider` interface in `src/web-search.ts`, so another can be
  added (`AGENT_WEB_SEARCH_PROVIDER` picks it). Its key is a provider key named
  `brave`: the tenant's own (`PUT /v1/providers/brave/key`, or the console's
  Models & keys page; not checked when set, as a check would cost a search), an
  admin's `apiKeys.brave` in the tenants file, else for a prepaid tenant the
  platform's `platformKeys.brave`. A `*` key never counts, as it is a model key.
  Without one, a search fails with a tool error saying so. A search on a key that
  is not the tenant's own is charged to credit at `AGENT_PRICE_WEB_SEARCH_USD`
  (default $0.005) once the API answers; every search appears in `/v1/usage` as
  the model `brave/web_search`. The request goes through the outbound guard, with
  the key sent to the API's origin only (`AGENT_BRAVE_SEARCH_URL` overrides the
  endpoint, for tests).

### MCP servers

```json
{"name": "Support", "mcpServers": [{
  "name": "kb", "url": "https://mcp.example.com/mcp",
  "auth": {"type": "bearer", "token": "…"}, "headers": {"X-Team": "support"},
  "allowTools": ["search", "fetch_article"], "exposure": "both", "timeoutMs": 30000
}]}
```

- The runtime speaks Streamable HTTP, and falls back to the older SSE transport
  when a server answers its POST with 400, 404 or 405.
- `headers` and `auth` (a bearer token today; the field leaves room for OAuth)
  are sealed like provider keys, with AES-256-GCM under `AGENT_SECRETS_KEY`,
  bound to the definition and server name. The API returns only `headerNames`
  and `auth.type`. Agents keep a sealed copy with their definition revision.
  Updating a server without `headers` and `auth` keeps its stored credentials,
  unless its URL moved to another origin: credentials belong to the origin they
  were given for.
- Each node connects lazily, once per tenant and server (URL and credentials),
  shares the connection among that tenant's agents, reconnects when the server
  drops a session, and closes connections idle for ten minutes. Tool lists are
  cached for five minutes and dropped when the server sends
  `notifications/tools/list_changed`. An agent takes the list when it starts, so
  a running agent sees changes at its next start.
- Tools reach the model as `<server>__<tool>` (other characters become `_`),
  filtered by `allowTools` and `denyTools`, with the server's input schemas. A
  schema that is not a valid tool schema drops that tool, and the agent's
  catalog stays within its limits (128 tools, 256 KiB). `exposure` is `codemode`
  (call them as `tools.kb__search(...)` in js_exec), `direct` or `both`. Without
  one, a source of up to 10 tools gets `both`, so a call is one step rather than
  a discovery in js_exec first, and a bigger one `codemode`, so its tools do not
  crowd the model's context. The same default applies to OpenAPI sources and an
  application's attached server.
- Calls from the model and from js_exec go through the same path as every tool.
  Arguments are checked against the schema, the result is capped at 1 MiB of
  JSON, and each call has a timeout (`timeoutMs`, default 60 s). Text and image
  content reach the model as content results. Other content is described in
  text, `isError` becomes a tool error, and `structuredContent` is kept as the
  result's `details`.
- A server that cannot be reached when an agent starts contributes no tools
  that time (logged as `mcp_tools_unavailable`); the agent starts anyway.

### OpenAPI specs

```json
{"name": "Support", "openApi": [{
  "name": "shop", "spec": "https://api.example.com/openapi.json",
  "auth": {"type": "bearer", "token": "…"}, "allowTools": ["listOrders", "getOrder", "refundOrder"]
}]}
```

As in [Executor](https://github.com/UsefulSoftwareCo/executor)'s openapi plugin,
every operation of an OpenAPI 3 spec (JSON or YAML) is a tool:

- Named `<name>__<operationId>` (or `<name>__<method>_<path>` without one); its
  input is the operation's path, query and header parameters by name, plus `body`
  for the request body: sent as JSON, or form-encoded with nested values in
  brackets (`metadata[key]=v`, `expand[]=x`, as Stripe reads them). Local `$ref`s
  in an operation's input are inlined up to a depth and size budget (past it, or
  a reference back into itself, a schema is `{}`: any value, which the API still
  checks), and 3.0's `nullable` becomes a JSON Schema type. Operations whose body
  is neither (multipart, octet streams) are left out, as are cookie parameters
  and the bodies GET and HEAD declare. Read-only methods (GET, HEAD, OPTIONS) may run in
  parallel.
- The spec is fetched (through the outbound guard, up to five redirects, 8 MiB)
  and checked when the definition is saved, and its operations, after
  `allowTools` and `denyTools` (at most 128, the agent's whole catalog), are stored with it: an agent's tools
  do not change under it, and saving the definition again takes a spec's
  changes. `spec` may also be the document itself; a source saved without `spec`
  keeps the operations it has.
- Requests go to `baseUrl`, by default the spec's first server (its variables at
  their defaults, resolved against the spec's URL), through the outbound guard
  with no redirects, `timeoutMs` (default 30 s) and a 1 MiB response cap.
  `headers` and `auth` are sealed as for MCP servers and sent to that origin only.
- A 2xx answer is the result: its JSON, else its text. Any other status is a tool
  error quoting the method, path, status and the start of the body.
- `exposure` defaults as for MCP servers. The API shows each
  source's `tools` (operation names) and `baseUrl`, never its credentials.

### Who sent a message (`from`)

An agent that several people talk to (a team agent, a group chat) can be told
who sent each message: `POST /v1/agents/:id/prompt {text, from: {id, name?, username?}}`,
or `prompt(text, { from })` in the SDKs (`from_=` in Python; also on `steer` and
`followUp`).

- The transcript stores `from` on the user message, apart from its text. Each
  time the model is called, the runtime opens that message with a block of its own:

  ```
  <<<RUNTIME_CONTEXT>>>
  {"from":{"id":"u_456","name":"Bob","username":"bob"}}
  <<<END_RUNTIME_CONTEXT>>>
  what's on my plate?
  ```

- Only the runtime writes these markers. Wherever else they appear in text the
  model reads (user messages, names, tool results) they are neutralized
  (`‹‹‹RUNTIME_CONTEXT›››`), so a sender cannot forge a block. The runtime's
  instructions tell the model that `from.id` identifies the sender and the
  names are the sender's own, never proof of identity or authority.
- It is one ordinary user message on every model, so it works the same on open
  models and strict chat templates, and the rendered history stays the
  provider's cached prefix. Compaction summaries see senders too.
- `from.id` is the turn's actor (`act` in identity tokens) unless `actor` names
  someone else. `actor` alone tells tools who is acting without telling the model.
- Channels set it for every message: `from.id` is `<type>:<the service's user id>`
  (`telegram:42`, `slack:U0123ABCD`), with the sender's display name and username.

### Identity tokens (`auth: { type: "runtime" }`)

A tool server can trust the runtime instead of a stored secret: with
`"auth": {"type": "runtime"}` on an MCP server or OpenAPI source, every request
to it carries `Authorization: Bearer <JWT>`, signed by the runtime for that
request. Nothing per user is stored anywhere, and there is no shared secret.

```json
{ "iss": "https://agents.camelai.dev", "aud": "https://app.example.com/mcp",
  "sub": "u_123", "tenant": "acme", "agent": "client_…", "definition": "def_…",
  "ctx": { "org": "acme", "thread": "t_1" }, "act": "u_456",
  "origin": { "channel": { "id": "ch_…", "type": "slack" }, "sender": { … } },
  "iat": 1790000000, "exp": 1790000120, "jti": "…" }
```

- `sub` is the agent's `subject` and `ctx` its `context`, both given when the
  agent is created (`POST /v1/agents` or the SDKs' `createAgent`) with the
  tenant's key; the agent's own token cannot set or change them. Without a
  subject, `sub` is the agent's id.
- `act` is who is acting in the turn: the `actor` given with the prompt
  (`POST /v1/agents/:id/prompt {text, actor}`, or `prompt(text, { actor })`),
  else the message's `from.id`,
  and `origin` where a channel turn came from. Requests outside a turn (listing
  an MCP server's tools when an agent starts) carry neither. `actor` reaches the
  tools, not the model: an application that lets several people talk to one
  agent tells the model who is speaking with `from`, as channels do. That agent's
  conversation is shared by all of them, so private data belongs with agents of
  one person each.
- `aud` is the MCP server's URL, or the OpenAPI source's `baseUrl`, so a token
  cannot be replayed against another server. A source can name its own
  `audience` instead, for a server that knows itself by another URL (behind a
  proxy, say). Tokens live two minutes, and each
  request gets its own (`jti`). Each agent has its own MCP session with a
  server that uses them.
- `iss` is `AGENT_PUBLIC_URL`, or without it the address the runtime listens on.
- Tokens are EdDSA (Ed25519). The public keys are at
  `/.well-known/jwks.json` (keys have `kid`; cache for minutes); the private key
  is sealed with `AGENT_SECRETS_KEY` in `signing_keys` and made on first use.
- To verify, in a Worker or Node (`jose`):

```ts
const jwks = createRemoteJWKSet(new URL("https://agents.camelai.dev/.well-known/jwks.json"));
const { payload } = await jwtVerify(token, jwks, { issuer: "https://agents.camelai.dev", audience: "https://app.example.com/mcp", algorithms: ["EdDSA"] });
// Authorize as payload.act ?? payload.sub, within payload.ctx, for tenant payload.tenant.
```

### Outbound calls

Every request to a URL a tenant or model chose (MCP servers, OpenAPI specs and APIs, `web_fetch`) goes through one guard (`src/outbound.ts`):

- Only `https://`, unless the operator sets `AGENT_OUTBOUND_ALLOW_HTTP=true`
  (tests and development). No credentials in URLs.
- These addresses are refused:
  - IPv4: loopback, unspecified, private (RFC 1918), shared/CGNAT
    (100.64.0.0/10), link-local (169.254.0.0/16, which includes the instance
    metadata service and the ECS credentials endpoint 169.254.170.2), and
    documentation, benchmarking, multicast and reserved ranges.
  - IPv6: loopback, unique local (fc00::/7, which includes fd00:ec2::254),
    link-local, site-local, multicast, documentation, Teredo, and IPv4-compatible.
  - IPv6 addresses that carry an IPv4 address (mapped, NAT64, 6to4) are judged
    by that IPv4 address.
  - `AGENT_OUTBOUND_BLOCK_CIDRS` adds ranges, such as the VPC's; nothing
    overrides them. `AGENT_OUTBOUND_ALLOW_CIDRS` makes exceptions to the
    built-in list (tests use `127.0.0.1/32`).
- Literal addresses are checked after the URL parser has normalized them, so
  decimal, octal, hex and short forms are caught. Names are resolved by the
  connection itself, through a custom `lookup` on an undici dispatcher. Every
  address the name returns must pass, and the socket connects to the address
  that was checked. A name that later resolves elsewhere (DNS rebinding) is
  checked again on the next connection, and each new connection resolves afresh.
- MCP servers and OpenAPI API calls get no redirects. Where redirects are
  followed (`web_fetch`, spec downloads), each hop is checked the same way, and
  credentials are never sent to another origin.
- Requests have a deadline (an event stream is timed until it starts) and
  responses a byte cap.

## Channels

A channel lets people talk to agents from a messaging service: Telegram, Slack or
Discord. Tenants manage channels with `/v1/channels` or the console's Channels page:

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"telegram","credentials":{"botToken":"<from @BotFather>"},
       "definition":"def_…","access":{"allow":["@ada","123456789"]}}' \
  https://agents.camelai.dev/v1/channels
```

Each conversation's agent is made from the channel's `definition`. The older
inline `template` (`{model, systemPrompt, thinkingLevel}`) is still
accepted for one release: it becomes a definition of the channel's own, which
later templates for that channel rewrite and which is deleted with the channel.
Migration 006 turned every existing channel's template into such a definition.

| Service | Credentials | Messages arrive | A conversation (one agent) is |
| --- | --- | --- | --- |
| `telegram` | `botToken` | webhook, registered for you | a chat |
| `slack` | `botToken` (`xoxb-…`), `signingSecret` | webhook, pasted into the app | a thread started by an @mention, or a DM |
| `discord` | `botToken` | the Gateway (a WebSocket) | a DM, or a channel or thread where the bot is @mentioned |

Creating a channel checks its credentials with the service. Credentials and a
random webhook secret are encrypted with `AGENT_SECRETS_KEY`; the API returns
only masked values.

- **Telegram.** `$AGENT_PUBLIC_URL/channels/telegram/<id>` is registered as the
  bot's webhook with the random secret, which each delivery must echo (compared
  in constant time). Deleting the channel removes the webhook. `/start` gets the
  channel's `greeting` without a model call.
- **Slack.** Create an app with the bot scopes `app_mentions:read`, `chat:write`,
  `im:history`, `channels:history` (and `groups:history` for private channels)
  and `files:read`, and install it. Slack has no API to set an app's event URL,
  so paste the channel's `webhookUrl` into Event Subscriptions and subscribe to
  `app_mention`, `message.im` and `message.channels`. Deliveries must carry a
  valid `X-Slack-Signature` from the signing secret, at most five minutes old; the
  URL check is answered once it verifies. A mention starts a thread and replies go
  there; later messages in that thread reach its agent without a mention. The
  same message sent as both `app_mention` and `message` is handled once. Slack has
  no typing indicator for bots.
- **Discord.** Create an application, add a bot, and invite it with Send
  Messages and Read Message History. There is no webhook for ordinary messages:
  each Discord channel is an actor (`gateway:<id>` in `actor_owners`) and the node
  that holds it keeps the Gateway connection, with heartbeats, resume after a
  dropped link, and a fresh identify when the session is lost. Every node's
  channel scan picks up connections that are not held, so when the holder
  drains, fences or dies, another node connects within one scan of its
  heartbeat expiring (at once after a drain). A token Discord rejects is retried
  every five minutes, not in a loop. The bot needs no privileged intents: it
  answers only DMs and messages that mention it. Replies never ping anyone
  (`allowed_mentions` is empty).

What all three share:

- Each external conversation gets its own agent, made on first contact from
  the channel's definition, at its revision then.
  Its prompts go through the agent's normal queue on whichever node serves it.
- Senders must be on the allowlist unless the channel sets `access.public`:
  Telegram and Discord user ids or @usernames, Slack member ids (`U0123ABCD`).
  Each sender is rate limited (`limits.perSenderPerMinute`, default 10) and the
  channel has a daily turn cap (`limits.turnsPerDay`, default 1000).
- Each message carries its sender as `from` (see [Who sent a message](#who-sent-a-message-from)), and tool calls carry a runtime-set `origin`
  (`{channel, conversationId, sender}`, `context.origin` in the SDKs) that
  tools can authorize against. Images reach the model (up to 750 KB each).
- The turn's final answer is sent back when the turn ends, split to the
  service's limit (4,096 characters on Telegram, 4,000 on Slack, 2,000 on
  Discord), with a typing indicator meanwhile where the service has one. Channel
  agents also get a `send_message` tool for updates mid-turn.
- A message is recorded in Postgres before it is acknowledged, and duplicates
  (provider retries, a Gateway resume) are dropped by message id for seven days.
  Replies go through a durable outbox: a failed send is retried with backoff by
  any node, a claim means one node sends each message, and a permanent failure
  (the bot was removed from the chat) is not retried.

`AGENT_TELEGRAM_API_URL`, `AGENT_SLACK_API_URL` and `AGENT_DISCORD_API_URL`
override the services' API endpoints (tests use local fakes).

## Volumes

A volume is a shared file tree that agents mount; there is no POSIX mount. Each
agent has mounts `{volumeId, path, mode: "ro" | "rw", subpath?, notify?}`, set at
creation (`mounts` on `POST /v1/agents` or the SDKs' `createAgent`) or with
`PUT /v1/agents/:id/mounts`. Without `mounts`, an agent gets its own workspace
volume at `/workspace`. Mounts are capabilities: sharing means mounting the same
volume in several agents, and only the tenant's own volumes can be mounted.

The agent's tools `read`, `write`, `edit`, `ls`, `glob` and `grep` work on mount
paths (`/workspace/notes.md`), directly and from `js_exec`. An application tool
with the same name takes precedence. Every file has a version; `write` and `edit`
take a `version` (0: the file must not exist), so an edit based on a stale read
fails with an error telling the model to read the file again. `read` returns at
most 32 KiB per call (up to 128 KiB) with a `nextOffset`; `grep` returns at most
200 lines and skips binary files and files over 4 MiB, and matches in a worker
that is stopped after 10 seconds; `glob` returns at most 1,000 paths.

A volume is an actor, like an agent: one node at a time owns it, and requests
to `/v1/volumes/:id` are forwarded to that node. Headers, snapshot summaries and
watchers are rows in Postgres; the rest is in Storage:

```text
volumes/<id>/tree                 append log of puts and deletes, folded into a base every 1,024 records
volumes/<id>/snapshots/<snap>     a snapshot's file map (a blob)
chunks/<tenant>/<aa>/<sha256>     contents, in 1 MiB content-addressed chunks
```

Writes: any node splits the content into chunks and stores those not already
present, then asks the owner to commit the path. The owner checks the version,
appends the record durably and applies it; a node that lost ownership is fenced
by the log. Reads ask the owner only for the path's chunk list, then fetch the chunks
needed for the requested range directly from storage. Downloads stream a chunk at
a time and support `Range`. Snapshots and forks copy metadata only, so a fork and
its source share chunks and diverge independently. `GET /v1/volumes/:id/changes`
lists recent changes; a mount with `notify` prompts the agent (about a second
after changes, coalesced) when others change files under it.

Not yet built: garbage collection of unreferenced chunks and snapshot file maps
(deleting a file, volume or snapshot leaves them), quotas per tenant, restoring a snapshot in
place, empty directories, renames, and durable change notifications (a crash
during the one-second window drops that notification). Listings and snapshots
hold a volume's file map in memory and in one blob, which suits volumes of
up to about 100,000 files. Uploads share the server's 30-second request timeout.

## Billing

Tenants created by console sign-in pay from **prepaid credit**, like OpenRouter;
admin tenants from the tenants file are unbilled unless their entry sets
`"billing": "prepaid"` (the default is `"none"`). Tenants that signed up before
billing existed stay unbilled. A prepaid tenant without a provider key of its own
runs on the platform's keys, the tenants file's top-level `platformKeys`
(`{"anthropic": "...", "*": "..."}`, like a tenant's `apiKeys`), and pays for:

- **Model tokens** on the platform's keys, at the provider's list price from the
  model catalog (no markup), turns and compaction alike. Responses on the tenant's
  own key cost no credit. `/v1/usage` reports `platformResponses` and `platformCost`.
- **Agent time**, $0.01 per hour an agent spends in a run (model calls and tool
  execution, not idle loaded time), metered continuously, with or without its own key.
- **Web searches** on the platform's search key (`platformKeys.brave`), $0.005
  each (`AGENT_PRICE_WEB_SEARCH_USD`), reported with the tokens: see `web_search`
  under [Built-ins](#built-ins-a-definition-enables).
- **Storage**, $0.10 per GB-month of what its agents and volumes keep in Storage
  (transcripts, journals, volume trees and snapshots, file chunks), measured once a
  UTC day on one node and charged for that day.

Every movement is an entry in `credit_ledger` (grant, purchase, usage, storage,
adjustment, refund), in integer micro-USD, under an idempotency key naming its
cause; the same statement moves the balance in `credit_accounts`. Token and time
charges ride the usage flush (a few seconds after a response), each batch in one
transaction that a retry after a lost commit skips. A prepaid tenant at or below
zero gets **402** for new runs, code executions included, with where to add credit;
a running turn ends after the response that spent the last credit, as at the
[monthly spend cap](#persistence). The balance counts this node's unwritten charges
at once and other nodes' within about five seconds, so the overdraft is about one
response per node running the tenant's turns.

**Sign-up.** Console sign-in with GitHub admits members of `GITHUB_ORG`, or with
`AGENT_OPEN_SIGNUP=true` anyone with a GitHub account (asking only for the public
profile). A self-serve tenant is tied to the GitHub account's numeric id, so a
renamed login keeps its tenant (and a new account that takes an old login gets a
tenant of its own, `<login>-<id>` when the name is taken). Each GitHub account's
first prepaid tenant gets $5 of starting credit, once per account id, and only if
the account is at least `AGENT_SIGNUP_MIN_ACCOUNT_DAYS` (30) days old; a newer
account can still sign in, bring its own key or buy credit. A prepaid tenant that
has never bought credit (grants and adjustments do not count; a full refund puts it
back) is on **free credit**, with tighter limits: at most `AGENT_FREE_MAX_AGENTS` (2)
agents at once per node, unless an admin set its `maxAgents`, and at most
`AGENT_FREE_HOURLY_SPEND_USD` ($1) of usage charges in any hour, past which runs get
429 and a running turn ends as above. Both lift with the first purchase.

`GET /v1/billing` has the balance, this month by kind, recent entries and the
rates; `GET /v1/billing/ledger?before=<id>` pages through the ledger; the console's
Billing page shows both. An operator of a tenant in `AGENT_BILLING_ADMINS` can
`POST /v1/billing/adjustments` `{tenant, amount (micro-USD), reason, idempotencyKey?}`.

**Buying credit.** `POST /v1/billing/checkout {amountUsd}` ($5 to $1000, whole
cents) creates a Stripe Checkout session (mode `payment`) for the tenant's Stripe
customer, with a 5.5% processing fee as a line of its own ($10 of credit costs
$10.55), and returns its `url`; Stripe returns the buyer to
`/console/billing?checkout=success` (or `cancelled`). Stripe then calls
`POST /v1/billing/stripe/webhook`, authenticated by its `Stripe-Signature` (HMAC-SHA256
of `<t>.<payload>` under the endpoint's signing secret, at most five minutes old):

- `checkout.session.completed` or `checkout.session.async_payment_succeeded`, paid:
  the credit bought, not the fee, is added once per session;
- `charge.refunded`: credit is removed in proportion to the refunded share of the
  charge, once per refunded total.

Sessions and charges the runtime did not create (the Stripe account serves other
products) are acknowledged and ignored. Setup: create a secret or restricted key
(Customers and Checkout Sessions, write) and a webhook endpoint at
`https://<host>/v1/billing/stripe/webhook` for those three events, then run
`infra/stripe.sh` and paste the key and the signing secret; it stores them in the
`stripe` secret and rolls the service.

## Tenant isolation contract

This prototype is **single-tenant, with one trusted operator**. Separate agent
processes and scoped SDK session credentials do not constitute a multi-tenant
authorization system. The operator credential controls the whole runtime.

- **Generated code:** QuickJS/WASM confines generated JavaScript to the exposed
  capabilities. It does not enforce tenant ownership of agents, tools or data.
- **Application tools:** Tool implementations are trusted host code. Applications
  must limit them to the intended workspace, data and credentials; model-supplied
  arguments are not a trusted source of tenant identity.
- **Shared chat:** Anyone who can reach `/a/:agentId` can access that agent's
  shared conversation and send prompts. The URL does not create a private
  conversation per visitor. Studio's developer access protects inspection and
  configuration data, not access to the shared conversation.
- **Host resources:** Guest execution limits do not enforce per-tenant quotas
  or isolate all host-process memory, filesystem permissions and network access.

Before deploying a shared multi-tenant service, implement authenticated tenant
identity as an end-to-end authorization boundary: derive it from verified
credentials and carry it through agent creation, storage access, tool connections
and every API access check. Bind tool capabilities and credentials to that
identity. Do not treat knowledge of an agent ID as permission to access it, and
define an explicit access policy for end-user chat links.

Acceptance tests must prove tenant A cannot list, read, prompt, inspect, stop or
attach tools to tenant B's agents, including after reconnects and restarts.
Then enforce per-tenant concurrency, CPU/memory, tool-use and inference-spending
quotas. Restrict host-process permissions and use OS/container containment as
appropriate for the code being hosted; hosting customers' arbitrary Node/Python
tool implementations requires a separate isolation boundary.

Multiple agents per VM remains the intended architecture; this does not require
a VM per tenant. A `tenantId` field alone provides no protection, so add it with
the authentication and enforcement design rather than as a placeholder.

## Sandbox boundary and remaining production work

The guest has ECMAScript built-ins plus `tools`, `text` and captured `console`
methods. There is no `process`, `Bun`, `require`, filesystem, `fetch`, sockets,
workers, timers, shared memory or nested WebAssembly. Every module import is
denied, including `node:`, `file:`, `data:` and HTTP URLs. `eval` and function
constructors stay inside QuickJS; they never create host functions.

Guest code is contained by layers, each assuming the one inside it failed:

1. **QuickJS compiled to WebAssembly.** A worker (`src/code-worker.ts`)
   compiles the QuickJS module once; every execution instantiates it with its
   own fixed WASM memory, then creates a new runtime and context, and drops all
   three when it ends. No guest state survives an execution, and one worker runs
   one execution at a time. Guest code only ever sees the QuickJS heap, never the
   worker's Node globals, `process.env`, modules or the filesystem.
2. **A separate process with its own uid.** The workers run in sandbox
   processes (`src/sandbox-server.ts`, `AGENT_SANDBOX_PROCESSES`, default 2),
   not in the runtime. The image's entrypoint, `agent-launcher`
   (`sandbox/launcher.c`), starts as root under the container's init and runs
   the runtime as `node` (uid 1000) and sandbox process *i* as uid 1001 + *i*
   (group `sandbox`, no supplementary groups), so a sandbox process cannot read
   another process's `/proc/<pid>/environ` or `mem`, or trace it. It restarts a
   sandbox process that dies, forwards termination signals to the runtime and
   exits with its status.
3. **No network, no secrets.** A sandbox process starts with an empty
   environment (a fixed `PATH`, `HOME` and `TMPDIR` only), `/dev/null` for stdin
   and no descriptors but its socket. The runtime's data directory (`/data`,
   mode 0700) is unreadable to it, and secrets are never in any environment it
   can see. It has no capabilities, `no_new_privs`, and a seccomp filter
   installed before `exec`: every `socket()` fails (`AF_UNIX` included), as do
   `ptrace`, `process_vm_readv`/`writev`, `pidfd_getfd`, the keyring calls,
   `mount`, `unshare`/`setns` and namespace flags to `clone`, `bpf`,
   `perf_event_open`, `userfaultfd`, `io_uring` (which could open sockets past
   the filter), `kexec`, module loading and `reboot`; other architectures' calls
   kill it. It is a denylist: Node, V8, libuv and glibc use a syscall set that
   shifts with their versions and the kernel, and an allowlist that misses one
   crashes rare paths.

The launcher binds one unix socket per sandbox process at
`/run/agent-sandbox/<i>.sock` (root:node 0660, in a root:node 0710 directory, so
only the runtime's uid connects) and hands it over as fd 3; a sandbox process
cannot reach its own socket's path, only accept on it. Each execution is one
connection carrying length-prefixed JSON frames (at most 4 MiB each; either side
drops the connection on anything bigger or malformed); closing it cancels the
execution. The runtime sends each execution to the process with the fewest open,
and at startup checks that every one answers. A sandbox process that dies fails
the executions it held with "Codemode sandbox process exited", and new ones queue
on its socket until the launcher has restarted it.

The runtime treats a sandbox process as compromised: it accepts only tool-call
requests, output events and the execution's answer, rebuilt from checked fields;
it caps the number of messages, holds output to the caller's character and event
limits, validates the result, and enforces tool schemas, call count, concurrency,
and result and transfer size limits on its side, as it always has. Cancellation
reaches a guest spinning in QuickJS through a shared flag its interrupt handler
polls, and one awaiting a tool through the closed connection and message port.

Without the launcher (macOS, tests, not root, or `AGENT_SANDBOX_PROCESSES=0`),
js_exec runs on the same pool of worker threads inside the runtime process
(`src/codemode.ts`), with layer 1 only; the `listening` log line says which mode
is active, and the image sets `AGENT_SANDBOX_REQUIRED=1` so production cannot
start that way. `tests/image-isolation.ts` boots the image and proves the other
layers from inside a sandbox process.

What guest code can reach on the host, all through the trusted bootstrap
(`src/sandbox-bootstrap.ts`) and never as globals:

- `call(name, argsJson)`: a string name of at most 80 characters and a JSON
  string of at most 128 KiB. It returns a promise settled with the result as a
  JSON string, or rejected with an error carrying only a message of at most
  2,048 characters (tool errors keep the message the application's tool threw).
- `emit(text, truncated)`: a string of at most 128,000 characters, returning
  nothing.
- The tool catalog (names, descriptions and parameter schemas), as one JSON
  string at start.

Arguments cross as strings the host copies out after checking their length;
guest objects are never read from the host, so getters, proxies and `toJSON`
run inside QuickJS under its limits. Host errors surface as plain guest
`Error`s whose stacks are guest frames only. The module loader rejects every
import. The interrupt handler and memory limits are not guest-callable.

The WASM linear memory has equal initial and maximum sizes, and initialization
checks that QuickJS actually uses that memory. This matters because the pinned
QuickJS package's `setMemoryLimit` alone can undercount large arrays/strings:
[upstream report #271](https://github.com/justjake/quickjs-emscripten/issues/271).
Regression tests allocate retained bulk arrays and strings beyond the nominal
heap limit and verify that the fixed WASM boundary stops them.

The supervisor, Pi process, tool schemas and tool implementations remain trusted
code with OS access. The example filesystem adapter rejects traversal, symlinks
(including dangling links), hard links and special files, uses `O_NOFOLLOW` for
file opens, and bounds reads, writes and directory listings. Its workspace must
be owned exclusively by the service: this portable adapter does not provide
race-proof directory traversal against another OS process replacing directories.
Use DO/R2-backed tools or an OS-contained filesystem service for that threat.

The tests cover known escape patterns and limits; they are not a security audit
or proof against engine vulnerabilities. A sandbox process serves many tenants'
executions in turn, so an escape that persists in one would see later executions
routed to it. Production shared-VM operation still needs resource quotas around the sandbox, tenant
authentication, tool-specific authorization, controlled egress for tool hosts,
and a maintained engine/security update process. No deployed environment has
been changed.

## Integration seam and next extraction

`AgentSupervisor` is the embeddable host API. `ToolBridge` is the key platform
boundary: it contains discoverable JSON schemas and `call(name,args,signal)`.
The [client adapters and runnable demos](clients/README.md) implement this bridge
over SSE plus HTTP POST, with replay, execution claims, and recorded outcomes. The TypeScript release board and Python
SQLite inventory app each expose their own functions while the hosted agent
owns the model loop, sandbox and history. Run both with `npm run demo:clients`
(install the documented Python dependency first).
The agent and its scripts never import DO classes. A production adapter should
implement the bridge with a short-lived, thread-scoped RPC capability back to
the Worker, retaining its authorization and confirmation checks.

The application no longer owns model retries, model-context compaction, or
isolate-death recovery. A browser/DO reconnect observes the saved service request
ID. It never re-prompts the model to reconstruct a UI stream. The DO retains only
a UI turn marker, the SDK event cursor, and a render projection.

The service persists native messages and tool outcomes. A killed service run
resumes on the next node with "outcome unknown" tool results (at most twice,
then it completes with an uncertain error); unknown side effects are never
automatically repeated. The service retries transient provider errors itself,
so no degraded retry ladder, salvage mode, or retry budget is needed in the
application.

Remaining production migration work includes model/provider reconfiguration,
billing enforcement at the inference boundary, and testing application tools
under real deployment conditions. Configuration changes during a run are rejected;
they do not abort and regenerate the turn. Nothing has been deployed.
