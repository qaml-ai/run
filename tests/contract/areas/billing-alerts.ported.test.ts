import {portedTest} from "../ported.ts";
const test=portedTest("webhooks", "tests/billing-alerts.test.ts");
import assert from "node:assert/strict";
import {createHmac} from "node:crypto";
import {listen,runtime,until} from "../support.ts";
const micros=(usd:number)=>Math.round(usd*1e6);

function signedHeaders(id: string, body: string, secrets: string[], now: number) {
  const timestamp = String(Math.floor(now / 1000));
  return { "webhook-signature": secrets.map(secret => `v1,${createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`).join(" ") };
}

test("registered billing webhooks are delivered by the existing worker with valid signatures", async t => {
  const received: { body: string; headers: any }[] = [];
  const target = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ body, headers: req.headers });
    res.writeHead(204).end();
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), {
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
    AGENT_SCHEDULER_INTERVAL_MS: "100", AGENT_BILLING_ADMINS: "alice",
  });
  const endpoint = await r.call("/v1/webhooks", { body: { url: target, events: ["billing.balance.low", "billing.balance.depleted"] } });
  assert.equal(endpoint.status, 201, endpoint.text);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "alice", amount: 5e6, reason: "test" } })).status, 201);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "alice", amount: -6e6, reason: "test" } })).status, 201);
  await until(() => received.length === 2, "billing events delivered");
  assert.deepEqual(received.map(r => JSON.parse(r.body).type).sort(), ["billing.balance.depleted", "billing.balance.low"]);
  for (const entry of received) {
    const body = JSON.parse(entry.body);
    assert.equal(body.id, entry.headers["webhook-id"]);
    const headers = signedHeaders(body.id, entry.body, [endpoint.json.secret], Number(entry.headers["webhook-timestamp"]) * 1000);
    assert.equal(entry.headers["webhook-signature"], headers["webhook-signature"]);
    assert.equal(body.data.balance, micros(-1));
  }
});
