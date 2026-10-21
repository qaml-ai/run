# Pi durable sessions

The runtime has an opt-in replacement backed by `@earendil-works/pi-durable`
1.3.0. The default remains the current pi-agent-core runtime (`legacy`). The code is deployed with Pi disabled; activation and migration are separate rollout steps.

```sh
AGENT_ENGINE=pi-durable npm start
```

Both `AGENT_HOSTING=inline` and `process` are supported. The choice applies when a
host opens; already awake hosts retain their engine. Setting `AGENT_ENGINE=legacy`
selects the current runtime again.

## Canary before cutover

Keep `AGENT_ENGINE=legacy` and set `AGENT_PI_CANARY_AGENTS` or
`AGENT_PI_CANARY_TENANTS` to comma-separated exact IDs chosen by the operator.
Apply the same allowlist on every node. Selected sessions use Pi on their next
host open; every other session keeps the default engine. Existing active hosts
finish on their current engine. These settings cannot be changed by tenants.

Exercise a new session and an existing idle session, check retained history and
request IDs, tools, human-input resume, and cross-node reload. Observe memory,
CPU, latency and errors before broadening the cohort. Removing an ID reopens it
on the default engine and uses the documented rollback path. Once the canary is
accepted, `AGENT_ENGINE=pi-durable` selects Pi fleet-wide; keep the old engine and
migration support while deferred sessions or rollback needs remain.

## Ownership of state

Pi owns model/tool execution, canonical history and compaction on the opt-in
path. Native compaction uses the scaled reserve/recent-context limits and has
background speculation disabled. Camel supplies credentials, lease and network
checks, tools, sandbox execution, human-input handling, output schemas, run
limits and provider retry policy. The legacy compactor remains available to the
legacy engine; it does not run alongside native compaction.

The host stores its bounded working state in a latest-only `camel.host.snapshot`
document. Immutable `camel.host.record` entries preserve turns, resets,
retractions, configuration changes and human waits. A record for a native message
references its canonical entry rather than copying the message body. The host
record and checkpoint commit atomically. Loading reads the checkpoint and any
unacknowledged native tail, without replaying the legacy transcript or retaining
lifetime request/tool-ID maps. Request deduplication uses Pi's indexed submissions.

Full history, export and fork operations reconstruct immutable history on demand;
they are intentionally separate from bounded host loading. The original legacy
transcript is not appended during normal native operation.

## Migration and rollback

Eligible sessions migrate when next opened. `AGENT_PI_SWEEP` (off by default) opens the
remaining idle legacy sessions one at a time so they migrate without waiting for traffic: run it
with `dry-run` first, which logs each candidate's predicted outcome (`would_migrate` or
`deferred_<reason>`) and writes nothing, then with `on`. The admin health page counts agents still
on the legacy engine.
An active legacy turn or a human wait continues on its original engine, and can
migrate on a later idle open. Contexts that Pi would normalize differently defer
migration rather than silently changing provider history.

Migration retains public session IDs, configuration, credentials, request
journals, attachments, volume files and API routes. Original records, opaque
provider fields, system changes, summaries, retractions, request IDs and tool
identities are preserved. The initial archive and indexed historical request
submissions commit atomically. A fingerprint detects conflicting imports.

The host adopts the existing effective history into its native generation before
it begins writing native control records. This can include work performed during
a previous rollback. Automatic import and adoption are limited to 64 MiB of
serialized source records and 200,000 records. Larger sources remain on the legacy
engine with `migration: { state: "deferred", reason: "size_limit" }`; no history
is deleted and retrying an open is safe. The limits also apply to adoption after
rollback, while already migrated native sessions reload normally regardless of
archive size.

File imports check size before allocating the source. Shared-storage imports
check object sizes and Postgres tail bytes before downloading/parsing bodies;
missing size information also defers migration. Checks count obsolete objects
conservatively, so some eligible histories may defer. The supervisor applies the
bound before transferring an archive to a child. First imports remain serialized
per node. These are source-size limits, not a hard process RSS cap: parsing and
native commits need additional memory, and normal legacy loading/export/rollback
keep their existing behavior. There is no streaming bulk importer yet.

For rollback, reopen with `AGENT_ENGINE=legacy`. The host first exports the native
history and atomically rebuilds the legacy transcript, then marks the native host
generation inactive. Pending native work is retired before legacy execution.
Keep both stores. A later opt-in creates a fresh native host generation from the
current legacy history, including intervening legacy turns. Rollback changes no
public IDs and does not delete the native archive.

## Persistence and billing

Normal nodes store Pi data in the session-scoped `pi_durable_*` Postgres tables
(migration 078). Mutations and ID reservations use the owner's claim and serialize
on the session metadata row. A former owner cannot write after takeover. Child
processes access storage through their supervisor.

A standalone supervisor without a database uses `pi-durable.sqlite`, created with
mode `0600` and `synchronous=FULL`. This is a local, single-owner configuration.
Shared legacy storage without a supervisor database is refused for Pi execution.

Migration 079 adds `pi_usage_receipts`. Production model calls retain the existing durable model-attempt accounting,
including end-user credit holds. A response already settled by that path never
creates a second receipt. For untracked calls on Postgres, the native response
commits its fallback receipt and agent spend increment in the same transaction
as its canonical entry. Summary responses have durable `camel.compaction.usage`
entries. Live usage notifications wake accounting without counting a second copy.
Workers claim receipts with row locks and atomically commit daily usage, prepaid
charges, webhook events and receipt completion. Startup drains surviving receipts;
concurrent workers and retries cannot charge a receipt twice. Legacy-engine usage
retains its existing model-attempt accounting behavior.

Recovery does not replay arbitrary tool side effects. Committed results are reused;
unknown interrupted outcomes are closed as unknown, with the existing special
handling for safe runtime delegation. Temporary human-wait results remain outside
completed public history. Session purge removes the native journal; account deletion
also removes its receipt records after the normal accounting flush.

## Local validation and rollout gates

The tests cover inline/process migration and rollback, bounded reload, old request
IDs, exact full history, forks, human answers, failed host checkpoints, lost commit
acknowledgements, native compaction failures, transaction rollback and concurrent
receipt consumption. Existing cluster tests exercise Postgres handoff, cross-node
human input, forks and exports with the opt-in engine.

```sh
node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/pi-durable-*.test.ts
AGENT_ENGINE=pi-durable AGENT_HOSTING=inline node --experimental-strip-types --disable-warning=ExperimentalWarning --test tests/human-input.test.ts tests/cluster-handoff.test.ts tests/cluster-step-handoff.test.ts tests/cluster-fork.test.ts tests/cluster-export.test.ts tests/fresh-history.test.ts tests/history-import.test.ts
```

See the [integrated comparison](../../benchmarks/session-memory/INTEGRATED-NATIVE.md)
for the actual host workload and raw trials. The earlier
[compatibility-adapter comparison](../../benchmarks/session-memory/INTEGRATION.md)
and [native prototype](../../benchmarks/session-memory/REPLACEMENT.md) measured
different implementations and should not be substituted for this comparison.

Storage metering is deferred at the operator's request; the current object-storage
meter does not measure the new Postgres bodies. Real-provider summary quality,
production concurrency and a staged rollout remain unverified by these local tests.
Oversized legacy sessions need a separately planned import if they must move to Pi.
