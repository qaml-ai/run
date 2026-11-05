import { readdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const migrations = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations",
);
/** Apply the repository schema, unchanged, to the caller's isolated local schema. */
export async function migrate(db) {
  await db.query(
    "create table if not exists schema_migrations (name text primary key,applied_at timestamptz not null default now())",
  );
  const files = (await readdir(migrations))
    .filter((x) => /^\d{3}_.*\.sql$/.test(x))
    .sort();
  let applied = 0;
  for (const file of files) {
    if (
      (await db.query("select 1 from schema_migrations where name=$1", [file]))
        .rowCount
    )
      continue;
    const sql = await readFile(resolve(migrations, file), "utf8");
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
        throw new Error(`Migration ${file} failed (${error.code})`);
      }
    }
    applied++;
  }
  return { migrations: files.length, newlyApplied: applied };
}
