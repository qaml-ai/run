import { test } from "node:test";
import assert from "node:assert/strict";
import { dayAfter, EndUserCredits, utcDay } from "../src/end-user-credits.ts";
import { testDatabase } from "./database.ts";
import { OPERATOR, OTHER_OPERATOR, runtime } from "./runtime-server.ts";
import { Agents } from "../clients/node.ts";

const USD = 1_000_000;
const DAY = 86_400_000;

/** A person with usage over two days and two buckets (with a markup), and entries of the tenant's own. */
async function history(credits: EndUserCredits, db: { query: (text: string, values?: unknown[]) => Promise<any> }, tenant = "a", now = Date.now()) {
  await credits.setSettings(tenant, { enabled: true, allowances: { "bot:*": USD, builder: USD / 2 }, markupBps: 2_500 });
  await credits.post(tenant, "p", { kind: "grant", amount: 10 * USD, key: "pi_1" });
  const before = now - 2 * DAY, yesterday = now - DAY;
  // Two days ago: bot:1 spends all its allowance and some of the balance; builder some of its allowance.
  await credits.charge(tenant, "p", "bot:1", 600_000, "charge:1", {}, before);
  await credits.charge(tenant, "p", "bot:1", 600_000, "charge:2", {}, before + 1);
  await credits.charge(tenant, "p", "builder", 200_000, "charge:3", {}, before + 2);
  // Yesterday: builder past its allowance.
  await credits.charge(tenant, "p", "builder", USD, "charge:4", {}, yesterday);
  // A refund and an adjustment two days ago, the grant today.
  await credits.post(tenant, "p", { kind: "refund", amount: USD, key: "re_1" });
  await credits.post(tenant, "p", { kind: "adjustment", amount: -250_000, key: "adj_1" });
  await db.query("update end_user_ledger set created_at = $2 where tenant = $1 and idempotency_key in ('entry:re_1', 'entry:adj_1')", [tenant, before + 3]);
  return { before: utcDay(before), yesterday: utcDay(yesterday), today: utcDay(now) };
}

test("the ledger narrows by kind, time, bucket and moved, and pages with its filters", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  const now = Date.now();
  await history(credits, db, "a", now);
  const all = (await credits.ledger("a", "p", { limit: 200 })).entries;
  assert.equal(all.length, 7);

  const credit = await credits.ledger("a", "p", { kinds: ["grant", "refund", "adjustment"] });
  assert.deepEqual(credit.entries.map(entry => entry.key), ["adj_1", "re_1", "pi_1"], "the credit history, without usage");
  const paged = await credits.ledger("a", "p", { kinds: ["grant", "refund", "adjustment"], limit: 2 });
  assert.deepEqual([paged.entries.map(entry => entry.key), paged.next], [["adj_1", "re_1"], paged.entries[1].id]);
  const rest = await credits.ledger("a", "p", { kinds: ["grant", "refund", "adjustment"], limit: 2, before: paged.next });
  assert.deepEqual([rest.entries.map(entry => entry.key), rest.next], [["pi_1"], undefined], "before pages within the filter");

  const moved = await credits.ledger("a", "p", { moved: true, kinds: ["usage"] });
  assert.deepEqual(moved.entries.map(entry => entry.key), ["charge:4", "charge:2"], "usage the allowance paid for in full is left out");
  assert.ok(moved.entries.every(entry => entry.amount < 0));

  const bot = await credits.ledger("a", "p", { bucket: "bot:1" });
  assert.deepEqual(bot.entries.map(entry => entry.key), ["charge:2", "charge:1"]);

  const yesterday = Date.parse(`${utcDay(now - DAY)}T00:00:00Z`);
  const ranged = await credits.ledger("a", "p", { from: yesterday, to: yesterday + DAY });
  assert.deepEqual(ranged.entries.map(entry => entry.key), ["charge:4"], "from is inclusive and to exclusive, on createdAt");

  await assert.rejects(credits.ledger("a", "p", { kinds: ["gift" as never] }), (error: any) => error.status === 400);
  assert.deepEqual((await credits.ledger("b", "p", { kinds: ["grant"] })).entries, [], "another tenant's are its own");
});

test("per-day totals equal the day's usage rows by bucket, with the tenant's entries, newest first and paged", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  const now = Date.now();
  const days = await history(credits, db, "a", now);

  const { days: read, next } = await credits.days("a", "p", {}, now);
  assert.equal(next, undefined);
  assert.deepEqual(read.map(day => day.day), [days.today, days.yesterday, days.before], "newest first");
  // What each bucket's day says is what its usage rows say: the allowance's part (raw) and what the balance paid (charged).
  const usage = (await credits.ledger("a", "p", { kinds: ["usage"], limit: 200 })).entries;
  for (const day of read) {
    for (const bucket of day.buckets) {
      const rows = usage.filter(entry => entry.metadata.day === day.day && entry.bucket === bucket.bucket);
      assert.deepEqual([bucket.freeRaw, bucket.paidCharged], [rows.reduce((sum, row) => sum + row.allowance, 0), rows.reduce((sum, row) => sum - row.amount, 0)], `${day.day} ${bucket.bucket}`);
    }
  }
  const [today, yesterday, before] = read;
  assert.deepEqual(today, { day: days.today, freeRaw: 0, paidCharged: 0, writtenOff: 0, granted: 10 * USD, refunded: 0, adjusted: 0, entries: 1, buckets: [] }, "a day with only an entry");
  // builder: USD / 2 from its allowance, the other USD / 2 paid at +25%.
  assert.deepEqual(yesterday, { day: days.yesterday, freeRaw: USD / 2, paidCharged: 625_000, writtenOff: 0, granted: 0, refunded: 0, adjusted: 0, entries: 0, buckets: [{ bucket: "builder", freeRaw: USD / 2, paidCharged: 625_000, writtenOff: 0 }] });
  assert.deepEqual(before.buckets, [{ bucket: "bot:1", freeRaw: USD, paidCharged: 250_000, writtenOff: 0 }, { bucket: "builder", freeRaw: 200_000, paidCharged: 0, writtenOff: 0 }]);
  assert.deepEqual([before.freeRaw, before.paidCharged, before.granted, before.refunded, before.adjusted, before.entries], [1_200_000, 250_000, 0, USD, -250_000, 2]);

  // A page at a time: next is passed as to.
  const first = await credits.days("a", "p", { limit: 2 }, now);
  assert.deepEqual([first.days.map(day => day.day), first.next], [[days.today, days.yesterday], days.yesterday]);
  const second = await credits.days("a", "p", { limit: 2, to: first.next }, now);
  assert.deepEqual([second.days.map(day => day.day), second.next], [[days.before], undefined]);

  // One bucket: its spend alone, no entries.
  const builder = await credits.days("a", "p", { bucket: "builder" }, now);
  assert.deepEqual(builder.days.map(day => [day.day, day.buckets.map(bucket => bucket.bucket), day.entries]), [[days.yesterday, ["builder"], 0], [days.before, ["builder"], 0]]);
  // A range: from inclusive, to exclusive.
  assert.deepEqual((await credits.days("a", "p", { from: days.yesterday, to: days.today }, now)).days.map(day => day.day), [days.yesterday]);

  for (const bad of [{ from: "2026-13-01" }, { to: "yesterday" }, { from: days.today, to: days.today }, { from: "2020-01-01", to: "2026-01-01" }, { bucket: "bad bucket!" }]) {
    await assert.rejects(credits.days("a", "p", bad, now), (error: any) => error.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual((await credits.days("b", "p", {}, now)).days, [], "another tenant's are its own");
  assert.equal(dayAfter("2026-02-28", 1), "2026-03-01");
});

test("the history API and the TypeScript SDK: ledger filters and per-day totals, for the tenant only", async t => {
  const r = await runtime(t, () => ({ content: "ok" }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  await agents.endUsers.configure({ enabled: true, allowances: { builder: USD } });
  await agents.endUsers.grant("p", { amount: 5 * USD, key: "pi_1" });
  await agents.endUsers.adjust("p", { amount: -USD, key: "adj_1" });

  const credit = await agents.endUsers.ledger("p", { kind: ["grant", "refund"], from: new Date(Date.now() - DAY), moved: true });
  assert.deepEqual(credit.entries.map(entry => entry.key), ["pi_1"]);
  const days = await agents.endUsers.days("p", { limit: 5 });
  assert.deepEqual(days.days.map(day => [day.day, day.granted, day.adjusted, day.entries]), [[utcDay(Date.now()), 5 * USD, -USD, 2]]);

  const ledger = (query: string) => r.call(`/v1/end-users/p/ledger?${query}`);
  assert.deepEqual((await ledger("kind=grant,adjustment&from=2020-01-01&to=2099-01-01T00:00:00Z")).json.entries.map((entry: any) => entry.key), ["adj_1", "pi_1"]);
  for (const bad of ["kind=gift", "kind=", "from=soon", "to=12abc", "moved=yes", "bucket=bad%20bucket!"]) assert.equal((await ledger(bad)).status, 400, bad);
  for (const bad of ["from=2026-02-30", "to=tomorrow", "limit=0", "limit=x"]) assert.equal((await r.call(`/v1/end-users/p/days?${bad}`)).status, 400, bad);

  assert.deepEqual((await r.call("/v1/end-users/p/days", { token: OTHER_OPERATOR })).json.days, [], "another tenant sees none of it");
  assert.deepEqual((await r.call("/v1/end-users/p/ledger?kind=grant", { token: OTHER_OPERATOR })).json.entries, []);
});
