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

The host stores its bounded working state in a latest-only `camel.host.snapshot`
document. Immutable `camel.host.record` entries preserve turns, resets,
retractions, configuration changes and human waits. A record for a native message
references its canonical entry rather than copying the message body. The host
record and checkpoint commit atomically. Loading reads the checkpoint and any
unacknowledged native tail, without replaying a legacy transcript or retaining
lifetime request/tool-ID maps. Request deduplication uses Pi's indexed submissions.

Full history, export and fork operations reconstruct immutable history on demand;
they are intentionally separate from bounded host loading.

## Sessions from the legacy engine

Every session the legacy engine kept was imported into Pi, when a host first opened
it or by the migration sweep (both now removed). The runtime no longer reads a
legacy transcript to import it. It still reads every format those imports wrote:

- A session's Pi storage starts with a seed marker (`camel.legacy.migration`), then
  its host generation (`camel.host.bootstrap`) with the records it started with as
  archive blocks, a context checkpoint and its request IDs, all in one commit. New
  agents and forks are seeded the same way (`NativeTranscript.seed`); releases before
  #326 refuse a root without the marker.
- An import too large to copy (more than 64 MiB or 200,000 records) left its records
  in the session's legacy log (`archive: "legacy-log"` on the marker and the
  generation). That log is read-only: the generation's history reads it first,
  live, cold and for exports. A fork that large is seeded the same way, into its
  own legacy log.
- Imports from before #322 have archive blocks and no generation of their own; their
  history reads the same way.

A session whose history is still only in the legacy format (its Pi host generation
missing, or disabled by an earlier release's rollback to the legacy engine) is
refused: its host logs `legacy_session_not_imported` (agent, tenant, `reason`:
`legacy_log` or `not_on_pi`), and the request fails with 409 `AGENT_NOT_MIGRATED`.
Nothing is written, so its history stays where it is, and readable. To import one,
run it on a release that still has the importer (before the importer's removal),
then come back. The operator dashboard's "Agents not on Pi" counts them.

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

The tests cover import of every shape above, inline/process hosting, bounded
reload, old request IDs, exact full history, forks, human answers, failed host
checkpoints, lost commit acknowledgements, native compaction failures, transaction
rollback and concurrent receipt consumption. Cluster tests exercise Postgres
handoff, cross-node human input, forks and exports.

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/pi-durable-*.test.ts tests/agent-host.test.ts
```

See the [integrated comparison](../../benchmarks/session-memory/INTEGRATED-NATIVE.md)
for the actual host workload and raw trials.

Storage metering is deferred at the operator's request; the current object-storage
meter does not measure the new Postgres bodies.
