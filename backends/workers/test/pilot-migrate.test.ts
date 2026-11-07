import { createHash, randomBytes } from "node:crypto";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { applyMigrations, readMigrations } from "../scripts/migrate.mjs";
import pilotMigrator from "../scripts/pilot-migrate-worker.mjs";

type Migration = { name: string; sql: string };
const base = process.env.AGENT_TEST_DATABASE_URL ?? "postgresql://postgres:local-only-unused@127.0.0.1:55434/camelrun_proto";
const token = randomBytes(32).toString("hex");
const tokenHash = createHash("sha256").update(token).digest("hex");
const cleanups: (() => Promise<void>)[] = [];
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

/** An empty database (no schema_migrations), as a fresh pilot database would be. */
async function emptyDatabase() {
  const url = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Pilot migration tests require local Postgres");
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  const name = `pilot_migrate_${randomBytes(6).toString("hex")}`;
  await admin.query(`create database ${name}`);
  url.pathname = `/${name}`;
  cleanups.push(async () => { await admin.query(`drop database ${name} with (force)`); await admin.end(); });
  return { admin, connectionString: url.toString() };
}

/** The migrations alter cluster-wide role settings; serialize with test/migrated-database.ts's template build. */
async function roleSettings<T>(admin: pg.Client, work: () => Promise<T>): Promise<T> {
  await admin.query("select pg_advisory_lock(hashtext('agent-runtime:role-settings'))");
  try { return await work(); }
  finally { await admin.query("select pg_advisory_unlock(hashtext('agent-runtime:role-settings'))"); }
}

function call(connectionString: string, migrations: Migration[], method: "GET" | "POST", options: { bearer?: string; expiresAt?: number } = {}) {
  const worker = pilotMigrator({ tokenHash, expiresAt: options.expiresAt ?? Date.now() + 60_000, migrations });
  return worker.fetch(new Request("https://migrate.example/pilot/migrations", { method, headers: { Authorization: `Bearer ${options.bearer ?? token}` } }), { HYPERDRIVE: { connectionString } });
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function appliedNames(connectionString: string) {
  const db = new pg.Client({ connectionString });
  await db.connect();
  try { return (await db.query("select name from schema_migrations order by name")).rows.map(row => row.name as string); }
  finally { await db.end(); }
}

const migrations: Migration[] = await readMigrations();
const names = migrations.map(m => m.name);

test("a fresh database gets every migration, and a rerun applies none", async () => {
  const { admin, connectionString } = await emptyDatabase();
  assert.deepEqual(await json(await call(connectionString, migrations, "GET")), { status: 200, body: { applied: [], pending: names, unknown: [] } });
  const first = await roleSettings(admin, async () => json(await call(connectionString, migrations, "POST")));
  assert.deepEqual(first, { status: 200, body: { applied: names } });
  assert.deepEqual(await appliedNames(connectionString), names);
  assert.deepEqual(await json(await call(connectionString, migrations, "POST")), { status: 200, body: { applied: [] } });
  assert.deepEqual(await json(await call(connectionString, migrations, "GET")), { status: 200, body: { applied: names, pending: [], unknown: [] } });

  // A failing migration rolls back entirely, reports only its name and SQLSTATE, and is not recorded.
  const broken = [...migrations, { name: "999_broken.sql", sql: "create table pilot_migrate_partial(x int);\nselect 1/0;" }];
  assert.deepEqual(await json(await call(connectionString, broken, "POST")), {
    status: 500, body: { error: "Migration failed", migration: "999_broken.sql", code: "22012", applied: [] },
  });
  const db = new pg.Client({ connectionString });
  await db.connect();
  try { assert.equal((await db.query("select to_regclass('pilot_migrate_partial') as t")).rows[0].t, null); }
  finally { await db.end(); }
  assert.deepEqual(await appliedNames(connectionString), names);

  // A database ahead of the checkout (or a renamed file) is refused before anything runs.
  const older = migrations.slice(0, -1);
  assert.deepEqual(await json(await call(connectionString, older, "GET")), {
    status: 200, body: { applied: names.slice(0, -1), pending: [], unknown: names.slice(-1) },
  });
  const behind = [...older, { name: "999_should_not_run.sql", sql: "create table pilot_migrate_refused(x int);" }];
  assert.deepEqual(await json(await call(connectionString, behind, "POST")), {
    status: 409, body: { error: "Database is ahead of this checkout", unknown: names.slice(-1) },
  });
  assert.deepEqual(await appliedNames(connectionString), names);
});

test("a partially migrated database gets exactly the pending migrations", async () => {
  const { admin, connectionString } = await emptyDatabase();
  const held = 2;
  const db = new pg.Client({ connectionString });
  await db.connect();
  try { await roleSettings(admin, () => applyMigrations(db, migrations.slice(0, -held))); }
  finally { await db.end(); }
  assert.deepEqual(await json(await call(connectionString, migrations, "GET")), {
    status: 200, body: { applied: names.slice(0, -held), pending: names.slice(-held), unknown: [] },
  });
  assert.deepEqual(await roleSettings(admin, async () => json(await call(connectionString, migrations, "POST"))), { status: 200, body: { applied: names.slice(-held) } });
  assert.deepEqual(await appliedNames(connectionString), names);
  assert.deepEqual(await json(await call(connectionString, migrations, "POST")), { status: 200, body: { applied: [] } });
});

test("the migration Worker answers only its bearer, before its expiry", async () => {
  const unused = "postgresql://nobody@127.0.0.1:1/none";
  assert.equal((await call(unused, migrations, "GET", { bearer: randomBytes(32).toString("hex") })).status, 401);
  assert.equal((await call(unused, migrations, "POST", { expiresAt: Date.now() - 1 })).status, 410);
  const worker = pilotMigrator({ tokenHash, expiresAt: Date.now() + 60_000, migrations });
  const env = { HYPERDRIVE: { connectionString: unused } };
  assert.equal((await worker.fetch(new Request("https://migrate.example/healthz", { headers: { Authorization: `Bearer ${token}` } }), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://migrate.example/pilot/migrations", { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }), env)).status, 404);
  // Connection failures carry no database text.
  assert.deepEqual(await json(await call(unused, migrations, "GET")), { status: 500, body: { error: "Pilot migration request failed", code: "ECONNREFUSED" } });
});
