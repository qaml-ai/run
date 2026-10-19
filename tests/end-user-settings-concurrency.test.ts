import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { EndUserCredits } from "../src/end-user-credits.ts";
import { testDatabase } from "./database.ts";

// Several writers of one tenant's end-user settings (server nodes as they start, an admin UI, scripts) at once: each
// write changes only the fields it sends, and the keys it sends of a map, so none undoes another's (#274).

const USD = 1_000_000;

test("concurrent PATCHes adding their own keys all land", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("a", { enabled: true, allowances: { builder: 50 * USD } });
  await Promise.all(Array.from({ length: 20 }, (_, i) => credits.setSettings("a", { allowances: { [`bot:${i}`]: USD + i }, bucketLimits: { [`bot:${i}`]: i } }, { merge: true })));
  const settings = await credits.settings("a");
  assert.equal(Object.keys(settings.allowances).length, 21, JSON.stringify(settings.allowances));
  assert.equal(Object.keys(settings.bucketLimits).length, 20, JSON.stringify(settings.bucketLimits));
  for (let i = 0; i < 20; i++) assert.deepEqual([settings.allowances[`bot:${i}`], settings.bucketLimits[`bot:${i}`]], [USD + i, i]);
});

test("a node's PUT at start never resets the markup and daily limit an operator PATCHes at the same time", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  for (let round = 0; round < 20; round++) {
    const tenant = `t${round}`;
    await credits.setSettings(tenant, { enabled: false, markupBps: 0, dailyLimit: null });
    await Promise.all([
      ...Array.from({ length: 5 }, () => credits.setSettings(tenant, { enabled: true, allowances: { builder: 50 * USD, "bot:*": USD } })),
      credits.setSettings(tenant, { markupBps: 2_500, dailyLimit: 5 * USD }, { merge: true }),
    ]);
    const settings = await credits.settings(tenant);
    assert.deepEqual([settings.enabled, settings.allowances, settings.markupBps, settings.dailyLimit], [true, { builder: 50 * USD, "bot:*": USD }, 2_500, 5 * USD], `round ${round}`);
  }
});

test("writers queued on the settings row each keep their own change (deterministic)", async () => {
  const { db, schema } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("a", { enabled: true, allowances: { builder: 50 * USD }, markupBps: 0 });
  // Another connection holds the row; a PUT of the allowances and a PATCH of the markup both start, and wait on it.
  const holder = await db.connect();
  try {
    await holder.query("begin");
    await holder.query("select * from end_user_settings where tenant = 'a' for update");
    const put = credits.setSettings("a", { enabled: true, allowances: { builder: 75 * USD, "bot:*": USD } });
    const patch = credits.setSettings("a", { markupBps: 2_500 }, { merge: true });
    for (let waited = 0; ; waited += 20) {
      // Asked on another connection: in the holder's transaction, pg_stat_activity would stay as it first read it.
      const waiting = Number((await db.query("select count(*)::int as n from pg_stat_activity where application_name = $1 and wait_event_type = 'Lock'", [schema])).rows[0].n);
      if (waiting >= 2) break;
      assert.ok(waited < 10_000, "both writers wait on the row");
      await sleep(20);
    }
    await holder.query("commit");
    await Promise.all([put, patch]);
  } finally { holder.release(); }
  const settings = await credits.settings("a");
  assert.deepEqual([settings.allowances, settings.markupBps], [{ builder: 75 * USD, "bot:*": USD }, 2_500]);
});

test("two first writes for a tenant with no settings yet both land", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  for (let round = 0; round < 10; round++) {
    const tenant = `new${round}`;
    await Promise.all([
      credits.setSettings(tenant, { enabled: true, allowances: { builder: USD } }),
      credits.setSettings(tenant, { markupBps: 1_000, lowBalance: 2 * USD, allowances: { "bot:*": 3 } }, { merge: true }),
    ]);
    const settings = await credits.settings(tenant);
    assert.deepEqual([settings.enabled, settings.markupBps, settings.lowBalance], [true, 1_000, 2 * USD], `round ${round}`);
    // The PUT replaces the map and the PATCH merges into it: whichever came second, the PUT's key is there.
    assert.equal(settings.allowances.builder, USD, `round ${round}`);
  }
});

test("a PATCH past 100 keys is refused and changes nothing", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("a", { enabled: true, allowances: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`bot:${i}`, i])) });
  await assert.rejects(credits.setSettings("a", { allowances: { "bot:new": 1 }, markupBps: 2_500 }, { merge: true }), (error: any) => error.status === 400 && /100/.test(error.message));
  const settings = await credits.settings("a");
  assert.deepEqual([Object.keys(settings.allowances).length, settings.markupBps], [100, 0]);
  // Replacing one key and removing another stays within it.
  const swapped = await credits.setSettings("a", { allowances: { "bot:0": null, "bot:new": 1 } }, { merge: true });
  assert.deepEqual([Object.keys(swapped.allowances).length, swapped.allowances["bot:new"], swapped.allowances["bot:0"]], [100, 1, undefined]);
});

test("holds and charges go through while a writer holds the settings row", async () => {
  const { db } = await testDatabase();
  const credits = new EndUserCredits(db);
  await credits.setSettings("a", { enabled: true, allowances: { builder: USD } });
  await credits.post("a", "u", { kind: "grant", amount: 10 * USD, key: "g1" });
  const holder = await db.connect();
  try {
    await holder.query("begin");
    await holder.query("select * from end_user_settings where tenant = 'a' for update");
    const within = <T>(work: Promise<T>) => Promise.race([work, sleep(5_000).then(() => { throw new Error("blocked on the settings row"); })]);
    const reserved = await within(credits.reserve("a", "u", "builder", { id: crypto.randomUUID(), want: 1_000, min: 1 }));
    assert.equal(reserved?.hold?.raw, 1_000);
    await within(credits.charge("a", "u", "builder", 2 * USD, "charge:1"));
    assert.ok((await within(credits.get("a", "u"))).balance < 10 * USD);
    await holder.query("rollback");
  } finally { holder.release(); }
});
