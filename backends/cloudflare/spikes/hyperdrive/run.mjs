import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const migrations = resolve(root, "migrations");
const name = `camelrun-proto-hybrid-pg-${process.pid}`;
// Wrangler requires a syntactic password. Local Postgres uses trust auth, so
// this fixed dummy is not a credential and has no security significance.
const fixturePassword = "local-only-unused";
const state = await mkdtemp(resolve(tmpdir(), "camelrun-proto-hyperdrive-"));
const report = { schemaVersion: 1, measuredAt: new Date().toISOString(),
  scope: "local workerd DO -> Hyperdrive localConnectionString -> disposable PostgreSQL 16; no Cloudflare network pool/cache",
  node: process.version, cases: {}, latency: {}, cleanup: {} };
let db, worker, created = false;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const endpoint = "http://127.0.0.1:8797";
async function invoke(agent, input, expected = 200) {
  const start = performance.now();
  const response = await fetch(`${endpoint}/${agent}`, { method: "POST", body: JSON.stringify(input), signal: AbortSignal.timeout(15_000) });
  const data = await response.json();
  assert.equal(response.status, expected, JSON.stringify(data));
  return { ...data, clientMs: performance.now() - start };
}
function sample(tenant, overrides = {}) {
  return { operation: "charge", tenant, id: randomUUID(), reserve: 10_000, cost: 7_000, ...overrides };
}
async function fund(tenant, amount) {
  await db.query("insert into tenants (id, created_at, billing) values ($1, $2, 'prepaid')", [tenant, Date.now()]);
  await db.query(`with entry as (
    insert into credit_ledger (tenant, kind, amount, idempotency_key, metadata, created_at)
    values ($1, 'purchase', $2, $3, '{}', $4) returning tenant, amount
  ) insert into credit_accounts (tenant, balance, purchased) select tenant, amount, amount from entry`,
  [tenant, amount, `fixture:${tenant}`, Date.now()]);
}
async function snapshot(tenant) {
  const { rows: [row] } = await db.query(`select
    (select balance::text from credit_accounts where tenant=$1) balance,
    (select coalesce(sum(amount),0)::text from credit_ledger where tenant=$1) ledger,
    (select count(*)::int from credit_holds where tenant=$1) holds,
    (select coalesce(sum(amount),0)::text from credit_spend_minutes where tenant=$1) spent`, [tenant]);
  assert.equal(row.balance, row.ledger, "balance equals append-only ledger sum");
  return row;
}
function stats(values) {
  const v = [...values].sort((a,b) => a-b);
  return { n: v.length, min: v[0], p50: v[Math.ceil(v.length * .5)-1], p95: v[Math.ceil(v.length * .95)-1], max: v.at(-1) };
}
try {
  docker("run", "--rm", "-d", "--name", name, "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=camelrun_proto", "-p", "127.0.0.1::5432", "postgres:16-alpine");
  created = true;
  const port = docker("port", name, "5432/tcp").split(":").at(-1);
  // Do not accept an externally supplied DB URL.
  const connectionString = `postgresql://postgres:${fixturePassword}@127.0.0.1:${port}/camelrun_proto`;
  for (let i=0; i<60; i++) {
    db = new pg.Client({ connectionString });
    try { await db.connect(); break; } catch { await db.end().catch(() => {}); db = undefined; await pause(250); }
  }
  assert.ok(db, "fresh Postgres started");
  const files = (await readdir(migrations)).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  const digest = createHash("sha256");
  await db.query("create table schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  for (const file of files) {
    const sql = await readFile(resolve(migrations, file), "utf8");
    digest.update(file).update(sql);
    if (sql.startsWith("-- migrate: concurrently")) {
      const statements = sql.split("\n").filter(line => !line.trimStart().startsWith("--")).join("\n").split(";").map(s => s.trim()).filter(Boolean);
      for (const statement of statements) {
        assert.match(statement, /^create\s+(?:unique\s+)?index\s+concurrently\s+if\s+not\s+exists\s/i);
        await db.query(statement);
      }
      await db.query("insert into schema_migrations (name) values ($1)", [file]);
    } else {
      await db.query("begin");
      try { await db.query(sql); await db.query("insert into schema_migrations (name) values ($1)", [file]); await db.query("commit"); }
      catch (error) { await db.query("rollback"); throw new Error(`migration ${file}: ${error.code ?? "failed"}`); }
    }
  }
  report.migrations = { applied: files.length, digest: digest.digest("hex"), first: files[0], last: files.at(-1) };
  report.liveTables = (await db.query("select tablename from pg_tables where schemaname='public' order by tablename")).rows.map(row => row.tablename);
  report.postgres = (await db.query("show server_version")).rows[0].server_version;
  const wrangler = resolve(here, "../../node_modules/wrangler/bin/wrangler.js");
  const childEnv = { ...process.env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: connectionString,
    WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: resolve(state, "logs") };
  // Generated bindings include no localConnectionString and no credentials.
  execFileSync(process.execPath, [wrangler, "types", "worker-configuration.d.ts", "--include-runtime", "false"],
    { cwd: here, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  worker = spawn(process.execPath, [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", "8797", "--persist-to", state],
    { cwd: here, env: childEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
  // Keep a bounded sanitized diagnostic tail only. Never persist binding URLs.
  let startupLog = "";
  const log = chunk => { startupLog = (startupLog + String(chunk).replace(/postgres(?:ql)?:\/\/[^\s)]+/g, "[local DB URL redacted]")).slice(-3000); };
  worker.stdout.on("data", log); worker.stderr.on("data", log);
  let ready = false;
  for (let i=0; i<120; i++) {
    try { ready = (await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(500) })).ok; if (ready) break; } catch {}
    if (worker.exitCode !== null) throw new Error(`local Worker startup failed: ${startupLog}`);
    await pause(250);
  }
  assert.ok(ready, "local Worker started");
  const sequential = "camelrun-proto-sequential";
  await fund(sequential, 1_000_000);
  const trials = [];
  for (let i=0; i<30; i++) trials.push(await invoke(`agent-${i}`, sample(sequential)));
  report.latency.freshDOs = Object.fromEntries(["clientMs", "connectionMs", "transactionAndCloseMs", "totalMs"].map(k => [k, stats(trials.map(row => row[k]))]));
  const warm = [];
  for (let i=0; i<30; i++) warm.push(await invoke("warm-agent", sample(sequential)));
  report.latency.sameDO = Object.fromEntries(["clientMs", "connectionMs", "transactionAndCloseMs", "totalMs"].map(k => [k, stats(warm.map(row => row[k]))]));
  report.latency.raw = { freshDOs: trials, sameDO: warm };
  report.cases.sequential = await snapshot(sequential);

  const concurrency = "camelrun-proto-concurrent";
  await fund(concurrency, 100_000);
  const concurrent = await Promise.all(Array.from({length:20}, (_, i) => invoke(`concurrent-${i}`, sample(concurrency, { reserve: 15_000, cost: 15_000 }))));
  assert.equal(concurrent.filter(x => x.status === "committed").length, 6);
  assert.equal(concurrent.filter(x => x.status === "insufficient").length, 14);
  report.cases.concurrent = { attempts:20, committed:6, refused:14, state:await snapshot(concurrency), timings: concurrent };

  const retryTenant = "camelrun-proto-retries";
  await fund(retryTenant, 100_000);
  const duplicate = sample(retryTenant);
  const duplicates = await Promise.all(Array.from({length:12}, (_, i) => invoke(`duplicate-${i}`, duplicate)));
  assert.equal(duplicates.filter(x => x.status === "committed").length, 1);
  assert.equal(duplicates.filter(x => x.status === "duplicate").length, 11);
  const mismatch = await invoke("mismatch", { ...duplicate, cost: 6_000 }, 500);
  const reserveMismatch = await invoke("mismatch", { ...duplicate, reserve: 11_000 }, 500);
  report.cases.duplicate = { attempts:12, committed:1, duplicates:11, mismatch, reserveMismatch };

  const beforeRollback = await snapshot(retryTenant);
  const rollback = sample(retryTenant, { failAfterLedger:true });
  const failed = await invoke("rollback", rollback, 500);
  assert.deepEqual(await snapshot(retryTenant), beforeRollback);
  const rollbackReceipt = await db.query("select id from usage_flushes where id=$1", [rollback.id]);
  assert.equal(rollbackReceipt.rowCount, 0);
  await invoke("rollback", { ...rollback, failAfterLedger:false });
  report.cases.rollback = { error:failed.error, allWritesRolledBack:true, retryCommitted:true };

  const lost = sample(retryTenant, { loseAcknowledgement:true });
  await invoke("lost", lost, 500);
  const recovered = await invoke("lost", { ...lost, loseAcknowledgement:false });
  assert.equal(recovered.status, "duplicate");
  report.cases.lostAcknowledgement = { recovered:recovered.status, state:await snapshot(retryTenant) };

  const held = sample(retryTenant, { operation:"reserve" });
  assert.equal((await invoke("split", held)).status, "reserved");
  // Between calls there is a durable hold and no open transaction from the DO.
  const active = await db.query("select count(*)::int count from pg_stat_activity where application_name='camelrun-proto-hybrid' and state='idle in transaction'");
  assert.equal(active.rows[0].count, 0);
  assert.equal((await invoke("split", { ...held, operation:"settle" })).status, "committed");
  report.cases.splitReserveSettle = { idleTransactionsBetweenCalls:0, state:await snapshot(retryTenant) };
  const openTenant = "camelrun-proto-open-reservation";
  await fund(openTenant, 20_000);
  const openHold = sample(openTenant, { operation:"reserve", reserve:15_000, cost:10_000 });
  assert.equal((await invoke("open-a", openHold)).status, "reserved");
  assert.equal((await invoke("open-b", sample(openTenant, { reserve:10_000, cost:10_000 }))).status, "insufficient");
  const openBefore = await snapshot(openTenant);
  assert.equal(openBefore.holds, 1);
  await invoke("open-a", {...openHold, operation:"settle", failAfterLedger:true}, 500);
  assert.deepEqual(await snapshot(openTenant), openBefore);
  assert.equal((await invoke("open-a", {...openHold, operation:"settle"})).status, "committed");
  report.cases.openReservation = { competingChargeRefused:true, failedSettlementPreservedHold:true,
    before:openBefore, after:await snapshot(openTenant) };
  console.log(JSON.stringify({ migrations:report.migrations, latency: {freshDOs:report.latency.freshDOs,sameDO:report.latency.sameDO}, cases:report.cases }, (_, value) => Array.isArray(value) ? `[${value.length} samples]` : value, 2));
} catch (error) {
  report.failed = { message: String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, "[redacted local DB URL]") };
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null) {
    try { process.kill(-worker.pid, "SIGTERM"); } catch {}
    await Promise.race([once(worker,"exit"),pause(3000)]);
    if (worker.exitCode === null) { try { process.kill(-worker.pid,"SIGKILL"); } catch {} }
  }
  if (db) await db.end().catch(() => {});
  if (created) docker("rm", "-f", name);
  report.cleanup = { localWorkerStopped: !worker || worker.exitCode !== null || worker.killed,
    localPostgresRemoved: !docker("ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}").includes(name),
    cloudResourcesCreated:0 };
  await rm(state, {recursive:true,force:true});
  await writeFile(resolve(here,"../../docs/hybrid-hyperdrive-results.json"), `${JSON.stringify(report,null,2)}\n`);
  console.log(JSON.stringify({cleanup:report.cleanup, failed:report.failed ?? null}));
}
