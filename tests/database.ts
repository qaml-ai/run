import { randomBytes } from "node:crypto";
import { after } from "node:test";
import pg from "pg";
import { migrate } from "../src/db.ts";

export const TEST_DATABASE_URL = process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres";

/** `url` with every connection's search_path set to `schema`. */
export function inSchema(url: string, schema: string) {
  const parsed = new URL(url);
  parsed.searchParams.set("options", `-c search_path=${schema}`);
  return parsed.toString();
}

// Schemas are dropped once the file's tests (and their own cleanup, which may still use them) are done.
const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

/**
 * A fresh schema for one test, so parallel test files never share rows. `url`
 * points a runtime process at it. Without a reachable database this fails:
 * every test that runs the runtime needs one.
 */
export async function testDatabase(options: { migrate?: boolean } = {}) {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5_000 });
  try { await admin.connect(); }
  catch (error) { throw new Error(`The tests need Postgres at ${TEST_DATABASE_URL} (set AGENT_TEST_DATABASE_URL): ${(error as Error).message}`); }
  const schema = `test_${randomBytes(6).toString("hex")}`;
  await admin.query(`create schema ${schema}`);
  // Every connection to the schema, the test's and any runtime process's, is named after it in pg_stat_activity.
  const named = new URL(inSchema(TEST_DATABASE_URL, schema));
  named.searchParams.set("application_name", schema);
  const url = named.toString();
  const db = new pg.Pool({ connectionString: url, max: 5 });
  cleanups.push(async () => {
    // A file that hangs after its tests (the 120 s per-file timeout) is usually stuck here, on a
    // connection never released or a lock the drop waits for: after 10 s, log which.
    const stuck = setTimeout(() => void admin.query(`
      select pid, state, wait_event_type, wait_event, extract(epoch from now() - state_change)::int as seconds, left(query, 200) as query
      from pg_stat_activity where application_name = $1`, [schema]).then(result => result.rows, error => String(error)).then(activity =>
      console.error(JSON.stringify({ type: "test_database_cleanup_stuck", schema, pool: { total: db.totalCount, idle: db.idleCount, waiting: db.waitingCount }, activity }))), 10_000);
    try {
      await db.end();
      await admin.query(`drop schema ${schema} cascade`);
      await admin.end();
    } finally { clearTimeout(stuck); }
  });
  if (options.migrate !== false) await migrate(db);
  return { db, url, schema };
}
