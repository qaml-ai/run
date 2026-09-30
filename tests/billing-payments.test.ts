import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Billing } from "../src/billing.ts";
import { Stripe, StripeError, STRIPE_API_VERSION, signWebhook } from "../src/stripe.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { listen, runtime } from "./runtime-server.ts";

const SECRET = "whsec_billing_payments_fixture";
async function fixture(t: TestContext) {
  const { db } = await testDatabase();
  const requests: { method: string; path: string; params: URLSearchParams; key?: string; version?: string }[] = [];
  const objects = new Map<string, any>(), keys = new Map<string, { body: string; value: any }>();
  let loseResponse = false, count = 0;
  const config = { id: "bpc_fixture", active: true, livemode: false, metadata: { purpose: "agent-runtime-credit" }, features: {
    payment_method_update: { enabled: true }, invoice_history: { enabled: true }, subscription_update: { enabled: false }, subscription_cancel: { enabled: false },
  } };
  const url = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const path = new URL(req.url!, "http://local").pathname, params = new URLSearchParams(body), key = req.headers["idempotency-key"] as string;
    requests.push({ method: req.method!, path, params, key, version: req.headers["stripe-version"] as string });
    let value: any;
    if (req.method === "GET") value = path === "/v1/billing_portal/configurations/bpc_fixture" ? config : objects.get(path);
    else if (key && keys.has(key)) {
      const prior = keys.get(key)!;
      assert.equal(body, prior.body, "a retry must send exactly the saved parameters");
      value = prior.value;
    } else if (path === "/v1/customers") {
      value = { id: `cus_${++count}`, livemode: req.headers.authorization?.includes("live"), metadata: { purpose: params.get("metadata[purpose]"), tenant: params.get("metadata[tenant]") }, invoice_settings: { default_payment_method: null } };
      objects.set(`/v1/customers/${value.id}`, value);
    } else if (path === "/v1/checkout/sessions") {
      value = { id: `cs_${++count}`, livemode: req.headers.authorization?.includes("live"), mode: params.get("mode"), customer: params.get("customer"), status: "open", payment_status: "unpaid", currency: "usd",
        amount_total: Number(params.get("line_items[0][price_data][unit_amount]")) + Number(params.get("line_items[1][price_data][unit_amount]")),
        client_reference_id: params.get("client_reference_id"), metadata: { purpose: params.get("metadata[purpose]"), tenant: params.get("metadata[tenant]"), credit: params.get("metadata[credit]"), order: params.get("metadata[order]") },
        expires_at: Math.floor(Date.now()/1000)+86400, url: `https://checkout.stripe.test/${count}` };
      objects.set(`/v1/checkout/sessions/${value.id}`, value);
    } else if (path === "/v1/billing_portal/sessions") value = { url: "https://billing.stripe.test/portal" };
    if (key && value) keys.set(key, { body, value });
    if (loseResponse && path === "/v1/checkout/sessions" && req.method === "POST") { loseResponse = false; res.destroy(); return; }
    res.writeHead(value ? 200 : 404, { "Content-Type": "application/json", "request-id": "req_fixture" }).end(JSON.stringify(value ?? { error: { message: "Missing fixture", code: "resource_missing" } }));
  });
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { alice: { tokenSha256: "a".repeat(64), billing: "prepaid" }, bob: { tokenSha256: "b".repeat(64), billing: "prepaid" } } }) });
  await tenants.reload();
  const stripe = new Stripe({ secretKey: "sk_test_fixture", webhookSecret: SECRET, apiUrl: url, portalConfiguration: "bpc_fixture" });
  const billing = new Billing({ db, tenants, stripe, publicUrl: "https://agents.example.test" });
  const send = (object: any, type = "checkout.session.completed") => {
    const body = JSON.stringify({ id: `evt_${randomUUID()}`, type, livemode: false, data: { object } });
    return billing.webhook(body, signWebhook(SECRET, body));
  };
  const paid = (id: string) => ({ ...objects.get(`/v1/checkout/sessions/${id}`), status: "complete", payment_status: "paid", payment_intent: `pi_${id}`, invoice: `in_${id}` });
  return { db, stripe, billing, requests, objects, config, send, paid, url, loseNext: () => { loseResponse = true; } };
}

test("Checkout persists its quote, creates an invoice, and reuses one purchase through concurrency and a lost response", async t => {
  const f = await fixture(t), requestId = randomUUID();
  f.loseNext();
  await assert.rejects(f.billing.checkout("alice", 10_000_000, requestId));
  const saved = (await f.db.query("select * from billing_checkouts")).rows[0];
  assert.equal(saved.session, null, "the provider created the object but the process did not receive its response");
  const changedPricing = new Billing({ db: f.db, tenants: f.billing.tenants, stripe: f.stripe, publicUrl: "https://changed.example.test", pricing: { ...DEFAULT_PRICING, purchaseFeeBps: 999 } });
  const results = await Promise.all(Array.from({ length: 4 }, () => changedPricing.checkout("alice", 10_000_000, requestId)));
  assert.equal(new Set(results.map(row => row.id)).size, 1);
  assert.equal(results[0].fee, 550_000, "the original price survives rate changes and restart");
  assert.equal((await f.db.query("select count(*) from billing_checkouts")).rows[0].count, 1);
  const calls = f.requests.filter(row => row.method === "POST" && row.path === "/v1/checkout/sessions");
  assert.equal(new Set(calls.map(row => row.key)).size, 1);
  assert.equal(calls[0].params.get("invoice_creation[enabled]"), "true");
  assert.equal(calls[0].params.get("invoice_creation[invoice_data][metadata][order]"), saved.id);
  assert.match(calls[0].params.get("integration_identifier")!, /^camelrun-credit-[a-z]{8}$/);
  assert.ok(f.requests.every(row => row.version === STRIPE_API_VERSION));
  await assert.rejects(f.billing.checkout("alice", 20_000_000, requestId), /different credit amount/);
  assert.equal((await f.billing.checkout("alice", 10_000_000, requestId)).id, results[0].id);
});

test("fulfillment validates the stored terms and ownership, applies early refunds, and ignores invoice.paid", async t => {
  const f = await fixture(t);
  const otherMode = JSON.stringify({ id: "evt_other_mode", type: "charge.refunded", livemode: true, data: { object: { id: "ch_other", payment_intent: "pi_other", amount: 100, amount_refunded: 100 } } });
  assert.equal((await f.billing.webhook(otherMode, signWebhook(SECRET, otherMode))).handled, "ignored");
  assert.equal((await f.db.query("select count(*) from billing_stripe_refunds")).rows[0].count, 0);
  const result = await f.billing.checkout("alice", 10_000_000, randomUUID()), good = f.paid(result.id);
  for (const changes of [{ customer: "cus_other" }, { livemode: true }, { amount_total: 1 }, { currency: "eur" }, { mode: "setup" }, { client_reference_id: "wrong" }, { payment_intent: null }]) {
    await assert.rejects(f.send({ ...good, ...changes }));
  }
  assert.equal((await f.db.query("select count(*) from credit_ledger")).rows[0].count, 0);
  await f.send({ id: "ch_early", payment_intent: good.payment_intent, amount: 1055, amount_refunded: 1055, currency: "usd" }, "charge.refunded");
  // Mutable metadata cannot increase the saved credit or move it to another tenant.
  await f.send({ ...good, metadata: { ...good.metadata, credit: "999999999", tenant: "bob" } });
  await Promise.all([f.send(good), f.send(good, "checkout.session.async_payment_succeeded")]);
  assert.deepEqual((await f.db.query("select tenant,balance,purchased from credit_accounts")).rows, [{ tenant: "alice", balance: 0, purchased: 0 }]);
  const row = (await f.db.query("select * from billing_checkouts")).rows[0];
  assert.equal(row.payment_intent, good.payment_intent); assert.equal(row.invoice, good.invoice); assert.ok(row.paid_at);
  assert.equal((await f.send({ ...good, id: good.invoice, status: "paid", paid_out_of_band: true, total: 1055, hosted_invoice_url: "https://invoice.stripe.test/manual" }, "invoice.paid")).handled, "ignored");
  assert.equal((await f.db.query("select count(*) from credit_ledger")).rows[0].count, 2);
  await assert.rejects(f.billing.checkout("alice", 10_000_000, row.request_id), /already paid/);
});

test("a webhook arriving before the create response binds the order atomically; a conflicting session cannot bind", async t => {
  const f = await fixture(t), requestId = randomUUID();
  f.loseNext(); await assert.rejects(f.billing.checkout("alice", 5_000_000, requestId));
  const session = [...f.objects.values()].find(row => row.id.startsWith("cs_")), good = f.paid(session.id);
  await f.send(good);
  await assert.rejects(f.send({ ...good, id: "cs_conflict", payment_intent: "pi_conflict" }), /does not match/);
  assert.equal((await f.db.query("select count(*) from credit_ledger where kind='purchase'")).rows[0].count, 1);
});

test("ambiguous creates older than the safe idempotency window fail closed without contacting Stripe", async t => {
  const f = await fixture(t), requestId = randomUUID();
  f.loseNext(); await assert.rejects(f.billing.checkout("alice", 5_000_000, requestId));
  await f.db.query("update billing_checkouts set created_at=0");
  const before = f.requests.length;
  await assert.rejects(f.billing.checkout("alice", 5_000_000, requestId), /reconciliation/);
  assert.equal(f.requests.length, before);
  await f.db.query("insert into billing_stripe_customers (tenant,livemode,request_id,created_at) values ('bob',false,$1,0)", [randomUUID()]);
  assert.ok((await f.billing.checkout("bob", 5_000_000, randomUUID())).id);
  assert.ok(f.requests.length > before, "an abandoned empty Customer can be replaced safely");
});

test("portal scopes both flows to the tenant, validates product configuration, and only displays Stripe-owned card details", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.billing.paymentMethod("alice"), { portal: true, customer: false, card: null });
  await assert.rejects(f.billing.portal("alice", "manage"), /Add credit/);
  await f.billing.portal("alice", "payment_method");
  const portal = f.requests.at(-1)!;
  assert.equal(portal.params.get("flow_data[type]"), "payment_method_update");
  assert.equal(portal.params.get("flow_data[after_completion][redirect][return_url]"), "https://agents.example.test/console/billing?payment_method=updated");
  assert.equal(portal.params.get("configuration"), "bpc_fixture");
  const customer = f.objects.get(`/v1/customers/${portal.params.get("customer")}`);
  customer.invoice_settings.default_payment_method = { id: "pm_secret", type: "card", customer: customer.id, card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030, fingerprint: "private" } };
  assert.deepEqual(await f.billing.paymentMethod("alice"), { portal: true, customer: true, card: { brand: "visa", last4: "4242", expMonth: 4, expYear: 2030 } });
  await f.billing.portal("alice", "manage");
  assert.equal(f.requests.at(-1)!.params.get("customer"), customer.id);
  assert.equal(f.requests.at(-1)!.params.get("flow_data[type]"), null);
  await assert.rejects(f.billing.portal("bob", "manage"), /Add credit/);
  const freshBilling = () => new Billing({ db: f.db, tenants: f.billing.tenants, stripe: f.stripe, publicUrl: "https://agents.example.test" });
  f.config.features.subscription_cancel.enabled = true;
  await assert.rejects(freshBilling().portal("alice", "manage"), /configuration/);
  f.config.features.subscription_cancel.enabled = false;
  f.config.metadata.purpose = "other-product";
  await assert.rejects(freshBilling().portal("alice", "manage"), /configuration/);
});

test("test/live customers are isolated; legacy customer adoption requires ownership and mode", async t => {
  const f = await fixture(t);
  const test = await f.billing.payments!.customer("alice");
  const liveStripe = new Stripe({ secretKey: "sk_live_fixture", webhookSecret: SECRET, apiUrl: f.url });
  const live = new Billing({ db: f.db, tenants: f.billing.tenants, stripe: liveStripe, publicUrl: "https://agents.example.test" });
  assert.notEqual(await live.payments!.customer("alice"), test);
  assert.equal((await f.db.query("select count(*) from billing_stripe_customers where tenant='alice'")).rows[0].count, 2);
  f.objects.set("/v1/customers/cus_legacy", { id: "cus_legacy", livemode: false, metadata: { purpose: "agent-runtime-credit", tenant: "bob" } });
  await f.db.query("insert into credit_accounts (tenant,stripe_customer) values ('bob','cus_legacy')");
  const before = f.requests.filter(row => row.method === "POST" && row.path === "/v1/customers").length;
  assert.equal(await f.billing.payments!.customer("bob"), "cus_legacy");
  assert.equal(f.requests.filter(row => row.method === "POST" && row.path === "/v1/customers").length, before);
});

test("unregistered sessions only use legacy fulfillment if created before cutover; provider errors retain code and request id", async t => {
  const f = await fixture(t);
  const object = { id: "cs_legacy", livemode: false, created: Math.floor(Date.now()/1000)+3600, payment_status: "paid", payment_intent: "pi_legacy", metadata: { purpose: "agent-runtime-credit", tenant: "alice", credit: "5000000" } };
  await assert.rejects(f.send(object), /no recorded billing order/);
  await assert.rejects(f.send({ ...object, created: 1, livemode: true }), /no recorded billing order/);
  await f.send({ ...object, created: 1 });
  assert.equal((await f.db.query("select balance from credit_accounts where tenant='alice'")).rows[0].balance, 5_000_000);
  await assert.rejects(f.stripe.get("/v1/customers/cus_missing"), (error: any) => error instanceof StripeError && error.status === 404 && error.code === "resource_missing" && error.requestId === "req_fixture");
});


test("billing REST routes bind portal ownership to authentication and reject caller-supplied redirects", async t => {
  const f = await fixture(t), token = "payment-api-test-operator-token-long-enough";
  const r = await runtime(t, () => ({ role: "assistant", content: "Hi" }), {
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: SECRET,
    AGENT_STRIPE_API_URL: f.url, AGENT_STRIPE_PORTAL_CONFIGURATION: "bpc_fixture",
  }, { tenants: { alice: { tokenSha256: createHash("sha256").update(token).digest("hex"), billing: "prepaid", apiKeys: {} } } });
  const call = (path: string, body?: object) => r.call(path, { token, ...(body ? { body } : {}) });
  assert.equal((await r.call("/v1/billing/portal", { token: null, body: { flow: "payment_method" } })).status, 401);
  assert.equal((await call("/v1/billing/portal", { flow: "payment_method", customer: "cus_other", return_url: "https://evil.test" })).status, 400);
  assert.deepEqual((await call("/v1/billing/payment-method")).json, { portal: true, customer: false, card: null });
  const opened = await call("/v1/billing/portal", { flow: "payment_method" });
  assert.equal(opened.status, 201, JSON.stringify(opened.json));
  assert.deepEqual(opened.json, { url: "https://billing.stripe.test/portal" });
  assert.equal((await call("/v1/billing/portal", { flow: "manage" })).status, 201);
  const requestId = randomUUID();
  const first = await call("/v1/billing/checkout", { amountUsd: 10, requestId });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.deepEqual((await call("/v1/billing/checkout", { amountUsd: 10, requestId })).json, first.json);
  assert.equal((await call("/v1/billing/checkout", { amountUsd: 20, requestId })).status, 409);
});
