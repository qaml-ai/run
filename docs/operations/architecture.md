# Architecture

```text
app (TypeScript / Python SDK, HTTP + SSE)
  -> any runtime node --forwarded to--> the node that owns the agent
      -> agent host (Pi loop, working-set transcript, compaction, retries)
          -> QuickJS/WASM sandbox (restored from a clean snapshot for every execution, on a pool of worker threads)
              -> JSON tool calls -> back to the app's SDK callbacks
  control plane: Postgres (ownership, headers, accounts, schedules, channels, volume metadata)
  data plane: Storage (append logs and blobs, S3 in production)
```

Postgres is the control plane: every piece of small mutable state and all
coordination. Storage is the data plane: bulk data that is appended or written
once. The runtime does not start without a database.

| Postgres (`migrations/`) | Storage (`AGENT_STORAGE`) |
| --- | --- |
| node heartbeats and actor ownership | agent transcripts and request journals (append logs) |
| the recent records of each append log (`log_records`) | |
| agent headers: identity, configuration, mounts; the tenant index | volume trees (append logs) |
| console tenants, sealed provider keys and key scopes, API tokens, usage | volume chunks and snapshot file maps (blobs, written once) |
| agent definitions (tool credentials sealed) | |
| schedules and their claims | |
| channels, conversations, the outbox, dedupe markers, rate counters | |
| volume headers, snapshots, watchers | |
| agent spend limits, usage webhooks, webhook endpoints and their outboxes | |

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

**Work no one is watching.** An agent's row is marked when its first run of a
busy spell opens (`pending_runs`) and cleared when it unloads with none open. An
agent so marked with no live owner (its node died mid-turn, or a drain left runs
queued for the next owner) resumes when a node loads it: for a request that acts
on it (a prompt, an application connecting), or in a sweep every node runs
(`AGENT_ORPHAN_SWEEP_MS`, default 30 s, 0 for none), for as many such agents as
it has room for, its tenant's quota included. Reads never load it: they answer
from storage. A node without room for the work answers an acting request 503
with `Retry-After`, to reach one with room; one that loaded the agent but lost
its room before a run began gives it back, still marked, for an interval. A
failed load puts the next off by the sweep's interval, doubling, at most an
hour, never for good; the agent's listing and state show it (`resume: {failures,
after}`).

**Deleting agents.** `DELETE /v1/agents/:id` (or `/clients/:id`) revokes the
agent, stops it and unloads it at once. A sweep every node runs
(`AGENT_PURGE_INTERVAL_MS`, default a minute; started at once after a delete)
then purges every revoked or expired agent no live node holds: its journal and
transcript objects (segments, snapshots, blobs), tail rows, local directory,
schedules, channel bindings, email threads (addresses, subjects, Message-IDs)
and volume watches. Nodes claim agents with
`FOR UPDATE SKIP LOCKED` and a five-minute lease, and every step is idempotent,
so a purge that fails or whose node dies is retried. The row stays as a tombstone
holding only the agent's id (no tenant, token hash, name or model): the id is
derived from the tenant and idempotency key, so neither is ever reused,
`/v1/agents/:id` answers 404 and `/clients/:id` 410. Deleting a channel deletes
its queued items and its email threads' metadata too. Logs written before the tail existed are
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
  started, the task is superseded. It retires once that deployment runs all its
  tasks (or after `AGENT_RETIRE_WAIT_MS`, default 10 min, so a stuck deployment
  cannot keep it) and a peer that is not retiring has joined; until then it serves
  as before, so a deploy never leaves work with nowhere to go. Retiring, it takes no
  new agents or volumes (requests for them go to a live peer, as when draining; a
  request a peer forwarded to it by a stale cache goes on once more), lets running turns finish for up to
  `AGENT_RETIRE_MAX_MS` (default 6 h), gives up each agent and volume as soon as
  nothing runs on it (closing its event stream so the client reconnects to the new
  owner), and clears protection once idle. ECS then stops it and the drain finds
  nothing to do. `/healthz` stays 200 while retiring: ECS replaces tasks that fail
  their health check, protected or not, so the task keeps the load balancer's
  traffic and hands it on. A retiring task that finds no such peer any more serves
  again (`retire_paused`), and retires once one joins.

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
hosted or not), `volumes` (volumes it serves), `runningTurns` and `rssBytes`, with no dimension
or `ServiceName` from `AGENT_SERVICE_NAME`, plus `watchers` (event stream subscribers)
and the database pool's `dbConnections`, `dbIdle` and `dbWaiting`. CloudWatch Logs extracts them
without API calls, so they can drive target-tracking scaling.

Other lines in the same format (`src/metrics.ts`), each metric under `ServiceName` and the
dimension sets listed:

| line (`type`) | when | metrics | dimensions |
| --- | --- | --- | --- |
| `turn_metrics` | a turn (prompt, continue, resume) ends | `Turns`, `TurnDurationMs`, `TimeToFirstTokenMs`, `ModelResponses`, `ModelRetries`, `ToolCalls`, `ToolErrors` | `Outcome` (completed, failed, input_required, spend_limit, turn_limit), `ErrorClass`, `Provider`+`Model` |
| `model_error` | a model response fails (retried or not) | `ModelErrors` | `Provider`+`Model`, `ErrorClass` |
| `run_events` | run events are written to the outbox | `RunsStarted`, `RunsResumed`, `RunsCompleted`, `RunsInputRequired`, `RunsSpendLimited`, `RunsTurnLimited`, `RunsFailed`, `RunsUncertain` | `Tenant` |
| `run_failed` | the same, per failed run | `RunsFailedByClass` | `ErrorClass`, `Tenant`+`ErrorClass` |
| `model_cost` | usage events are written | `ModelCostUsd`, `ModelUsageEvents` | `Tenant`, `Provider`+`Model` |
| `webhook_delivered` / `webhook_failed` | a delivery succeeds / fails | `WebhooksDelivered`, `WebhookDeliveryLagMs`, `WebhookAttempts` / `WebhooksFailed` | `Kind` (endpoint, usage) |
| `webhook_backlog` | every minute, from each node (read with Maximum) | `WebhookBacklog`, `WebhookOldestPendingMs` | |
| `code_execution` | a js_exec execution (or `execute`) ends; properties `tenant`, `timeoutMs` (what it got) and `requestedTimeoutMs` | `CodeExecutions`, `CodeDurationMs`, `CodeCpuMs` (guest CPU, when it finished) | `ErrorClass` (none, cpu_limit, guest_limit, timeout_tool, timeout_waiting_worker, timeout, aborted, worker_exited, memory, tool_limit, syntax, guest_error) |
| `watch_refused` | an event stream subscriber is refused (429) at a limit | `WatchersRefused` | `Scope` (agent, tenant, node), `Tenant` |

`ErrorClass` is one of rate_limit, overloaded, context_overflow, auth, billing, timeout,
provider_5xx, network, runtime_restart, exception, other (none for a success). A failed
tool call also logs `tool_failed` with the tool's name, the tenant and the error's class
(js_exec's as for `code_execution`), never its text (not a metric). Run events exist
only for tenants with an endpoint for them. An agent in its own process
(`AGENT_HOSTING=process`) writes its lines to stderr. Alarms and the launch dashboard
on them are in `infra/terraform/observability.tf`.

**What logs hold.** Log lines carry ids (tenant, agent, request, channel, item),
counts, sizes and durations, never what a user wrote: no prompt, transcript, tool
arguments or results, file names or contents, or email addresses, subjects or bodies.
An error from a model provider, a channel, a tool server or a request can echo such
text, so those lines carry `safeError(error)` (`src/metrics.ts`): the error's class,
its name, status and code, and its message's length, not the message. Only background
work over the runtime's own tables and services (database, ECS, sweeps) logs an error's
message. `tests/log-privacy.test.ts` scans every log call in `src/` and `shared/`
and fails on a content field, or on a raw error message outside that list. An agent process's stderr is
piped through `childStderr` (`src/child-stderr.ts`): its own JSON lines pass, and anything else (a crash's
stack trace, a library warning) becomes one `agent_stderr` line with the error's name and class, the first
frame's file and line, and the text's size.

Schedules and channel work items are claimed with `FOR UPDATE SKIP LOCKED` and a
claim deadline, so one node delivers each; a crashed node's claims lapse.
