import { test } from "node:test";
import assert from "node:assert/strict";
import { allowanceFor, EndUserCredits, marked, unmarked } from "../src/end-user-credits.ts";
import { testDatabase } from "./database.ts";
import { runtime } from "./runtime-server.ts";

const USD = 1_000_000;

test("a bucket's allowance: its own key, else the longest prefix, else *, with the user's keys over the tenant's", () => {
  const tenant = { builder: 50 * USD, "bot:*": 1 * USD, "bot:vip-*": 5 * USD, "*": 10_000 };
  assert.equal(allowanceFor(tenant, {}, "builder"), 50 * USD);
  assert.equal(allowanceFor(tenant, {}, "bot:42"), 1 * USD);
  assert.equal(allowanceFor(tenant, {}, "bot:vip-7"), 5 * USD, "the longest prefix wins");
  assert.equal(allowanceFor(tenant, {}, "other"), 10_000);
  assert.equal(allowanceFor({ builder: 1 }, {}, "other"), 0, "no key and no *: no allowance");
  assert.equal(allowanceFor(tenant, { builder: 75 * USD }, "builder"), 75 * USD, "a user's own key wins");
  assert.equal(allowanceFor(tenant, { "bot:*": 2 * USD }, "bot:42"), 2 * USD);
  assert.equal(allowanceFor({ "bot:42": 3 * USD }, { "bot:*": 2 * USD }, "bot:42"), 3 * USD, "an exact name beats a prefix, whoever set it");
});

test("markup rounds what the user is charged up and what it pays for down", () => {
  assert.equal(marked(1_000_000, 2_500), 1_250_000);
  assert.equal(marked(1, 2_500), 2, "a micro-USD of cost is never charged as less");
  assert.equal(marked(0, 2_500), 0);
  assert.equal(marked(333, 0), 333);
  assert.equal(unmarked(1_250_000, 2_500), 1_000_000);
  assert.equal(unmarked(1, 2_500), 0);
  for (const raw of [1, 7, 999, 123_457, 10_000_001]) assert.ok(unmarked(marked(raw, 2_500), 2_500) >= raw, "what a charge pays for covers its cost");
});

test("settings default to off, change field by field, and refuse what is not an amount", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  assert.deepEqual(await credits.settings("a"), { enabled: false, allowances: {}, bucketLimits: {}, dailyLimit: null, markupBps: 0, lowBalance: null, updatedAt: null });
  const set = await credits.setSettings("a", { enabled: true, allowances: { builder: 50 * USD, "bot:*": USD }, markupBps: 2_500 });
  assert.equal(set.enabled, true);
  assert.deepEqual(set.allowances, { builder: 50 * USD, "bot:*": USD });
  const again = await credits.setSettings("a", { dailyLimit: 20 * USD });
  assert.deepEqual([again.enabled, again.markupBps, again.dailyLimit, again.allowances.builder], [true, 2_500, 20 * USD, 50 * USD], "fields left out keep their values");
  assert.equal((await credits.setSettings("a", { dailyLimit: null })).dailyLimit, null);
  // What camel-bots sends as each node starts (enabled and the allowances): the markup, limits and low balance stay.
  await credits.setSettings("a", { dailyLimit: 20 * USD, lowBalance: USD, bucketLimits: { "bot:*": 2 * USD } });
  const restarted = await credits.setSettings("a", { enabled: true, allowances: { builder: 50 * USD, "bot:*": USD } });
  assert.deepEqual([restarted.markupBps, restarted.dailyLimit, restarted.lowBalance, restarted.bucketLimits], [2_500, 20 * USD, USD, { "bot:*": 2 * USD }]);
  for (const bad of [{ allowances: { builder: 1.5 } }, { allowances: { "bad key!": 1 } }, { allowances: { "*x": 1 } }, { markupBps: -1 }, { dailyLimit: -5 }, { lowBalance: "1" }, { enabled: "yes" }, { surprise: 1 }, { bucketLimits: { "bot:*": -1 } }, { bucketLimits: [] }]) {
    await assert.rejects(credits.setSettings("a", bad), (error: any) => error.status === 400, JSON.stringify(bad));
  }
  assert.equal((await credits.settings("b")).enabled, false, "another tenant's are its own");
});

test("grants, refunds and adjustments move the balance once per key, and the ledger pages newest first", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  const grant = await credits.post("a", "user-1", { kind: "grant", amount: 10 * USD, key: "pi_1", reference: "Stripe payment pi_1" });
  assert.deepEqual([grant.replayed, grant.entry.kind, grant.entry.amount, grant.entry.balanceAfter, grant.entry.key, grant.entry.reference], [false, "grant", 10 * USD, 10 * USD, "pi_1", "Stripe payment pi_1"]);
  // The same payment reported again (a webhook retried) posts nothing; the key for another entry is a conflict.
  const replay = await credits.post("a", "user-1", { kind: "grant", amount: 10 * USD, key: "pi_1", reference: "Stripe payment pi_1" });
  assert.deepEqual([replay.replayed, replay.entry.id], [true, grant.entry.id]);
  await assert.rejects(credits.post("a", "user-1", { kind: "grant", amount: 20 * USD, key: "pi_1" }), (error: any) => error.status === 409);
  await assert.rejects(credits.post("a", "user-2", { kind: "grant", amount: 10 * USD, key: "pi_1", reference: "Stripe payment pi_1" }), (error: any) => error.status === 409, "a key is the tenant's, across users");
  assert.equal((await credits.get("a", "user-1")).balance, 10 * USD);

  // Retries racing each other still post once.
  const raced = await Promise.all(Array.from({ length: 8 }, () => credits.post("a", "user-1", { kind: "grant", amount: USD, key: "pi_2" })));
  assert.equal(raced.filter(result => !result.replayed).length, 1);
  assert.equal((await credits.get("a", "user-1")).balance, 11 * USD);

  await credits.post("a", "user-1", { kind: "refund", amount: 3 * USD, key: "re_1" });
  await credits.post("a", "user-1", { kind: "adjustment", amount: -500_000, key: "adj_1", metadata: { why: "goodwill reversed" } });
  await credits.post("a", "user-1", { kind: "adjustment", amount: 250_000, key: "adj_2" });
  const user = await credits.get("a", "user-1");
  assert.equal(user.balance, 11 * USD - 3 * USD - 500_000 + 250_000);
  for (const bad of [{ kind: "grant", amount: 0, key: "k" }, { kind: "grant", amount: -1, key: "k" }, { kind: "refund", amount: -1, key: "k" }, { kind: "adjustment", amount: 0, key: "k" },
    { kind: "usage", amount: 1, key: "k" }, { kind: "grant", amount: 1 }, { kind: "grant", amount: 1.5, key: "k" }, { kind: "grant", amount: 1, key: "k", extra: true }]) {
    await assert.rejects(credits.post("a", "user-1", bad), (error: any) => error.status === 400, JSON.stringify(bad));
  }

  const first = await credits.ledger("a", "user-1", { limit: 2 });
  assert.deepEqual(first.entries.map(entry => entry.key), ["adj_2", "adj_1"]);
  assert.equal(first.entries[1].metadata.why, "goodwill reversed");
  const second = await credits.ledger("a", "user-1", { limit: 2, before: first.next });
  assert.deepEqual(second.entries.map(entry => [entry.kind, entry.amount]), [["refund", -3 * USD], ["grant", USD]]);
  const last = await credits.ledger("a", "user-1", { limit: 2, before: second.next });
  assert.deepEqual([last.entries.map(entry => entry.key), last.next], [["pi_1"], undefined]);
  assert.equal((await credits.ledger("b", "user-1")).entries.length, 0, "another tenant's user is another user");
});

test("a user's overrides merge key by key and never touch what they spent", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("a", { enabled: true, allowances: { builder: 50 * USD, "bot:*": USD } });
  const unseen = await credits.get("a", "someone", ["bot:9"]);
  assert.deepEqual([unseen.balance, unseen.createdAt, unseen.today.buckets.map(bucket => [bucket.bucket, bucket.allowance])], [0, null, [["bot:9", USD], ["builder", 50 * USD]]]);
  assert.equal((await credits.list("a")).endUsers.length, 0, "reading makes no user");

  await db.query("insert into end_user_days (tenant, end_user, day, bucket, allowance_spent) values ('a', 'someone', $1, 'builder', $2)", [new Date().toISOString().slice(0, 10), 30 * USD]);
  const raised = await credits.update("a", "someone", { allowances: { builder: 75 * USD, "bot:7": 0 }, dailyLimit: 5 * USD });
  const builder = raised.today.buckets.find(bucket => bucket.bucket === "builder")!;
  assert.deepEqual([builder.allowance, builder.allowanceSpent, builder.allowanceLeft], [75 * USD, 30 * USD, 45 * USD], "a raised allowance keeps what was spent today");
  assert.deepEqual([raised.dailyLimit, raised.overrides.dailyLimit], [5 * USD, 5 * USD]);
  const lowered = await credits.update("a", "someone", { allowances: { builder: 20 * USD, "bot:7": null } });
  const after = lowered.today.buckets.find(bucket => bucket.bucket === "builder")!;
  assert.deepEqual([after.allowanceSpent, after.allowanceLeft], [30 * USD, 0], "lowered below what was spent: nothing left, nothing reset");
  assert.deepEqual(lowered.overrides.allowances, { builder: 20 * USD });
  assert.equal(lowered.dailyLimit, 5 * USD, "left out: kept");
  assert.equal((await credits.update("a", "someone", { dailyLimit: null })).dailyLimit, null);
  await assert.rejects(credits.update("a", "someone", { allowances: { builder: -1 } }), (error: any) => error.status === 400);
  await assert.rejects(credits.update("a", "", {}), (error: any) => error.status === 400);
  assert.deepEqual((await credits.list("a")).endUsers.map(user => user.id), ["someone"]);
});

test("the end-user API: settings, entries, an end user and their ledger, for the tenant only", async t => {
  const r = await runtime(t, () => ({ content: "ok" }));
  assert.equal((await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, allowances: { builder: 50 * USD }, markupBps: 2_500 } })).status, 200);
  assert.equal((await r.call("/v1/end-user-settings")).json.markupBps, 2_500);
  assert.equal((await r.call("/v1/end-user-settings", { method: "PUT", body: { markupBps: "lots" } })).status, 400);

  const id = encodeURIComponent("discord:1234/abc");
  const posted = await r.call(`/v1/end-users/${id}/entries`, { body: { kind: "grant", amount: 10 * USD, key: "cs_1", reference: "Checkout cs_1" } });
  assert.equal(posted.status, 201, posted.text);
  assert.equal(posted.json.entry.balanceAfter, 10 * USD);
  const again = await r.call(`/v1/end-users/${id}/entries`, { body: { kind: "grant", amount: 10 * USD, key: "cs_1", reference: "Checkout cs_1" } });
  assert.deepEqual([again.status, again.json.replayed], [200, true]);
  assert.equal((await r.call(`/v1/end-users/${id}/entries`, { body: { kind: "grant", amount: 5, key: "cs_1" } })).status, 409);

  const user = await r.call(`/v1/end-users/${id}?buckets=bot:1`);
  assert.equal(user.status, 200, user.text);
  assert.deepEqual([user.json.id, user.json.balance, user.json.available, user.json.today.buckets.map((bucket: any) => bucket.bucket)], ["discord:1234/abc", 10 * USD, 10 * USD, ["bot:1", "builder"]]);
  const patched = await r.call(`/v1/end-users/${id}`, { method: "PATCH", body: { dailyLimit: 2 * USD } });
  assert.deepEqual([patched.status, patched.json.available], [200, 2 * USD], "the daily limit bounds what paid spend may take today");
  const ledger = await r.call(`/v1/end-users/${id}/ledger?limit=1`);
  assert.deepEqual([ledger.json.entries.length, ledger.json.entries[0].key, ledger.json.next], [1, "cs_1", undefined]);
  assert.equal((await r.call(`/v1/end-users/${id}/ledger?limit=0`)).status, 400);
  assert.deepEqual((await r.call("/v1/end-users")).json.endUsers.map((entry: any) => entry.id), ["discord:1234/abc"]);

  // Another tenant sees none of it.
  const { OTHER_OPERATOR } = await import("./runtime-server.ts");
  assert.equal((await r.call(`/v1/end-users/${id}`, { token: OTHER_OPERATOR })).json.balance, 0);
  assert.deepEqual((await r.call("/v1/end-users", { token: OTHER_OPERATOR })).json.endUsers, []);
  assert.equal((await r.call("/v1/end-users", { token: null })).status, 401);
});
