import { randomBytes } from "node:crypto";
import { after } from "node:test";
import pg from "pg";
import { database } from "../src/postgres.ts";
import { createMigratedDatabase } from "./migrated-database.ts";

const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
/** Wait for the database's other sessions to finish. A client released with `void client.end()` is still closing when
 * the test ends, and `drop database ... with (force)` would kill it mid-close ("terminating connection due to
 * administrator command" on a client nobody is listening to). A session that never finishes is dropped after 10 s. */
async function sessionsEnded(admin: pg.Client, database: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query("select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
    if (rows[0].n === 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** Each source test uses the Workers short-connection adapter and an isolated local database. */
export async function testDatabase() {
  const base = process.env.AGENT_TEST_DATABASE_URL ?? "postgresql://postgres:local-only-unused@127.0.0.1:55434/camelrun_proto";
  const url = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Billing tests require local Postgres");
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  const schema = `billing_workers_${randomBytes(6).toString("hex")}`;
  await createMigratedDatabase(admin, base, schema);
  url.pathname = `/${schema}`;
  url.searchParams.set("application_name", schema);
  const connectionString = url.toString();
  const db = database({ HYPERDRIVE: { connectionString } });
  cleanups.push(async () => { await db.end(); await sessionsEnded(admin, schema); await admin.query(`drop database ${schema} with (force)`); await admin.end(); });
  return { db, url: connectionString, schema };
}
