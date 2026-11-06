import {portedTest} from "../ported.ts";
const test=portedTest("billing", "tests/billing-payments.test.ts");
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import type {TestContext} from "node:test";
import {listen,runtime} from "../support.ts";

const SECRET = "whsec_billing_payments_fixture";

async function fixture(t: TestContext) {
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
  return {requests, objects, config, url, loseNext: () => { loseResponse = true; }};
}

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
