# Reclaim superseded journal checkpoints

Stage 1 removes obsolete context copies from Postgres. An operator runs this command with the runtime's
`AGENT_DATABASE_URL`, or `AGENT_DATABASE_HOST` and `AGENT_DATABASE_SECRET_ARN` settings (including its usual TLS settings).
Deploy the fork-boundary change to all readers before applying reclaim: journal forks before the newest retained
context head return `400 FORK_POINT_INVALID`, asking for a later message.

Start with a read-only inventory (dry run is also the default):

```sh
node --experimental-strip-types scripts/ops/reclaim-checkpoints.ts --dry-run
```

Review the `reclaim_session` JSON lines and `reclaim_total` totals. Rows and bytes are the entries' serialized text
sizes, not a promise of immediate disk space returned to the filesystem. No record content is printed.
Use `--session ID` to inspect or apply to one session. Sessions with no obsolete rows are omitted.

Apply to a small batch, then dry-run each applied session ID from the log and check that those agents still open,
run, page history, and fork at a recent message:

```sh
node --experimental-strip-types scripts/ops/reclaim-checkpoints.ts --apply --limit 5
node --experimental-strip-types scripts/ops/reclaim-checkpoints.ts --dry-run --session ID_FROM_APPLY
```

Then apply across the remaining sessions:

```sh
node --experimental-strip-types scripts/ops/reclaim-checkpoints.ts --apply
node --experimental-strip-types scripts/ops/reclaim-checkpoints.ts --dry-run
```

Discovery reads at most 100 session IDs per batch, ordered by ID. `--limit N` bounds candidate sessions considered,
including skips. Each session has its own transaction. An interrupted apply can be run again: committed sessions
have no obsolete rows left, and an interrupted transaction rolls back. Retry busy or locked sessions on a later run.

A session is skipped if it has a live owner (matching node and lease in `actor_owners` / `runtime_nodes`, including
draining nodes), `agents.pending_runs`, or any nonterminal `pi_durable_tasks` row. Apply locks the ownership row,
the agent row and Pi metadata row, then rechecks idleness before deleting. A missing ownership row is inserted
empty in that transaction so first acquisition also waits. Locks are held until commit; contention is skipped.
Dry runs use read-only transactions and write no claim rows. Their counts can change before apply.

For root conversation 1, the boundary is `head` of the newest entry with a non-null head. Only entries with IDs
strictly below that boundary and kinds `camel.legacy.context`, `camel.context.message` or `pi.system` are deleted.
Other conversations and all entries at or above the boundary stay. A compaction's retained head can precede the
compaction marker's own ID; a fork at that retained head uses that compaction's summary.

Never removed: native messages (`pi.user`, `pi.assistant`, `pi.tool-result`, `camel.user`, `camel.message`), history
markers including the base (`camel.history.marker`), compactions (`pi.compaction`, `camel.compaction.usage`), the
seed marker (`camel.legacy.migration`), `camel.host.bootstrap`, or any `pi_durable_record_ids` row. Reserved IDs
remain reserved forever. Stage 2 data, including host records, archives, documents and revisions, is untouched.
