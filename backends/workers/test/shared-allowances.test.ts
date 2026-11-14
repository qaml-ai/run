// Ported from tests/shared-allowances.test.ts. Included assertions and test bodies are unchanged.
// Only service imports and the isolated Postgres fixture differ; see money-policy-port.json for excluded ECS fixtures.
import { test } from "node:test";

import assert from "node:assert/strict";

import { EndUserCredits, utcDay, settleUsage } from "../src/end-user-credits.ts";

import { transaction } from "../src/postgres.ts";

import { testDatabase } from "./billing-database.ts";

async function fixture(settings: Record<string, unknown> = {}) {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("t", { enabled: true, sharedAllowances: { "bot:*": 100 }, ...settings });
  return { db, credits };
}

test("concurrent debits share one pool and preserve per-bucket spend", async () => {
  const { credits } = await fixture({ allowances: { builder: 80, "bot:*": 1000 } });
  const buckets = ["bot:1", "bot:2"];
  for (const bucket of buckets) assert.equal(await credits.refusal("t", "u", bucket), undefined);
  const debits = buckets.map(bucket => () => credits.debit("t", "u", bucket, 0.000070, bucket));
  await Promise.all([...debits, ...debits].map(debit => debit()));
  const after = await credits.get("t", "u", ["bot:3"]);
  assert.deepEqual([after.balance, after.today.pools[0].allowanceSpent, after.today.pools[0].held], [-40, 100, 0]);
  assert.equal(after.today.buckets.filter(row => row.bucket.startsWith("bot:")).reduce((sum, row) => sum + row.allowanceSpent, 0), 100);
  assert.equal((await credits.refusal("t", "u", "bot:3"))?.reason, "balance");
  assert.equal(await credits.refusal("t", "u", "builder"), undefined);
  assert.equal((await credits.get("t", "other")).today.pools[0].allowanceLeft, 100);
});

test("exact, prefix, and fallback pools have separate membership, including zero overrides", async () => {
  const { credits } = await fixture({ sharedAllowances: { "*": 100, "bot:*": 200, "bot:exact": 300 } });
  await credits.debit("t", "u", "bot:exact", (30) / 1_000_000, "exact");
  await credits.debit("t", "u", "bot:other", (20) / 1_000_000, "prefix");
  await credits.debit("t", "u", "other", (10) / 1_000_000, "fallback");
  const user = await credits.get("t", "u");
  assert.deepEqual(user.today.pools.map(pool => [pool.key, pool.allowanceSpent]), [["*", 10], ["bot:*", 20], ["bot:exact", 30]]);
  assert.ok(user.today.buckets.some(bucket => bucket.bucket === "bot:exact"));
  await credits.update("t", "u", { sharedAllowances: { "bot:*": 0 } });
  assert.ok(await credits.refusal("t", "u", "bot:new"));
  assert.equal((await credits.get("t", "someone", ["bot:exact"])).today.buckets[0].pool!.allowanceLeft, 300);
});

test("a shared allowance pays first and a paid bucket limit gates the next call", async () => {
  const { credits } = await fixture({ bucketLimits: { "bot:*": 50 }, markupBps: 2500 });
  await credits.post("t", "u", { kind: "grant", amount: 1000, key: "paid" });
  await credits.debit("t", "u", "bot:1", 0.000040, "first");
  await credits.debit("t", "u", "bot:2", 0.000120, "second");
  const state = await credits.get("t", "u");
  assert.equal(state.today.pools[0].allowanceLeft, 0);
  assert.deepEqual(state.today.buckets.map(row => [row.bucket, row.allowanceSpent, row.paidSpent]), [["bot:1", 40, 0], ["bot:2", 60, 75]]);
  assert.equal((await credits.refusal("t", "u", "bot:2"))?.reason, "bucket_limit");
  assert.equal(await credits.refusal("t", "u", "bot:3"), undefined);
});

test("policy changes regroup existing spend, most-specific pools win, and overrides merge safely", async () => {
  const { credits } = await fixture({ sharedAllowances: {}, allowances: { "bot:*": 100 } });
  await credits.debit("t", "u", "bot:1", (60) / 1_000_000, "old-spend");
  await credits.setSettings("t", { sharedAllowances: { "bot:*": 100, "bot:vip-*": 200 } });
  assert.equal((await credits.get("t", "u")).today.pools.find(row => row.key === "bot:*")!.allowanceLeft, 40);
  await credits.debit("t", "u", "bot:vip-1", (150) / 1_000_000, "vip-spend");
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

test("a debit uses the original UTC day and leaves the new day's pool available", async () => {
  const { credits } = await fixture();
  const now = Date.parse(`${utcDay(Date.now())}T00:00:00Z`), yesterday = now - 1_000;
  await credits.debit("t", "u", "bot:1", 0.000100, "yesterday", {}, { now: yesterday });
  const [entry] = (await credits.ledger("t", "u")).entries;
  assert.equal(entry.metadata.day, utcDay(yesterday));
  assert.equal((await credits.get("t", "u", ["bot:1"], now)).today.pools[0].allowanceLeft, 100);
});
