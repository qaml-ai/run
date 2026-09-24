import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Accounts } from "../src/accounts.ts";
import { postLedger } from "../src/billing.ts";
import { migrate, type Db } from "../src/db.ts";
import { DEFAULT_PRICING, micros, pricingFromEnvironment, purchaseFee } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { testDatabase } from "./database.ts";
import { runtime, toolCall, until } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAYG = "payg-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    ops: { tokenSha256: sha(OPS), apiKeys: { "*": "ops-admin-key" } },
  },
  platformKeys: { "*": "fixture-platform-key" },
};
const fileTenants = () => new Tenants({ read: async () => JSON.stringify(tenantsFile) });
async function accountsOn(db: Db, pricing = DEFAULT_PRICING) {
  const tenants = fileTenants();
  await tenants.reload();
  return new Accounts({ tenants, db, pricing, publicUrl: "https://agents.example.test" });
}
const balance = async (db: Db, tenant: string) => Number((await db.query("select balance from credit_accounts where tenant = $1", [tenant])).rows[0]?.balance ?? 0);
const ledgerSum = async (db: Db, tenant: string) => Number((await db.query("select coalesce(sum(amount), 0) as sum from credit_ledger where tenant = $1", [tenant])).rows[0].sum);
/** A response of `cost` USD that ran on the platform's key (or the tenant's own). */
const response = (cost: number, platform = true) => ({ provider: "openrouter", model: "m", usage: { input: 10, output: 1, cost: { total: cost } }, platform });

test("pricing: defaults, environment overrides in USD, and the purchase fee in whole cents", () => {
  assert.equal(DEFAULT_PRICING.agentHour, 10_000);
  assert.equal(DEFAULT_PRICING.storageGbMonth, 100_000);
  assert.equal(purchaseFee(DEFAULT_PRICING, micros(10)), micros(0.55));
  assert.equal(purchaseFee(DEFAULT_PRICING, micros(5)), micros(0.28), "27.5 cents rounds to 28");
  const custom = pricingFromEnvironment({ AGENT_PRICE_AGENT_HOUR_USD: "0.02", AGENT_CREDIT_FEE_PERCENT: "3", AGENT_FREE_MAX_AGENTS: "1" });
  assert.deepEqual([custom.agentHour, custom.purchaseFeeBps, custom.free.maxAgents, custom.storageGbMonth], [20_000, 300, 1, 100_000]);
  assert.throws(() => pricingFromEnvironment({ AGENT_PRICE_AGENT_HOUR_USD: "-1" }), /non-negative/);
  assert.throws(() => pricingFromEnvironment({ AGENT_CREDIT_MIN_PURCHASE_USD: "0.1" }), /at least 0.50/);
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
  assert.equal(Number((await db.query("select count(*) from credit_ledger where kind = 'usage'")).rows[0].count), 40, "one entry per node per flush");
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
  assert.match((await accounts.billing.creditLimit("payg"))!, /prepaid credit is used up \(balance \$0\.00\); add credit at https:\/\/agents\.example\.test\/console\/billing/);
  assert.equal(await accounts.billing.creditLimit("ops"), undefined, "admin tenants are unbilled by default");
  await accounts.billing.post([{ tenant: "payg", kind: "adjustment", amount: 100_000, key: "a1" }]);
  assert.equal(await accounts.billing.creditLimit("payg"), undefined);
  accounts.recordUsage("payg", "a", response(0.1));
  assert.match((await accounts.runLimit("payg"))!, /used up/, "an unwritten debit counts at once");
  // Another node's debits count once its cached balance expires.
  const other = await accountsOn(db);
  assert.equal(await other.billing.creditLimit("payg"), undefined);
  await accounts.flushUsage();
  assert.equal(await other.billing.creditLimit("payg"), undefined, "cached for a few seconds");
  await until(async () => await other.billing.creditLimit("payg"), "the other node to see the debit", 10_000);
});

test("a self-serve tenant gets its starting credit once; tenants from before billing stay unbilled", async () => {
  const { db } = await testDatabase({ migrate: false });
  // Migrate to before billing, sign someone up, then migrate the rest.
  const earlier = mkdtempSync(join(tmpdir(), "migrations-"));
  const all = fileURLToPath(new URL("../migrations", import.meta.url));
  for (const name of readdirSync(all).filter(name => name < "007")) cpSync(join(all, name), join(earlier, name));
  await migrate(db, earlier);
  rmSync(earlier, { recursive: true });
  await db.query("insert into tenants (id, github, created_at) values ('veteran', 'Veteran', 1)");
  await migrate(db);
  const accounts = await accountsOn(db);
  assert.equal(await accounts.tenantForGithub("Carol"), "carol");
  assert.equal(await accounts.tenantForGithub("carol"), "carol");
  assert.equal(await balance(db, "carol"), micros(5));
  const summary = await accounts.billing.summary("carol");
  assert.equal(summary.billing, "prepaid");
  assert.equal(summary.freeCredit, true);
  assert.equal(summary.month.grant, micros(5));
  assert.equal(await accounts.tenantForGithub("Veteran"), "veteran");
  assert.equal((await accounts.billing.summary("veteran")).billing, "none");
  assert.equal(await balance(db, "veteran"), 0);
  // Self-serve prepaid tenants use the platform's keys; unbilled ones need their own.
  assert.equal((await accounts.providerKey("carol", "anthropic"))?.source, "platform");
  assert.equal(await accounts.providerKey("veteran", "anthropic"), undefined);
  assert.deepEqual((await accounts.keyStatus("carol")).map(status => [status.provider, status.source]), [["*", "platform"]]);
});

test("storage is charged once a UTC day, pro rata, to prepaid tenants by what their agents and volumes store", async () => {
  const { db } = await testDatabase();
  // $30 per GB-month: in a 30-day month, a day of 1 MB is 1000 micro-USD.
  const pricing = { ...DEFAULT_PRICING, storageGbMonth: micros(30) };
  const accounts = await accountsOn(db, pricing);
  await db.query("insert into tenants (id, created_at) values ('carol', 1)");
  const agent = `client_${"a".repeat(40)}`, volume = `vol_${"b".repeat(24)}`, opsAgent = `client_${"c".repeat(40)}`;
  for (const [id, tenant] of [[agent, "carol"], [opsAgent, "ops"]]) {
    await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, $2, '{}', 1, 'x', 'general', 'm')", [id, tenant]);
  }
  await db.query("insert into volumes (id, tenant, name, created_at) values ($1, 'carol', 'v', 1)", [volume]);
  const storage = memoryStorage(postgresTail(db));
  const mb = new Uint8Array(1_000_000);
  await storage.writeBlob(`sessions/${agent}/transcript.log/blob-x`, mb);
  await storage.writeBlob(`volumes/${volume}/snapshots/s1`, mb);
  await storage.writeBlob(`chunks/carol/ab/abc`, mb);
  await storage.writeBlob(`chunks/payg/ab/abc`, mb.subarray(0, 500_000));
  await storage.writeBlob(`sessions/${opsAgent}/transcript.log/blob-x`, mb);
  const june = Date.parse("2026-06-15T12:00:00Z");
  const runs = await Promise.all([accounts.billing.chargeStorage(storage, "node-a", june), (await accountsOn(db, pricing)).billing.chargeStorage(storage, "node-b", june)]);
  assert.deepEqual(runs.sort(), [false, true], "one node runs the day's job");
  assert.equal(await accounts.billing.chargeStorage(storage, "node-a", june), false, "the day is done");
  const entries = (await db.query("select tenant, amount, metadata, idempotency_key from credit_ledger where kind = 'storage' order by tenant")).rows;
  assert.deepEqual(entries.map(row => [row.tenant, Number(row.amount), row.metadata.bytes, row.idempotency_key]), [
    ["carol", -3000, 3_000_000, "storage:carol:2026-06-15"],
    ["payg", -500, 500_000, "storage:payg:2026-06-15"],
  ]);
  assert.equal(await accounts.billing.chargeStorage(storage, "node-a", june + 86_400_000), true, "the next day runs");
  assert.equal(Number((await db.query("select count(*) from credit_ledger where kind = 'storage'")).rows[0].count), 4);
});

test("a prepaid tenant pays list price for tokens on the platform's key; the turn that spends the last credit ends, and new runs get 402", async t => {
  const { call, prompt, model } = await runtime(t, (_body, index) => ({
    // Each response costs $0.15: 5000 input tokens of openai/gpt-5.5-pro.
    ...(index < 2 ? toolCall("js_exec", { code: `return ${index}` }, `call_${index}`) : { role: "assistant", content: "finished" }),
    usage: { prompt_tokens: 5000, completion_tokens: 0 },
  }), { AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0" }, tenantsFile);
  const agent = (await call("/v1/agents", { body: {}, token: PAYG })).json;
  const refused = await call(`/v1/agents/${agent.id}/prompt`, { body: { text: "hi" }, token: PAYG });
  assert.equal(refused.status, 402);
  assert.match(refused.json.error, /prepaid credit is used up.*\/console\/billing/);
  const code = await call(`/clients/${agent.id}/requests`, { body: { id: "code", method: "execute", params: { code: "return 1" } }, token: agent.token });
  assert.equal(code.status, 402, "code runs need credit too");

  // Only the platform operator adjusts credit; an adjustment repeated with its key applies once.
  const adjustment = { tenant: "payg", amount: 200_000, reason: "test credit", idempotencyKey: "topup-1" };
  assert.equal((await call("/v1/billing/adjustments", { body: adjustment, token: PAYG })).status, 403);
  const added = await call("/v1/billing/adjustments", { body: adjustment, token: OPS });
  assert.equal(added.status, 201);
  assert.equal((await call("/v1/billing/adjustments", { body: adjustment, token: OPS })).json.id, added.json.id);
  assert.equal((await call("/v1/billing/adjustments", { body: { ...adjustment, amount: 1 }, token: OPS })).status, 409);
  assert.equal((await call("/v1/billing/adjustments", { body: { ...adjustment, tenant: "nobody" }, token: OPS })).status, 404);
  assert.equal((await call("/v1/billing", { token: PAYG })).json.balance, 200_000);

  const first = await prompt(agent.id, "go", PAYG);
  assert.equal(first.outcome.result.stopped, "spend_limit");
  assert.match(first.outcome.result.error, /prepaid credit is used up/);
  assert.equal(model.bodies.length, 2, "the turn ended after the response that spent the last credit");
  assert.deepEqual(new Set(model.keys), new Set(["Bearer fixture-platform-key"]));
  assert.equal((await call(`/v1/agents/${agent.id}/prompt`, { body: { text: "again" }, token: PAYG })).status, 402);

  const billing = (await call("/v1/billing", { token: PAYG })).json;
  assert.equal(billing.billing, "prepaid");
  assert.equal(billing.balance, 200_000 - 300_000);
  assert.equal(billing.month.usage, -300_000);
  assert.equal(billing.month.adjustment, 200_000);
  assert.equal(billing.rates.agentHour, 0);
  const usage = (await call("/v1/usage", { token: PAYG })).json;
  assert.equal(usage.totals.platformResponses, 2);
  // Paging through the ledger.
  const page = (await call("/v1/billing/ledger?limit=1", { token: PAYG })).json;
  assert.equal(page.entries.length, 1);
  const rest = (await call(`/v1/billing/ledger?before=${page.next}`, { token: PAYG })).json;
  assert.deepEqual([...page.entries, ...rest.entries].map((entry: any) => entry.kind).at(-1), "adjustment");
  assert.equal([...page.entries, ...rest.entries].reduce((sum: number, entry: any) => sum + entry.amount, 0), billing.balance);
  // Unbilled tenants see their mode and no balance.
  assert.equal((await call("/v1/billing", { token: OPS })).json.billing, "none");
});

test("responses on the tenant's own key cost no credit for tokens, but time in turns is charged", async t => {
  const { call, prompt, model } = await runtime(t, (_body, index) => ({
    ...(index === 0 ? toolCall("js_exec", { code: "return 1" }) : { role: "assistant", content: "done" }),
    usage: { prompt_tokens: 5000, completion_tokens: 0 }, delayMs: 150,
  }), { AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "3600", AGENT_VERIFY_KEYS: "false" }, tenantsFile);
  assert.equal((await call("/v1/billing/adjustments", { body: { tenant: "payg", amount: micros(10), reason: "test" }, token: OPS })).status, 201);
  assert.equal((await call("/v1/providers/openrouter/key", { method: "PUT", body: { apiKey: "sk-or-own-key" }, token: PAYG })).status, 200);
  const agent = (await call("/v1/agents", { body: {}, token: PAYG })).json;
  const started = Date.now();
  assert.equal((await prompt(agent.id, "go", PAYG)).outcome.result.reply, "done");
  const elapsed = Date.now() - started;
  assert.deepEqual(new Set(model.keys), new Set(["Bearer sk-or-own-key"]));
  const entries = await until(async () => {
    const ledger = (await call("/v1/billing/ledger", { token: PAYG })).json.entries.filter((entry: any) => entry.kind === "usage");
    return ledger.length && ledger;
  }, "the usage flush");
  const activeMs = entries.reduce((sum: number, entry: any) => sum + entry.metadata.activeMs, 0);
  assert.ok(activeMs >= 300 && activeMs <= elapsed, `two responses of at least 150 ms each, within the turn (${activeMs} of ${elapsed} ms)`);
  for (const entry of entries) {
    assert.equal(entry.metadata.tokens, 0);
    assert.ok(Math.abs(entry.amount + entry.metadata.activeMs * 1000) <= 1000, "$1 per second of agent time");
  }
  assert.equal((await call("/v1/usage", { token: PAYG })).json.totals.platformResponses, 0);
});
