import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

/**
 * The control plane: Postgres holds every piece of small mutable state and all
 * coordination (ownership, claims, counters, indexes). Storage keeps bulk data.
 */
export type Db = pg.Pool;
export type Sql = Pick<pg.Pool | pg.PoolClient, "query">;

// bigint columns hold millisecond times and counts, all well inside 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

/**
 * A pool from AGENT_DATABASE_URL (sslmode and sslrootcert in the URL are honoured).
 * AGENT_DATABASE_CA names a PEM bundle to verify the server against, such as RDS's.
 */
export function databaseFromEnvironment(env = process.env): Db {
  if (!env.AGENT_DATABASE_URL) throw new Error("Set AGENT_DATABASE_URL: the runtime keeps its control-plane state in Postgres");
  const url = new URL(env.AGENT_DATABASE_URL);
  if (env.AGENT_DATABASE_CA) {
    url.searchParams.set("sslrootcert", env.AGENT_DATABASE_CA);
    if (!url.searchParams.has("sslmode")) url.searchParams.set("sslmode", "verify-full");
  }
  const max = Number(env.AGENT_DATABASE_POOL_SIZE ?? 10);
  if (!Number.isInteger(max) || max < 1) throw new Error("AGENT_DATABASE_POOL_SIZE must be a positive integer");
  const pool = new pg.Pool({ connectionString: url.toString(), max, connectionTimeoutMillis: 10_000 });
  // An idle connection dropped by the server must not crash the process; the next query reconnects.
  pool.on("error", error => console.error(JSON.stringify({ type: "database_connection_error", error: error.message })));
  return pool;
}

/** Apply pending `migrations/NNN_name.sql` files in order, one runner at a time per schema. */
export async function migrate(db: Db, directory = MIGRATIONS) {
  const files = readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  return transaction(db, async sql => {
    await sql.query("select pg_advisory_xact_lock(hashtext('agent-runtime-migrations:' || coalesce(current_schema(), '')))");
    await sql.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await sql.query("select name from schema_migrations")).rows.map(row => row.name));
    const pending = files.filter(name => !applied.has(name));
    for (const name of pending) {
      await sql.query(readFileSync(join(directory, name), "utf8"));
      await sql.query("insert into schema_migrations (name) values ($1)", [name]);
    }
    return pending;
  });
}

export async function transaction<T>(db: Db, work: (sql: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
