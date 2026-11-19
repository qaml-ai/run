import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import { signWebhook, STRIPE_API_VERSION } from "../src/stripe.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

test("the standalone listener preserves raw Stripe signatures and settles a registered live-mode checkout only once", async () => {
  const { db, url } = await testDatabase();
  const order = randomUUID();
  const signingSecret = "whsec_fixture_only";
  const topic = "arn:aws:sns:us-west-2:123456789012:fixture";
  await db.query(`insert into billing_checkouts (id,tenant,livemode,request_id,customer,amount,fee,currency,api_version,parameters,created_at)
    values ($1,'t',true,$2,'cus_fixture',10000000,550000,'usd',$3,'{}',$4)`, [order, randomUUID(), STRIPE_API_VERSION, Date.now()]);
  const event = { type: "checkout.session.completed", id: "evt_fixture", livemode: true, data: { object: {
    id: "cs_fixture", customer: "cus_fixture", livemode: true, currency: "usd", mode: "payment", payment_status: "paid", amount_total: 1055,
    payment_intent: "pi_fixture", client_reference_id: order, metadata: { purpose: "agent-runtime-credit", order },
  } } };
  const payload = JSON.stringify(event, null, 2) + "\n";
  const env = {
    AGENT_DATABASE_URL: url, AGENT_V1_BILLING_CALLBACK_PORT: "0",
    AGENT_TENANT: "t", AGENT_OPERATOR_TOKEN: "fixture-billing-callback-operator", AGENT_SECRETS_KEY: "ab".repeat(32),
    AGENT_PUBLIC_URL: "https://run.example.test", AGENT_BILLING_EMAIL_FROM: "billing@example.test",
    AGENT_BILLING_EMAIL_SNS_TOPICS: topic, AGENT_BILLING_EMAIL_CONFIGURATION_SET: "fixture",
    STRIPE_SECRET_KEY: "sk_live_fixture_not_a_real_key", STRIPE_WEBHOOK_SECRET: signingSecret, AGENT_STRIPE_API_URL: "http://127.0.0.1:9",
    AGENT_JOURNEY_URL: "http://127.0.0.1:9", AGENT_JOURNEY_COLLECT_UNKNOWN: "true",
    AGENT_JOURNEY_SECRET: `whsec_${Buffer.alloc(24, 1).toString("base64")}`,
  };
  const worker = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/v1-billing-callbacks-server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const done = once(worker, "exit");
  let logs = "";
  worker.stdout.on("data", part => { logs += part; });
  worker.stderr.on("data", part => { logs += part; });
  try {
    const port = await until(() => {
      assert.equal(worker.exitCode, null, logs);
      return /"type":"v1_billing_callbacks_started","port":(\d+)/.exec(logs)?.[1];
    }, "the loopback callback listener");
    const origin = `http://127.0.0.1:${port}`;
    const stripeUrl = origin + "/v1/billing/stripe/webhook";
    const signature = signWebhook(signingSecret, payload);
    const post = (body: string, stripeSignature: string) => fetch(stripeUrl, { method: "POST", headers: { "Stripe-Signature": stripeSignature }, body });
    const invalid = await post(payload.trim(), signature);
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "Invalid Stripe signature");
    assert.equal((await post(payload, signWebhook(signingSecret, payload, Math.floor(Date.now()/1000)-600))).status, 400);
    assert.equal((await fetch(origin + "/v1/billing")).status, 404);
    assert.equal((await fetch(stripeUrl)).status, 404);
    assert.equal((await fetch(origin + "/v1/billing/email/feedback", { method: "POST", body: JSON.stringify({ TopicArn: topic }) })).status, 401);
    assert.equal((await db.query("select count(*)::int n from credit_ledger where kind='purchase'")).rows[0].n, 0);
    const responses = await Promise.all([post(payload, signature), post(payload, signature)]);
    for (const response of responses) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { handled: "purchase" });
    }
    assert.deepEqual((await db.query("select amount from credit_ledger where kind='purchase'")).rows, [{ amount: 10_000_000 }]);
    assert.equal((await db.query("select payment_intent from billing_checkouts where id=$1", [order])).rows[0].payment_intent, "pi_fixture");
    assert.deepEqual((await db.query("select body->'properties'->>'transaction_ref' as payment from journey_outbox")).rows, [{ payment: "pi_fixture" }]);
  } finally {
    worker.kill("SIGTERM");
    assert.deepEqual(await done, [0, null], logs);
  }
});
