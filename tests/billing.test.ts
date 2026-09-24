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
import { listen, runtime, toolCall, until } from "./runtime-server.ts";
import { formEncode, signWebhook, Stripe } from "../src/stripe.ts";

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
  assert.match((await accounts.billing.creditLimit("payg"))!.message, /prepaid credit is used up \(balance \$0\.00\); add credit at https:\/\/agents\.example\.test\/console\/billing/);
  assert.equal(await accounts.billing.creditLimit("ops"), undefined, "admin tenants are unbilled by default");
  await accounts.billing.post([{ tenant: "payg", kind: "adjustment", amount: 100_000, key: "a1" }]);
  assert.equal(await accounts.billing.creditLimit("payg"), undefined);
  accounts.recordUsage("payg", "a", response(0.1));
  const limited = await accounts.runLimit("payg");
  assert.equal(typeof limited === "object" && limited.status, 402);
  assert.match(String(typeof limited === "object" && limited.message), /used up/, "an unwritten debit counts at once");
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
  const carol = { login: "Carol", id: 1001, createdAt: Date.parse("2020-01-01") };
  assert.equal(await accounts.tenantForGithub(carol), "carol");
  assert.equal(await accounts.tenantForGithub({ ...carol, login: "carol" }), "carol");
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

const WEBHOOK_SECRET = "whsec_fixture_signing_secret";
/** A Stripe API that records requests and creates customers and checkout sessions. */
async function fakeStripe(t: { after(fn: () => void | Promise<void>): void }) {
  const requests: { path: string; params: URLSearchParams; idempotencyKey?: string; authorization?: string }[] = [];
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = new URLSearchParams(body);
    requests.push({ path: req.url!, params, idempotencyKey: req.headers["idempotency-key"] as string | undefined, authorization: req.headers.authorization });
    const count = requests.length;
    const reply = req.url === "/v1/customers" ? { id: `cus_${params.get("metadata[tenant]")}` }
      : req.url === "/v1/checkout/sessions" ? { id: `cs_test_${count}`, url: `https://checkout.stripe.test/c/pay/cs_test_${count}` }
      : undefined;
    res.writeHead(reply ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(reply ?? { error: { message: "No such route" } }));
  });
  return { url, requests };
}

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

test("credit is bought through Stripe Checkout with the fee on top, added once the webhook reports payment, and refunds take it back", async t => {
  const stripeApi = await fakeStripe(t);
  const { call } = await runtime(t, () => ({ role: "assistant", content: "hi" }), {
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, AGENT_STRIPE_API_URL: stripeApi.url,
  }, tenantsFile);
  const webhook = (event: object, signature?: string) => {
    const payload = JSON.stringify(event);
    return call("/v1/billing/stripe/webhook", { body: event, token: null, headers: { "Stripe-Signature": signature ?? signWebhook(WEBHOOK_SECRET, payload) } });
  };
  assert.equal((await call("/v1/billing", { token: PAYG })).json.checkout, true);
  for (const amountUsd of [4.99, 10.001, 1001, "10"]) assert.equal((await call("/v1/billing/checkout", { body: { amountUsd }, token: PAYG })).status, 400, String(amountUsd));
  assert.equal((await call("/v1/billing/checkout", { body: { amountUsd: 10 }, token: OPS })).status, 400, "unbilled tenants do not buy credit");

  const checkout = await call("/v1/billing/checkout", { body: { amountUsd: 10 }, token: PAYG });
  assert.equal(checkout.status, 201);
  assert.deepEqual(checkout.json, { id: "cs_test_2", url: "https://checkout.stripe.test/c/pay/cs_test_2", amount: 10_000_000, fee: 550_000, total: 10_550_000 });
  const [customer, session] = stripeApi.requests;
  assert.equal(customer.path, "/v1/customers");
  assert.equal(customer.idempotencyKey, "agent-runtime-customer:payg");
  assert.equal(customer.authorization, "Bearer sk_test_fixture");
  const params = Object.fromEntries(session.params);
  assert.equal(params.mode, "payment");
  assert.equal(params.customer, "cus_payg");
  assert.equal(params.client_reference_id, "payg");
  assert.equal(params["line_items[0][price_data][unit_amount]"], "1000");
  assert.equal(params["line_items[1][price_data][unit_amount]"], "55");
  assert.equal(params["line_items[1][price_data][product_data][name]"], "Processing fee (5.5%)");
  assert.equal(params["metadata[credit]"], "10000000");
  assert.equal(params["payment_intent_data[metadata][tenant]"], "payg");
  assert.equal(params.success_url, "https://agents.example.test/console/billing?checkout=success");
  // A second checkout reuses the customer.
  await call("/v1/billing/checkout", { body: { amountUsd: 5.5 }, token: PAYG });
  assert.deepEqual(stripeApi.requests.map(request => request.path), ["/v1/customers", "/v1/checkout/sessions", "/v1/checkout/sessions"]);

  const completed = (id: string, extra: object = {}) => ({
    id: `evt_${id}`, type: "checkout.session.completed",
    data: { object: { id, object: "checkout.session", payment_status: "paid", payment_intent: `pi_${id}`, customer: "cus_payg", amount_total: 1055, currency: "usd", metadata: { purpose: "agent-runtime-credit", tenant: "payg", credit: "10000000" }, ...extra } },
  });
  const balance = async () => (await call("/v1/billing", { token: PAYG })).json.balance;
  assert.equal((await webhook(completed("cs_test_2"), "t=1,v1=bad")).status, 400);
  assert.equal((await webhook(completed("cs_test_2"), signWebhook("whsec_wrong", JSON.stringify(completed("cs_test_2"))))).status, 400);
  assert.equal(await balance(), 0);
  assert.equal((await webhook(completed("cs_test_2", { payment_status: "unpaid" }))).json.handled, "awaiting payment");
  assert.equal((await webhook(completed("cs_test_2"))).json.handled, "purchase");
  assert.equal((await webhook(completed("cs_test_2"))).status, 200, "Stripe redelivers; it is acknowledged");
  assert.equal((await webhook({ ...completed("cs_test_2"), id: "evt_async", type: "checkout.session.async_payment_succeeded" })).status, 200);
  assert.equal(await balance(), 10_000_000, "credited once, without the fee");
  assert.equal((await call("/v1/billing", { token: PAYG })).json.freeCredit, false);
  // Sessions other products on the same Stripe account created are none of ours.
  assert.equal((await webhook(completed("cs_other", { metadata: { tenant: "payg", credit: "99000000" } }))).json.handled, "ignored");
  assert.equal((await webhook({ id: "evt_x", type: "invoice.paid", data: { object: {} } })).json.handled, "ignored");

  // Refunds are cumulative on the charge: a quarter, a repeat of it, then the rest.
  const refunded = (amountRefunded: number) => ({ id: `evt_r${amountRefunded}`, type: "charge.refunded", data: { object: { id: "ch_1", object: "charge", payment_intent: "pi_cs_test_2", amount: 1055, amount_refunded: amountRefunded } } });
  assert.equal((await webhook(refunded(264))).json.handled, "refund");
  assert.equal((await webhook(refunded(264))).status, 200);
  assert.equal(await balance(), 10_000_000 - Math.round(10_000_000 * 264 / 1055));
  await Promise.all([webhook(refunded(1055)), webhook(refunded(1055))]);
  assert.equal(await balance(), 0);
  assert.equal((await webhook({ ...refunded(1055), data: { object: { ...refunded(1055).data.object, id: "ch_2", payment_intent: "pi_unknown" } } })).json.handled, "ignored");
  const kinds = (await call("/v1/billing/ledger", { token: PAYG })).json.entries.map((entry: any) => [entry.kind, entry.amount]);
  assert.deepEqual(kinds, [["refund", -(10_000_000 - Math.round(10_000_000 * 264 / 1055))], ["refund", -Math.round(10_000_000 * 264 / 1055)], ["purchase", 10_000_000]]);
  assert.equal((await call("/v1/billing", { token: PAYG })).json.freeCredit, true, "fully refunded: back on free credit");
});

test("without Stripe, checkout answers 503 and the webhook 404", async t => {
  const { call } = await runtime(t, () => ({ role: "assistant", content: "hi" }), {}, tenantsFile);
  assert.equal((await call("/v1/billing", { token: PAYG })).json.checkout, false);
  assert.equal((await call("/v1/billing/checkout", { body: { amountUsd: 10 }, token: PAYG })).status, 503);
  assert.equal((await call("/v1/billing/stripe/webhook", { body: {}, token: null })).status, 404);
});

const DAY = 86_400_000;
/** GitHub's OAuth and user API for accounts that can be renamed: login → numeric id and creation time. */
async function fakeGithub(t: { after(fn: () => void | Promise<void>): void }) {
  const accounts = new Map<number, { login: string; createdAt: number }>();
  let current = 0;
  const url = await listen(t, async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const path = new URL(req.url!, "http://github.test").pathname;
    const account = accounts.get(Number((req.headers.authorization ?? "").replace("Bearer gho_", "")));
    const reply = path === "/login/oauth/access_token" ? { access_token: `gho_${current}` }
      : path === "/user" && account ? { login: account.login, id: current, created_at: new Date(account.createdAt).toISOString() }
      : undefined;
    res.writeHead(reply ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(reply ?? { message: "Not Found" }));
  });
  return {
    url,
    account(id: number, login: string, ageDays: number) { accounts.set(id, { login, createdAt: Date.now() - ageDays * DAY }); },
    rename(id: number, login: string) { accounts.get(id)!.login = login; },
    /** Complete the OAuth dance as account `id`; the session cookie, or the error the console is sent. */
    async signIn(base: string, id: number) {
      current = id;
      const start = await fetch(`${base}/console/auth/github`, { redirect: "manual" });
      const authorize = new URL(start.headers.get("location")!);
      const state = start.headers.get("set-cookie")!.split(";")[0];
      const callback = await fetch(`${base}/console/auth/callback?code=c&state=${authorize.searchParams.get("state")}`, { redirect: "manual", headers: { Cookie: state } });
      const cookie = callback.headers.getSetCookie().find(value => value.startsWith("ar_session="))?.split(";")[0];
      return { authorize, cookie, error: new URL(callback.headers.get("location")!, base).searchParams.get("error") };
    },
  };
}
const githubEnv = (github: string) => ({ GITHUB_CLIENT_ID: "client-id", GITHUB_CLIENT_SECRET: "client-secret", AGENT_GITHUB_WEB_URL: github, AGENT_GITHUB_API_URL: github, AGENT_OPEN_SIGNUP: "true" });
const consoleCall = (call: (path: string, init?: any) => Promise<any>, cookie: string) =>
  (path: string, init: { method?: string; body?: unknown } = {}) => call(path, { ...init, token: null, headers: { Cookie: cookie, "X-Agent-Runtime-Console": "1" } });

test("open sign-up admits any GitHub account; starting credit is once per account id and only for accounts 30 days old; a renamed login keeps its tenant", async t => {
  const github = await fakeGithub(t);
  const stripeApi = await fakeStripe(t);
  const { call, base } = await runtime(t, () => ({ role: "assistant", content: "hi" }), {
    ...githubEnv(github.url), AGENT_VERIFY_KEYS: "false", STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, AGENT_STRIPE_API_URL: stripeApi.url,
  }, tenantsFile);
  assert.deepEqual((await call("/console/auth/methods", { token: null })).json, { github: true, token: true, open: true, minAccountDays: 30 });

  // Too new for free credit, but in: it can bring its own key or buy credit.
  github.account(2001, "Newbie", 5);
  const newbie = await github.signIn(base, 2001);
  assert.equal(newbie.authorize.searchParams.get("scope"), null, "only the public profile");
  assert.equal(newbie.authorize.searchParams.get("allow_signup"), "true");
  const asNewbie = consoleCall(call, newbie.cookie!);
  assert.equal((await asNewbie("/v1/me")).json.tenant, "newbie");
  const newbieBilling = (await asNewbie("/v1/billing")).json;
  assert.deepEqual([newbieBilling.billing, newbieBilling.balance, newbieBilling.freeCredit], ["prepaid", 0, true]);
  assert.equal((await asNewbie("/v1/providers/anthropic/key", { method: "PUT", body: { apiKey: "sk-ant-newbie-1234" } })).status, 200);
  assert.equal((await asNewbie("/v1/billing/checkout", { body: { amountUsd: 5 } })).status, 201);

  // An old enough account gets $5, once, however often it signs in.
  github.account(3001, "Dave", 400);
  const dave = await github.signIn(base, 3001);
  const asDave = consoleCall(call, dave.cookie!);
  assert.equal((await asDave("/v1/billing")).json.balance, micros(5));
  await github.signIn(base, 3001);
  // Renamed on GitHub: the same account, the same tenant, no second grant.
  github.rename(3001, "David");
  const david = await github.signIn(base, 3001);
  const asDavid = consoleCall(call, david.cookie!);
  assert.deepEqual([(await asDavid("/v1/me")).json.tenant, (await asDavid("/v1/me")).json.login], ["dave", "David"]);
  assert.equal((await asDavid("/v1/billing")).json.balance, micros(5));
  assert.deepEqual((await asDavid("/v1/billing/ledger")).json.entries.map((entry: any) => entry.kind), ["grant"]);
  // Someone else now has the login "Dave": another account, so another tenant and its own grant.
  github.account(4001, "Dave", 90);
  const other = await github.signIn(base, 4001);
  const asOther = consoleCall(call, other.cookie!);
  assert.equal((await asOther("/v1/me")).json.tenant, "dave-4001");
  assert.equal((await asOther("/v1/billing")).json.balance, micros(5));
});

test("free credit brings fewer agents and an hourly spend limit, both lifted by the first purchase", async t => {
  const github = await fakeGithub(t);
  const { call, base, model } = await runtime(t, (_body, index) => ({
    ...(index < 2 ? toolCall("js_exec", { code: `return ${index}` }, `call_${index}`) : { role: "assistant", content: "finished" }),
    usage: { prompt_tokens: 5000, completion_tokens: 0 },
  }), {
    ...githubEnv(github.url), AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_PRICE_AGENT_HOUR_USD: "0",
    AGENT_FREE_MAX_AGENTS: "2", AGENT_FREE_HOURLY_SPEND_USD: "0.2", AGENT_MAX_AGENTS_PER_TENANT: "5",
    // The held calls are never answered: shut down without draining them.
    AGENT_DRAIN_TIMEOUT_MS: "0",
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, AGENT_STRIPE_API_URL: "http://127.0.0.1:9",
  }, tenantsFile);
  github.account(5001, "Erin", 365);
  const session = await github.signIn(base, 5001);
  const token = (await consoleCall(call, session.cookie!)("/v1/tokens", { body: { name: "test" } })).json.token;
  assert.equal((await call("/v1/billing", { token })).json.freeCredit, true);

  // Two agents kept busy by calls that are never answered, so neither is idle and can be stopped to make room for a third.
  const hold = { name: "hold", description: "Never answered", parameters: { type: "object", properties: {}, additionalProperties: false } };
  const busy: { id: string; token: string }[] = [];
  for (const key of ["a", "b"]) {
    const created = await call("/client-sessions", { token, body: { tools: [hold] }, headers: { "Idempotency-Key": key } });
    assert.equal(created.status, 201, created.text);
    busy.push(created.json);
    assert.equal((await call(`/clients/${created.json.id}/requests`, { token: created.json.token, body: { id: "hold", method: "execute", params: { code: "return await tools.hold({})" } } })).status, 202);
    await until(async () => (await call(`/clients/${created.json.id}/state`, { token: created.json.token })).json.calls.length > 0, "the held call to be offered");
  }
  assert.equal((await call("/v1/agents", { body: {}, token, headers: { "Idempotency-Key": "c" } })).status, 429, "two agents at once on free credit");
  assert.equal((await call(`/v1/agents/${busy[1].id}`, { method: "DELETE", token })).status, 200);
  const created = await call("/v1/agents", { body: {}, token, headers: { "Idempotency-Key": "c" } });
  assert.equal(created.status, 201, "deleting one makes room");
  const agent = created.json;

  const first = await prompt(call, agent.id, token);
  assert.equal(first.result.stopped, "spend_limit");
  assert.match(first.result.error, /Free credit allows \$0\.20 of usage per hour/);
  assert.equal(model.bodies.length, 2, "the turn ended after the response that reached the hourly limit");
  const limited = await call(`/v1/agents/${agent.id}/prompt`, { body: { text: "again" }, token });
  assert.equal(limited.status, 429);
  assert.match(limited.json.error, /buy credit/);

  // The first purchase lifts both limits at once.
  const event = { id: "evt_buy", type: "checkout.session.completed", data: { object: { id: "cs_erin", payment_status: "paid", payment_intent: "pi_erin", metadata: { purpose: "agent-runtime-credit", tenant: "erin", credit: "5000000" } } } };
  assert.equal((await call("/v1/billing/stripe/webhook", { body: event, token: null, headers: { "Stripe-Signature": signWebhook(WEBHOOK_SECRET, JSON.stringify(event)) } })).status, 200);
  assert.equal((await call("/v1/billing", { token })).json.freeCredit, false);
  assert.equal((await prompt(call, agent.id, token)).result.reply, "finished");
  assert.equal((await call("/v1/agents", { body: {}, token, headers: { "Idempotency-Key": "d" } })).status, 201, "a third agent while the other two are busy");
});

/** Prompt over the REST API with `token` and wait for the run's outcome. */
async function prompt(call: (path: string, init?: any) => Promise<any>, agent: string, token: string) {
  const accepted = await call(`/v1/agents/${agent}/prompt`, { body: { text: "go" }, token });
  assert.equal(accepted.status, 202, accepted.text);
  return (await until(async () => {
    const record = (await call(`/v1/agents/${agent}/requests/${accepted.json.id}`, { token })).json;
    return record.state === "completed" && record;
  }, "the turn to end")).outcome;
}
