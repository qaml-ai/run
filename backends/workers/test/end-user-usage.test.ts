// Ported from tests/end-user-usage.test.ts. Included assertions and test bodies are unchanged.
// Only service imports and the isolated Postgres fixture differ; see money-policy-port.json for excluded ECS fixtures.
import { test } from "node:test";

import assert from "node:assert/strict";

import { EndUserCredits } from "../src/end-user-credits.ts";

import { testDatabase } from "./billing-database.ts";

const HOUR = 3_600_000, DAY = 24 * HOUR;

const START = Date.parse("2026-02-01T00:00:00Z");

test("usage sums posting hours and UTC days across buckets, calls and agents", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("a", { enabled: true, allowances: { "bot:*": 100 }, markupBps: 2_500 });
  await credits.post("a", "p", { kind: "grant", amount: 1_000, key: "grant" });
  await credits.charge("a", "p", "bot:1", 200, "first", { call: "response", agent: "one" }, START + 1);
  await credits.charge("a", "p", "bot:1", 100, "second", { call: "response", agent: "one" }, START + 2);
  await credits.charge("a", "p", "bot:1", 20, "call", { call: "compaction", agent: "one" }, START + 3);
  await credits.charge("a", "p", "bot:1", 20, "agent", { call: "response", agent: "two" }, START + 4);
  await credits.charge("a", "p", "bot:2", 30, "bucket", {}, START + 5);
  await credits.charge("a", "p", "bot:1", 40, "hour", { call: "response", agent: "one" }, START + HOUR);
  await credits.charge("a", "p", "builder", 2_000, "writeoff", { call: "image" }, START + DAY);
  await credits.charge("a", "p", "builder", 10, "end", {}, START + 2 * DAY);
  // Every non-usage kind, even one carrying call metadata, is excluded.
  await db.query(`insert into end_user_ledger (tenant, end_user, kind, amount, raw, idempotency_key, balance_after, created_at)
    select 'a', 'p', kind, 1, 999, kind, 0, $1 from unnest('{grant,refund,adjustment,spend,expiry}'::text[]) kind`, [START]);
  const query = { from: START, to: START + 2 * DAY };
  const hourly = await credits.usage("a", "p", query);
  assert.deepEqual(hourly.rows, [
    { at: START, bucket: "bot:1", call: "compaction", agent: "one", calls: 1, raw: 20, allowance: 0, paid: 25, writtenOff: 0 },
    { at: START, bucket: "bot:1", call: "response", agent: "one", calls: 2, raw: 300, allowance: 100, paid: 250, writtenOff: 0 },
    { at: START, bucket: "bot:1", call: "response", agent: "two", calls: 1, raw: 20, allowance: 0, paid: 25, writtenOff: 0 },
    { at: START, bucket: "bot:2", call: null, agent: null, calls: 1, raw: 30, allowance: 30, paid: 0, writtenOff: 0 },
    { at: START + HOUR, bucket: "bot:1", call: "response", agent: "one", calls: 1, raw: 40, allowance: 0, paid: 50, writtenOff: 0 },
    { at: START + DAY, bucket: "builder", call: "image", agent: null, calls: 1, raw: 2_000, allowance: 0, paid: 650, writtenOff: 1_480 },
  ]);
  const daily = await credits.usage("a", "p", { ...query, step: "day" });
  assert.equal(daily.rows.length, 5);
  assert.deepEqual(daily.rows[1], { ...hourly.rows[1], calls: 3, raw: 340, paid: 300 });
  assert.deepEqual(daily.rows.at(-1), hourly.rows.at(-1));
  assert.equal((await credits.usage("a", "p", { ...query, bucket: "bot:*" })).rows.length, 5);
  assert.equal((await credits.usage("a", "p", { ...query, bucket: "bot:2" })).rows.length, 1);
  assert.equal((await credits.usage("a", "p", { ...query, bucket: "bot:_*" })).rows.length, 0, "underscore is literal");
  assert.deepEqual((await credits.usage("b", "p", query)).rows, []);
  assert.deepEqual((await credits.usage("a", "other", query)).rows, []);
  assert.deepEqual((await credits.usage("a", "p", { from: START + 1, to: START + 2 })).rows, [{ ...hourly.rows[1], calls: 1, raw: 200, paid: 125 }]);
});

test("usage corrections sum signed amounts at posting time", async () => {
  const { db } = await testDatabase();
  await db.query(`insert into end_user_ledger (tenant, end_user, kind, amount, raw, allowance, written_off, bucket, metadata, idempotency_key, balance_after, created_at)
    values ('a', 'p', 'usage', -50, 100, 20, 30, 'bot:1', '{"call":"response","agent":"one","day":"2026-01-31"}', 'first', 0, $1),
           ('a', 'p', 'usage', 10, -25, -5, -10, 'bot:1', '{"call":"response","agent":"one","day":"2026-01-31"}', 'correction', 0, $2)`, [START, START + 1]);
  const credits = new EndUserCredits(db);
  for (const step of ["hour", "day"] as const) {
    assert.deepEqual((await credits.usage("a", "p", { from: START + 1, to: START + DAY, step })).rows,
      [{ at: START, bucket: "bot:1", call: "response", agent: "one", calls: 1, raw: -25, allowance: -5, paid: -10, writtenOff: -10 }]);
    assert.deepEqual((await credits.usage("a", "p", { from: START, to: START + DAY, step })).rows,
      [{ at: START, bucket: "bot:1", call: "response", agent: "one", calls: 2, raw: 75, allowance: 15, paid: 40, writtenOff: 20 }]);
  }
});

test("usage defaults and invalid ranges", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  assert.deepEqual(await credits.usage("a", "p", {}, START), { step: "hour", from: START - DAY, to: START, rows: [] });
  assert.deepEqual(await credits.usage("a", "p", { step: "day" }, START), { step: "day", from: START - 30 * DAY, to: START, rows: [] });
  for (const query of [
    { step: "minute" }, { from: NaN }, { to: Infinity }, { from: 1.5 }, { from: "today" }, { from: null },
    { from: START, to: START }, { from: START + 1, to: START }, { from: START, to: START + 7 * DAY + 1 },
    { step: "day", from: START, to: START + 366 * DAY + 1 }, { bucket: "bad bucket" }, { bucket: "bot:*:x" }, { bucket: "" },
  ]) await assert.rejects(credits.usage("a", "p", query as any, START), (error: any) => error.status === 400, JSON.stringify(query));
  await credits.usage("a", "p", { from: START, to: START + 7 * DAY });
  await credits.usage("a", "p", { step: "day", from: START, to: START + 366 * DAY });
});

test("usage time ranges use the user's time index, not their history or other users", async () => {
  const { db } = await testDatabase();
  await db.query(`insert into end_user_ledger (tenant, end_user, kind, amount, idempotency_key, balance_after, created_at)
    select 'a', case when n <= 20000 then 'p' else 'other' end, 'usage', 0, 'seed:' || n, 0, n * 3600000::bigint
    from generate_series(1, 40000) n`);
  await db.query("analyze end_user_ledger");
  const credits = new EndUserCredits(db);
  const statements: { text: string; values: any[] }[] = [];
  const spy = new EndUserCredits({ query: async (text: string, values: any[]) => { statements.push({ text, values }); return db.query(text, values); } } as any);
  await spy.usage("a", "p", { from: 100 * HOUR, to: 101 * HOUR });
  assert.equal(statements.length, 1, "one SQL statement groups and sums");
  const { text, values } = statements[0];
  const plan = (await db.query(`explain (analyze, buffers) ${text}`, values)).rows.map(row => row["QUERY PLAN"]).join("\n");
  console.log(plan);
  assert.match(plan, /end_user_ledger_usage_time/);
  assert.match(plan, /Index Cond:.*tenant.*end_user.*created_at/);
  assert.equal((await credits.usage("a", "p", { from: 100 * HOUR, to: 101 * HOUR })).rows[0].calls, 1);
});
