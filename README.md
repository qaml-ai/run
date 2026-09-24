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
tool call whose outcome was lost gets an "outcome unknown" result (claimed calls
are never run again) and the model is called once more to continue. A run is
resumed at most twice, counted in the journal; after that, and for code
executions, the request fails as uncertain. A code execution counts as begun
once it has called a tool: until then it has no effect outside its sandbox, so
one whose node is lost before its first tool call is simply run again (its
start becomes durable with the first tool call's claim, or before a tool the
runtime answers itself).

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
| `AGENT_TENANTS_FILE` | tenants JSON (`{tenants: {<id>: {tokenSha256, apiKeys, github?, maxAgents?}}}`), re-read on SIGHUP |
| `AGENT_TENANTS_SECRET_ARN` | instead of a file: a Secrets Manager secret holding the same JSON, read at startup and every minute and on SIGHUP; a bad value is rejected and the last good tenants stay |
| `AGENT_SESSION_SECRET`, `AGENT_SECRETS_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | plain values, for development |
| `AGENT_SESSION_SECRET_ARN`, `AGENT_SECRETS_KEY_ARN`, `AGENT_GITHUB_OAUTH_SECRET_ARN` | instead of the plain values (not both): Secrets Manager secrets read once at startup, the last holding `{clientId, clientSecret}`. On ECS only these are set, so no secret value is in the process environment, which any other process running as the same uid could read from `/proc` |
| `AGENT_SERVICE_NAME` | the `ServiceName` dimension on the `node_load` metrics (none when unset) |
| `AGENT_HOSTING` | `process` (one Node process per awake agent) or `inline` (many agents per process) |
| `AGENT_CODE_WORKERS_MIN`, `AGENT_CODE_WORKERS_MAX` | codemode worker threads kept warm (default min(4, cores); none in each agent process under `process` hosting, which starts one on demand) and the most there may be (default 32); workers beyond the minimum stop after 30 s idle, and executions beyond the maximum queue within their own timeout. With sandbox processes, the totals are shared among them |
| `AGENT_SANDBOX_PROCESSES` | read by `agent-launcher` (the image's entrypoint): how many [sandbox processes](#sandbox-boundary-and-remaining-production-work) run js_exec (default 2, at most 16; 0 runs it in the runtime process) |
| `AGENT_SANDBOX_REQUIRED` | `1` (the image's default) refuses to start without sandbox processes |
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
- `<session>.journal.jsonl`: request and tool-call state changes. It is fsynced
  only where correctness needs it: accepting a request, claiming a tool call
  (before the application performs the side effect), and recording outcomes.
  Old settled records are folded away, keeping the most recent 256 of each
  for idempotent retries.

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
and its request completes with an `uncertain` error. Claimed tool calls are never
re-run, and nothing blocks later requests.

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
running. With `AGENT_STORAGE=file`, logs are local files, not
replicated storage, and their writes are not fenced: it is for a single node. A node
with it refuses to start while another node's heartbeat is live in the same database
(after waiting one lease for a peer that just stopped). The whole transcript of an
active agent is still held in memory.

The host provider key is only sent to trusted endpoints: the default model's,
Pi's published endpoint for the requested provider and model, or an entry in
`AGENT_ALLOWED_BASE_URLS` (comma-separated). Scoped credentials can only submit
user messages; assistant and tool-result history is produced by the runtime.

## Channels

A channel lets people talk to agents from a messaging service: Telegram, Slack or
Discord. Tenants manage channels with `/v1/channels` or the console's Channels page:

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"telegram","credentials":{"botToken":"<from @BotFather>"},
       "template":{"systemPrompt":"You are our support assistant."},
       "access":{"allow":["@ada","123456789"]}}' \
  https://agents.camelai.dev/v1/channels
```

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

- Each external conversation gets its own agent, created on first contact from
  the channel's template (model, system prompt, thinking level, client tools).
  Its prompts go through the agent's normal queue on whichever node serves it.
- Senders must be on the allowlist unless the channel sets `access.public`:
  Telegram and Discord user ids or @usernames, Slack member ids (`U0123ABCD`).
  Each sender is rate limited (`limits.perSenderPerMinute`, default 10) and the
  channel has a daily turn cap (`limits.turnsPerDay`, default 1000).
- The prompt names the sender, and tool calls carry a runtime-set `origin`
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
a UI turn marker, the SDK receipt cursor, and a render projection.

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
