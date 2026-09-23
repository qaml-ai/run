import { after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { Scheduler, scheduleInput, type Schedule } from "../src/scheduler.ts";
import { testDatabase } from "./database.ts";

/** Schedulers on separate pools, as separate nodes would be. */
async function nodes(count: number, deliver: (node: string, schedule: Schedule, requestId: string) => Promise<void> | void) {
  const { db, url } = await testDatabase();
  const pools = Array.from({ length: count }, () => new pg.Pool({ connectionString: url, max: 2 }));
  after(() => Promise.all(pools.map(pool => pool.end())));
  return { db, schedulers: pools.map((pool, index) => new Scheduler({ db: pool, node: `node-${index}`, deliver: async (schedule, requestId) => deliver(`node-${index}`, schedule, requestId) })) };
}

test("a due wake-up is delivered exactly once even when every node scans at the same moment", async () => {
  const deliveries: [string, string][] = [];
  const { schedulers } = await nodes(3, (node, _schedule, requestId) => { deliveries.push([node, requestId]); });
  const now = Date.now();
  const created = await schedulers[0].create({ agent: "client_a", tenant: "alice", text: "Check the queue", dueAt: now - 10 });
  await Promise.all(schedulers.map(scheduler => scheduler.scan(now)));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0][1], `schedule-${created.id}-${created.dueAt}`);
  assert.deepEqual(await schedulers[1].list("client_a"), [], "a one-off schedule is gone once delivered");
  await Promise.all(schedulers.map(scheduler => scheduler.scan(now + 60_000)));
  assert.equal(deliveries.length, 1);
});

test("many due wake-ups are each delivered once when three nodes scan concurrently and repeatedly", async () => {
  const deliveries: string[] = [];
  const { schedulers } = await nodes(3, async (_node, _schedule, requestId) => { await new Promise(resolve => setTimeout(resolve, Math.random() * 5)); deliveries.push(requestId); });
  const now = Date.now();
  const created = await Promise.all(Array.from({ length: 150 }, (_, index) => schedulers[index % 3].create({ agent: `client_${index % 7}`, tenant: "alice", text: `wake ${index}`, dueAt: now - index })));
  for (let round = 0; round < 3; round++) await Promise.all(schedulers.map(scheduler => scheduler.scan(now)));
  assert.equal(deliveries.length, 150);
  assert.deepEqual(new Set(deliveries), new Set(created.map(schedule => `schedule-${schedule.id}-${schedule.dueAt}`)));
});

test("a wake-up claimed by a node that died is delivered by another once the claim lapses, with the same request id", async () => {
  const deliveries: [string, string][] = [];
  let crash = true;
  const { db, schedulers: [dying, survivor] } = await nodes(2, (node, _schedule, requestId) => {
    if (node === "node-0" && crash) throw new Error("killed mid-delivery");
    deliveries.push([node, requestId]);
  });
  const created = await dying.create({ agent: "client_e", tenant: "alice", text: "once", dueAt: Date.now() - 1 });
  await assert.rejects(dying.scan(), /killed/);
  crash = false;
  await survivor.scan();
  assert.deepEqual(deliveries, [], "the claim still holds");
  await db.query("update schedules set claimed_until = now() - interval '1 second'");
  await survivor.scan();
  assert.deepEqual(deliveries, [["node-1", `schedule-${created.id}-${created.dueAt}`]]);
  assert.deepEqual(await survivor.list("client_e"), []);
});

test("repeating wake-ups move to their next occurrence, skipping ones missed while nothing ran", async () => {
  const deliveries: string[] = [];
  const { schedulers: [scheduler] } = await nodes(1, (_node, _schedule, requestId) => { deliveries.push(requestId); });
  const start = Date.now() - 3 * 60_000;
  const created = await scheduler.create({ agent: "client_b", tenant: "alice", code: "return 1", dueAt: start, everySeconds: 60 });
  await scheduler.scan(Date.now());
  assert.equal(deliveries.length, 1, "three missed minutes produce one catch-up delivery, not three");
  const [next] = await scheduler.list("client_b");
  assert.ok(next.dueAt > Date.now() && (next.dueAt - start) % 60_000 === 0);
  await scheduler.scan(next.dueAt);
  assert.deepEqual(deliveries, [`schedule-${created.id}-${start}`, `schedule-${created.id}-${next.dueAt}`]);
  assert.equal(await scheduler.remove("client_b", created.id), true);
  assert.deepEqual(await scheduler.list("client_b"), []);
});

test("a deleted agent's wake-ups are dropped; other delivery failures are retried", async () => {
  let failure: { status?: number } = { status: 404 };
  let attempts = 0;
  const { db, schedulers: [scheduler] } = await nodes(1, () => { attempts++; throw Object.assign(new Error("failed"), failure); });
  await scheduler.create({ agent: "client_c", tenant: "alice", text: "gone", dueAt: Date.now() - 1 });
  await scheduler.scan();
  assert.deepEqual(await scheduler.list("client_c"), []);
  assert.equal((await db.query("select count(*) as count from schedules")).rows[0].count, 0);
  failure = { status: 503 };
  await scheduler.create({ agent: "client_d", tenant: "alice", text: "retry me", dueAt: Date.now() - 1 });
  await assert.rejects(scheduler.scan(), /failed/);
  assert.equal((await scheduler.list("client_d")).length, 1, "kept for a retry once the claim times out");
  assert.equal(attempts, 2);
});

test("schedule input accepts ISO times, offsets and repeats, and rejects nonsense", () => {
  const now = Date.UTC(2026, 8, 23, 12);
  assert.deepEqual(scheduleInput({ text: "hi", at: "2026-09-23T13:00:00Z" }, now), { text: "hi", dueAt: Date.UTC(2026, 8, 23, 13) });
  assert.deepEqual(scheduleInput({ code: "return 1", inSeconds: 30, everySeconds: 3600 }, now), { code: "return 1", dueAt: now + 30_000, everySeconds: 3600 });
  assert.throws(() => scheduleInput({ text: "hi" }, now), /due time/);
  assert.throws(() => scheduleInput({ text: "hi", at: "2030-01-01" }, now), /a year ahead/);
});
