import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSecureContext, type SecureContext } from "node:tls";
import pg from "pg";
import { secretReader } from "./secrets.ts";
import { sometimes } from "./assert.ts";
import { clock, random } from "./node-context.ts";

/**
 * The control plane: Postgres holds every piece of small mutable state and all
 * coordination (ownership, claims, counters, indexes). Storage keeps bulk data.
 *
 * `Db` is what the runtime asks of it, and all it may: queries, a connection held for a transaction (`transaction`),
 * the pool's counts for the node's load line, and ending it. pg.Pool is the production one; a simulation passes another
 * (an in-process Postgres, or a wrapper that injects faults). LISTEN has a connection of its own (NodeDeps.listen), and
 * NOTIFY is a query. Answers are as pg gives them with the parser below: bigint columns as numbers.
 */
export type Db = Sql & {
  connect(): Promise<DbClient>;
  end(): Promise<void>;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
};
/** Anything a query runs on: the pool, or the connection a transaction holds. */
export type Sql = { query<R = any>(text: string, values?: unknown[]): Promise<Rows<R>> };
/** A query's answer: its rows, and how many rows it returned or changed. */
export type Rows<R = any> = { rows: R[]; rowCount: number | null };
/** A connection taken from the pool: released when done, with the error that broke it (so it is dropped, not reused). */
export type DbClient = Sql & {
  release(error?: Error): void;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
};

// bigint columns hold millisecond times and counts, all well inside 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

const MIGRATIONS = fileURLToPath(new URL("../migrations", import.meta.url));

/** The database login in an RDS-managed secret; RDS rotates the password, so it is re-read, never pinned. */
export type Credentials = { username: string; password: string };
const AUTH_FAILED = "28P01";
const REFRESH_MS = 10 * 60_000;

// Connection refused, reset or unreachable; SQLSTATE class 08 (connection exception), the server
// shutting down or starting (57P01-3, as in a failover), too many connections, and a failed login
// (a password mid-rotation). The request itself was fine: retrying it later can succeed.
const UNAVAILABLE_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "57P01", "57P02", "57P03", "53300", AUTH_FAILED]);
const UNAVAILABLE_MESSAGES = /^(Connection terminated|Query read timeout|timeout exceeded when trying to connect|Client has encountered a connection error)/;

/**
 * Whether an error means the database could not be reached (a failover, a restart,
 * a network blip) rather than that the query was wrong. Requests that fail this way
 * answer 503 so clients retry; the pool replaces broken connections by itself.
 */
/**
 * Whether an error means the database refused this statement for now, though it is up: a serialization failure
 * (40001), a deadlock (40P01) or a statement timeout (57014). Not an outage, so leases and fencing pay it no mind, but
 * the request was fine: it answers 503 (DATABASE_RETRY) with Retry-After, and a transaction meets the first two by
 * running again from the top (`transaction`).
 */
export function databaseRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;
  return error instanceof AggregateError && error.errors.some(databaseRetryable);
}
/** The errors a transaction runs again for: it lost a race with another, and nothing it did was kept. */
const RERUN_CODES = new Set(["40001", "40P01"]);
const RETRYABLE_CODES = new Set([...RERUN_CODES, "57014"]);
/** How many times a transaction runs in all when it keeps losing races (`transaction`). */
const TRANSACTION_ATTEMPTS = 3;

export function databaseUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && (UNAVAILABLE_CODES.has(code) || code.startsWith("08"))) return true;
  if (error instanceof AggregateError && error.errors.some(databaseUnavailable)) return true;
  return UNAVAILABLE_MESSAGES.test(error.message);
}

const secureContexts = new Map<string, SecureContext>();
/**
 * TLS for the database when AGENT_DATABASE_CA names a bundle: one SecureContext per bundle, made once and shared by every
 * connection. Given `ca` instead, each connection pg opens (the pool's reconnect as they idle out) parses the whole bundle
 * into a context of its own: ~0.9 MB of OpenSSL memory V8 does not count, so only a rare full GC frees it, and the
 * allocator keeps what it frees. With the RDS bundle and pg's 10 s idle timeout, nodes' RSS grew ~1 GB a day.
 */
export function databaseTls(env = process.env): { secureContext: SecureContext; rejectUnauthorized: true } | undefined {
  const path = env.AGENT_DATABASE_CA;
  if (!path) return undefined;
  let secureContext = secureContexts.get(path);
  if (!secureContext) secureContexts.set(path, secureContext = createSecureContext({ ca: readFileSync(path, "utf8") }));
  return { secureContext, rejectUnauthorized: true };
}

/**
 * The control-plane pool, from either
 * - AGENT_DATABASE_URL (development and tests), or
 * - AGENT_DATABASE_HOST + AGENT_DATABASE_SECRET_ARN (production: the login is read
 *   from Secrets Manager; AGENT_DATABASE_NAME, AGENT_DATABASE_PORT, AWS_REGION).
 * AGENT_DATABASE_CA names a PEM bundle, such as RDS's, to verify the server with.
 * AGENT_DATABASE_QUERY_TIMEOUT_MS bounds a query (default 30000; 0 for none), so a
 * connection that went dark in a failover fails the query instead of hanging it.
 * AGENT_DATABASE_IDLE_TIMEOUT_MS is how long an idle connection stays open (default 60000; pg's own 10 s had the pool
 * reconnecting, with a TLS handshake each time, all day).
 */
export async function databaseFromEnvironment(env = process.env): Promise<pg.Pool> {
  const max = Number(env.AGENT_DATABASE_POOL_SIZE ?? 10);
  if (!Number.isInteger(max) || max < 1) throw new Error("AGENT_DATABASE_POOL_SIZE must be a positive integer");
  const queryTimeout = Number(env.AGENT_DATABASE_QUERY_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(queryTimeout) || queryTimeout < 0) throw new Error("AGENT_DATABASE_QUERY_TIMEOUT_MS must be a non-negative integer");
  const idleTimeout = Number(env.AGENT_DATABASE_IDLE_TIMEOUT_MS ?? 60_000);
  if (!Number.isInteger(idleTimeout) || idleTimeout < 0) throw new Error("AGENT_DATABASE_IDLE_TIMEOUT_MS must be a non-negative integer");
  const ssl = databaseTls(env);
  const common = { max, connectionTimeoutMillis: 10_000, idleTimeoutMillis: idleTimeout, keepAlive: true, ...(queryTimeout ? { query_timeout: queryTimeout } : {}), ...(ssl ? { ssl } : {}) };
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

/** How often the listen connection is asked whether it is alive, and how long it has to answer. */
const LIVENESS_MS = 30_000, LIVENESS_TIMEOUT_MS = 10_000;

/**
 * Listen for notifications on each channel of `handlers` over one connection of its own, reconnecting
 * (with backoff) whenever it drops; each channel's handler gets its payloads. Configured as the pool is, except that
 * AGENT_DATABASE_LISTEN_HOST, when set, names another host: RDS Proxy does not carry notifications
 * reliably (a LISTEN pins a proxied session, and delivery to it is not assured), so production
 * listens on the database instance itself. Notifications are a fast path: callers keep a slower
 * check for what one missed while the connection was down.
 */
export async function listenFromEnvironment(handlers: Record<string, (payload: string) => void>, env = process.env) {
  const channels = Object.keys(handlers);
  const ssl = databaseTls(env);
  const secret = !env.AGENT_DATABASE_URL && env.AGENT_DATABASE_SECRET_ARN ? await secretReader(env.AGENT_DATABASE_SECRET_ARN, env) : undefined;
  const config = async (): Promise<pg.ClientConfig> => {
    if (env.AGENT_DATABASE_URL) {
      const url = new URL(env.AGENT_DATABASE_URL);
      if (ssl) for (const name of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) url.searchParams.delete(name);
      return { connectionString: url.toString(), ...(ssl ? { ssl } : {}), keepAlive: true, keepAliveInitialDelayMillis: 10_000 };
    }
    const login = JSON.parse(await secret!() || "{}");
    return { host: env.AGENT_DATABASE_LISTEN_HOST || env.AGENT_DATABASE_HOST, port: Number(env.AGENT_DATABASE_PORT ?? 5432), database: env.AGENT_DATABASE_NAME ?? "agent_runtime",
      user: login.username, password: login.password, ...(ssl ? { ssl } : {}), keepAlive: true, keepAliveInitialDelayMillis: 10_000, connectionTimeoutMillis: 10_000 };
  };
  let client: pg.Client | undefined, closed = false, backoff = 1_000, timer: ReturnType<typeof setTimeout> | undefined, alive: ReturnType<typeof setInterval> | undefined;
  const schedule = (error?: Error) => {
    if (closed) return;
    if (error) console.error(JSON.stringify({ type: "database_listen_failed", channels, error: error.message }));
    timer = setTimeout(() => void connect(), backoff);
    timer.unref();
    backoff = Math.min(backoff * 2, 30_000);
  };
  // Every failure, the login's (a Secrets Manager read) included, comes back here and tries again: nothing ends the loop but close().
  const connect = async (first = false) => {
    if (closed) return;
    let next: pg.Client;
    try { next = new pg.Client(await config()); }
    catch (error) { if (first) throw error; schedule(error as Error); return; }
    const retry = (error?: Error) => {
      if (client !== next) return;
      client = undefined;
      clearInterval(alive);
      void next.end().catch(() => {});
      schedule(error);
    };
    client = next;
    next.on("error", retry);
    next.on("end", () => retry(new Error("connection ended")));
    next.on("notification", message => { if (message.payload !== undefined) handlers[message.channel]?.(message.payload); });
    try {
      await next.connect();
      for (const channel of channels) await next.query(`listen "${channel.replaceAll("\"", "")}"`);
      backoff = 1_000;
      // A connection that went dark without a close (a failover's old address, a dropped NAT entry) sends no error until
      // TCP gives up, which takes hours: ask it something every LIVENESS_MS, and start over when it does not answer.
      clearInterval(alive);
      alive = setInterval(() => {
        if (client !== next) return;
        const late = setTimeout(() => retry(new Error("liveness check timed out")), LIVENESS_TIMEOUT_MS);
        late.unref();
        next.query("select 1").then(() => clearTimeout(late), error => { clearTimeout(late); retry(error as Error); });
      }, LIVENESS_MS);
      alive.unref();
    } catch (error) { retry(error as Error); }
  };
  await connect(true);
  return {
    async close() { closed = true; clearTimeout(timer); clearInterval(alive); const current = client; client = undefined; await current?.end().catch(() => {}); },
  };
}

/**
 * A pool whose password comes from `credentials`, cached. The cache is refreshed
 * every ten minutes and whenever a new connection fails authentication, and that
 * connection is retried once, so a rotation never takes the runtime down.
 */
export async function rotatingPool(options: Omit<pg.PoolConfig, "user" | "password"> & { credentials: () => Promise<Credentials> }): Promise<pg.Pool> {
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
function logErrors(pool: pg.Pool) {
  pool.on("error", error => console.error(JSON.stringify({ type: "database_connection_error", error: error.message })));
  return pool;
}

/**
 * Apply pending `migrations/NNN_name.sql` files in order, one runner at a time per schema. A statement
 * waiting on a lock (an ALTER behind a long transaction) gives up after `lockTimeoutMs` (2 s), so the
 * queries on that table that queue behind it wait at most that long; the whole run is then tried again,
 * `attempts` times, and a lock held throughout fails the node's start within about 50 s.
 *
 * Files run in one transaction, up to a file that opens with CONCURRENT_MIGRATION: that one builds indexes on a
 * table too large or busy to lock for the build, outside any transaction (`concurrently`), and the rest follow it.
 */
export async function migrate(db: Db, directory = MIGRATIONS, options: { lockTimeoutMs?: number; attempts?: number; retryMs?: number } = {}): Promise<string[]> {
  const attempts = options.attempts ?? 10;
  for (let attempt = 1; ; attempt++) {
    try { return await migrateOnce(db, directory, options.lockTimeoutMs ?? 2_000); }
    catch (error) {
      if ((error as { code?: string }).code !== LOCK_NOT_AVAILABLE || attempt >= attempts) throw error;
      console.error(JSON.stringify({ type: "migration_lock_timeout", attempt, error: (error as Error).message }));
      await new Promise(resolve => setTimeout(resolve, options.retryMs ?? 3_000));
    }
  }
}
const LOCK_NOT_AVAILABLE = "55P03";

/** The first line of a migration that builds indexes concurrently: each statement a CREATE INDEX CONCURRENTLY IF NOT EXISTS. */
export const CONCURRENT_MIGRATION = "-- migrate: concurrently";
/** The runners' lock: one per schema, so parallel test schemas migrate side by side. */
const MIGRATION_LOCK = "hashtext('agent-runtime-migrations:' || coalesce(current_schema(), ''))";
/** How long a concurrent index build may take before its node gives up (the build is tried again by the next start). */
const CONCURRENT_BUILD_MS = 10 * 60_000;
const CONCURRENT_INDEX = /^create\s+(?:unique\s+)?index\s+concurrently\s+if\s+not\s+exists\s+([a-z_][a-z0-9_]*)\s+on\s/i;
const sleep = (ms: number) => clock().sleep(ms);

async function migrateOnce(db: Db, directory: string, lockTimeoutMs: number) {
  const files = readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const applied: string[] = [];
  for (;;) {
    const { ran, next } = await transaction(db, async sql => {
      // Waited for by polling, not by blocking: a statement blocked on the lock holds a snapshot, which a concurrent index
      // build holding the lock would wait for in turn. Between polls this transaction holds none.
      while (!(await sql.query(`select pg_try_advisory_xact_lock(${MIGRATION_LOCK}) as held`)).rows[0].held) await sleep(200);
      await sql.query(`set local lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
      await sql.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
      const done = new Set((await sql.query("select name from schema_migrations")).rows.map(row => row.name));
      const ran: string[] = [];
      for (const name of files.filter(name => !done.has(name))) {
        const text = readFileSync(join(directory, name), "utf8");
        if (text.startsWith(CONCURRENT_MIGRATION)) return { ran, next: { name, text } };
        await sql.query(text);
        await sql.query("insert into schema_migrations (name) values ($1)", [name]);
        ran.push(name);
      }
      return { ran, next: undefined };
    });
    applied.push(...ran);
    if (!next) return applied;
    if (await concurrently(db, next.name, next.text, lockTimeoutMs)) applied.push(next.name);
  }
}

/**
 * Apply a CONCURRENT_MIGRATION file: its indexes built without locking their table against writes, outside any
 * transaction, on one connection holding the runners' lock (as a session's). A build cut short (its node stopped, the
 * lock timeout) leaves an invalid index behind: it is dropped and built again. False: another runner applied it first.
 */
async function concurrently(db: Db, name: string, text: string, lockTimeoutMs: number): Promise<boolean> {
  const statements = text.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n").split(";").map(statement => statement.trim()).filter(Boolean);
  const indexes = statements.map(statement => {
    const index = CONCURRENT_INDEX.exec(statement)?.[1];
    if (!index) throw new Error(`${name}: a concurrent migration holds only CREATE INDEX CONCURRENTLY IF NOT EXISTS statements`);
    return { statement, index };
  });
  const client = await db.connect();
  let broken: Error | undefined;
  try {
    while (!(await client.query(`select pg_try_advisory_lock(${MIGRATION_LOCK}) as held`)).rows[0].held) await sleep(200);
    try {
      if ((await client.query("select 1 from schema_migrations where name = $1", [name])).rowCount) return false;
      await client.query(`set lock_timeout = ${Math.max(1, Math.floor(lockTimeoutMs))}`);
      for (const { statement, index } of indexes) {
        const { rows: [leftover] } = await client.query("select i.indisvalid as valid from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = $1 and c.relnamespace = current_schema()::regnamespace", [index]);
        if (leftover && !leftover.valid) await client.query(`drop index concurrently if exists ${index}`);
        // A build may outlast the pool's per-query timeout: it has its own.
        await (client as unknown as { query(config: { text: string; query_timeout: number }): Promise<unknown> }).query({ text: statement, query_timeout: CONCURRENT_BUILD_MS });
      }
      await client.query("insert into schema_migrations (name) values ($1)", [name]);
      return true;
    } finally {
      await client.query("reset lock_timeout").catch(() => {});
      await client.query(`select pg_advisory_unlock(${MIGRATION_LOCK})`).catch(() => {});
    }
  } catch (error) {
    broken = error as Error;
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * Run `work` in a transaction on one connection. One that loses a race (a serialization failure, a deadlock) runs again
 * from the top, up to TRANSACTION_ATTEMPTS times in all, after a short random wait so the two do not collide again;
 * past that, the error goes to the caller (a request answers 503 DATABASE_RETRY). So `work` does nothing but database
 * writes, or only what may be done twice: one whose other effects may not (Storage's, metered) passes `rerun: false`.
 */
export async function transaction<T>(db: Db, work: (sql: Sql) => Promise<T>, options: { rerun?: boolean } = {}): Promise<T> {
  if (options.rerun === false) return transactionOnce(db, work);
  for (let attempt = 1; ; attempt++) {
    try { return await transactionOnce(db, work); }
    catch (error) {
      const code = (error as { code?: unknown }).code;
      if (attempt >= TRANSACTION_ATTEMPTS || typeof code !== "string" || !RERUN_CODES.has(code)) throw error;
      sometimes(true, "a transaction that lost a race ran again");
      await clock().sleep(Math.floor((10 + random().float() * 40) * attempt));
    }
  }
}

/** Run `work` in a transaction on a connection the caller already holds, once. */
export async function transactionOn<T>(client: Sql, work: (sql: Sql) => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  }
}

async function transactionOnce<T>(db: Db, work: (sql: Sql) => Promise<T>): Promise<T> {
  const client = await db.connect();
  // A checked-out client whose connection drops emits 'error'; unheard, that would crash the process.
  // The statement in flight fails too, and a broken client is dropped from the pool, not reused.
  let broken: Error | undefined;
  const lost = (error: Error) => { broken = error; };
  client.on("error", lost);
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => { broken ??= error as Error; });
    throw error;
  } finally {
    client.off("error", lost);
    client.release(broken);
  }
}
