import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { fakeModel, toolCall, until } from "../../../tests/contract/http.ts";
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

test("lowering agent spend during a tool call refuses the next provider request", { timeout: 90_000 }, async t => {
  let toolStarted = false;
  const releaseTool = Promise.withResolvers<void>();
  const tools = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (!message.id) { response.writeHead(202).end(); return; }
    if (message.method === "tools/call") {
      toolStarted = true;
      await releaseTool.promise;
    }
    const result = message.method === "tools/list"
      ? { tools: [{ name: "wait", description: "Wait for the budget update", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "ready" }] };
    response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  tools.listen(0, "127.0.0.1");
  await once(tools, "listening");
  t.after(() => { releaseTool.resolve(); tools.closeAllConnections(); tools.close(); });
  const model = await fakeModel(t, (_body, index) => ({
    ...(index === 0 ? toolCall("budget__wait", {}) : { role: "assistant", content: "must not be billed" }),
    usage: { prompt_tokens: 7, completion_tokens: 0, total_tokens: 7 },
  }));
  const fixture = await startFixture({ vars: { TEST_MODEL: "0", MODEL: "openai/gpt-4o-mini" } });
  t.after(() => fixture.stop());
  const call = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(fixture.url + path, {
      method, headers: { authorization: `Bearer ${fixture.token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  await call("/v1/providers/budget-fixture", {
    type: "openai-completions", baseUrl: model.url,
    models: [{ id: "budget-model", contextWindow: 32768, pricing: { input: 1000, output: 0 } }],
  }, "PUT");
  const agent = await call("/v1/agents", {
    model: "budget-fixture/budget-model", codeMode: false, fileTools: false, spendLimit: { usd: 1 },
    mcpServers: [{ name: "budget", url: `http://127.0.0.1:${(tools.address() as { port: number }).port}/mcp` }],
  });
  const path = `/v1/agents/${agent.id}`;
  const accepted = await call(path + "/prompt", { text: "Call the tool, then reply", requestId: "mid-turn" });
  await until(() => toolStarted, "the first model response starts its tool");
  assert.deepEqual((await call(path)).spendLimit, { usd: 1, spent: 0.007 });
  // Explicit assignments reset the spend epoch. Zero is already exhausted in the new epoch.
  await call(path + "/configuration", { spendLimit: { usd: 0 } }, "PATCH");
  releaseTool.resolve();
  const completed = await until(async () => {
    const record = await call(`${path}/requests/${accepted.id}`);
    return record.state === "completed" && record;
  }, "the spend-limited run settles");
  assert.equal(completed.outcome.result.stopped, "spend_limit");
  assert.equal(completed.outcome.result.limit, "agent");
  assert.equal(completed.outcome.result.usage.responses, 1);
  assert.equal(completed.outcome.result.usage.costUsd, 0.007);
  assert.equal(model.bodies.length, 1);
  const { rows } = await fixture.db.query("select (totals->>'cost')::float8 as cost from model_attempts where agent=$1", [agent.id]);
  assert.deepEqual(rows, [{ cost: 0.007 }]);
});
