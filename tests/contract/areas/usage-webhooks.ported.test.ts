import { portedTest } from '../ported.ts';
const test = portedTest("webhooks", "tests/usage-webhooks.test.ts");

import assert from "node:assert/strict";

import { createHash } from "node:crypto";

import { listen, OPERATOR, runtime, until } from "../support.ts";

import { anthropic, gateway } from "../../provider-fixtures.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_USAGE_WEBHOOK_RETRY_MS: "100" };

test("calls through a tenant's own endpoint are sent too, named as the agent names its model", async t => {
  const received: any[] = [];
  const receiver = await listen(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push(JSON.parse(body));
    res.writeHead(200).end();
  });
  const endpoint = await gateway(t, () => anthropic([{ type: "text", text: "Via the endpoint." }], "end_turn", { input_tokens: 30, output_tokens: 4 }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL, { tenants: { alice: { tokenSha256: sha(OPERATOR), modelEndpoints: { chiridion: { baseUrl: endpoint.url } } } } });
  await r.call("/v1/usage-webhook", { method: "PUT", body: { url: receiver } });
  const agent = (await r.call("/v1/agents", { body: { model: "chiridion/anthropic/claude-opus-5" } })).json.id;
  assert.equal((await r.prompt(agent, "Hi")).outcome.result.reply, "Via the endpoint.");
  await r.call("/v1/usage");
  const [event] = await until(() => received.length && received, "the event");
  assert.deepEqual([event.provider, event.model, event.input, event.output, event.cost], ["chiridion", "anthropic/claude-opus-5", 30, 4, { usd: 0, source: "catalog" }]);
});
