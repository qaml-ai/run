# Pi durable sessions

Every agent runs on `@earendil-works/pi-durable` 1.3.0, in process or inline
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
`camel.host.snapshot` document and `camel.host.record` entries. Its first load by
this release retires it, once (`HostJournal.retire`): the settled history before
the journal's base that the history index lacks is indexed from the host's records
first (the session's legacy log first, for an import too large to copy); then, in
one commit, the base marker (where the host's last snapshot stood, with the running
or waiting turn's messages before it, unless an earlier release's base marker
holds the session already), the base document, and the host document set to
`enabled: false, retired: "journal"` with a `camel.host.disabled` entry. The host
logs `host_transcript_retired`. Releases from #374 on refuse such a session with 409
`AGENT_NOT_MIGRATED` saying its history format is newer (`session_format_newer`);
earlier ones refuse it as not on Pi. Rolling back below this release is one-way.

A history index that lacks messages before a session's base (it was lost, or never
written) is logged as `history_index_behind_journal`; history reads then read those
messages from the retired host records.

## Sessions from the legacy engine

Every session the legacy engine kept was imported into Pi, when a host first opened
it or by the migration sweep (both now removed). The runtime no longer reads a
legacy transcript to import it. It still reads every format those imports wrote:

- Every session starts with `camel.legacy.migration`, and its context checkpoint
  uses `camel.legacy.context`. These persisted kinds stay the same for new agents,
  imports of initial messages and forks. Older imports follow the seed marker with
  their host generation (`camel.host.bootstrap`), archive blocks, a context
  checkpoint and request IDs. New seeds follow it with their journal history's
  base, initial history, context checkpoint and request IDs (`seedJournal`).
- An import too large to copy (more than 64 MiB or 200,000 records) left its records
  in the session's legacy log (`archive: "legacy-log"` on the marker and the
  generation). Retirement reads that log first to backfill the history index.
  New forks put their copied history into the history index, then seed their Pi
  context; they do not write a legacy log.
- Imports from before #322 have archive blocks and no generation of their own; their
  history reads the same way.

A session whose history is still only in the legacy format (its Pi host generation
missing, or disabled by an earlier release's rollback to the legacy engine) is
refused: its host logs `legacy_session_not_imported` (agent, tenant, `reason`:
`legacy_log` or `not_on_pi`), and the request fails with 409 `AGENT_NOT_MIGRATED`.
Nothing is written, so its history stays where it is, and readable (from its legacy
log, and Pi's messages past it). This refusal protects old data; it is not an
upgrade path. Every production agent is on Pi. Rollback below the host transcript's
removal is no longer supported, and the migration dashboard check is gone.

## Legacy format coverage

`GET /v1/operations/legacy-coverage` counts the live agents whose history is still
in a legacy format, which need the readers above (`src/pi-durable/retired-host.ts`,
`HostJournal.retire`, the legacy log's reads), so those can be deleted once nothing
needs them. Only the
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

## Converting legacy formats

`POST /v1/operations/legacy-migrate` converts every agent the coverage gate counts
to the current format, with the legacy readers one last time
(`src/pi-durable/legacy-migrate.ts`), so the gate reads 0. Platform operator only,
like coverage. The body is JSON: `dryRun` (default `true`: reads and checks
everything, writes nothing), `maxBytes` (default 16 MiB, at most 64 MiB, the history
index's full-read bound: the most stored history a conversion that holds it all in
memory may read), `budgetMs` (default 20000, at most 25000) and `cursor`.

It walks agents as coverage does (the same batches and probes, read-only, 20 s
statement timeouts) and converts each agent of a batch that a gate count names, one
at a time:

| `kind` | What it was | What it becomes |
| --- | --- | --- |
| `host_transcript` | A host transcript never retired. | Retired as a first load does (`HostJournal.retire`), streaming: the host's records (its legacy log's first, streamed from Storage an object at a time, a snapshot an item at a time) pass through a window holding the latest turn, and the settled history before the base the index lacks is written to it 4 MiB at a time from where it ends, so memory stays bounded whatever the history's size and a stop goes on from there; then the base, the base document and the host document retired, in one commit. `maxBytes` does not bound it. Pi's context is kept. |
| `not_on_pi` | A journal with no journal history: an import before #322 never adopted, or a rollback to the legacy engine. | Its history as the readers gave it (the legacy log's records, then Pi's messages past the newest they name) indexed whole; then, in one commit, a base after it, a context checkpoint (the context's system message, a summary, the last 20 messages) and, after a rollback, the host document retired. |
| `legacy_log` | No journal, a legacy log (from before Pi). | The log's history indexed whole, then its journal seeded after it (`seedJournal`) with a summary and the last 20 messages as its context, and its requests recorded. |
| `history_before_base` | Retired, its index short of the base. | The missing messages indexed from the retired host's records. |
| `base_document` | A base marker but no base document. | The document naming the newest marker. |

Each agent gets a result `code`: `migrated` (or `would_migrate` in a dry run),
`current` (nothing to do), `skipped_hosted` (loaded, loading or being deleted
here, or held by a live node), `skipped_busy` (runs open or queued),
`skipped_memory` (this node is past `AGENT_MEMORY_HIGH_BYTES`), `skipped_gone`
(revoked or purged), `too_large` (not a host transcript, and its journal entries and
documents, and its legacy log's objects and tail rows, measured without reading
them, before the claim and again under it, are past `maxBytes`: never read), `review` (the converter cannot read it whole or tell what it is: a journal
with no history and an empty legacy log, an index short of a base whose host
records reclaim removed, an index holding more than the records give, a rollback
after the journal had a base; nothing written) or `failed` (tried again next time).
Before converting, the node takes the agent under a claim of its own (a dry run
takes none), so no other node loads it meanwhile and a load on this node waits for
it, and lets it go after. Legacy logs are read, never written. A converted agent is
`current` the next time, so the walk can be run again until coverage reads 0.

A call answers `counts` (by code, for the walk so far), `kinds` (conversions by
kind), `results` (this call's, but `current`, up to 500), `complete`, `next`,
`dryRun` and `maxBytes`. A cursor keeps its walk's `dryRun`: a dry run's cursor is
refused for a migration. Each conversion is logged as `legacy_migrated`; a
`review` as `legacy_migrate_review` and a failure as `legacy_migrate_failed`, with
the agent and the error; each call as `legacy_migrate_called`.

```sh
url=https://run.camelai.com/v1/operations/legacy-migrate; body='{"dryRun":true}'
while :; do
  page=$(curl -fsS -X POST -H "Authorization: Bearer $op" -H 'content-type: application/json' -d "$body" "$url") || break
  jq -c '{counts, kinds, results: [.results[] | select(.code != "skipped_hosted")]}' <<<"$page"
  next=$(jq -r '.next // empty' <<<"$page")
  [ -z "$next" ] && break
  body=$(jq -nc --arg c "$next" '{dryRun: true, cursor: $c}')
done
```

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
