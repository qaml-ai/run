import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATION = /^\d{3}_.*\.sql$/;

/** The repository migrations, in order, as [{ name, sql }]. The path is resolved
 * lazily: the pilot's temporary migration Worker bundles this module, not the directory. */
export async function readMigrations() {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = async (directory, prefix = "") => {
    const files = (await readdir(directory)).filter(name => MIGRATION.test(name)).sort();
    return Promise.all(files.map(async name => ({ name: prefix + name, sql: await readFile(resolve(directory, name), "utf8") })));
  };
  const [shared, workers] = await Promise.all([read(resolve(here, "../../../migrations")), read(resolve(here, "../migrations"), "workers:")]);
  return [...shared, ...workers];
}

/** Compare schema_migrations with `migrations`, by name (no checksum is kept).
 * `unknown` names were applied but are not in this checkout: the database is
 * ahead of it, or a file was renamed after it ran. A deploy must refuse then. */
export async function migrationStatus(db, migrations) {
  const { rows: [{ present }] } = await db.query("select to_regclass('schema_migrations') is not null as present");
  const done = present ? (await db.query("select name from schema_migrations order by name")).rows.map((row) => row.name) : [];
  const names = new Set(migrations.map((m) => m.name));
  const applied = new Set(done);
  return {
    applied: done.filter((name) => names.has(name)),
    pending: migrations.map((m) => m.name).filter((name) => !applied.has(name)),
    unknown: done.filter((name) => !names.has(name)),
  };
}

/** Apply each of `migrations` ([{ name, sql }], in order) that schema_migrations
 * lacks, and return the names this call applied. A failed migration is rolled
 * back (a "-- migrate: concurrently" file is not transactional; its statements
 * are idempotent) and throws an error carrying `migration`, `code` (SQLSTATE)
 * and `applied` (the names applied before it). */
export async function applyMigrations(db, migrations) {
  await db.query(
    "create table if not exists schema_migrations (name text primary key,applied_at timestamptz not null default now())",
  );
  const applied = [];
  for (const { name: file, sql } of migrations) {
    if (!MIGRATION.test(file.replace(/^workers:/, ""))) throw new Error(`Not a migration file name: ${file}`);
    if (
      (await db.query("select 1 from schema_migrations where name=$1", [file]))
        .rowCount
    )
      continue;
    try {
      if (sql.startsWith("-- migrate: concurrently")) {
        for (const statement of sql
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .split(";")
          .map((x) => x.trim())
          .filter(Boolean))
          await db.query(statement);
        await db.query("insert into schema_migrations(name) values($1)", [file]);
      } else {
        await db.query("begin");
        try {
          await db.query(sql);
          await db.query("insert into schema_migrations(name) values($1)", [
            file,
          ]);
          await db.query("commit");
        } catch (error) {
          await db.query("rollback");
          throw error;
        }
      }
    } catch (error) {
      throw Object.assign(new Error(`Migration ${file} failed (${error?.code})`), { migration: file, code: error?.code, applied });
    }
    applied.push(file);
  }
  return applied;
}

/** Apply the repository schema, unchanged, to the caller's isolated local schema. */
export async function migrate(db) {
  const migrations = await readMigrations();
  const applied = await applyMigrations(db, migrations);
  return { migrations: migrations.length, newlyApplied: applied.length };
}
