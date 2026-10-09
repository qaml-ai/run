# Persistence

Nothing is serialized per streamed delta. Each agent has two append-only logs:

- `transcript.jsonl`: one durable record per finished native Pi message
  (`message_end`), plus turn start/end markers. Messages stay native instead of
  being converted to UI messages. A retried provider error is retracted. The
  supervisor writes it under the agent's ownership claim; an agent in its own
  process sends records over IPC and holds no database connection.
- History chunks (`sessions/<id>/history/<start>-<count>-<hash>`, indexed in
  `agent_history_chunks`): the settled messages again, in immutable chunks of
  whole turns of about 1 MB, so a page of history (`/history?limit=`) reads a
  few index rows and the chunks it returns, never the whole log (whose snapshot
  is every record in one object). Like the log's segments, chunks are written
  when the agent stops and when what is unindexed passes a chunk's size, never
  per turn; what is newer comes from the running agent, which keeps at most
  8 MB of it in memory (past that it reads the rest back from its log to index
  it, a chunk at a time). The rest of an index behind what the agent's runs
  reported (a stop that could not write), or all of an agent's history when it
  has no index yet (made before the index), is read from its whole log, as
  `/history` without paging is, until the agent's next start indexes it.
- `<session>.journal.jsonl`: request state changes. It is fsynced only where
  correctness needs it: accepting a request, a run's start (before its first tool
  call can have an effect), and recording outcomes. Tool calls are not journaled:
  the transcript has them. Old settled records are folded away, keeping the most
  recent 256 for idempotent retries.

Streamed events (token deltas, tool progress) are kept in a bounded in-memory
buffer for SSE replay. After a host restart a client's cursor falls outside the
buffer, it receives `REPLAY_GAP`, and it recovers durable state from `/state`
and `/history`. A result never depends on its event arriving: the SDKs also
settle requests from `/state` on every reconnect, and a request still waiting
asks for its own status every 30 s (`pollMs`; Python `poll_interval`), so a
result lost with a connection, or across a deploy, still reaches its caller.
The session header (a row in `agents`) is rewritten only when
configuration or metadata changes.

If the runtime dies mid-turn, the next owner resumes the turn (see
[Turn handoff](architecture.md#turn-handoff)): tool calls without results get an explicit
"outcome unknown" result so the model neither assumes success nor repeats the
effect blindly, and the model continues from there. A turn that cannot resume
(a code execution, or one resumed twice already) is closed with a runtime notice
and its request completes with an `uncertain` error. Tool calls are never re-sent,
and nothing blocks later requests.

**Compaction.** The agent host keeps only its working set in memory: the latest
compaction summary and the messages after its cut. A compaction is one
transcript record, `{t: "compaction", summary, cut, tokensBefore, at}`, where
`cut` is the absolute index of the first message it keeps; the messages before
it stay in the log and the history index. Background compaction summarizes the
working set as it was when it began, and turns go on meanwhile: their messages
are appended after everything the summary read, so they follow the cut and stay.
The record is appended under the owner's claim like every other, and only onto
the working set it summarized (never past the history's end, nor over a newer
summary). A node that loses the agent mid-compaction cannot write its summary;
the next owner loads the transcript without it and compacts again if the context
still needs it. An agent runs one compaction at a time; a run whose context would
not fit waits for the one running instead of starting another.

Transient provider failures (overload, rate limits, 5xx, dropped streams) are
retried in the same turn with exponential backoff (3 attempts from 2 s).
Context overflow is not retried.

Sessions load lazily and unload after `AGENT_IDLE_MS` (default 5 minutes)
without activity; the agent's process stops at the same point. When all
`AGENT_MAX_AGENTS` slots are in use (hosted agents per node, processes or inline;
the tenant's busy-agent limit per tenant), the least recently active idle
agent is stopped to make room. If none is idle, creating or waking an agent is
refused with 429 (the tenant's limit) or 503 (the node's), with `Retry-After`;
the SDKs retry both.

**Busy agents per tenant, across the fleet.** An agent is busy while it has a run
open (running or queued). Each tenant may have a number of agents busy at once on
all nodes together: its entry's `maxAgents` (a positive integer) if set, else for a
self-serve tenant the operator's `maxBusyAgents` (`tenants.limits`, set with
`PUT /v1/tenants/{id}/limits`), else for a prepaid tenant its [usage tier](../reference/limits.md#usage-tiers)'s
(`AGENT_USAGE_TIERS`), else `AGENT_MAX_AGENTS_PER_TENANT` (default half of
`AGENT_MAX_AGENTS`). A run that would pass it gets 429 `BUSY_AGENT_LIMIT`. Each busy
agent has a row in `busy_agents` naming the node session that holds it, written
when its first run is accepted and deleted when its last one ends or it unloads.
Rows count only while that session's heartbeat is live, so a dead or fenced node's
agents stop counting when its actors become free to take over. Taking a slot is one
transaction under a per-tenant advisory lock that counts the live rows, reads the
limit (a prepaid tenant's tier from `credit_accounts.purchased`, in the same
transaction, so a payment applies to the next run on every node), and inserts:
nodes racing for a tenant's last slot queue on the lock, so new work never passes
the limit. Two things may: runs a node takes over from a lost or draining one, and
resumed turns, take a slot regardless, since they were accepted before; and agents
already busy when a limit is lowered (a tenants reload, a refund) keep running. Both
fall back under the limit as those runs end. A `maxAgents` change applies from the
next tenants reload (SIGHUP, or the secret's refresh every minute). The same limit
also caps the tenant's agents hosted on any one node, as above.

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

Agents name their models (`provider/model-id`); the runtime resolves each from
Pi's catalog or the tenant's own endpoints and providers, so the host provider key
is only sent to the catalog's endpoint (or the default model's), and responses on
it are priced from the catalog. Scoped credentials can only submit
user messages; assistant and tool-result history is produced by the runtime.

## Volume storage

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

Not yet built: quotas per tenant, restoring a snapshot in
place, empty directories, renames, and durable change notifications (a crash
during the one-second window drops that notification). Listings and snapshots
hold a volume's file map in memory and in one blob, which suits volumes of
up to about 100,000 files.

## Storage garbage collection

Deleting a file, volume or snapshot leaves its chunks, which other files, forks,
snapshots and transcripts may share. `src/storage-gc.ts` collects the ones nothing
refers to any more, so they stop being stored and billed:

- **References.** A chunk is kept while a live volume's files or snapshots refer to
  it, or an agent holds a FileRef to it. Each FileRef pins its chunks to its agent
  (`chunk_pins`) as it is made: attachments, files a tool saved or read natively,
  presented files, and FileRefs in a new agent's `initialMessages`. Purging an
  agent drops its pins.
- **Only chunks written since.** A chunk is collectable once a write has stored it
  (`chunk_touches`); bytes stored before collection began and never written again
  are left alone. A chunk stored before collection began and written again since is
  collectable even if a FileRef from before pins existed (migration 026) still refers
  to it, so a runtime with agents from then runs `scripts/backfill-pins.ts` once
  before enabling collection: it pins every FileRef each live agent holds (header,
  transcript, journal and history pages), counts with `--dry-run`, and is idempotent.
- **Two passes.** A pass marks what is referred to; a chunk it finds unreferenced
  becomes a candidate, and a later pass at least `AGENT_GC_GRACE_MS` (a day) on
  deletes it if it is still unreferenced and nothing touched it since. Writes, pins,
  commits that refer to existing chunks (copies and moves between volumes), forks and
  snapshots all touch the chunks they refer to, so a reference made while a pass
  runs (which a mark read piecemeal may miss) makes the collection stand down.
- **Racing writers.** A writer touches a chunk before writing it. The collector
  reads the chunk, deletes it, then checks for a touch again and puts it back if
  one came, so a write that found the chunk still there never loses it.
- **Scheduling.** Each tenant is collected every `AGENT_GC_INTERVAL_MS` (6 h) by
  whichever node claims it; a node looks for due tenants every `AGENT_GC_POLL_MS`
  (60 s). Two collections of one tenant at once each claim a chunk by its candidate
  row, so it is deleted, and taken off the storage meter, once.
- **Volumes.** A deleted volume's tree and snapshot maps are removed after the grace
  period; a deleted snapshot's map at once.
- **Switches.** Off unless `AGENT_GC_ENABLED=true` (the hosted runtime, run.camelai.com, has collected since
  2026-10-01; a self-hosted runtime collects only once you turn it on); `AGENT_GC_DRY_RUN=true` marks and
  logs what it would delete (`storage_gc_dry_run`) without deleting. Pins and which
  chunks writes created are recorded either way. To roll it out: deploy with it off,
  run `scripts/backfill-pins.ts` (in the image, so it can run as a one-off task), enable
  it with the dry run and watch the logs for a few intervals, check them with
  `scripts/verify-gc.ts --logged <tenant:hash,…>` (read-only: it fails if a due candidate is
  held by a FileRef without a pin, or a hash the dry run named is referred to at all), then
  unset the dry run. `scripts/check-storage.ts` checks the result at any time, read-only:
  every chunk a live agent's FileRefs or a live volume's files and snapshots refer to must
  still be stored.
- **Accepted gap.** A collector that crashes after deleting a chunk and before putting
  it back for a writer that touched it meanwhile loses that chunk. The window is one
  delete and one query long, and needs a writer storing the same bytes at that moment.

## File references in the transcript

The transcript stores a reference, never bytes:

```ts
type FileRef = {
  type: "file"; path: string;            // as the agent saw it, e.g. /workspace/uploads/r1/q3.pdf
  volume: string; version: number;       // the volume file it was
  size: number; contentType: string;
  chunks: string[];                      // its content: content-addressed chunks, never rewritten
  media?: { kind: "image"; mimeType: string; width: number; height: number } | { kind: "pdf"; pages: number } | { kind: "none"; reason: string };
};
```

The chunk list pins the content, so a file deleted or overwritten after it was
attached still reads as it was, for as long as the agent exists (see
[Storage garbage collection](#storage-garbage-collection)). The agent host hydrates references into native blocks
each time it builds a model request, fetching the bytes through its supervisor
(an agent process has no storage access) and keeping up to 32 MiB of them
between requests. The same references always produce the same request, so the
provider's cached prefix holds. Request records keep references too, so a queued
prompt's journal entry is small. Context estimates count what a reference stands
for (an image like one of pi's, a PDF at about 3,000 tokens a page), not its JSON,
so compaction triggers as it would for the bytes.
