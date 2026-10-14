# Migrations

The control database's schema is `migrations/NNN_name.sql`: plain SQL files, applied in name order by every node as
it starts (`migrate` in `src/db.ts`). A run takes an advisory lock, so nodes starting together apply each file once,
and runs in one transaction, so a failing file leaves nothing half-applied and the node does not start.

## How they are recorded

`schema_migrations` has one row per applied file, **keyed by its file name** (`068_email_thread_forwarded.sql`), not
by its number. A file whose name has no row is applied at the next start. So:

- renaming a file that some database has already applied makes that database apply it **again** under the new name;
- a file that does not match `NNN_name.sql` (three digits, lowercase letters, digits and underscores) is skipped
  silently.

A statement that waits on a lock (an `ALTER` behind a long transaction) gives up after 2 s, and the run is tried again
up to 10 times, so a lock held throughout fails the node's start within about 50 s rather than stalling every query
behind it. Prefer statements that hold their locks briefly (`add column` without a volatile default is instant). The
whole run is one transaction, so `create index concurrently` cannot be used in a migration.

## One number per migration

`tests/db.test.ts` ("each migration has its own number") fails when two files share a number, and when a file's name
does not match the pattern. The runner itself would apply both files of a shared number (their names differ), but in
an order that depends on the rest of the name, so two branches that each took the next number can apply in a
different order than either was tested in. The test fails as soon as both files are in one tree: on a branch brought
up to date with `main`, or on `main` itself once the second branch merges (as on 2026-10-14, below).

## Renumbering one that is not applied

When a branch's migration collides with one already on `main` (PR #148's `067_email_thread_forwarded.sql` and main's
`067_model_attempts_recheck.sql`, on 2026-10-14):

1. Check that no database has applied the branch's file. Production applies a migration only when an image that has
   it starts, so a migration that was never on `main` (and that nobody deployed from a branch with
   `infra/ecs-deploy.sh`) has not run in production. For a staging or self-hosted
   database that ran the branch, ask it: `select name, applied_at from schema_migrations order by name desc limit 5;`.
2. Rename the file to the next free number (`git mv migrations/067_x.sql migrations/068_x.sql`) and update every
   mention: the release note in `docs/operations/unreleased/`, comments and docs that cite it.
3. Run `node --experimental-strip-types --test tests/db.test.ts` (it needs the test database from the
   [index](README.md#develop)), then push.

If a database did apply it under the old name, don't rename it there blindly: either insert the new name into its
`schema_migrations` by hand before the new image starts, or make the file safe to run twice (`if not exists`).

## Rules for writing one

- **Expand only.** During a rolling deploy old tasks keep running against the new schema for up to about 20 minutes,
  and a rollback runs an older image against it indefinitely. Add tables, columns and indexes; drop or rename only
  in a later release, once no running image reads them (see "Pending removals" in the [index](README.md)).
- Each file runs in the deploy's transaction with the others pending: keep a backfill small, or batch it in code.
- Say in the change's note in `docs/operations/unreleased/` which migration it adds, so self-hosters read it before
  upgrading ([Release notes](release-notes.md)).
