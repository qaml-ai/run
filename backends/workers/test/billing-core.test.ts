// Ported from the first 12 service tests and standalone Stripe signature test in tests/billing.test.ts; assertions and bodies unchanged.
import { test } from "node:test";

import assert from "node:assert/strict";

import { createHash } from "node:crypto";

import { Accounts } from "../src/accounts.ts";

import { accrueUsage, postLedger } from "../src/billing.ts";

import { type Db } from "../src/postgres.ts";

import { DEFAULT_PRICING, micros, pricingFromEnvironment, purchaseFee, usageTier } from "../../../src/pricing.ts";

import { Tenants } from "../src/tenants.ts";

import type { Storage } from "../src/billing-host.ts";

import { StorageUsage } from "../src/storage-usage.ts";

import { testDatabase } from "./billing-database.ts";

import { until } from "./billing-listen.ts";

import { formEncode, signWebhook, Stripe } from "../src/stripe.ts";

import { usageCost } from "../src/webhook-policy.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const PAYG = "payg-operator-token-at-least-24-chars";

const OPS = "ops-operator-token-at-least-24-chars";

const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    ops: { tokenSha256: sha(OPS), apiKeys: { anthropic: "ops-admin-key", openrouter: "ops-admin-key" } },
  },
  platformKeys: { anthropic: "fixture-platform-key", openrouter: "fixture-platform-key" },
};

const fileTenants = () => new Tenants({ read: async () => JSON.stringify(tenantsFile) });

async function accountsOn(db: Db, pricing = DEFAULT_PRICING) {
  const tenants = fileTenants();
  await tenants.reload();
  return new Accounts({ tenants, db, pricing, publicUrl: "https://agents.example.test" });
}

const balance = async (db: Db, tenant: string) => Number((await db.query("select balance from credit_accounts where tenant = $1", [tenant])).rows[0]?.balance ?? 0);

const ledgerSum = async (db: Db, tenant: string) => Number((await db.query("select coalesce(sum(amount), 0) as sum from credit_ledger where tenant = $1", [tenant])).rows[0].sum);

async function assertLedgerMatchesBalances(db: Db) {
  const { rows } = await db.query(`
    select tenant, coalesce(a.balance, 0) as balance, coalesce(l.sum, 0) as sum
    from credit_accounts a full join (select tenant, sum(amount) as sum from credit_ledger group by tenant) l using (tenant)
    where coalesce(a.balance, 0) <> coalesce(l.sum, 0)`);
  assert.deepEqual(rows, [], "balances equal to their ledger entries");
}

const HOUR = 3_600_000;

const DAY = 86_400_000;

const response = (cost: number, platform = true) => ({ provider: "anthropic", model: "m", usage: { input: 10, output: 1, cost: { total: cost } }, platform });

test("pricing: defaults, environment overrides in USD, and the purchase fee in whole cents", () => {
  assert.equal(DEFAULT_PRICING.agentHour, 10_000);
  assert.equal(DEFAULT_PRICING.storageGbMonth, 100_000);
  assert.equal(DEFAULT_PRICING.openrouterCreditMultiplier, 1.055);
  assert.equal(pricingFromEnvironment({ AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1" }).openrouterCreditMultiplier, 1);
  assert.equal(pricingFromEnvironment({ AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1.1246" }).openrouterCreditMultiplier, 1.1246);
  for (const value of ["-1", "NaN", "Infinity", "no"]) assert.throws(() => pricingFromEnvironment({ AGENT_OPENROUTER_CREDIT_MULTIPLIER: value }), /non-negative/);
  assert.equal(purchaseFee(DEFAULT_PRICING, micros(10)), micros(0.55));
  assert.equal(purchaseFee(DEFAULT_PRICING, micros(5)), micros(0.28), "27.5 cents rounds to 28");
  const custom = pricingFromEnvironment({ AGENT_PRICE_AGENT_HOUR_USD: "0.02", AGENT_CREDIT_FEE_PERCENT: "3" });
  assert.deepEqual([custom.agentHour, custom.purchaseFeeBps, custom.storageGbMonth], [20_000, 300, 100_000]);
  assert.throws(() => pricingFromEnvironment({ AGENT_PRICE_AGENT_HOUR_USD: "-1" }), /non-negative/);
  assert.throws(() => pricingFromEnvironment({ AGENT_CREDIT_MIN_PURCHASE_USD: "0.1" }), /at least 0.50/);
});

test("card-credit pricing follows the starting grant unless explicitly configured", () => {
  assert.equal(pricingFromEnvironment({}).cardCreditGrant, micros(5));
  assert.equal(pricingFromEnvironment({ AGENT_CREDIT_GRANT_USD: "7" }).cardCreditGrant, micros(7));
  const disabled = pricingFromEnvironment({ AGENT_CARD_CREDIT_USD: "0" });
  assert.equal(disabled.cardCreditGrant, 0);
  assert.equal(disabled.startingGrant, micros(5));
  assert.equal(pricingFromEnvironment({ AGENT_CARD_CREDIT_USD: "1.25" }).cardCreditGrant, micros(1.25));
  for (const value of ["-1", "NaN", "Infinity", "no", "1e20"]) {
    assert.throws(() => pricingFromEnvironment({ AGENT_CARD_CREDIT_USD: value }), /AGENT_CARD_CREDIT_USD must be a non-negative/);
  }
});

test("usage tiers: the defaults, AGENT_USAGE_TIERS, its validation, and which tier an amount paid is in", () => {
  assert.deepEqual(DEFAULT_PRICING.tiers.map(tier => [tier.name, tier.paid, tier.busyAgents, tier.runsPerMinute, tier.agentCreatesPerMinute, tier.codeConcurrency, tier.decisionConcurrency]), [
    ["Free", 0, 50, 300, 600, 4, 16], ["Tier 1", micros(5), 250, 1_500, 1_200, 8, 32], ["Tier 2", micros(50), 1_000, 6_000, 3_000, 16, 48],
    ["Tier 3", micros(250), 4_000, 20_000, 6_000, 16, 64], ["Tier 4", micros(1000), 10_000, 60_000, 12_000, 16, 64],
  ]);
  const at = (paid: number) => { const { tier, next } = usageTier(DEFAULT_PRICING.tiers, paid); return [tier.name, next?.name]; };
  assert.deepEqual(at(0), ["Free", "Tier 1"]);
  assert.deepEqual(at(-micros(5)), ["Free", "Tier 1"], "refunds beyond purchases stay free");
  assert.deepEqual(at(micros(4.99)), ["Free", "Tier 1"]);
  assert.deepEqual(at(micros(5)), ["Tier 1", "Tier 2"]);
  assert.deepEqual(at(micros(249.99)), ["Tier 2", "Tier 3"]);
  assert.deepEqual(at(micros(1000)), ["Tier 4", undefined]);
  assert.deepEqual(at(micros(50_000)), ["Tier 4", undefined]);

  const custom = pricingFromEnvironment({ AGENT_USAGE_TIERS: JSON.stringify([{ name: "Trial", paidUsd: 0, busyAgents: 1 }, { name: "Paid", paidUsd: 10, busyAgents: 3 }]) });
  assert.deepEqual(custom.tiers, [{ name: "Trial", paid: 0, busyAgents: 1 }, { name: "Paid", paid: micros(10), busyAgents: 3 }]);
  // The other limits are optional; one left out is the deployment's default.
  const fuller = pricingFromEnvironment({ AGENT_USAGE_TIERS: JSON.stringify([{ name: "Trial", paidUsd: 0, busyAgents: 1, runsPerMinute: 10, decisionConcurrency: 4 }]) });
  assert.deepEqual(fuller.tiers, [{ name: "Trial", paid: 0, busyAgents: 1, runsPerMinute: 10, decisionConcurrency: 4 }]);
  assert.throws(() => pricingFromEnvironment({ AGENT_USAGE_TIERS: JSON.stringify([{ name: "A", paidUsd: 0, busyAgents: 1, codeConcurrency: 0 }]) }), /codeConcurrency must be a positive integer/);
  for (const [tiers, error] of [
    ["nope", /must be JSON/], ["[]", /non-empty array/], [[{ name: "A", paidUsd: 1, busyAgents: 1 }], /start with a tier at paidUsd 0/],
    [[{ name: "A", paidUsd: 0, busyAgents: 1 }, { name: "B", paidUsd: 0, busyAgents: 2 }], /ascending/],
    [[{ name: "A", paidUsd: 0, busyAgents: 0 }], /busyAgents must be a positive integer/], [[{ name: "", paidUsd: 0, busyAgents: 1 }], /needs a name/],
    [[{ name: "A", paidUsd: -1, busyAgents: 1 }], /non-negative/],
  ] as const) assert.throws(() => pricingFromEnvironment({ AGENT_USAGE_TIERS: typeof tiers === "string" ? tiers : JSON.stringify(tiers) }), error);
  assert.throws(() => pricingFromEnvironment({ AGENT_FREE_MAX_AGENTS: "2" }), /replaced by AGENT_USAGE_TIERS/);
});

test("provider-reported cost wins over the catalog, including zero; invalid amounts cannot poison billing", () => {
  assert.deepEqual(usageCost({ providerCost: 0.02, cost: { total: 0.15 } }), { usd: 0.02, source: "provider" });
  assert.deepEqual(usageCost({ providerCost: 0, cost: { total: 0.15 } }), { usd: 0, source: "provider" });
  for (const providerCost of [-1, NaN, Infinity, "0.01", undefined]) {
    assert.deepEqual(usageCost({ providerCost, cost: { total: 0.15 } }), { usd: 0.15, source: "catalog" });
  }
  assert.deepEqual(usageCost({ cost: { total: -1 } }), { usd: 0, source: "catalog" });
});

test("platform model usage passes through actual cost and funding, including compaction, without charging customer-owned keys", async () => {
  const { db } = await testDatabase();
  const accounts = await accountsOn(db);
  await accounts.billing.post([{ tenant: "payg", kind: "grant", amount: micros(1), key: "actual-cost-grant" }]);
  const actual = (providerCost: number, platform = true) => ({ ...response(0.15, platform), provider: "openrouter", usage: { cost: { total: 0.15 }, providerCost } });
  accounts.recordUsage("payg", "a", actual(0.004));
  accounts.recordUsage("payg", "a", { ...actual(0.01), kind: "compaction" });
  accounts.recordUsage("payg", "a", actual(0));
  accounts.recordUsage("payg", "a", actual(0.3, false));
  accounts.recordUsage("payg", "a", { ...actual(0.02), provider: "anthropic" });
  // BYOK through our OpenRouter account: $0.10 is paid directly upstream, only $0.005 uses OpenRouter credits.
  accounts.recordUsage("payg", "a", { ...actual(0.105), usage: { cost: { total: 1 }, providerCost: 0.105, providerCreditCost: 0.005 } });
  const charged = micros(0.004 * 1.055 + 0.01 * 1.055 + 0.02 + 0.1 + 0.005 * 1.055);
  assert.equal(accounts.pendingCharges("payg"), charged);
  await accounts.flushUsage();
  assert.equal(await balance(db, "payg"), micros(1) - charged);
  const entries = (await accounts.billing.ledger("payg")).entries.filter(row => row.kind === "usage");
  assert.equal(entries.reduce((sum, row) => sum + Number(row.metadata.tokens), 0), micros(0.139));
  assert.equal(entries.reduce((sum, row) => sum + Number(row.metadata.funding ?? 0), 0), micros(0.019 * 0.055));
  const usage = await accounts.usage("payg", Date.now() - DAY);
  assert.ok(Math.abs(usage.totals.cost - 0.439) < 1e-12);
  assert.ok(Math.abs(usage.totals.platformCost - charged / 1e6) < 1e-12);
  assert.ok(Math.abs(usage.days.filter(row => row.kind === "compaction")[0].platformCost - 0.01 * 1.055) < 1e-12);
  await assertLedgerMatchesBalances(db);
});

test("a waived funding fee charges exactly the reported usage amount", async () => {
  const { db } = await testDatabase();
  const accounts = await accountsOn(db, { ...DEFAULT_PRICING, openrouterCreditMultiplier: 1 });
  accounts.recordUsage("payg", "a", { ...response(0.15), provider: "openrouter", usage: { providerCost: 0.0123 } });
  await accounts.flushUsage();
  assert.equal(await balance(db, "payg"), -micros(0.0123));
  assert.equal((await accounts.billing.ledger("payg")).entries[0].metadata.funding, undefined);
});

test("the ledger posts each idempotency key once and keeps the balance equal to its entries", async () => {
  const { db } = await testDatabase();
  const entry = { tenant: "acme", kind: "grant" as const, amount: 5_000_000, key: "grant:acme" };
  assert.equal((await postLedger(db, [entry])).length, 1);
  assert.equal((await postLedger(db, [entry])).length, 0, "the same key again is skipped");
  await postLedger(db, [{ tenant: "acme", kind: "usage", amount: -1_234, key: "usage:1" }, { tenant: "other", kind: "purchase", amount: 10_000_000, key: "purchase:1" }, entry]);
  assert.equal(await balance(db, "acme"), 5_000_000 - 1_234);
  assert.equal(await ledgerSum(db, "acme"), await balance(db, "acme"));
  assert.equal(Number((await db.query("select purchased from credit_accounts where tenant = 'other'")).rows[0].purchased), 10_000_000);
  await assert.rejects(postLedger(db, [{ tenant: "acme", kind: "usage", amount: 0.5, key: "fraction" }]), /integer micro-USD/);
});

test("two nodes debiting one tenant at once lose no debit, and each flush posts once", async () => {
  const { db } = await testDatabase();
  const pricing = { ...DEFAULT_PRICING, agentHour: micros(3600) }; // 1000 micro-USD per ms of agent time
  const [first, second] = [await accountsOn(db, pricing), await accountsOn(db, pricing)];
  await first.billing.post([{ tenant: "payg", kind: "grant", amount: micros(5), key: "grant:payg" }]);
  let expected = micros(5);
  for (let round = 0; round < 20; round++) {
    for (const [index, node] of [first, second].entries()) {
      node.recordUsage("payg", "a", response(0.001 * (index + 1)));
      node.recordUsage("payg", "a", response(0.5, false)); // the tenant's own key: not charged
      node.recordActive("payg", "a", 3);
      expected -= micros(0.001 * (index + 1)) + 3_000;
    }
    await Promise.all([first.flushUsage(), second.flushUsage(), first.flushUsage()]);
  }
  assert.equal(await balance(db, "payg"), expected);
  assert.equal(await ledgerSum(db, "payg"), expected);
  await assertLedgerMatchesBalances(db);
  // One entry per UTC hour, however many flushes and nodes: one, or two if the test crossed an hour.
  const hours = (await db.query("select amount, metadata, created_at from credit_ledger where kind = 'usage' order by id")).rows;
  assert.ok(hours.length === 1 || hours.length === 2, `${hours.length} usage entries`);
  assert.equal(new Set(hours.map(row => Number(row.created_at))).size, hours.length);
  for (const row of hours) assert.equal(row.metadata.hour, new Date(Number(row.created_at)).toISOString());
  assert.equal(hours.reduce((sum, row) => sum + row.metadata.tokens, 0), micros(0.06), "the hour's breakdown: tokens");
  assert.equal(hours.reduce((sum, row) => sum + row.metadata.activeMs, 0), 120, "and active time");
  const usage = await first.usage("payg", Date.now() - 86_400_000);
  assert.equal(usage.totals.responses, 80);
  assert.equal(usage.totals.platformResponses, 40);
  assert.ok(Math.abs(usage.totals.platformCost - 20 * 0.003) < 1e-9);
  // An unbilled admin tenant on admin keys has usage but no ledger entries.
  first.recordUsage("ops", "a", response(1));
  first.recordActive("ops", "a", 1000);
  await first.flushUsage();
  assert.equal(Number((await db.query("select count(*) from credit_ledger where tenant = 'ops'")).rows[0].count), 0);
});

test("usage accrues into one entry per tenant per UTC hour, updated in place until the hour ends, and the ledger still sums to the balance", async () => {
  const { db } = await testDatabase();
  const ten = Date.parse("2026-09-25T10:00:00Z");
  await postLedger(db, [{ tenant: "acme", kind: "grant", amount: micros(5), key: "grant:acme" }], ten - 5 * HOUR);
  // A per-flush entry from before hourly accrual is history like any other.
  await postLedger(db, [{ tenant: "acme", kind: "usage", amount: -7, key: "usage:0b1c:acme", metadata: { tokens: 7, activeMs: 0 } }], ten - HOUR);
  await accrueUsage(db, [{ tenant: "acme", amount: 100, metadata: { tokens: 60, activeMs: 4 } }, { tenant: "beta", amount: 5, metadata: { tokens: 5, activeMs: 0 } }], ten + 1_000);
  await postLedger(db, [{ tenant: "acme", kind: "purchase", amount: micros(10), key: "purchase:1" }], ten + 2_000);
  await accrueUsage(db, [{ tenant: "acme", amount: 30, metadata: { tokens: 0, activeMs: 3, searches: 2 } }], ten + HOUR - 1);
  await accrueUsage(db, [{ tenant: "acme", amount: 1, metadata: { tokens: 1, activeMs: 0 } }], ten + HOUR);
  const usage = (await db.query("select tenant, amount, metadata, created_at, idempotency_key from credit_ledger where kind = 'usage' order by id")).rows
    .map(row => [row.tenant, Number(row.amount), row.metadata, Number(row.created_at), row.idempotency_key]);
  assert.deepEqual(usage, [
    ["acme", -7, { tokens: 7, activeMs: 0 }, ten - HOUR, "usage:0b1c:acme"],
    ["acme", -130, { tokens: 60, activeMs: 7, searches: 2, hour: "2026-09-25T10:00:00.000Z" }, ten, "usage:acme:2026-09-25T10:00:00.000Z"],
    ["beta", -5, { tokens: 5, activeMs: 0, hour: "2026-09-25T10:00:00.000Z" }, ten, "usage:beta:2026-09-25T10:00:00.000Z"],
    ["acme", -1, { tokens: 1, activeMs: 0, hour: "2026-09-25T11:00:00.000Z" }, ten + HOUR, "usage:acme:2026-09-25T11:00:00.000Z"],
  ]);
  assert.equal(await balance(db, "acme"), micros(15) - 138);
  assert.equal(await balance(db, "beta"), -5);
  await assertLedgerMatchesBalances(db);
  await assert.rejects(accrueUsage(db, [{ tenant: "acme", amount: -1, metadata: {} }]), /positive integer/);
  // The free hourly limit reads spend by minute; the billing timer drops minutes older than it needs.
  const minutes = async () => (await db.query("select minute, amount from credit_spend_minutes where tenant = 'acme' order by minute")).rows.map(row => [Number(row.minute) * 60_000 - ten, Number(row.amount)]);
  assert.deepEqual(await minutes(), [[0, 100], [HOUR - 60_000, 30], [HOUR, 1]]);
  await (await accountsOn(db)).billing.chargeStorage({} as Storage, new StorageUsage(db), "node-a", { now: ten + 2 * HOUR + 60_000 });
  assert.deepEqual(await minutes(), [[HOUR - 60_000, 30], [HOUR, 1]]);
});

test("the ledger sums to every balance under concurrent flushes, grants, purchases and refunds on several nodes", async () => {
  const { db } = await testDatabase();
  const pricing = { ...DEFAULT_PRICING, agentHour: micros(3600) };
  const nodes = [await accountsOn(db, pricing), await accountsOn(db, pricing), await accountsOn(db, pricing)];
  const work: Promise<unknown>[] = [];
  for (let round = 0; round < 15; round++) {
    for (const [index, node] of nodes.entries()) {
      node.recordUsage("payg", "a", response(0.0001 * (round + 1)));
      node.recordActive("payg", "a", index + 1);
      node.recordUsage(`t${round % 4}`, "a", response(0.001));
      work.push(node.flushUsage());
    }
    work.push(nodes[round % 3].billing.post([{ tenant: "payg", kind: round % 2 ? "purchase" : "grant", amount: 1_000 + round, key: `credit:${round}` }]));
    work.push(accrueUsage(db, [{ tenant: "payg", amount: 3, metadata: { searches: 1 } }, { tenant: "t1", amount: 2, metadata: {} }]));
  }
  await Promise.all(work);
  await Promise.all(nodes.map(node => node.flushUsage()));
  await assertLedgerMatchesBalances(db);
  assert.ok(Number((await db.query("select count(*) from credit_ledger where kind = 'usage' and tenant = 'payg'")).rows[0].count) <= 2);
});

test("a flush whose commit acknowledgement is lost is retried without counting twice", async () => {
  const { db } = await testDatabase();
  let loseCommit = true;
  // The commit lands, but the node sees the connection fail.
  const flaky = {
    query: (...args: any[]) => (db.query as any)(...args),
    connect: async () => {
      const client = await db.connect();
      const query = client.query.bind(client);
      return Object.assign(client, { query: async (...args: any[]) => {
        const result = await (query as any)(...args);
        if (args[0] === "commit" && loseCommit) { loseCommit = false; throw new Error("Connection terminated unexpectedly"); }
        return result;
      } });
    },
  } as unknown as Db;
  const accounts = await accountsOn(flaky);
  accounts.recordUsage("payg", "a", response(0.25));
  await assert.rejects(accounts.flushUsage(), /Connection terminated/);
  assert.equal(await balance(db, "payg"), -250_000, "it did commit");
  assert.equal(accounts.pendingCharges("payg"), 250_000, "the node still counts it until a flush succeeds");
  accounts.recordUsage("payg", "a", response(0.5));
  await accounts.flushUsage();
  assert.equal(await balance(db, "payg"), -750_000);
  assert.equal(accounts.pendingCharges("payg"), 0);
  assert.equal((await accounts.usage("payg", Date.now() - 86_400_000)).totals.responses, 2);
});

test("credit: prepaid tenants are refused at zero, others never; the balance counts this node's unwritten debits", async () => {
  const { db } = await testDatabase();
  const accounts = await accountsOn(db);
  assert.match((await accounts.billing.creditLimit("payg"))!.message, /^This account is out of credit \(balance \$0\.00\), so runs cannot start$/);
  assert.equal(await accounts.billing.creditLimit("ops"), undefined, "admin tenants are unbilled by default");
  await accounts.billing.post([{ tenant: "payg", kind: "adjustment", amount: 100_000, key: "a1" }]);
  assert.equal(await accounts.billing.creditLimit("payg"), undefined);
  accounts.recordUsage("payg", "a", response(0.1));
  const limited = await accounts.runLimit("payg");
  assert.equal(typeof limited === "object" && limited.status, 402);
  assert.match(String(typeof limited === "object" && limited.message), /out of credit/, "an unwritten debit counts at once");
  // Another node's debits count once its cached balance expires.
  const other = await accountsOn(db);
  assert.equal(await other.billing.creditLimit("payg"), undefined);
  await accounts.flushUsage();
  assert.equal(await other.billing.creditLimit("payg"), undefined, "cached for a few seconds");
  await until(async () => await other.billing.creditLimit("payg"), "the other node to see the debit", 10_000);
});

const WEBHOOK_SECRET = "whsec_fixture_signing_secret";

test("Stripe webhooks are verified by signature: a bad or stale signature is refused, and a well-signed replay is harmless", () => {
  const stripe = new Stripe({ secretKey: "sk_test_x", webhookSecret: WEBHOOK_SECRET });
  const payload = JSON.stringify({ id: "evt_1", type: "ping", data: { object: {} } });
  assert.equal(stripe.verify(payload, signWebhook(WEBHOOK_SECRET, payload))?.id, "evt_1");
  // Several v1 signatures during a secret rotation: any one may match.
  const now = Math.floor(Date.now() / 1000);
  assert.ok(stripe.verify(payload, `t=${now},v1=${"0".repeat(64)},${signWebhook(WEBHOOK_SECRET, payload, now).split(",")[1]}`));
  assert.equal(stripe.verify(payload, signWebhook("whsec_other", payload)), undefined);
  assert.equal(stripe.verify(payload.replace("ping", "pong"), signWebhook(WEBHOOK_SECRET, payload)), undefined, "the payload is signed");
  assert.equal(stripe.verify(payload, signWebhook(WEBHOOK_SECRET, payload, now - 600)), undefined, "older than five minutes");
  assert.equal(stripe.verify(payload, undefined), undefined);
  assert.equal(stripe.verify(payload, "t=abc,v1=zz"), undefined);
  assert.equal(formEncode({ a: { b: [{ c: 1 }, { c: "x" }] }, d: undefined }).toString(), "a%5Bb%5D%5B0%5D%5Bc%5D=1&a%5Bb%5D%5B1%5D%5Bc%5D=x");
  assert.throws(() => new Stripe({ secretKey: "pk_test_x", webhookSecret: WEBHOOK_SECRET }), /secret \(sk_\)/);
});
