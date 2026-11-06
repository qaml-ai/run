import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";
import { migrate } from "../scripts/migrate.mjs";

const migrations = fileURLToPath(new URL("../../../migrations/", import.meta.url));
const migrateScript = fileURLToPath(new URL("../scripts/migrate.mjs", import.meta.url));
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let templateName: Promise<string> | undefined;

/** The repository migrations run once per migration set, into a template database named by their hash.
 * Every test database is then a copy of it, so applying 100+ migrations is not repeated per test, per
 * file or per process. Concurrent processes serialize on one cluster-wide advisory lock; a changed
 * migration is a new hash and so a new template. */
async function ensureTemplate(admin: pg.Client, base: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(migrateScript));
  for (const file of (await readdir(migrations)).filter(x => /^\d{3}_.*\.sql$/.test(x)).sort()) {
    hash.update(file).update(await readFile(join(migrations, file)));
  }
  const name = `agent_tmpl_${hash.digest("hex").slice(0, 16)}`;
  const building = `${name}_building`;
  await admin.query("select pg_advisory_lock(hashtext('agent-runtime:template'))");
  try {
    if ((await admin.query("select 1 from pg_database where datname=$1", [name])).rowCount) return name;
    // A builder that was killed mid-way leaves only the _building name; nobody else holds this lock.
    await admin.query(`drop database if exists ${building} with (force)`);
    await admin.query(`create database ${building}`);
    const url = new URL(base);
    url.pathname = `/${building}`;
    url.search = "";
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    // Role settings belong to the cluster; the migrations alter them.
    await admin.query("select pg_advisory_lock(hashtext('agent-runtime:role-settings'))");
    try { await migrate(client); }
    finally {
      await admin.query("select pg_advisory_unlock(hashtext('agent-runtime:role-settings'))");
      await client.end();
    }
    // The backend of the closed connection may linger for a moment, and a rename needs no sessions.
    for (let attempt = 0; ; attempt++) {
      try { await admin.query(`alter database ${building} rename to ${name}`); break; }
      catch (error) { if (attempt >= 100) throw error; await delay(50); }
    }
    return name;
  } finally {
    await admin.query("select pg_advisory_unlock(hashtext('agent-runtime:template'))");
  }
}

/** Create database `name` holding the fully migrated repository schema. `admin` must be connected to the
 * cluster's maintenance database named by `base`. */
export async function createMigratedDatabase(admin: pg.Client, base: string, name: string) {
  const template = await (templateName ??= ensureTemplate(admin, base).catch(error => { templateName = undefined; throw error; }));
  // Copying fails while another session is connected to the template. Nothing connects to it after its
  // build, but a just-closed builder's backend may linger briefly.
  for (let attempt = 0; ; attempt++) {
    try { await admin.query(`create database ${name} template ${template}`); return; }
    catch (error) {
      if ((error as { code?: string }).code !== "55006" || attempt >= 100) throw error;
      await delay(50);
    }
  }
}
