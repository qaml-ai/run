import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { Accounts } from "../src/accounts.ts";
import { BusyAgents, busyCount, busyLimitError, type BusyLimit } from "../src/busy-agents.ts";
import type { Db } from "../src/db.ts";
import { errorFields } from "../src/http.ts";
import { Ownership } from "../src/ownership.ts";
import { micros } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/** A node: its own pool and heartbeat, counting busy agents against `limit`. */
async function node(url: string, name: string, limit: (tenant: string) => BusyLimit) {
  const db = new pg.Pool({ connectionString: url, max: 4 }) as Db;
  const ownership = new Ownership(db, { node: name, ttlMs: 30_000 });
  await ownership.start();
  const busy = new BusyAgents({ db, ownership, limitFor: async tenant => limit(tenant) });
  return { ownership, busy, stop: async () => { await ownership.close().catch(() => {}); await db.end(); } };
}

test("two nodes taking busy slots for one tenant at once never pass its limit; forced work does, and dead nodes stop counting", async t => {
  const { db, url } = await testDatabase();
  const limit = (): BusyLimit => ({ limit: 5, source: "default" });
  const a = await node(url, "http://a", limit), b = await node(url, "http://b", limit);
  t.after(async () => { await a.stop(); await b.stop(); });

  // Forty agents, half asking on each node, all at once.
  const results = await Promise.all(Array.from({ length: 40 }, (_, index) => (index % 2 ? a : b).busy.hold("acme", `agent_${index}`)));
  const refused = results.filter(Boolean);
  assert.equal(results.length - refused.length, 5, "exactly the limit is taken");
  assert.equal(await busyCount(db, "acme"), 5);
  assert.ok(refused.every(error => error!.status === 429 && error!.code === "BUSY_AGENT_LIMIT"));
  assert.deepEqual(errorFields(refused[0]), { busyAgents: { busy: 5, limit: 5, source: "default" } });
  // Another tenant has its own count; an agent already holding a slot holds it again without counting twice.
  assert.equal(await a.busy.hold("other", "agent_x"), undefined);
  const holder = results.findIndex(result => !result);
  assert.equal(await (holder % 2 ? a : b).busy.hold("acme", `agent_${holder}`), undefined);
  assert.equal(await busyCount(db, "acme"), 5);

  // Work accepted before (taken over from a lost node) holds a slot past the limit.
  assert.equal(await a.busy.hold("acme", "agent_taken_over", true), undefined);
  assert.equal(await busyCount(db, "acme"), 6);
  // Released slots are free for others.
  await a.busy.release("agent_taken_over");
  await (holder % 2 ? a : b).busy.release(`agent_${holder}`);
  assert.equal(await b.busy.hold("acme", "agent_new"), undefined);
  assert.equal(await busyCount(db, "acme"), 5);

  // A node that leaves (or whose heartbeat lapses) stops counting at once: its agents are free for others to take.
  const onA = Number((await db.query("select count(*) as n from busy_agents where tenant = 'acme' and node = 'http://a'")).rows[0].n);
  assert.ok(onA > 0);
  await a.ownership.close();
  assert.equal(await busyCount(db, "acme"), 5 - onA);
  assert.equal(await b.busy.hold("acme", "agent_after"), undefined);
  // The next hold for the tenant drops the dead node's rows.
  assert.equal(Number((await db.query("select count(*) as n from busy_agents where node = 'http://a' and tenant = 'acme'")).rows[0].n), 0);
});

test("the 429 names the tier, the limit and what unlocks the next tier", () => {
  const error = busyLimitError({ limit: 8, source: "tier", tier: "Free", paid: 0, next: { tier: "Tier 1", paid: micros(5), limit: 25 } }, 8);
  assert.equal(error.status, 429);
  assert.equal(error.code, "BUSY_AGENT_LIMIT");
  assert.equal(error.message, "This account has 8 agents busy, the most its usage tier (Free) allows; retry when one finishes. Tier 1 (25 busy agents) applies once the account has paid $5 in total for credit.");
  assert.deepEqual(errorFields(error), { busyAgents: { busy: 8, limit: 8, source: "tier", tier: "Free", paid: 0, next: { tier: "Tier 1", paid: micros(5), limit: 25 } } });
  const top = busyLimitError({ limit: 1000, source: "tier", tier: "Tier 4", paid: micros(1200) }, 1000);
  assert.equal(top.message, "This account has 1000 agents busy, the most its usage tier (Tier 4) allows; retry when one finishes.");
  assert.equal(busyLimitError({ limit: 200, source: "tenant" }, 200).message, "This account has 200 agents busy, the most this account allows; retry when one finishes.");
});

test("busy limits: a tenant's own maxAgents wins, prepaid tenants get their tier from what they paid (at once, net of refunds, grants not counted), others the default", async () => {
  const { db } = await testDatabase();
  const file = {
    tenants: {
      payg: { tokenSha256: sha("payg-token-at-least-24-chars!!"), apiKeys: {}, billing: "prepaid" },
      vip: { tokenSha256: sha("vip-token-at-least-24-chars!!!"), apiKeys: {}, billing: "prepaid", maxAgents: 3 },
      ops: { tokenSha256: sha("ops-token-at-least-24-chars!!!"), apiKeys: {} },
    },
  };
  const accountsOn = async () => {
    const tenants = new Tenants({ read: async () => JSON.stringify(file) });
    await tenants.reload();
    return new Accounts({ tenants, db, maxAgentsPerTenant: 40 });
  };
  const here = await accountsOn(), there = await accountsOn();
  const tier = async (accounts: Accounts, tenant: string) => {
    const limit = await accounts.billing.busyLimit(tenant);
    return limit.source === "tier" ? [limit.tier, limit.limit, limit.next?.tier, limit.next?.paid] : [limit.source, limit.limit];
  };
  assert.deepEqual(await tier(here, "payg"), ["Free", 8, "Tier 1", micros(5)]);
  assert.deepEqual(await tier(here, "ops"), ["default", 40], "not prepaid: the deployment's default");
  assert.deepEqual(await tier(here, "vip"), ["tenant", 3], "the tenant's own limit");

  // Starting credit and adjustments are not payments.
  await here.billing.post([{ tenant: "payg", kind: "grant", amount: micros(5), key: "g1" }, { tenant: "payg", kind: "adjustment", amount: micros(100), key: "adj1" }]);
  assert.deepEqual(await tier(here, "payg"), ["Free", 8, "Tier 1", micros(5)]);
  // The other node has the tenant's balance cached; the tier is read afresh, so a payment counts there at once.
  await there.billing.account("payg");
  await here.billing.post([{ tenant: "payg", kind: "purchase", amount: micros(5), key: "p1" }]);
  assert.deepEqual(await tier(there, "payg"), ["Tier 1", 25, "Tier 2", micros(50)]);
  await here.billing.post([{ tenant: "payg", kind: "purchase", amount: micros(60), key: "p2" }]);
  assert.deepEqual(await tier(there, "payg"), ["Tier 2", 100, "Tier 3", micros(250)]);
  // A refund takes its amount back out.
  await here.billing.post([{ tenant: "payg", kind: "refund", amount: -micros(20), key: "r1" }]);
  assert.deepEqual(await tier(there, "payg"), ["Tier 1", 25, "Tier 2", micros(50)]);
  // A tenant's own limit wins over any tier.
  await here.billing.post([{ tenant: "vip", kind: "purchase", amount: micros(2000), key: "p3" }]);
  assert.deepEqual(await tier(there, "vip"), ["tenant", 3]);

  // GET /v1/billing shows it, with how many are busy now.
  const summary = await there.billing.summary("payg");
  assert.deepEqual(summary.busyAgents, { busy: 0, limit: 25, source: "tier", tier: "Tier 1", paid: micros(45), next: { tier: "Tier 2", paid: micros(50), limit: 100 } });
});
