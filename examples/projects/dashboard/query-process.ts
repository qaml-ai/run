import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// node:sqlite (Node 22.13+), typed here as far as this file uses it: its own types need @types/node 22.
type Statement = { columns(): { name: string }[]; iterate(): Iterable<Record<string, unknown>> };
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): Statement } };

// The sample data, in memory, read-only once loaded. Queries run in this process of their own, so one that runs away
// is stopped by killing it (see db.ts): SQLite can't be interrupted from another thread.
const db = new DatabaseSync(":memory:");
db.exec(readFileSync(new URL("./sample.sql", import.meta.url), "utf8"));
db.exec("PRAGMA query_only = ON");

const maxRows = Number(process.argv[2]);

// Ends with the app.
process.on("disconnect", () => process.exit());

process.on("message", ({ id, sql }: { id: number; sql: string }) => {
  try {
    const statement = sql.trim().replace(/;\s*$/, "");
    if (statement.includes(";")) throw new Error("One statement per query");
    const prepared = db.prepare(statement);
    const columns = prepared.columns().map(column => column.name);
    if (columns.length === 0) throw new Error("A query must return rows (a SELECT)");
    const rows: unknown[][] = [];
    for (const row of prepared.iterate()) {
      if (rows.length === maxRows) throw new Error(`Returns more than ${maxRows} rows: aggregate, or add a LIMIT`);
      rows.push(columns.map(column => row[column]));
    }
    process.send!({ id, columns, rows });
  } catch (error) {
    process.send!({ id, error: (error as Error).message });
  }
});
