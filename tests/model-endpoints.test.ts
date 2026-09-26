import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { Tenants } from "../src/tenants.ts";
import { fakeModel, OPERATOR, OTHER_OPERATOR, runtime, toolCall, toolResults, until } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

test("a tenant's own endpoint serves its agents' models, called with identity tokens and at no token cost", async t => {
  // The tenant's inference proxy: an OpenAI-compatible endpoint that answers with reasoning, a tool call, then text.
  const endpoint = await fakeModel(t, (_body, index) => [
    { reasoning_content: "Adding in code.", ...toolCall("js_exec", { code: "return 1 + 1;" }) },
    { content: "It is 2.", usage: { prompt_tokens: 1000, completion_tokens: 10 } },
  ][index] ?? { content: "ok" });
  const r = await runtime(t, () => ({ role: "assistant", content: "platform model" }), {}, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, modelEndpoints: { chiridion: { baseUrl: endpoint.url, models: { "free/tiny": { contextWindow: 32_000, maxTokens: 4_000 } } } } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
  } });
  const models = (await r.call("/v1/models?provider=chiridion")).json;
  assert.deepEqual(models.map((model: any) => [model.id, model.contextWindow, model.available, model.cost.input]), [["chiridion/free/tiny", 32_000, true, 0]]);

  for (const model of ["chiridion/unknown-model", "chiridion/"]) assert.equal((await r.call("/v1/agents", { body: { model } })).status, 400, model);
  assert.equal((await r.call("/v1/agents", { token: OTHER_OPERATOR, body: { model: "chiridion/free/tiny" } })).status, 400, "another tenant's endpoint is unknown to bob");

  // A catalog model's id goes to the endpoint as it is, with the catalog's capabilities.
  const definition = (await r.call("/v1/definitions", { body: { name: "Camel", model: "chiridion/anthropic/claude-opus-5" } })).json;
  const created = await r.call("/v1/agents", { body: { definition: definition.id, subject: "u_1", context: { org: "org_9" } } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id;
  assert.equal((await r.call(`/v1/agents/${agent}`)).json.model, "chiridion/anthropic/claude-opus-5");
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "What is 1 + 1?", actor: "u_2" } });
  const record = await until(async () => { const record = (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json; return record.state === "completed" && record; }, "the turn");
  assert.equal(record.outcome.result.reply, "It is 2.");
  assert.equal(r.model.bodies.length, 0, "the platform's model is never called");
  assert.equal(endpoint.bodies.length, 2);
  assert.equal(endpoint.bodies[0].model, "anthropic/claude-opus-5");
  assert.equal(endpoint.bodies[0].stream, true);
  assert.match(toolResults(endpoint.bodies[1]).at(-1), /2/);
  assert.ok(JSON.stringify(endpoint.bodies[1].messages).includes("Adding in code."), "the reasoning came back with the tool call");

  // Each call has a token of its own, which the endpoint verifies against the runtime's keys.
  const keys = createLocalJWKSet((await r.call("/.well-known/jwks.json", { token: null })).json);
  const tokens = endpoint.keys.map(header => header.replace(/^Bearer /, ""));
  assert.equal(new Set(tokens).size, 2);
  for (const token of tokens) {
    const { payload } = await jwtVerify(token, keys, { issuer: "https://agents.example.test", audience: endpoint.url });
    assert.deepEqual([payload.tenant, payload.agent, payload.sub, payload.act, payload.ctx, payload.definition], ["alice", agent, "u_1", "u_2", { org: "org_9" }, definition.id]);
  }

  // Tokens were counted, and cost nothing.
  const usage = (await r.call("/v1/usage")).json;
  const row = usage.days.flatMap((day: any) => day.models ?? [day]).find((entry: any) => entry.model === "chiridion/anthropic/claude-opus-5");
  assert.ok(row, JSON.stringify(usage));
  assert.equal(row.input, 1000);
  assert.equal(row.cost, 0);
  assert.equal(row.platformCost, 0);
});

test("model endpoints are checked when the tenants file loads", async () => {
  const load = async (modelEndpoints: unknown) => {
    const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { alice: { tokenSha256: sha(OPERATOR), modelEndpoints } } }) });
    await tenants.reload();
    return tenants.modelEndpoints("alice");
  };
  const ok = { chiridion: { baseUrl: "https://camelai.example/v1", models: { "free/tiny": { contextWindow: 1000, maxTokens: 100, input: ["text", "image"] } } } };
  assert.deepEqual(await load(ok), ok);
  for (const endpoints of [
    { openai: { baseUrl: "https://camelai.example/v1" } }, { Bad: { baseUrl: "https://camelai.example/v1" } },
    { chiridion: { baseUrl: "http://camelai.example/v1" } }, { chiridion: { baseUrl: "https://user:pass@camelai.example/v1" } },
    { chiridion: { baseUrl: "https://camelai.example/v1", models: { x: { contextWindow: 0, maxTokens: 1 } } } },
    { chiridion: { baseUrl: "https://camelai.example/v1", models: { x: { contextWindow: 1, maxTokens: 1, input: ["audio"] } } } },
  ]) await assert.rejects(load(endpoints), /Tenant alice/, JSON.stringify(endpoints));
});
