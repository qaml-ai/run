import { portedTest } from '../ported.ts';
const test = portedTest("credits", "tests/end-user-webhooks.test.ts");

import assert from "node:assert/strict";


import { signedHeaders } from "../../../src/webhooks.ts";

import { listen, runtime, toolCall, until } from "../support.ts";


test("end-user events reach an endpoint that selected them, signed", async t => {
  const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const hook = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, body });
    res.writeHead(200).end();
  });
  const r = await runtime(t, (_body, index) => ({ ...toolCall("codemode", { code: `return ${index}` }, `call_${index}`), usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.05 } }),
    { AGENT_MODEL: "openai/gpt-4.1", AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.0/8" });
  const endpoint = await r.call("/v1/webhooks", { body: { url: `${hook}/hook`, events: ["end_user.balance.low", "end_user.credit.exhausted"] } });
  assert.equal(endpoint.status, 201, endpoint.text);
  await r.call("/v1/end-user-settings", { method: "PUT", body: { enabled: true, lowBalance: 60_000 } });
  await r.call("/v1/end-users/person/entries", { body: { kind: "grant", amount: 100_000, key: "pay" } });
  const { id } = (await r.call("/v1/agents", { body: { subject: "person" } })).json;
  const run = await r.prompt(id, "go");
  assert.equal(run.outcome.result.code, "end_user_credit");
  await until(() => received.length >= 2, "both events to be delivered", 30_000);
  const bodies = received.map(entry => JSON.parse(entry.body));
  assert.deepEqual(bodies.map(body => body.type).sort(), ["end_user.balance.low", "end_user.credit.exhausted"]);
  for (const entry of received) {
    const id = entry.headers["webhook-id"] as string;
    const expected = signedHeaders(id, entry.body, [endpoint.json.secret], Number(entry.headers["webhook-timestamp"]) * 1000);
    assert.equal(entry.headers["webhook-signature"], expected["webhook-signature"]);
  }
  assert.equal(bodies.find(body => body.type === "end_user.credit.exhausted").data.reason, "balance");
});
