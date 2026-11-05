import {portedTest} from "../ported.ts";
const test=portedTest("billing", "tests/auto-topup.test.ts");
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import type {TestContext} from "node:test";
import {listen,runtime,OPERATOR} from "../support.ts";

const SECRET = "whsec_auto_fixture";

async function fixture(t: TestContext) {
  let now = Date.UTC(2026,8,29), seq = 0;
  let outcome: "success" | "decline" | "action" | "processing" = "success";
  let card: any = { id: "pm_4242", type: "card", customer: "cus_alice", card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2030 } };
  let lost: string | undefined;
  let tamper = false;
  const invoices = new Map<string, any>(), payments = new Map<string, any>(), keys = new Map<string, any>();
  const calls: { path: string; method: string; params: URLSearchParams; key?: string }[] = [];
  const url = await listen(t, async (req,res) => {
    let body = ""; for await (const part of req) body += part;
    const path = new URL(req.url!, "http://local").pathname, params = new URLSearchParams(body), key = req.headers["idempotency-key"] as string;
    calls.push({ path, method: req.method!, params, key });
    let value: any;
    if (key && keys.has(key)) { const prior = keys.get(key); assert.equal(body, prior.body); value = prior.value; }
    else if (req.method === "GET" && path === "/v1/customers/cus_alice") value = { id: "cus_alice", livemode: false, invoice_settings: { default_payment_method: card } };
    else if (req.method === "GET" && path === "/v1/invoice_payments") {
      const id = new URL(req.url!, "http://local").searchParams.get("invoice")!;
      const pi = payments.get(id);
      value = { has_more: false, data: pi ? [{ invoice: id, status: pi.status === "succeeded" ? "paid" : "open", amount_paid: pi.amount_received, payment: { type: "payment_intent", payment_intent: pi } }] : [] };
    } else if (req.method === "GET" && path.startsWith("/v1/invoices/")) value = invoices.get(path.split("/")[3]);
    else if (req.method === "POST" && path === "/v1/invoices") {
      const id = `in_${++seq}`;
      assert.equal(params.get("pending_invoice_items_behavior"), "exclude");
      assert.equal(params.get("auto_advance"), "false");
      assert.equal(params.has("default_tax_rates"), false, "Stripe rejects unsetting default_tax_rates on invoice creation");
      assert.equal(params.get("automatic_tax[enabled]"), "false");
      value = { id, customer: params.get("customer"), livemode: false, metadata: { purpose: params.get("metadata[purpose]"), attempt: params.get("metadata[attempt]") }, currency: "usd", status: "draft", auto_advance: false, starting_balance: 0, total: 0, amount_due: 0, amount_paid: 0, hosted_invoice_url: `https://invoice.stripe.test/${id}` };
      invoices.set(id, value);
    } else if (req.method === "POST" && path === "/v1/invoiceitems") {
      const invoice = invoices.get(params.get("invoice")!)!;
      assert.equal(invoice.status, "draft"); assert.equal(params.get("discountable"), "false");
      const amount = Number(params.get("amount")); invoice.total += amount; invoice.amount_due += amount;
      if (tamper) { tamper = false; invoice.total += 100; }
      value = { id: `ii_${++seq}`, invoice: invoice.id, amount };
    } else if (path.endsWith("/void")) {
      value = invoices.get(path.split("/")[3]); value.status = "void";
      const pi = payments.get(value.id); if (pi) pi.status = "canceled";
    } else if (path.endsWith("/finalize")) {
      value = invoices.get(path.split("/")[3]); value.status = "open";
      payments.set(value.id, { id: `pi_${value.id}`, customer: value.customer, livemode: false, currency: "usd", amount: value.total, amount_received: 0, status: "requires_payment_method" });
    } else if (path.endsWith("/pay")) {
      value = invoices.get(path.split("/")[3]); const pi = payments.get(value.id)!;
      assert.equal(params.get("off_session"), "true");
      pi.payment_method = card;
      pi.status = outcome === "success" ? "succeeded" : outcome === "decline" ? "requires_payment_method" : outcome === "action" ? "requires_action" : "processing";
      if (outcome === "success") { value.status = "paid"; value.amount_paid = value.total; pi.amount_received = pi.amount; }
    }
    if (key && value) keys.set(key, { body, value });
    if ((lost === path || (lost === "pay" && path.endsWith("/pay"))) && req.method === "POST") { lost = undefined; res.destroy(); return; }
    res.writeHead(value ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(value ?? { error: { code: "resource_missing" } }));
  });
  return {url, calls, invoices, payments};
}

test("auto top-up REST requires the exact quote version and explicit consent", async t => {
  const f = await fixture(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "Hi" }), { STRIPE_SECRET_KEY: "sk_test_auto", STRIPE_WEBHOOK_SECRET: SECRET, AGENT_STRIPE_API_URL: f.url },
    { tenants: { alice: { billing: "prepaid", apiKeys: {}, tokenSha256: createHash("sha256").update(OPERATOR).digest("hex") } } });
  await r.seedStripeCustomer("alice", { customer: "cus_alice" });
  assert.equal((await r.call("/v1/billing/auto-topup", { token: null })).status, 401);
  assert.equal((await r.call("/v1/billing/auto-topup")).json.state, "off");
  const quote = await r.call("/v1/billing/auto-topup/quote", { body: { thresholdUsd: 5, amountUsd: 20, monthlyLimitUsd: 200 } });
  assert.equal(quote.status, 201, JSON.stringify(quote.json)); assert.equal(quote.json.total, 21.1e6); assert.equal(quote.json.immediate, true);
  const body = { quoteId: quote.json.id, version: quote.json.version };
  assert.equal((await r.call("/v1/billing/auto-topup/enable", { body })).status, 400);
  assert.equal((await r.call("/v1/billing/auto-topup/enable", { body: { ...body, version: "0".repeat(64), consent: true } })).status, 409);
  const enabled = await r.call("/v1/billing/auto-topup/enable", { body: { ...body, consent: true } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.json)); assert.equal(enabled.json.held, 21.1e6);
  assert.equal((await r.call("/v1/billing/auto-topup/disable", { body: {} })).json.state, "off");
});
