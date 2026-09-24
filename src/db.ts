import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { secretReader } from "./secrets.ts";

/**
 * The control plane: Postgres holds every piece of small mutable state and all
 * coordination (ownership, claims, counters, indexes). Storage keeps bulk data.
 */
export type Db = pg.Pool;
export type Sql = Pick<pg.Pool | pg.PoolClient, "query">;

// bigint columns hold millisecond times and counts, all well inside 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

/** The database login in an RDS-managed secret; RDS rotates the password, so it is re-read, never pinned. */
export type Credentials = { username: string; password: string };
const AUTH_FAILED = "28P01";
const REFRESH_MS = 10 * 60_000;

/**
 * The control-plane pool, from either
 * - AGENT_DATABASE_URL (development and tests), or
 * - AGENT_DATABASE_HOST + AGENT_DATABASE_SECRET_ARN (production: the login is read
 *   from Secrets Manager; AGENT_DATABASE_NAME, AGENT_DATABASE_PORT, AWS_REGION).
 * AGENT_DATABASE_CA names a PEM bundle, such as RDS's, to verify the server with.
 */
export async function databaseFromEnvironment(env = process.env): Promise<Db> {
  const max = Number(env.AGENT_DATABASE_POOL_SIZE ?? 10);
  if (!Number.isInteger(max) || max < 1) throw new Error("AGENT_DATABASE_POOL_SIZE must be a positive integer");
  const ssl = env.AGENT_DATABASE_CA ? { ca: readFileSync(env.AGENT_DATABASE_CA, "utf8"), rejectUnauthorized: true } : undefined;
  const common = { max, connectionTimeoutMillis: 10_000, ...(ssl ? { ssl } : {}) };
  if (env.AGENT_DATABASE_URL) {
    const url = new URL(env.AGENT_DATABASE_URL);
    // TLS settings in the URL would replace the ssl object when pg parses it.
    if (ssl) for (const name of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(name);
    return logErrors(new pg.Pool({ connectionString: url.toString(), ...common }));
  }
  if (!env.AGENT_DATABASE_HOST || !env.AGENT_DATABASE_SECRET_ARN) {
    throw new Error("Set AGENT_DATABASE_URL, or AGENT_DATABASE_HOST and AGENT_DATABASE_SECRET_ARN: the runtime keeps its control-plane state in Postgres");
  }
  const port = Number(env.AGENT_DATABASE_PORT ?? 5432);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_DATABASE_PORT must be a TCP port");
  const secret = await secretReader(env.AGENT_DATABASE_SECRET_ARN, env);
  return rotatingPool({
    ...common, host: env.AGENT_DATABASE_HOST, port, database: env.AGENT_DATABASE_NAME ?? "agent_runtime",
    credentials: async () => JSON.parse(await secret() || "{}"),
  });
}

/**
 * A pool whose password comes from `credentials`, cached. The cache is refreshed
 * every ten minutes and whenever a new connection fails authentication, and that
 * connection is retried once, so a rotation never takes the runtime down.
 */
export async function rotatingPool(options: Omit<pg.PoolConfig, "user" | "password"> & { credentials: () => Promise<Credentials> }): Promise<Db> {
  const { credentials, ...config } = options;
  let current = await credentials();
  if (!current?.username || !current.password) throw new Error("The database secret needs username and password");
  let refreshing: Promise<void> | undefined;
  const refresh = () => refreshing ??= credentials().then(next => { current = next; }).finally(() => { refreshing = undefined; });
  const timer = setInterval(() => void refresh().catch(error => console.error(JSON.stringify({ type: "database_credentials_refresh_failed", error: (error as Error).message }))), REFRESH_MS);
  timer.unref();

  class RotatingPool extends pg.Pool {
    connect(): Promise<pg.PoolClient>;
    connect(callback: (error: Error | undefined, client: pg.PoolClient | undefined, done: (release?: boolean | Error) => void) => void): void;
    connect(callback?: (error: Error | undefined, client: pg.PoolClient | undefined, done: (release?: boolean | Error) => void) => void): Promise<pg.PoolClient> | void {
      const attempt = async () => {
        try { return await super.connect(); }
        catch (error) {
          if ((error as { code?: string }).code !== AUTH_FAILED) throw error;
          await refresh();
          return await super.connect();
        }
      };
      if (!callback) return attempt();
      attempt().then(client => callback(undefined, client, client.release.bind(client)), error => callback(error, undefined, () => {}));
    }
    async end() { clearInterval(timer); await super.end(); }
  }
  return logErrors(new RotatingPool({ ...config, user: current.username, password: async () => current.password }));
}

// An idle connection dropped by the server must not crash the process; the next query reconnects.
function logErrors(pool: Db) {
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
