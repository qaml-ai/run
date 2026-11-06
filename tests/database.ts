import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let template: Promise<string> | undefined;

/** A database holding every migration, built once per cluster and migration set (named by their hash, under an advisory
 * lock) and copied for each test: applying 100+ migrations took 0.3 s a test, 250 times a run. */
function migratedTemplate(): Promise<string> {
  return template ??= (async () => {
    const files = readdirSync(MIGRATIONS).filter(name => name.endsWith(".sql")).sort();
    const hash = createHash("sha256");
    for (const name of files) hash.update(name).update(readFileSync(MIGRATIONS + name));
    hash.update(readFileSync(fileURLToPath(new URL("../src/db.ts", import.meta.url))));
    const name = `rt_template_${hash.digest("hex").slice(0, 16)}`, building = `${name}_building`;
    // Advisory locks belong to one database and each test file has a database of its own (test-worker-database.ts), so
    // the files meet in the cluster's maintenance database.
    const maintenance = new URL(TEST_DATABASE_URL);
    maintenance.pathname = "/postgres";
    const admin = new pg.Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5_000 });
    await admin.connect();
    await admin.query("select pg_advisory_lock(hashtext('agent-runtime:test-template'))");
    try {
      if ((await admin.query("select 1 from pg_database where datname = $1", [name])).rowCount) return name;
      await admin.query(`drop database if exists ${building} with (force)`);
      await admin.query(`create database ${building}`);
      const url = new URL(TEST_DATABASE_URL);
      url.pathname = `/${building}`;
      const pool = new pg.Pool({ connectionString: url.toString(), max: 2 });
      try {
        await migrate(pool);
        const { rows } = await pool.query("select unnest(s.setconfig) as setting from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = current_user and s.setdatabase = 0");
        await admin.query(`comment on database ${building} is '${JSON.stringify(rows.map(row => row.setting)).replaceAll("'", "''")}'`);
      } finally { await pool.end(); }
      // The closed pool's backends may linger a moment, and a rename needs none.
      for (let attempt = 0; ; attempt++) {
        try { await admin.query(`alter database ${building} rename to ${name}`); break; }
        catch (error) { if (attempt >= 100) throw error; await sleep(50); }
      }
      return name;
    } finally { await admin.end(); }
  })().catch(error => { template = undefined; throw error; });
}

/** The settings the migrations left on the template builder's role, as `name=value` strings. A role setting belongs to the
 * cluster, not to the template: a database copied from it would otherwise miss what migrating it would have set on the
 * test's own role. Kept in the template's comment, for every process that copies it. */
async function roleSettings(admin: pg.Client, template: string): Promise<string[]> {
  const { rows } = await admin.query("select shobj_description(oid, 'pg_database') as comment from pg_database where datname = $1", [template]);
  return rows[0]?.comment ? JSON.parse(rows[0].comment) : [];
}

/** Give the connection's role the settings it lacks. Files share a role (CI's docs job, local runs), and two
 * `alter role` statements on one role race on pg_db_role_setting ("tuple concurrently updated"), so a role that has them
 * already is left alone, and the rest are set one file at a time under a lock taken in the maintenance database. */
async function applyRoleSettings(db: pg.Pool, settings: string[]) {
  const lacking = async (query: { query(text: string): Promise<pg.QueryResult> }) => {
    const { rows } = await query.query("select coalesce(array_agg(setting), '{}') as have from (select unnest(s.setconfig) as setting from pg_db_role_setting s join pg_roles r on r.oid = s.setrole where r.rolname = current_user and s.setdatabase = 0) t");
    return settings.filter(setting => !rows[0].have.includes(setting));
  };
  if (!(await lacking(db)).length) return;
  const maintenance = new URL(TEST_DATABASE_URL);
  maintenance.pathname = "/postgres";
  const lock = new pg.Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5_000 });
  await lock.connect();
  try {
    await lock.query("select pg_advisory_lock(hashtext('agent-runtime:test-role-settings'))");
    for (const setting of await lacking(db)) {
      const [name, ...value] = setting.split("=");
      if (!/^[a-z_.]+$/i.test(name!)) throw new Error(`Unexpected role setting ${name}`);
      await db.query(`alter role current_user set ${name} = '${value.join("=").replaceAll("'", "''")}'`);
    }
  } finally { await lock.end(); }
}

/** Wait (up to 10 s) for the other sessions on a database to end, as `drop schema` waited for their locks. */
async function ended(admin: pg.Client, database: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await admin.query("select count(*)::int as n from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
    if (rows[0].n === 0) return;
    await sleep(20);
  }
}

/**
 * A fresh database (a schema, with migrate: false) for one test, so parallel test files never share rows. `url`
 * points a runtime process at it. Without a reachable database this fails:
 * every test that runs the runtime needs one.
 */
export async function testDatabase(options: { migrate?: boolean } = {}) {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 5_000 });
  try { await admin.connect(); }
  catch (error) { throw new Error(`The tests need Postgres at ${TEST_DATABASE_URL} (set AGENT_TEST_DATABASE_URL): ${(error as Error).message}`); }
  const schema = `test_${randomBytes(6).toString("hex")}`;
  const copied = options.migrate !== false;
  let named: URL, source: string | undefined;
  if (copied) {
    // A database of its own, copied from the migrated template; a test that migrates by hand (migrate: false) gets a schema.
    source = await migratedTemplate();
    // Copying needs the template free of sessions; the builder's backends may still be closing.
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`create database ${schema} template ${source}`); break; }
      catch (error) { if ((error as { code?: string }).code !== "55006" || attempt >= 100) throw error; await sleep(50); }
    }
    named = new URL(TEST_DATABASE_URL);
    named.pathname = `/${schema}`;
  } else {
    await admin.query(`create schema ${schema}`);
    named = new URL(inSchema(TEST_DATABASE_URL, schema));
  }
  // Every connection to the schema, the test's and any runtime process's, is named after it in pg_stat_activity.
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
      if (copied) await ended(admin, schema);
      await admin.query(copied ? `drop database ${schema} with (force)` : `drop schema ${schema} cascade`);
      await admin.end();
    } finally { clearTimeout(stuck); }
  });
  if (copied) await applyRoleSettings(db, await roleSettings(admin, source!));
  return { db, url, schema };
}
