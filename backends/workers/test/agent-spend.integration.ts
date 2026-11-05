import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { Agents } from "../../../clients/agents.ts";
import { startFixture } from "./fixture.ts";

test("agent-wide spend survives runs and restart; explicit assignments reset and null clears", { timeout: 120_000 }, async t => {
  const server = createServer(async (request, response) => {
    for await (const _part of request) {}
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (chunk: unknown) => response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    const base = { id: "budget-model", object: "chat.completion.chunk", created: 1, model: "budget-model" };
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Budgeted reply" }, finish_reason: null }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 } });
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const fixture = await startFixture({ vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini" } });
  t.after(() => fixture.stop());
  const agents = new Agents({ url: fixture.url, apiKey: fixture.token, connection: "lazy", pollMs: 10 });
  t.after(() => agents.close());
  const provider = await fetch(`${fixture.url}/v1/providers/budget-fixture`, {
    method: "PUT", headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "openai-completions", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, models: [{ id: "budget-model", contextWindow: 32768, pricing: { input: 1000, output: 0 } }] }),
  });
  assert.equal(provider.status, 200);
  const agent = await agents.upsert("cumulative-spend", { model: "budget-fixture/budget-model", codeMode: false, fileTools: false, spendLimit: { usd: 0.01 } });
  const request = async (path = "", body?: unknown, method = body === undefined ? "GET" : "PATCH") => {
    const response = await fetch(`${fixture.url}/v1/agents/${agent.id}${path}`, {
      method, headers: { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() as any };
  };
  assert.deepEqual((await request()).value.spendLimit, { usd: 0.01, spent: 0 });
  assert.equal((await agent.run("first", { timeoutMs: 15_000 })).status, "completed");
  assert.deepEqual((await request()).value.spendLimit, { usd: 0.01, spent: 0.007 });
  assert.equal((await request("/configuration", { temperature: 0.2 })).status, 202);
  assert.deepEqual((await request()).value.spendLimit, { usd: 0.01, spent: 0.007 }, "an unrelated update preserves the counter");
  await fixture.worker.stop(true);
  await fixture.worker.start();
  assert.equal((await agent.run("second", { timeoutMs: 15_000 })).status, "completed");
  assert.deepEqual((await request()).value.spendLimit, { usd: 0.01, spent: 0.014 });
  const refused = await request("/prompt", { text: "third" }, "POST");
  assert.equal(refused.status, 402);
  assert.match(refused.value.error, /This agent has reached its spend limit/);
  assert.equal((await request("/configuration", { spendLimit: { usd: 0.01 } })).status, 202);
  assert.deepEqual((await request()).value.spendLimit, { usd: 0.01, spent: 0 });
  assert.equal((await agent.run("new budget", { timeoutMs: 15_000 })).status, "completed");
  assert.equal((await request("/configuration", { spendLimit: null })).status, 202);
  assert.equal((await request()).value.spendLimit, null);
  assert.equal((await agent.run("unlimited", { timeoutMs: 15_000 })).status, "completed");
});
