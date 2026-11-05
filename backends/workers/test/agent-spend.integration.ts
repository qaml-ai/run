import assert from "node:assert/strict";
import test from "node:test";
import { Agents } from "../../../clients/agents.ts";
import { startFixture } from "./fixture.ts";

test("agent-wide spend survives runs and restart; explicit assignments reset and null clears", { timeout: 120_000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const agents = new Agents({ url: fixture.url, apiKey: fixture.token, connection: "lazy", pollMs: 10 });
  t.after(() => agents.close());
  const agent = await agents.upsert("cumulative-spend", { model: "test/echo", codeMode: false, fileTools: false, spendLimit: { usd: 0.01 } });
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
