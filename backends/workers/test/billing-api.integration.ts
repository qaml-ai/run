import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { startFixture } from "./fixture.ts";
import { listen } from "./billing-listen.ts";
import { signWebhook } from "../src/stripe.ts";

const secret = "whsec_workers_billing_fake";
test("Workers billing routes preserve adjustment, Checkout, refund, dispute and signature rules", async t => {
  let count = 0;
  const objects = new Map<string, any>(), requests: string[] = [];
  const fake = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const params = new URLSearchParams(text), path = new URL(req.url!, "http://local").pathname;
    requests.push(path);
    let value: any = objects.get(path);
    if (path === "/v1/customers" && req.method === "POST") value = { id: `cus_${++count}`, livemode: false };
    if (path === "/v1/checkout/sessions" && req.method === "POST") value = {
      id: `cs_${++count}`, livemode: false, status: "open", mode: "payment", payment_status: "unpaid", currency: "usd",
      customer: params.get("customer"), amount_total: Number(params.get("line_items[0][price_data][unit_amount]")) + Number(params.get("line_items[1][price_data][unit_amount]")),
      client_reference_id: params.get("client_reference_id"), expires_at: Math.floor(Date.now()/1000) + 3600, url: "https://checkout.stripe.test/fake",
      metadata: Object.fromEntries(["purpose", "tenant", "credit", "order"].map(k => [k, params.get(`metadata[${k}]`)])),
    };
    if (value?.id) objects.set(`${path}/${value.id}`, value);
    res.writeHead(value ? 200 : 404, { "Content-Type": "application/json" }).end(JSON.stringify(value ?? {}));
  });
  const f = await startFixture({ vars: { PUBLIC_URL: "https://workers.example.test", STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: secret, STRIPE_API_URL: fake, BILLING_ADMINS: "camelrun-proto-local" } });
  t.after(() => f.stop());
  const call = async (path: string, body?: object, auth = true) => {
    const response = await fetch(`${f.url}${path}`, { method: body ? "POST" : "GET", headers: { ...(auth ? { Authorization: `Bearer ${f.token}` } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json() as any };
  };
  const starting = (await call("/v1/billing")).json.balance;
  assert.equal(typeof starting, "number");
  const adjustment = { tenant: "camelrun-proto-local", amount: 123456, reason: "fake route test", idempotencyKey: randomUUID() };
  assert.equal((await call("/v1/billing/adjustments", adjustment, false)).status, 401);
  const first = await call("/v1/billing/adjustments", adjustment);
  assert.equal(first.status, 201);
  assert.deepEqual(await call("/v1/billing/adjustments", adjustment), first);
  assert.equal((await call("/v1/billing/adjustments", { ...adjustment, amount: 1 })).status, 409);
  assert.equal((await call("/v1/billing")).json.balance, starting + 123456);
  const requestId = randomUUID();
  const checkout = await call("/v1/billing/checkout", { amountUsd: 10, requestId });
  assert.equal(checkout.status, 201, JSON.stringify({ response: checkout.json, requests, customers: (await f.db.query("select customer from billing_stripe_customers")).rows, orders: (await f.db.query("select id,session,amount from billing_checkouts")).rows }));
  assert.deepEqual((await call("/v1/billing/checkout", { amountUsd: 10, requestId })).json, checkout.json);
  assert.equal((await call("/v1/billing/checkout", { amountUsd: 11, requestId })).status, 409);
  const session = { ...objects.get(`/v1/checkout/sessions/${checkout.json.id}`), status: "complete", payment_status: "paid", payment_intent: "pi_worker_fake" };
  const send = async (type: string, object: object, signature = true) => {
    const payload = JSON.stringify({ id: randomUUID(), livemode: false, type, data: { object } });
    return fetch(`${f.url}/v1/billing/stripe/webhook`, { method: "POST", headers: { "Stripe-Signature": signature ? signWebhook(secret, payload) : "bad", "Content-Type": "application/json" }, body: payload });
  };
  assert.equal((await send("checkout.session.completed", session, false)).status, 400);
  assert.equal((await send("checkout.session.completed", session)).status, 200);
  assert.equal((await send("checkout.session.completed", session)).status, 200);
  assert.equal((await call("/v1/billing")).json.balance, starting + 123456 + 10_000_000);
  const dispute = { id: "dp_worker_fake", payment_intent: "pi_worker_fake", amount: 1055, currency: "usd", status: "needs_response" };
  assert.equal((await send("charge.dispute.created", dispute)).status, 200);
  assert.equal((await send("charge.dispute.closed", { ...dispute, status: "won" })).status, 200);
  assert.equal((await send("charge.refunded", { id: "ch_worker_fake", payment_intent: "pi_worker_fake", amount: 1055, amount_refunded: 1055, currency: "usd" })).status, 200);
  assert.equal((await call("/v1/billing")).json.balance, starting + 123456);
  assert.ok(requests.length > 0);
});
