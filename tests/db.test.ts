import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { databaseFromEnvironment, databaseUnavailable, migrate, rotatingPool, transaction } from "../src/db.ts";
import { testDatabase } from "./database.ts";

const MIGRATIONS = readdirSync(fileURLToPath(new URL("../migrations", import.meta.url))).filter(name => name.endsWith(".sql")).sort();

test("migrations apply once: running them again does nothing", async () => {
  const { db } = await testDatabase({ migrate: false });
  assert.deepEqual(await migrate(db), MIGRATIONS);
  assert.deepEqual(await migrate(db), []);
  assert.deepEqual((await db.query("select name from schema_migrations order by name")).rows.map(row => row.name), MIGRATIONS);
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
  t.after(() => rm(root, { recursive: true, force: true }));
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
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_RUNTIME_TOKEN: "no-database-operator-token-24", PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += chunk; });
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(stderr, /Set AGENT_DATABASE_URL/);
});
