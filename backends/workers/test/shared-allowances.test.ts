// Ported from tests/shared-allowances.test.ts. Included assertions and test bodies are unchanged.
// Only service imports and the isolated Postgres fixture differ; see money-policy-port.json for excluded ECS fixtures.
import { test } from "node:test";

import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";

import { EndUserCredits, utcDay, settleUsage } from "../src/end-user-credits.ts";

import { transaction } from "../src/postgres.ts";

import { testDatabase } from "./billing-database.ts";

async function fixture(settings: Record<string, unknown> = {}) {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("t", { enabled: true, sharedAllowances: { "bot:*": 100 }, ...settings });
  return { db, credits };
}

test("parallel bots reserve one pool, keep per-bucket spend, and settle idempotently", async () => {
  const { credits } = await fixture({ allowances: { builder: 80, "bot:*": 1000 } });
  const results = await Promise.all(["bot:1", "bot:2"].map(bucket => credits.reserve("t", "u", bucket, { id: randomUUID(), want: 70, min: 1 })));
  assert.deepEqual(results.map(result => result!.hold!.allowance).sort((a,b) => a-b), [30, 70]);
  const held = await credits.get("t", "u");
  assert.deepEqual(held.today.pools, [{ key: "bot:*", allowance: 100, allowanceSpent: 0, held: 100, allowanceLeft: 0 }]);
  assert.equal((await credits.reserve("t", "u", "bot:3", { id: randomUUID(), want: 1, min: 1 }))?.refused?.reason, "balance");
  for (const [i, result] of results.entries()) {
    const hold = result!.hold!;
    await credits.settleHold("t", "u", `bot:${i + 1}`, hold.id, hold.raw, `settle:${i}`);
    await credits.settleHold("t", "u", `bot:${i + 1}`, hold.id, hold.raw, `settle:${i}`);
  }
  const after = await credits.get("t", "u", ["bot:3"]);
  assert.equal(after.today.pools[0].allowanceSpent, 100);
  assert.equal(after.today.pools[0].held, 0);
  assert.equal(after.today.buckets.filter(row => row.bucket.startsWith("bot:")).reduce((sum, row) => sum + row.allowanceSpent, 0), 100);
  assert.equal(after.today.buckets.find(row => row.bucket === "bot:3")!.pool!.allowanceLeft, 0);
  assert.equal((await credits.reserve("t", "u", "builder", { id: randomUUID(), want: 80, min: 80 }))?.hold?.allowance, 80);
  assert.equal((await credits.get("t", "other")).today.pools[0].allowanceLeft, 100);
});

test("exact, prefix, and fallback pools have separate membership, including zero overrides", async () => {
  const { credits } = await fixture({ sharedAllowances: { "*": 100, "bot:*": 200, "bot:exact": 300 } });
  await credits.charge("t", "u", "bot:exact", 30, "exact");
  await credits.charge("t", "u", "bot:other", 20, "prefix");
  await credits.charge("t", "u", "other", 10, "fallback");
  const user = await credits.get("t", "u");
  assert.deepEqual(user.today.pools.map(pool => [pool.key, pool.allowanceSpent]), [["*", 10], ["bot:*", 20], ["bot:exact", 30]]);
  assert.ok(user.today.buckets.some(bucket => bucket.bucket === "bot:exact"));
  await credits.update("t", "u", { sharedAllowances: { "bot:*": 0 } });
  assert.ok((await credits.reserve("t", "u", "bot:new", { id: randomUUID(), want: 1, min: 1 }))?.refused);
  assert.equal((await credits.get("t", "someone", ["bot:exact"])).today.buckets[0].pool!.allowanceLeft, 300);
});

test("pool extensions, refunds, and paid bucket limits share the same budget", async () => {
  const { credits } = await fixture({ bucketLimits: { "bot:*": 0 } });
  const first = (await credits.reserve("t", "u", "bot:1", { id: randomUUID(), want: 60, min: 1 }))!.hold!;
  const second = (await credits.reserve("t", "u", "bot:2", { id: randomUUID(), want: 30, min: 1 }))!.hold!;
  assert.equal((await credits.extend("t", "u", "bot:1", first.id, 30))?.hold?.allowance, 10);
  assert.equal((await credits.extend("t", "u", "bot:2", second.id, 1))?.refused?.reason, "bucket_limit");
  await credits.settleHold("t", "u", "bot:1", first.id, 40, "first");
  assert.equal((await credits.get("t", "u")).today.pools[0].allowanceLeft, 30);
  await credits.release(second.id);
  await credits.post("t", "u", { kind: "grant", amount: 100, key: "paid" });
  await credits.setSettings("t", { bucketLimits: { "bot:*": 50 }, markupBps: 2500 });
  const paid = (await credits.reserve("t", "u", "bot:3", { id: randomUUID(), want: 100, min: 1 }))!.hold!;
  assert.deepEqual([paid.allowance, paid.paid], [60, 50]);
  await credits.release(paid.id);
});

test("policy changes regroup existing spend, most-specific pools win, and overrides merge safely", async () => {
  const { credits } = await fixture({ sharedAllowances: {}, allowances: { "bot:*": 100 } });
  await credits.charge("t", "u", "bot:1", 60, "old-spend");
  await credits.setSettings("t", { sharedAllowances: { "bot:*": 100, "bot:vip-*": 200 } });
  assert.equal((await credits.get("t", "u")).today.pools.find(row => row.key === "bot:*")!.allowanceLeft, 40);
  await credits.charge("t", "u", "bot:vip-1", 150, "vip-spend");
  const state = await credits.update("t", "u", { sharedAllowances: { "bot:*": 500 } });
  assert.deepEqual(state.today.pools.map(row => [row.key, row.allowanceLeft]), [["bot:*", 440], ["bot:vip-*", 50]]);
  assert.equal((await credits.update("t", "u", { sharedAllowances: { "bot:*": null } })).today.pools[0].allowance, 100);
  await Promise.all(Array.from({ length: 10 }, (_, i) => credits.setSettings("t", { sharedAllowances: { [`p${i}:*`]: i } }, { merge: true })));
  assert.equal(Object.keys((await credits.settings("t")).sharedAllowances).length, 12);
  await credits.setSettings("t", { sharedAllowances: { "bot:*": null } }, { merge: true });
  assert.equal((await credits.get("t", "u", ["bot:1"])).today.buckets.find(row => row.bucket === "bot:1")!.allowanceLeft, 40);
  for (const value of [{ "bad key": 1 }, { "bot:*": -1 }, { "bot:*": 1.5 }, []]) {
    await assert.rejects(credits.update("t", "u", { sharedAllowances: value }), (error: any) => error.status === 400);
  }
});

test("pool warnings and exhaustion fire once per day even after a correction", async () => {
  const { credits, db } = await fixture({ allowanceWarningPercent: 50 });
  await db.query(`insert into webhook_endpoints (id, tenant, url, events, secret, created_at)
    values ('we_shared', 't', 'https://example.test/hook', ARRAY['end_user.allowance.low','end_user.credit.exhausted'], '{}', 0)`);
  const now = Date.now(), day = utcDay(now);
  const post = (bucket: string, raw: number, key: string, previous = {}) => transaction(db, sql => settleUsage(sql, { tenant: "t", endUser: "u", bucket, day, raw, key, previous }, now));
  const a = await post("bot:1", 30, "a");
  await post("bot:2", 30, "b");
  await post("bot:3", 40, "c");
  const corrected = await post("bot:1", 10, "a-corrected", a);
  await post("bot:1", 30, "a-restored", corrected);
  const events = (await db.query("select body from webhook_deliveries where tenant='t'")).rows.map(row => row.body);
  assert.equal(events.filter(row => row.type === "end_user.allowance.low").length, 1);
  assert.equal(events.filter(row => row.type === "end_user.credit.exhausted" && row.data.reason === "allowance").length, 1);
  assert.equal(events.find(row => row.type === "end_user.allowance.low")!.data.pool, "bot:*");
});

test("a hold begun yesterday extends from yesterday's pool and leaves today's pool free", async () => {
  const { credits } = await fixture();
  const now = Date.parse(`${utcDay(Date.now())}T00:00:00Z`), yesterday = now - 1000;
  const old = (await credits.reserve("t", "u", "bot:1", { id: randomUUID(), want: 60, min: 1 }, yesterday))!.hold!;
  assert.equal((await credits.extend("t", "u", "bot:1", old.id, 100, now))!.hold!.allowance, 40);
  await credits.post("t", "u", { kind: "grant", amount: 50, key: "paid" });
  await credits.reserve("t", "u", "bot:3", { id: randomUUID(), want: 40, min: 40 }, yesterday);
  const today = await credits.get("t", "u", ["bot:1"], now);
  assert.equal(today.today.pools[0].held, 0);
  assert.equal(today.today.buckets.find(row => row.bucket === "bot:3")!.held, 40);
  assert.equal(today.available, 10);
  assert.equal((await credits.reserve("t", "u", "bot:2", { id: randomUUID(), want: 100, min: 1 }, now))!.hold!.allowance, 100);
});
