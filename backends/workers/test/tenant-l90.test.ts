import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers")
    return { url: "data:text/javascript,export class DurableObject { constructor(ctx) { this.ctx = ctx; } }", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { TenantAdmission } = await import("../src/tenant.ts");
hooks.deregister();

test("L90 counts and drops only the legacy tables while preserving live admission state", async t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE storage_objects (id TEXT);
    INSERT INTO storage_objects VALUES ('one'), ('two');
    CREATE TABLE storage_total (bytes INTEGER);
    INSERT INTO storage_total VALUES (2);
    CREATE TABLE storage_listing (id TEXT);
    INSERT INTO storage_listing VALUES ('one');
  `);
  const alarm = Date.now() + 60_000;
  const storage = {
    sql: { exec(query: string, ...args: SQLInputValue[]) {
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
    } },
    transactionSync<T>(write: () => T): T {
      db.exec("BEGIN");
      try { const result = write(); db.exec("COMMIT"); return result; }
      catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    getAlarm: async () => alarm,
  };
  const admission = new TenantAdmission({ storage } as unknown as DurableObjectState, {});
  assert.equal(await admission.acquire("agent-active"), true);
  assert.equal(await admission.reserveCreation("agent-creating", "reservation", 2), true);
  assert.equal(await admission.rate("calls", 1, 1e15), true);
  assert.equal(await admission.acquireWatcher("agent-active", "socket", 1), true);
  const repo = { id: "repo", name: "repo", key: null, lineage: "lineage", createdAt: 1, deletedAt: null, bytes: 0, files: 0 };
  assert.equal(admission.registerRepo(repo).existing, false);

  for (const drop of [false, true]) {
    const result = await admission.legacyVolumeTables(drop);
    assert.equal(result.alarm, alarm);
    assert.deepEqual(Object.fromEntries(result.tables.map(({ name, rows }) => [name, rows])), {
      storage_objects: 2, storage_total: 1, storage_listing: 1,
    });
  }
  assert.deepEqual(await admission.legacyVolumeTables(false), { tables: [], alarm });
  assert.deepEqual(await admission.legacyVolumeTables(true), { tables: [], alarm });
  assert.deepEqual(await admission.status(), { active: 1 });
  assert.equal(await admission.acquire("agent-extra", 2), false, "creation reservation still consumes a slot");
  assert.equal(await admission.rate("calls", 1, 1e15), false);
  assert.equal(await admission.canWatch(1), false);
  assert.deepEqual({ ...admission.repoRow("repo") }, repo);
});
