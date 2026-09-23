import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { databaseFromEnvironment, migrate } from "../src/db.ts";
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
    const db = databaseFromEnvironment(); console.log(JSON.stringify(await migrate(db))); await db.end();`;
  const run = () => promisify(execFile)(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
    { env: { PATH: process.env.PATH, AGENT_DATABASE_URL: url } });
  const outputs = (await Promise.all([run(), run()])).map(({ stdout }) => JSON.parse(stdout));
  assert.deepEqual(outputs.flat().sort(), MIGRATIONS, "one process applied them, the other found nothing to do");
  assert.equal((await db.query("select count(*) as count from schema_migrations")).rows[0].count, MIGRATIONS.length);
});

test("the connection honours AGENT_DATABASE_CA and the pool size, and a URL is required", () => {
  assert.throws(() => databaseFromEnvironment({}), /AGENT_DATABASE_URL/);
  const pool = databaseFromEnvironment({ AGENT_DATABASE_URL: "postgres://user:pass@db.example.test:5432/agents", AGENT_DATABASE_CA: "/etc/ssl/rds-global-bundle.pem", AGENT_DATABASE_POOL_SIZE: "4" });
  const url = new URL((pool.options as { connectionString: string }).connectionString);
  assert.equal(url.searchParams.get("sslrootcert"), "/etc/ssl/rds-global-bundle.pem");
  assert.equal(url.searchParams.get("sslmode"), "verify-full");
  assert.equal(pool.options.max, 4);
  void pool.end();
  const explicit = databaseFromEnvironment({ AGENT_DATABASE_URL: "postgres://db.example.test/agents?sslmode=require", AGENT_DATABASE_CA: "/ca.pem" });
  assert.equal(new URL((explicit.options as { connectionString: string }).connectionString).searchParams.get("sslmode"), "require");
  void explicit.end();
  assert.throws(() => databaseFromEnvironment({ AGENT_DATABASE_URL: "postgres://db/agents", AGENT_DATABASE_POOL_SIZE: "0" }), /POOL_SIZE/);
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
