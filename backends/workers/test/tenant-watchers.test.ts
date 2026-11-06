import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TenantWatchers } from "../src/tenant-watchers.ts";

test("tenant socket quotas survive waking, reconcile only their owner and release idempotently", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const sql = { exec(query: string, ...args: any[]) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } } as unknown as SqlStorage;
  const atomic = <T>(write: () => T): T => {
    db.exec("BEGIN");
    try { const result = write(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  let watchers = new TenantWatchers(sql, atomic);
  assert.equal(watchers.canWatch(2), true);
  assert.equal(watchers.acquire("agent-a", "socket-1", 2), true);
  assert.equal(watchers.acquire("agent-b", "socket-2", 2), true);
  assert.equal(watchers.canWatch(2), false);
  assert.equal(watchers.acquire("agent-c", "socket-3", 2), false);
  assert.equal(watchers.acquire("agent-a", "socket-1", 2), true, "a replay consumes no slot");
  assert.equal(watchers.acquire("agent-b", "socket-1", 2), false, "IDs cannot change owners");
  watchers = new TenantWatchers(sql, atomic);
  assert.equal(watchers.canWatch(2), false, "waking preserves all live reservations");
  watchers.reconcile("agent-a", ["socket-1", "unknown"]);
  assert.equal(watchers.canWatch(2), false);
  watchers.reconcile("agent-a", []);
  assert.equal(watchers.canWatch(2), true);
  assert.equal(watchers.acquire("agent-c", "socket-3", 2), true);
  assert.equal(watchers.canWatch(2), false, "other agents retain their reservations");
  watchers.release("socket-2");
  watchers.release("socket-2");
  assert.equal(watchers.canWatch(2), true);
  db.exec("DROP TABLE event_watchers");
  watchers.initialize();
  assert.equal(watchers.canWatch(1), true, "account purge recreates an empty schema");
});
