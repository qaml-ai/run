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

test("a one-off wake-up leaves the list as its delivery begins: the run it starts never sees it", async () => {
  let listed: Schedule[] | undefined;
  const { schedulers } = await nodes(1, async (_node, schedule) => { listed = await schedulers[0].list(schedule.agent); });
  const now = Date.now();
  await schedulers[0].create({ agent: "client_self", tenant: "alice", text: "Look at your schedules", dueAt: now - 10 });
  const hourly = await schedulers[0].create({ agent: "client_self", tenant: "alice", text: "Hourly", dueAt: now + 3_600_000, everySeconds: 3600 });
  await schedulers[0].scan(now);
  assert.deepEqual(listed?.map(schedule => schedule.id), [hourly.id]);
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

test("an agent's cap of 100 schedules holds when creates race on separate connections", async () => {
  const { db, schedulers } = await nodes(3, () => {});
  const now = Date.now();
  for (let index = 0; index < 97; index++) await db.query("insert into schedules (id, agent, tenant, text, due_at, created_at) values (gen_random_uuid(), 'client_cap', 'alice', 'x', $1, $1)", [now + 60_000]);
  const results = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => schedulers[index % 3].create({ agent: "client_cap", tenant: "alice", text: `race ${index}`, dueAt: now + 60_000 })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 3);
  assert.equal(Number((await db.query("select count(*) as count from schedules where agent = 'client_cap'")).rows[0].count), 100);
});

test("a wake-up claimed by a node that died is delivered by another once the claim lapses, with the same request id", async () => {
  const deliveries: [string, string][] = [];
  let crash = true;
  const { db, schedulers: [dying, survivor] } = await nodes(2, (node, _schedule, requestId) => {
    if (node === "node-0" && crash) throw new Error("killed mid-delivery");
    deliveries.push([node, requestId]);
  });
  const created = await dying.create({ agent: "client_e", tenant: "alice", text: "once", dueAt: Date.now() - 1 });
  await dying.scan();
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

/** Let a wake-up's backoff (its claim's expiry) lapse now, as if its retry were due. */
const lapse = (db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, id: string) => db.query("update schedules set claimed_until = now() - interval '1 second' where id = $1", [id]);
/** How long until a wake-up's retry, in milliseconds. */
const backoff = async (db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }, id: string) =>
  Number((await db.query("select extract(epoch from claimed_until - now()) * 1000 as ms from schedules where id = $1", [id])).rows[0].ms);

test("a deleted agent's wake-ups are dropped", async () => {
  const { db, schedulers: [scheduler] } = await nodes(1, () => { throw Object.assign(new Error("gone"), { status: 404 }); });
  await scheduler.create({ agent: "client_c", tenant: "alice", text: "gone", dueAt: Date.now() - 1 });
  await scheduler.scan();
  assert.deepEqual(await scheduler.list("client_c"), []);
  assert.equal((await db.query("select count(*) as count from schedules")).rows[0].count, 0);
});

test("a failed delivery is retried with a backoff and the same request id; a success clears the failure", async () => {
  const requests: string[] = [];
  let failing = true;
  const { db, schedulers: [scheduler] } = await nodes(1, (_node, _schedule, requestId) => {
    requests.push(requestId);
    if (failing) throw Object.assign(new Error("owner unreachable"), { status: 503 });
  });
  const created = await scheduler.create({ agent: "client_d", tenant: "alice", text: "retry me", dueAt: Date.now() - 1, everySeconds: 3600 });
  await scheduler.scan();
  const [retrying] = await scheduler.list("client_d");
  assert.equal(retrying.dueAt, created.dueAt, "still the same occurrence");
  assert.equal(retrying.lastError, "HTTP 503: owner unreachable");
  assert.equal(retrying.failures, undefined, "not given up");
  assert.ok(Math.abs(await backoff(db, created.id) - 60_000) < 5_000, "retried in a minute");
  await scheduler.scan();
  assert.equal(requests.length, 1, "not before its backoff");
  await lapse(db, created.id);
  await scheduler.scan();
  assert.ok(Math.abs(await backoff(db, created.id) - 5 * 60_000) < 5_000, "then in five");
  failing = false;
  await lapse(db, created.id);
  await scheduler.scan();
  assert.deepEqual(requests, Array(3).fill(`schedule-${created.id}-${created.dueAt}`));
  const [next] = await scheduler.list("client_d");
  assert.equal(next.dueAt, created.dueAt + 3_600_000);
  assert.equal(next.lastError, undefined);
  assert.equal((await db.query("select attempts from schedules where id = $1", [created.id])).rows[0].attempts, 0);
});

test("a delivery that keeps failing is given up after its retries: a repeating schedule moves on and records it, a one-off one is dropped", async () => {
  const requests: string[] = [];
  const { db, schedulers: [scheduler] } = await nodes(1, (_node, _schedule, requestId) => { requests.push(requestId); throw new Error("connection reset"); });
  const hourly = await scheduler.create({ agent: "client_f", tenant: "alice", text: "hourly", dueAt: Date.now() - 1, everySeconds: 3600 });
  const once = await scheduler.create({ agent: "client_f", tenant: "alice", text: "once", dueAt: Date.now() - 1 });
  for (let attempt = 0; attempt < 4; attempt++) {
    await Promise.all([lapse(db, hourly.id), lapse(db, once.id)]);
    await scheduler.scan();
  }
  assert.equal(requests.length, 8, "each tried four times: once and after 1, 5 and 15 minutes");
  const [moved, ...rest] = await scheduler.list("client_f");
  assert.deepEqual(rest, [], "the one-off schedule is dropped");
  assert.equal(moved.id, hourly.id);
  assert.equal(moved.dueAt, hourly.dueAt + 3_600_000, "on to its next occurrence");
  assert.equal(moved.failures, 1);
  assert.equal(moved.lastError, "connection reset");
  assert.ok(moved.lastErrorAt! <= Date.now());
  await scheduler.scan(moved.dueAt);
  assert.equal(requests.length, 9, "the next occurrence is delivered as usual");
});

test("a retry is not let run into a repeating schedule's next occurrence", async () => {
  let attempts = 0;
  const { schedulers: [scheduler] } = await nodes(1, () => { attempts++; throw new Error("down"); });
  // Every minute: a retry a minute later would be the next occurrence, so the occurrence is given up at once.
  const created = await scheduler.create({ agent: "client_g", tenant: "alice", text: "minutely", dueAt: Date.now() - 1, everySeconds: 60 });
  await scheduler.scan();
  const [moved] = await scheduler.list("client_g");
  assert.equal(attempts, 1);
  assert.equal(moved.dueAt, created.dueAt + 60_000);
  assert.equal(moved.failures, 1);
});

test("a refusal a retry cannot change (a spend limit's 402) gives the occurrence up at once and is recorded", async () => {
  let attempts = 0;
  const { schedulers: [scheduler] } = await nodes(1, () => { attempts++; throw Object.assign(new Error("This agent has reached its spend limit"), { status: 402, code: "SPEND_LIMIT" }); });
  const daily = await scheduler.create({ agent: "client_h", tenant: "alice", text: "daily", dueAt: Date.now() - 1, everySeconds: 86_400 });
  await scheduler.scan();
  const [moved] = await scheduler.list("client_h");
  assert.equal(attempts, 1, "no retries");
  assert.equal(moved.dueAt, daily.dueAt + 86_400_000);
  assert.equal(moved.failures, 1);
  assert.equal(moved.lastError, "HTTP 402: This agent has reached its spend limit");
  await scheduler.scan(moved.dueAt);
  assert.equal((await scheduler.list("client_h"))[0].failures, 2, "occurrences given up in a row");
});

test("one failing wake-up does not hold up the others in its batch", async () => {
  const delivered: string[] = [];
  const { schedulers: [scheduler] } = await nodes(1, (_node, schedule) => { if (schedule.text === "bad") throw new Error("down"); delivered.push(schedule.text!); });
  const now = Date.now();
  await scheduler.create({ agent: "client_i", tenant: "alice", text: "bad", dueAt: now - 10 });
  await scheduler.create({ agent: "client_i", tenant: "alice", text: "good", dueAt: now - 5 });
  await scheduler.scan(now);
  assert.deepEqual(delivered, ["good"]);
});

test("schedule input accepts ISO times, offsets and repeats, and rejects nonsense", () => {
  const now = Date.UTC(2026, 8, 23, 12);
  assert.deepEqual(scheduleInput({ text: "hi", at: "2026-09-23T13:00:00Z" }, now), { text: "hi", dueAt: Date.UTC(2026, 8, 23, 13) });
  assert.deepEqual(scheduleInput({ code: "return 1", inSeconds: 30, everySeconds: 3600 }, now), { code: "return 1", dueAt: now + 30_000, everySeconds: 3600 });
  assert.throws(() => scheduleInput({ text: "hi" }, now), /due time/);
  assert.throws(() => scheduleInput({ text: "hi", at: "2030-01-01" }, now), /a year ahead/);
});
