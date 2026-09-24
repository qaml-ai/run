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
          -> QuickJS/WASM sandbox (local process, or a gVisor executor host)
              -> JSON tool calls -> back to the app's SDK callbacks
  control plane: Postgres (ownership, headers, accounts, schedules, channels, volume metadata)
  data plane: Storage (append logs and blobs, S3 in production)
```

## Layout

- `src/` server, supervisor, agent host, sessions, scheduler, REST API, executor
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
renews it every third of `AGENT_LEASE_TTL_MS` with `now()`: one write per node,
however many actors it serves. Each actor has one `actor_owners` row naming a
node's session and an epoch. A node takes an actor in one statement that
succeeds only when the row is released, already names this session, or names a
session whose heartbeat has expired; every acquire advances the epoch. Header
writes are conditional on the writer's session and epoch, and log segments are
exclusive creates, so a node that lost an actor cannot write for it. A node
that cannot renew fences itself before its published expiry: it stops every
agent and volume it owns and rejoins under a new session. Requests for an actor
are forwarded to the node that `actor_owners` joined to live heartbeats names.

Nodes cache an actor's owner for up to 5 seconds, never past the owner's
heartbeat as last read, so forwarding costs no query per request. The cache is
only a hint: a node that no longer owns an actor cannot serve it, and an entry
is dropped when its node answers 503 or cannot be reached.

**Load.** Every minute each node logs a `node_load` line in CloudWatch Embedded
Metric Format: namespace `AgentRuntime`, metrics `agents` (awake agents),
`volumes` (volumes it serves), `runningTurns` and `rssBytes`, with no dimension
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
| `AGENT_STORAGE` | `file` (default), `shared-file` (several processes on one filesystem), or `s3` (`AGENT_S3_BUCKET`, `AGENT_S3_PREFIX`) |
| `AGENT_NODE_URL` | this node's address for forwarding between nodes; unset on ECS, it is `http://<task private IPv4>:<PORT>` from `ECS_CONTAINER_METADATA_URI_V4`, and elsewhere `http://127.0.0.1:<PORT>` |
| `AGENT_LEASE_TTL_MS` | node heartbeat lifetime (default 30000) |
| `AGENT_TENANTS_FILE` | tenants JSON (`{tenants: {<id>: {tokenSha256, apiKeys, github?}}}`), re-read on SIGHUP |
| `AGENT_TENANTS_SECRET_ARN` | instead of a file: a Secrets Manager secret holding the same JSON, read at startup and every minute and on SIGHUP; a bad value is rejected and the last good tenants stay |
| `AGENT_SESSION_SECRET`, `AGENT_SECRETS_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | plain values, e.g. from an ECS task definition's `secrets` (a JSON key of a secret is `<arn>:clientId::`) |
| `AGENT_SERVICE_NAME` | the `ServiceName` dimension on the `node_load` metrics (none when unset) |
| `AGENT_HOSTING` | `process` (one Node process per awake agent) or `inline` (many agents per process) |
| `AGENT_EXECUTOR_URL` | run `js_exec` on executor hosts (see `infra/executor/README.md`) |

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
| `DELETE /agents/:id` | Kill the agent process group; keep its saved session/files |

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
process deadline. Every invocation has fixed 32 MiB WebAssembly memory, a 16 MiB
QuickJS allocation limit and a 256 KiB interpreter stack limit. These are guest
limits, not a limit on the entire Node/Bun process's resident memory.

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
External side effects cannot be rolled back by a process kill or AbortSignal.
Adapters must honor cancellation and must implement idempotency for writes.

## Persistence

Nothing is serialized per streamed delta. Each agent has two append-only logs:

- `transcript.jsonl`: one durable record per finished native Pi message
  (`message_end`), plus turn start/end markers. Messages stay native instead of
  being converted to UI messages. A retried provider error is retracted.
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

If the runtime dies mid-turn, the next start closes the turn automatically:
tool calls without results get an explicit "outcome unknown" result, and a
runtime notice is added so the model neither assumes success nor repeats the
effect blindly. The interrupted request completes with an `uncertain` error.
Nothing is re-driven automatically and nothing blocks later requests.

Transient provider failures (overload, rate limits, 5xx, dropped streams) are
retried in the same turn with exponential backoff (3 attempts from 2 s).
Context overflow is not retried.

Sessions load lazily and unload after `AGENT_IDLE_MS` (default 5 minutes)
without activity; the agent's process stops at the same point. When all
`AGENT_MAX_PROCESSES` slots are in use, the least recently active idle agent is
stopped to make room. Logs are local files, not replicated storage; the whole
transcript of an active agent is still held in memory.

The host provider key is only sent to trusted endpoints: the default model's,
Pi's published endpoint for the requested provider and model, or an entry in
`AGENT_ALLOWED_BASE_URLS` (comma-separated). Scoped credentials can only submit
user messages; assistant and tool-result history is produced by the runtime.

## Channels

A channel lets people talk to agents from a messaging service (Telegram for
now). Tenants manage channels with `/v1/channels` or the console's Channels page:

```sh
curl -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"telegram","credentials":{"botToken":"<from @BotFather>"},
       "template":{"systemPrompt":"You are our support assistant."},
       "access":{"allow":["@ada","123456789"]}}' \
  https://agents.camelai.dev/v1/channels
```

Creating a channel checks the bot token (`getMe`) and registers
`$AGENT_PUBLIC_URL/channels/telegram/<id>` as its webhook with a random secret,
which each delivery must echo (compared in constant time). Credentials and the
secret are encrypted with `AGENT_SECRETS_KEY`; the API returns only a masked
token. Deleting the channel removes the webhook.

- Each external conversation gets its own agent, created on first contact from
  the channel's template (model, system prompt, thinking level, client tools).
  Its prompts go through the agent's normal queue on whichever node serves it.
- Senders must be on the allowlist (Telegram user ids or @usernames) unless the
  channel sets `access.public`. Each sender is rate limited
  (`limits.perSenderPerMinute`, default 10) and the channel has a daily turn
  cap (`limits.turnsPerDay`, default 1000).
- The prompt names the sender, and tool calls carry a runtime-set `origin`
  (`{channel, conversationId, sender}`, `context.origin` in the SDKs) that
  tools can authorize against. Photos reach the model as images (up to 750 KB).
- The turn's final answer is sent back when the turn ends (split into 4,096
  character messages), with a typing indicator meanwhile. Channel agents also
  get a `send_message` tool for updates mid-turn. `/start` gets the channel's
  `greeting` without a model call.
- A webhook is recorded in Postgres before it is acknowledged, and duplicates
  (Telegram retries) are dropped by message id for seven days. Replies go
  through a durable outbox: a failed send is retried with backoff by any node,
  and a claim means one node sends each message.

`AGENT_TELEGRAM_API_URL` overrides the Bot API endpoint (tests use a local fake).

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
constructors stay inside QuickJS; they never create host functions. Each
invocation gets a separate WASM instance and interpreter heap.

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
or proof against engine vulnerabilities. Production shared-VM operation still
needs OS/container containment and resource quotas around the executor, tenant
authentication, tool-specific authorization, controlled egress for tool hosts,
and a maintained engine/security update process. Agent shutdown reaps its Unix
process group. No deployed environment has been changed.

### Remote executors

Setting `AGENT_EXECUTOR_URL` and `AGENT_EXECUTOR_TOKEN` moves `js_exec` off the
runtime host. With them set, `executeCode()` posts each program to an executor
(`src/executor/server.ts`, the same image with a different command). The
executor starts a fresh sandbox for every execution (`src/executor/sandbox.ts`):
on executor hosts, its own gVisor sandbox with no network, a read-only root and
no host mounts; in development and tests, a plain child process. Inside runs the
same code child and QuickJS limits, speaking the RPC over its stdin/stdout, and
the executor streams output back as NDJSON. The executor holds no credentials
or agent state. On hosts it reads its bearer token from Secrets Manager and
re-reads it for rotation, and it clears its own environment at startup.

Guest tool calls come back to a separate runtime listener
(`AGENT_EXECUTOR_CALLBACK_PORT`, default 8791) at
`POST /internal/executions/:id/tools`. The executor reaches that listener
through `AGENT_EXECUTOR_CALLBACK_URL`. Each call carries a random capability,
minted for that one execution, that expires at its deadline.

The agent process has no HTTP server, so the supervisor registers the
execution. The supervisor then relays each callback over IPC into the owning
agent's `executeCode`. That relay runs the same validation, quotas and
`ToolBridge` path as a local child. The runtime never trusts the executor: it
checks streamed output against the same limits. When the runtime aborts or
times out, it disconnects, and the executor kills the sandbox.

Without these variables, execution stays local and unchanged. Deployment is
covered in [`infra/executor`](infra/executor/README.md),
and the tests are in `tests/executor.test.ts`.

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
completes with an uncertain error, and the agent's next start closes the turn
with "outcome unknown" tool results; unknown side effects are never
automatically repeated. The service retries transient provider errors itself,
so no degraded retry ladder, salvage mode, or retry budget is needed in the
application.

Remaining production migration work includes model/provider reconfiguration,
billing enforcement at the inference boundary, and testing application tools
under real deployment conditions. Configuration changes during a run are rejected;
they do not abort and regenerate the turn. Nothing has been deployed.
