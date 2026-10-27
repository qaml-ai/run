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
