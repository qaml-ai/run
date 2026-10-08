import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { databaseFromEnvironment, databaseRetryable, databaseUnavailable, migrate, rotatingPool, transaction } from "../src/db.ts";
import { errorCode, errorHeaders, errorStatus } from "../src/http.ts";
import { testDatabase } from "./database.ts";

const MIGRATIONS = readdirSync(fileURLToPath(new URL("../migrations", import.meta.url))).filter(name => name.endsWith(".sql")).sort();

test("each migration has its own number, so two branches cannot both claim one", () => {
  // The runner applies files by name and does not refuse a shared number: a clash would only reorder them.
  const numbers = MIGRATIONS.map(name => name.slice(0, 3));
  assert.deepEqual(numbers.filter((number, index) => numbers.indexOf(number) !== index), []);
  assert.ok(MIGRATIONS.every(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)), "every file is NNN_name.sql, or the runner skips it");
});

test("migrations apply once: running them again does nothing", async () => {
  const { db } = await testDatabase({ migrate: false });
  assert.deepEqual(await migrate(db), MIGRATIONS);
  assert.deepEqual(await migrate(db), []);
  assert.deepEqual((await db.query("select name from schema_migrations order by name")).rows.map(row => row.name), MIGRATIONS);
});

/** Apply the migrations before `name` only: the schema as an older release left it. */
async function migrateBefore(db: pg.Pool, name: string) {
  const all = fileURLToPath(new URL("../migrations", import.meta.url));
  const before = mkdtempSync(join(tmpdir(), "migrations-"));
  for (const file of MIGRATIONS.filter(file => file < name)) cpSync(join(all, file), join(before, file));
  await migrate(db, before);
}

test("the migration names each agent header's tenant, from its row", async () => {
  const { db } = await testDatabase({ migrate: false });
  await migrateBefore(db, "013");
  const insert = (id: string, tenant: string, header: object) => db.query(
    "insert into agents (id, tenant, header, revision, name, type, model) values ($1, $2, $3, 1, $1, 'general', 'anthropic/claude')", [id, tenant, JSON.stringify(header)]);
  await insert("client_old", "default", { version: 3, id: "client_old", digest: "d", expiresAt: null, revoked: false });
  await insert("client_new", "alice", { version: 3, id: "client_new", tenant: "alice", digest: "d", expiresAt: null, revoked: false });
  await migrate(db);
  const headers = Object.fromEntries((await db.query("select id, header from agents")).rows.map(row => [row.id, row.header]));
  assert.deepEqual(headers.client_old, { version: 3, id: "client_old", tenant: "default", digest: "d", expiresAt: null, revoked: false });
  assert.equal(headers.client_new.tenant, "alice");
});

test("new sessions carry the role's idle-in-transaction timeout, so no transaction needs a pinning SET", async () => {
  await testDatabase();
  const client = new pg.Client({ connectionString: process.env.AGENT_TEST_DATABASE_URL ?? "postgres://postgres:test@127.0.0.1:55432/postgres" });
  await client.connect();
  try { assert.equal((await client.query("show idle_in_transaction_session_timeout")).rows[0].idle_in_transaction_session_timeout, "30s"); }
  finally { await client.end(); }
});

test("two processes starting at once apply each migration exactly once", async () => {
  const { db, url } = await testDatabase({ migrate: false });
  const script = `import { databaseFromEnvironment, migrate } from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)};
    const db = await databaseFromEnvironment(); console.log(JSON.stringify(await migrate(db))); await db.end();`;
  const run = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    { env: { PATH: process.env.PATH, AGENT_DATABASE_URL: url } });
  const outputs = (await Promise.all([run(), run()])).map(({ stdout }) => JSON.parse(stdout));
  assert.deepEqual(outputs.flat().sort(), MIGRATIONS, "one process applied them, the other found nothing to do");
  assert.equal((await db.query("select count(*) as count from schema_migrations")).rows[0].count, MIGRATIONS.length);
});

test("the connection takes a URL or a host and secret, verifies TLS against AGENT_DATABASE_CA, and needs one of them", async t => {
  await assert.rejects(databaseFromEnvironment({}), /AGENT_DATABASE_URL, or AGENT_DATABASE_HOST and AGENT_DATABASE_SECRET_ARN/);
  await assert.rejects(databaseFromEnvironment({ AGENT_DATABASE_URL: "postgres://db/agents", AGENT_DATABASE_POOL_SIZE: "0" }), /POOL_SIZE/);
  const root = await mkdtemp(join(tmpdir(), "agent-ca-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const ca = join(root, "bundle.pem");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n");
  const pool = await databaseFromEnvironment({ AGENT_DATABASE_URL: "postgres://user:pass@db.example.test:5432/agents?sslmode=require&sslrootcert=/elsewhere.pem", AGENT_DATABASE_CA: ca, AGENT_DATABASE_POOL_SIZE: "4" });
  t.after(() => pool.end());
  const options = pool.options as pg.PoolConfig & { connectionString: string };
  assert.deepEqual(options.ssl, { ca: readFileSync(ca, "utf8"), rejectUnauthorized: true });
  assert.equal(new URL(options.connectionString).search, "", "no TLS settings in the URL to override the ssl object");
  assert.equal(options.max, 4);
});

test("a connection lost mid-transaction fails the transaction without crashing, and the pool reconnects", async t => {
  const { url } = await testDatabase({ migrate: false });
  const pool = await databaseFromEnvironment({ AGENT_DATABASE_URL: url, AGENT_DATABASE_POOL_SIZE: "1", AGENT_DATABASE_QUERY_TIMEOUT_MS: "5000" });
  t.after(() => pool.end());
  assert.equal((pool.options as pg.PoolConfig).query_timeout, 5000);
  assert.equal((pool.options as pg.PoolConfig).keepAlive, true);
  // The backend is killed between statements, as in a failover: the client emits 'error' while checked out.
  const failed = await transaction(pool, async sql => {
    const { rows } = await sql.query("select pg_backend_pid() as pid");
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query("select pg_terminate_backend($1)", [rows[0].pid]);
    await admin.end();
    await new Promise(resolve => setTimeout(resolve, 100));
    await sql.query("select 1");
  }).then(() => undefined, error => error);
  assert.ok(databaseUnavailable(failed), `a connection failure: ${failed?.code} ${failed?.message}`);
  assert.equal((await pool.query("select 1 as one")).rows[0].one, 1, "the broken client was dropped and replaced");
  await assert.rejects(pool.query("select * from no_such_table"), (error: Error) => !databaseUnavailable(error), "a wrong query is not an outage");
  assert.ok(databaseUnavailable(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" })));
  assert.ok(databaseUnavailable(Object.assign(new Error("the database system is starting up"), { code: "57P03" })));
  assert.ok(databaseUnavailable(new Error("timeout exceeded when trying to connect")));
  assert.ok(!databaseUnavailable(Object.assign(new Error("duplicate key"), { code: "23505" })));
});

test("a pool on rotating credentials re-reads the secret when a connection fails authentication", async t => {
  const { url } = await testDatabase({ migrate: false });
  const role = `rotating_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  t.after(async () => {
    await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role}'`);
    await admin.query(`drop role if exists ${role}`);
    await admin.end();
  });
  let secret = { username: role, password: randomBytes(12).toString("hex") };
  await admin.query(`create role ${role} login password '${secret.password}'`);
  let reads = 0;
  const target = new URL(url);
  const pool = await rotatingPool({ host: target.hostname, port: Number(target.port), database: target.pathname.slice(1), max: 1, credentials: async () => { reads++; return secret; } });
  t.after(() => pool.end());
  assert.equal((await pool.query("select current_user as name")).rows[0].name, role);

  // RDS rotates the password: the secret changes, and open connections are eventually closed.
  secret = { username: role, password: randomBytes(12).toString("hex") };
  await admin.query(`alter role ${role} password '${secret.password}'`);
  await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where usename = '${role}'`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await pool.query("select 1 as ok")).rows[0].ok, 1, "the new connection failed with 28P01, re-read the secret and retried");
  assert.equal(reads, 2);
  const client = await pool.connect();
  client.release();
  assert.equal(reads, 2, "the refreshed password is cached");
});

test("the runtime refuses to start without AGENT_DATABASE_URL", async t => {
  const root = await mkdtemp(join(tmpdir(), "agent-no-db-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, "tenants.json"), JSON.stringify({ tenants: {} }));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_TENANTS_FILE: join(root, "tenants.json"),
      AGENT_SESSION_SECRET: "no-database-session-secret-with-32-chars", PORT: "0",
    }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(stderr, /Set AGENT_DATABASE_URL/);
});

test("a migration waiting on a lock gives up after lock_timeout instead of stalling every query behind it", async () => {
  const { db, url } = await testDatabase({ migrate: false });
  await migrateBefore(db, "022_agent_cursor.sql");
  // A long transaction holds a lock on agents, as a slow query would.
  const holder = new pg.Client({ connectionString: url });
  await holder.connect();
  await holder.query("begin");
  await holder.query("select * from agents limit 1");
  try {
    const started = Date.now();
    await assert.rejects(migrate(db, undefined, { lockTimeoutMs: 300, attempts: 2, retryMs: 100 }), /lock timeout/);
    assert.ok(Date.now() - started < 5_000, "it gave up");
    // Nothing queued behind it: reads of agents go on.
    await db.query("select count(*) from agents");
  } finally {
    await holder.query("rollback");
    await holder.end();
  }
  // Once the lock is gone, it applies.
  assert.deepEqual(await migrate(db, undefined, { lockTimeoutMs: 300 }), MIGRATIONS.filter(name => name >= "022_agent_cursor.sql"));
});

test("a serialization failure, a deadlock or a statement timeout is retryable, not an outage: 503 DATABASE_RETRY with Retry-After", () => {
  for (const code of ["40001", "40P01", "57014"]) {
    const error = Object.assign(new Error("refused for now"), { code });
    assert.equal(databaseRetryable(error), true, code);
    assert.equal(databaseUnavailable(error), false, code);
    assert.equal(errorStatus(error, 400), 503, code);
    assert.equal(errorCode(error, 503), "DATABASE_RETRY", code);
    assert.deepEqual(errorHeaders(error), { "Retry-After": "1" }, code);
  }
  assert.equal(databaseRetryable(Object.assign(new Error("syntax"), { code: "42601" })), false);
  assert.equal(errorStatus(Object.assign(new Error("syntax"), { code: "42601" }), 400), 400);
});

test("a transaction that loses a race runs again from the top, a few times at most, unless its work may not run twice; a statement timeout does not", async () => {
  // A fake pool whose transactions fail with `codes`, one per attempt, then succeed.
  const pool = (codes: string[]) => {
    let attempts = 0;
    const statements: string[] = [];
    const db = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({
        query: async (text: string) => {
          statements.push(text);
          if (text === "select 1" && attempts < codes.length) throw Object.assign(new Error("refused"), { code: codes[attempts] });
          return { rows: [], rowCount: 0 };
        },
        release: () => { attempts++; }, on: () => {}, off: () => {},
      }),
    } as any;
    return { db, statements, attempts: () => attempts };
  };
  const twice = pool(["40001", "40P01"]);
  assert.equal(await transaction(twice.db, async sql => { await sql.query("select 1"); return "done"; }), "done");
  assert.equal(twice.attempts(), 3);
  assert.deepEqual(twice.statements.filter(text => text !== "select 1"), ["begin", "rollback", "begin", "rollback", "begin", "commit"]);
  const always = pool(["40001", "40001", "40001", "40001"]);
  await assert.rejects(transaction(always.db, sql => sql.query("select 1")), (error: any) => error.code === "40001");
  assert.equal(always.attempts(), 3);
  const once = pool(["40001"]);
  await assert.rejects(transaction(once.db, sql => sql.query("select 1"), { rerun: false }), (error: any) => error.code === "40001");
  assert.equal(once.attempts(), 1, "work that may not run twice is not rerun");
  const timeout = pool(["57014"]);
  await assert.rejects(transaction(timeout.db, sql => sql.query("select 1")), (error: any) => error.code === "57014");
  assert.equal(timeout.attempts(), 1);
});
