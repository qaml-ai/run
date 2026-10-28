# Pi durable sessions

Every agent runs on `@earendil-works/pi-durable`, built from a commit of Pi's main ([Vendored Pi](pi-vendoring.md)), in process or inline
hosting. The earlier pi-agent-core loop (the "legacy" engine) was removed: no
session runs on it, and nothing rolls a session back to it. `AGENT_ENGINE`,
`AGENT_PI_CANARY_AGENTS` and `AGENT_PI_CANARY_TENANTS` are ignored; a node that has
them set starts and logs `settings_ignored` once.

## Ownership of state

Pi owns model/tool execution, canonical history and compaction. Native compaction
uses the scaled reserve/recent-context limits and has background speculation
disabled. Camel supplies credentials, lease and network checks, tools, sandbox
execution, human-input handling, output schemas, run limits and provider retry
policy.

An agent's history and its model context are Pi's journal alone
(`src/pi-durable/host-journal.ts`). Pi's own messages are history as Pi commits
them. The host writes the messages it makes itself (repairs, answers to calls that
waited on a person, messages that land without a turn) as native entries
(`camel.message`, `camel.user`), its system changes as `camel.system` entries (in
Pi's context, never history), and its retractions, turns, calls left waiting and
skips as `camel.history.marker` entries; a retraction or skip also takes its
messages out of Pi's context with an `omit` edit. `JournalHistory`
(`src/pi-durable/history.ts`) reads the history back from a base marker: the
messages before it are the history index's. Once a session's history has grown
256 messages past its base and the index holds all of it, the next turn's end
writes a new base (the `camel.history.base` document names the newest), so a load
reads the journal from there. Request deduplication uses Pi's indexed submissions.

A run's working context is Pi's own; nothing checks the host's in again. A new
agent's context starts with its leading system message, as a checkpoint
(`camel.legacy.context`); one with no history yet rebuilds it there when its
configuration changes. Every request sends Pi's context as it stands (a prompt's
deprecated `history: "none"` is ignored).

Full history, export and fork read the history index, then the journal past it.

## Sessions from before the host transcript's removal

Releases before it kept a host transcript beside Pi's journal: a latest-only
`camel.host.snapshot` document and `camel.host.record` entries. Releases from #374
to #465 retired it at a session's first load, once: the settled history before
the journal's base that the history index lacked was indexed from the host's
records (the session's legacy log first, for an import too large to copy); then,
in one commit, the base marker (where the host's last snapshot stood, with the
running or waiting turn's messages before it, unless an earlier release's base
marker held the session already), the base document, and the host document set to
`enabled: false, retired: "journal"` with a `camel.host.disabled` entry.

Since #465 the runtime no longer reads the host's records or the legacy log. An
agent whose history is still in such a format is refused with 409
`AGENT_NOT_MIGRATED`, its storage untouched, and logged as `legacy_format_refused`
with a `kind`: `host_transcript` (never retired), `not_on_pi` (a journal with no
journal history: an import before #322 never adopted, or a session an earlier
release rolled back to the legacy engine), `legacy_log` (no journal, only a legacy
log) or `history_before_base` (a history read reaches before the base, and the
index lacks it). None should be left: `POST /v1/operations/legacy-migrate` (#466,
#468, removed with the readers) converted every agent in those formats, and legacy
coverage read 0 before the readers went. The refusal stays as a guard against
losing history, never as an upgrade path.

## Sessions from the legacy engine

Every session the legacy engine kept was imported into Pi, when a host first opened
it or by the migration sweep (both now removed). Those imports wrote:

- Every session starts with `camel.legacy.migration`, and its context checkpoint
  uses `camel.legacy.context`. These persisted kinds stay the same for new agents,
  imports of initial messages and forks. Older imports follow the seed marker with
  their host generation (`camel.host.bootstrap`), archive blocks, a context
  checkpoint and request IDs. New seeds follow it with their journal history's
  base, initial history, context checkpoint and request IDs (`seedJournal`).
- An import too large to copy (more than 64 MiB or 200,000 records) left its records
  in the session's legacy log (`archive: "legacy-log"` on the marker and the
  generation). New forks put their copied history into the history index, then
  seed their Pi context; they do not write a legacy log.
- Imports from before #322 have archive blocks (`camel.legacy.record`) and their
  host generation, if a host adopted them, after the archive.

## Legacy format coverage

`GET /v1/operations/legacy-coverage` counts the live agents whose history is still
in a legacy format, which this release refuses (above). It read 0 before the
readers were deleted, and stays as a check that none appears. Only the
platform operator calls it: an operator token of a tenant in
`AGENT_BILLING_ADMINS`; API tokens, console sessions and OAuth tokens get 403. It
is not part of the documented API.

It walks the agents in id order, 500 at a time, for about 20 s per call
(`?budgetMs=`, at most 25000), and answers the counts so far with `complete` and
`next`, a cursor that carries them: call again with `?cursor=<next>` until
`complete` is true. Every call moves the walk on. One call at a time per node
(another gets 429).

```sh
op=$(aws secretsmanager get-secret-value --region us-west-2 --secret-id camelai/agent-runtime/operator-token/miguel --query SecretString --output text)
url=https://run.camelai.com/v1/operations/legacy-coverage; args=()
while :; do
  page=$(curl -fsS -G -H "Authorization: Bearer $op" "${args[@]}" "$url") || break
  next=$(jq -r '.next // empty' <<<"$page")
  [ -z "$next" ] && { jq . <<<"$page"; break; }
  args=(--data-urlencode "cursor=$next")
done
```

The last page has `counts`, `checked`, `gate`, `examples` (up to 20 agent ids per
nonzero bucket, ids only), `generatedAt` (when the walk began), `durationMs` (that
call), `totalDurationMs` and `calls`. An agent has a journal when its session has
an entry (Pi storage a refused start opened and left empty is none):

| Count | What it is |
| --- | --- |
| `unretired_host_transcripts` | A `camel.host.snapshot` document whose latest revision is not the retirement's (`retired: "journal"`, written in the commit with the `camel.host.disabled` entry): an enabled host transcript, or one a rollback disabled. Found by the document, so imports before #322, whose host generation comes after their archive, count too. |
| `retired_index_short` | A host session (a host generation among its first three entries, or a host document) retired, but the history index holds less than the newest journal base's `total` less its `kept` (or there is no base or no index row): history reads still need the retired records. |
| `pi_without_journal_history` | A journal with no `camel.history.base` document and no `camel.history.marker` entry: legacy format only, read from the legacy log. |
| `pi_without_base_document` | A journal with no `camel.history.base` document. Every session seeded or retired since #374 has one, so this is a superset of the one above: it also counts journals with history markers but no base marker the readers could open. |
| `no_pi_with_legacy_log_rows` | No journal, and the legacy log (`sessions/<id>/transcript`) still has hot `log_records` rows. |
| `no_pi_with_legacy_log_objects` | No journal, no hot rows, and the legacy log has segments or snapshots in Storage (listed, 16 at a time; `checked.legacyLogObjects` says the walk did). |
| `agents_without_pi_storage` | No journal at all: agents never started, or pre-Pi agents. The upper bound of the two above. |
| `agents_total` | Every `agents` row. |

`gate.ready` is true when the walk is complete, Storage was listed, and every count
but the last two is 0 (`gate.blocking` names those that are not). `gate.review` is
kept, always empty. Only agents with an `agents` row count, revoked ones until
their purge; a purged agent's tombstone counts only in `agents_total`, whatever a
failed purge left behind (the readers never read it).

Each batch is its own read-only transaction, each statement stopped after 20 s.
It never scans `pi_durable_entries` (a whole scan timed out at 60 s in
production): each agent gets a few index lookups (`LEGACY_COVERAGE_QUERIES` in
`src/legacy-coverage.ts`, for EXPLAIN): its first entry, and its first three for a
host generation; its host and base documents and their latest revisions; the base
marker its base names; and, only for a journal with no base document, its entries
newest first until a history marker. Entry kinds are matched in a record's first
200 characters (records are written `id`, `conversationId`, `kind` first, so a
message quoting a kind never matches), so no whole TOASTed entry is read; a host
document's latest revision is read whole, once per host session still holding one.
Agents with no journal and no hot rows then have their legacy log listed in
Storage, outside the transaction. Each call is logged as `legacy_coverage_viewed`
with the counts so far.

## History ordinals

Each history entry in Pi storage carries its place in the agent's history
(`src/pi-durable/ordinals.ts`): `pi_durable_entries.msg_from` and `msg_count` (its
messages are history messages `msg_from` .. `msg_from + msg_count - 1`, its own
history messages from its `msg_skip`-th on), and `turn_start` on a turn marker that
opens a turn, at `msg_from`. `pi_durable_metadata.history_next` is the history's
length and `history_last_id` the newest session entry committed with it. History
reads find messages by ordinal from these (plans/thin-host-slimdown-2.md §6.1).

`PostgresPiStorage.commit` places each entry as it commits, under the session's
metadata lock, as `JournalHistory` counts the journal: native messages in entry ID
order (one committed after a later one takes its place, and those after it move
up), a `retract` marker takes back the latest message (the next message takes its
place), a session's first `base` marker opens the history at its `total` (its
`kept` messages are placed on the marker itself), and a `pi` skip marker unplaces
the session (`history_ordinals_unplaced`) for the fill to place again. A new
session starts placed (`history_next` 0); sessions from before ordinals start
unplaced (null), and a base or retract that does not match logs
`history_ordinal_mismatch`.

`POST /v1/operations/history-ordinals` (platform operator only, as legacy coverage)
places every unplaced agent: a dry run unless the body says `dryRun: false`. It
walks agents in id order, 500 at a time, for about 20 s per call (`budgetMs`, at
most 25000) and answers `next` to go on from (a dry run's cursor goes on as a dry
run). Each agent is placed under its session's metadata lock (its commits wait),
from its first base marker on, reading its entries 250 at a time with their records
parsed in Postgres (never on the node), every statement stopped after 20 s; an
agent with more than `maxEntries` session entries (200,000 by default, at most
2,000,000) is reported `too_large`, not read. Placing is idempotent: a placed agent
whose newest session entry is placed is `current`; one with entries written since
by a release that did not place them (`stale`, during the deploy) is placed again.
Result codes: `placed`/`would_place`, `current`, `no_journal`, `no_base` (entries but
no base marker: refused by loads anyway), `too_large`, `irregular` (a later base
that does not stand where the history does, or an entry whose messages are not one
run: left for a person, `error` says where), `failed`. Calls are logged as
`history_ordinals_called`.

`GET /v1/operations/history-ordinals-coverage` walks the same way and counts agents:
`placed`, `unplaced` (Pi storage, never placed), `stale`, `no_journal` (no Pi
storage), `agents_total`; `gate.ready` once the walk is complete with `unplaced` and
`stale` at 0, `examples` up to 20 ids per nonzero bucket. Each batch is one
read-only transaction of index probes per agent (its metadata row and newest
session entry), statements stopped after 20 s; calls are logged as
`history_ordinals_coverage_viewed`. One ordinals call at a time per node (429).

## Persistence and billing

Normal nodes store Pi data in the session-scoped `pi_durable_*` Postgres tables
(migration 078). Mutations and ID reservations use the owner's claim and serialize
on the session metadata row. A former owner cannot write after takeover. Child
processes access storage through their supervisor.

A standalone supervisor without a database uses `pi-durable.sqlite`, created with
mode `0600` and `synchronous=FULL`. This is a local, single-owner configuration.
Shared storage without a supervisor database is refused.

Migration 079 adds `pi_usage_receipts`. Production model calls retain the existing durable model-attempt accounting,
including end-user credit holds. A response already settled by that path never
creates a second receipt. For untracked calls on Postgres, the native response
commits its fallback receipt and agent spend increment in the same transaction
as its canonical entry. Summary responses have durable `camel.compaction.usage`
entries. Live usage notifications wake accounting without counting a second copy.
Workers claim receipts with row locks and atomically commit daily usage, prepaid
charges, webhook events and receipt completion. Startup drains surviving receipts;
concurrent workers and retries cannot charge a receipt twice.

Recovery does not replay arbitrary tool side effects. Committed results are reused;
unknown interrupted outcomes are closed as unknown, with the existing special
handling for safe runtime delegation. Temporary human-wait results remain outside
completed public history. Session purge removes the native journal; account deletion
also removes its receipt records after the normal accounting flush.

## Local validation

The tests cover retiring every shape above (tests/fixtures/host-transcript.ts writes
them as the releases before did), inline/process hosting, old request IDs, exact full
history, forks, human answers, lost commits of the host's markers, native compaction
failures, transaction rollback and concurrent receipt consumption. Cluster tests exercise Postgres
handoff, cross-node human input, forks and exports.

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/pi-durable-*.test.ts tests/agent-host.test.ts
```

See the [integrated comparison](../../benchmarks/session-memory/INTEGRATED-NATIVE.md)
for the actual host workload and raw trials.

Storage metering is deferred at the operator's request; the current object-storage
meter does not measure the new Postgres bodies.
