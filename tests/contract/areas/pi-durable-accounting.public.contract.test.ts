import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { portedTest } from "../ported.ts";
import { OPERATOR, runtime, until, listen } from "../support.ts";

const imported = ["claude-sonnet-5", "claude-opus-4-1", "gpt-4o"].flatMap((model, index) => [
  { role: "user" as const, content: `Old question ${index}`, timestamp: index * 2 + 1 },
  { role: "assistant" as const, content: [{ type: "text" as const, text: `Old answer ${index}` }],
    api: index === 2 ? "openai-completions" as const : "anthropic-messages" as const,
    provider: index === 2 ? "openai" : "anthropic", model, stopReason: "stop" as const, timestamp: index * 2 + 2,
    usage: { input: 100, output: 20, cacheRead: 300, cacheWrite: 400, totalTokens: 820,
      cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } } },
]);

for (const hosting of ["inline", "process"]) portedTest("billing", "tests/pi-durable-accounting.test.ts:48")(`imported usage and forks are free; the next real turn is billed once (${hosting})`, async t => {
  const delivered: any[] = [];
  const webhook = await listen(t, async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    delivered.push(JSON.parse(text)); res.writeHead(204).end();
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "done", usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.01 } }),
    { AGENT_HOSTING: hosting, AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" }, { tenants: { alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), apiKeys: {} } },
      platformKeys: { openrouter: "fixture-platform-key" } });
  assert.equal((await r.call("/v1/webhooks", { body: { url: webhook + "/usage", events: ["usage.recorded"] } })).status, 201);
  const initialMessages = [...imported.slice(0, 2), { role: "compactionSummary", summary: "The first old question was answered.", tokensBefore: 820, timestamp: 2 }, ...imported.slice(2)];
  const created = await r.call("/v1/agents", { body: { codeMode: false, initialMessages, spendLimit: { usd: 100 } } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  // Wait for the imported messages through the public history endpoint.
  await until(async () => (await r.call(`/v1/agents/${id}/history`)).json.messages?.length === imported.length, "the import to finish");
  const history = (await r.call(`/v1/agents/${id}/history`)).json.messages;
  assert.deepEqual(history, imported, "keep original usage for context accounting");
  const noCharge = async (agent: string) => {
    await r.call("/v1/usage");
    assert.equal((await r.call(`/v1/agents/${agent}`)).json.spendLimit.spent, 0);
  };
  await noCharge(id);
  assert.equal(r.model.bodies.length, 0, "importing makes no provider call");
  assert.equal(Number((await r.call("/v1/usage")).json.totals.responses), 0);

  const forked = await r.call(`/v1/agents/${id}/fork`, { body: { key: "import-fork" } });
  assert.equal(forked.status, 201, forked.text);
  assert.deepEqual((await r.call(`/v1/agents/${forked.json.id}/history`)).json.messages, imported);
  await noCharge(forked.json.id);

  const reset = await r.call(`/v1/agents/${id}/context/reset`, { body: { keepMessages: 4 } });
  assert.equal(reset.status, 200, reset.text);
  await noCharge(id);
  assert.deepEqual((await r.call(`/v1/agents/${id}/history`)).json.messages, imported);

  await r.prompt(id, "A new question");
  await r.call("/v1/usage");
  assert.equal(r.model.bodies.length, 1);
  const totals = (await r.call("/v1/usage")).json.totals;
  assert.equal(Number(totals.responses), 1);
  assert.equal(Number(totals.cost), 0.01);
  assert.equal((await r.call(`/v1/agents/${id}`)).json.spendLimit.spent, 0.01);
  await until(() => delivered.filter(event => event.type === "usage.recorded" && event.data?.agentId === id).length === 1, "the real response's usage event");
});

