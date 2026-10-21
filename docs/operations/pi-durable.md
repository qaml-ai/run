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

## Importing legacy sessions

A session the legacy engine wrote (its `sessions/<id>/transcript` log) is imported
the first time a host opens it. The import is one-way and runs once: the host reads
the log, imports it as it stands, and from then on writes only Pi storage. Nothing
writes the legacy log again; it is kept, and readers still read it where needed.

The import keeps public session IDs, configuration, credentials, request journals,
attachments, volume files and API routes; original records, opaque provider
fields, system changes, summaries, retractions, request IDs and tool identities.
The archive, the historical request submissions (so a retried old request is
`taken`, never run again), the context checkpoint and the host generation commit
atomically. A fingerprint detects a conflicting import.

Whatever the legacy engine left is imported as it is; recovery then runs on Pi as
it does for any session on Pi:

| The log held | Outcome |
| --- | --- |
| A turn its node lost mid-run (`from: "active"`) | Imported with the turn open. A resumed run retracts a cut-off response, answers calls whose outcome was lost as unknown (never runs them again), makes again only the calls keyed by the call (`delegate` and the other multi-agent tools), and continues on Pi. Without a resume, the turn is closed as interrupted. |
| A tool waiting on a person (`from: "awaiting"`) | Imported with the call open. Its answer resumes the turn on Pi; a new message closes it first, as on Pi. |
| A context Pi orders its own way (`from: "context_changed"`): failed or aborted responses, results out of call order, a call without a result | Imported whole. Pi builds each request from it as it does for any context: failed and aborted responses left out, results in call order, a missing result given one saying so. Requests already went through the same normalization under the legacy engine (pi-ai's `transformMessages`), except for the order of results. |
| More than 64 MiB or 200,000 records | Imported without copying the archive (`archive: "legacy-log"`): the host generation starts from the working set as the host loaded it, and its history reader reads the legacy log first. The log is never read whole to import it. |

The host logs `legacy_session_imported` with `state` (`migrated` for a first
import, `adopted` for a session an earlier release imported without a host
generation or rolled back to the legacy engine), `from` and `archive`.

Sessions an earlier release rolled back (`AGENT_ENGINE=legacy` left a
`camel.host.disabled` entry and rebuilt the legacy log from Pi's history, which the
legacy engine then appended to) are adopted again: the native messages the log
lacks are copied to it, and the whole log becomes the archive of a new host
generation. The same applies to imports an earlier release made without a host
generation.

During a rolling deploy, a node on the previous release takes over imported
sessions on Pi as before, since that release has the Pi engine and the importer.
It does not read a by-reference archive (`archive: "legacy-log"`): there, its
history reads show only what followed the import until the session is back on a
node of this release.

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
