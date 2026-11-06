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
  const clock = { now: 1000 };
  let watchers = new TenantWatchers(sql, atomic, () => clock.now);
  assert.equal(watchers.canWatch(2), true);
  assert.equal(watchers.acquire("agent-a", "socket-1", 2), true);
  assert.equal(watchers.acquire("agent-b", "socket-2", 2), true);
  assert.equal(watchers.canWatch(2), false);
  assert.equal(watchers.acquire("agent-c", "socket-3", 2), false);
  assert.equal(watchers.acquire("agent-a", "socket-1", 2), true, "a replay consumes no slot");
  assert.equal(watchers.acquire("agent-b", "socket-1", 2), false, "IDs cannot change owners");
  watchers = new TenantWatchers(sql, atomic, () => clock.now);
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
  assert.equal(watchers.acquire("agent-a", "poll:1", 100), true);
  for (let i = 0; i < 31; i++) assert.equal(watchers.acquire("agent-a", `socket-${i}`, 100), true);
  assert.equal(watchers.canWatch(100, "agent-a"), false, "polls and sockets share the per-agent cap");
  assert.equal(watchers.canWatch(100, "agent-b"), true);
  assert.equal(watchers.acquire("agent-a", "socket-over-limit", 100), false);
  watchers.reconcile("agent-a", ["socket-0"]);
  assert.equal(watchers.acquire("agent-b", "poll:1", 100), false, "a socket wake leaves an active poll intact");
  assert.equal(watchers.canWatch(3), true);
  assert.equal(watchers.canWatch(2), false);
  clock.now += 29_999;
  assert.equal(watchers.canWatch(2), false, "a poll stays reserved throughout its bounded HTTP wait");
  clock.now++;
  assert.equal(watchers.canWatch(2), true, "an abandoned poll expires without a heartbeat");
  assert.equal(watchers.canWatch(1), false, "the socket remains reserved after the poll expires");
  assert.equal(watchers.acquire("agent-a", "poll:2", 2), true);
  clock.now += 30_000;
  assert.equal(watchers.acquire("agent-b", "socket-new", 2), true, "acquiring also prunes abandoned polls");
});
