import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime, toolCall } from "./runtime-server.ts";

test("an agent's spend limit ends the turn that crosses it and refuses new prompts until a new limit, which counts from zero", async t => {
  // Each response costs $0.15: 5000 input tokens of openai/gpt-5.5-pro. The model keeps calling tools.
  const r = await runtime(t, (_body, index) => ({ ...toolCall("js_exec", { code: `return ${index}` }, `call_${index}`), usage: { prompt_tokens: 5000, completion_tokens: 0 } }), { AGENT_MODEL: "openai/gpt-5.5-pro" });
  assert.equal((await r.call("/v1/agents", { body: { spendLimit: { usd: -1 } } })).status, 400);
  const { id, token } = (await r.call("/v1/agents", { body: { spendLimit: { usd: 0.2 } } })).json;
  assert.deepEqual((await r.call(`/v1/agents/${id}`)).json.spendLimit, { usd: 0.2, spent: 0 });

  const first = await r.prompt(id, "go");
  assert.equal(first.outcome.result.stopped, "spend_limit");
  assert.match(first.outcome.result.error, /This agent has reached its spend limit of \$0\.2 \(\$0\.3 spent/);
  assert.equal(r.model.bodies.length, 2, "the turn ended after the response that crossed the limit");
  assert.equal((await r.call(`/v1/agents/${id}`)).json.spendLimit.spent.toFixed(2), "0.30");
  const refused = await r.call(`/v1/agents/${id}/prompt`, { body: { text: "again" } });
  assert.equal(refused.status, 402);
  assert.match(refused.json.error, /spend limit/);

  // Only the tenant sets it; a new limit applies at once, ahead of queued work, and counts from zero.
  assert.equal((await r.call(`/clients/${id}/requests`, { token, body: { id: "self", method: "configure", params: { spendLimit: { usd: 100 } } } })).status, 403);
  assert.equal((await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { spendLimit: { usd: 0.1 } } })).status, 202);
  assert.deepEqual((await r.call(`/v1/agents/${id}`)).json.spendLimit, { usd: 0.1, spent: 0 });
  const second = await r.prompt(id, "go on");
  assert.equal(second.outcome.result.stopped, "spend_limit");
  assert.equal(r.model.bodies.length, 3, "one response crossed $0.10");

  // Without a limit, the agent runs as the tenant's own limits allow.
  await r.call(`/v1/agents/${id}/configuration`, { method: "PATCH", body: { spendLimit: null } });
  assert.equal((await r.call(`/v1/agents/${id}`)).json.spendLimit, null);
  assert.equal((await r.call(`/v1/agents/${id}/prompt`, { body: { text: "free" } })).status, 202);
});
