import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeModel, runtime } from "./runtime-server.ts";
import { converse, gateway } from "./provider-fixtures.ts";

const reply = (text: string) => () => ({ role: "assistant", content: text, usage: { prompt_tokens: 10, completion_tokens: 2 } });

test("key scopes store sealed entries, and an agent's calls use its scope's current key, gateway and headers, else the tenant's", async t => {
  // The default model (openrouter) answers with the tenant's admin key; the gateway stands in for an AI gateway in front of OpenRouter.
  const r = await runtime(t, reply("tenant key"));
  const aiGateway = await fakeModel(t, reply("scope key"));
  const put = (scope: string, provider: string, body: unknown) => r.call(`/v1/key-scopes/${scope}/providers/${provider}`, { method: "PUT", body });

  for (const [scope, provider, body] of [
    ["org_1", "openrouter", { apiKey: "" }],
    ["org_1", "openrouter", { apiKey: "k", baseUrl: "http://gateway.example.com" }],
    ["org_1", "openrouter", { apiKey: "k", region: "us-west-2" }],
    ["org_1", "openrouter", { apiKey: "k", headers: { "bad header": "x" } }],
    ["org_1", "no-such-provider", { apiKey: "k" }],
    ["bad scope!", "openrouter", { apiKey: "k" }],
  ] as const) assert.equal((await put(scope, provider, body)).status, 400, JSON.stringify([scope, provider, body]));

  // Created before its scope has a key: the tenant's.
  const { id: scoped, token } = (await r.call("/v1/agents", { body: { keyScope: "org_1" } })).json;
  const plain = (await r.call("/v1/agents", { body: {} })).json.id;
  assert.equal((await r.call(`/v1/agents/${scoped}`)).json.keyScope, "org_1");
  assert.equal((await r.call(`/v1/agents/${plain}`)).json.keyScope, null);
  assert.equal((await r.prompt(scoped, "Hi")).outcome.result.reply, "tenant key");

  const set = await put("org_1", "openrouter", { apiKey: "sk-or-org1-aaaa", baseUrl: `${aiGateway.url}/`, headers: { "cf-aig-authorization": "Bearer gateway-secret" } });
  assert.equal(set.status, 200, set.text);
  const shown = await r.call("/v1/key-scopes/org_1");
  assert.deepEqual(shown.json.providers.map(({ setAt: _at, ...entry }: any) => entry), [{ provider: "openrouter", last4: "aaaa", baseUrl: aiGateway.url, headers: ["cf-aig-authorization"] }]);
  for (const text of [set.text, shown.text]) assert.ok(!text.includes("sk-or-org1") && !text.includes("gateway-secret"), "secrets are never returned");

  // The running agent's next call takes the scope's key, at the gateway, with its headers; other agents keep the tenant's.
  assert.equal((await r.prompt(scoped, "Hi again")).outcome.result.reply, "scope key");
  assert.equal(aiGateway.keys.at(-1), "Bearer sk-or-org1-aaaa");
  assert.equal(aiGateway.headers.at(-1)!["cf-aig-authorization"], "Bearer gateway-secret");
  assert.equal((await r.prompt(plain, "Hi")).outcome.result.reply, "tenant key");
  assert.equal(r.model.keys.at(-1), "Bearer fixture-model-key");

  // Rotation reaches the same agent at its next call, without a restart.
  await put("org_1", "openrouter", { apiKey: "sk-or-org1-bbbb", baseUrl: aiGateway.url, headers: { "cf-aig-authorization": "Bearer gateway-secret" } });
  await r.prompt(scoped, "And again");
  assert.equal(aiGateway.keys.at(-1), "Bearer sk-or-org1-bbbb");

  // An agent moved into the scope, and back out: only the tenant can move it.
  const moved = await r.call(`/v1/agents/${plain}/configuration`, { method: "PATCH", body: { keyScope: "org_1" } });
  assert.equal(moved.status, 202, moved.text);
  assert.equal((await r.prompt(plain, "Moved")).outcome.result.reply, "scope key");
  await r.call(`/v1/agents/${plain}/configuration`, { method: "PATCH", body: { keyScope: null } });
  assert.equal((await r.prompt(plain, "Back")).outcome.result.reply, "tenant key");
  const own = await r.call(`/clients/${scoped}/requests`, { token, body: { id: "self-scope", method: "configure", params: { keyScope: "org_2" } } });
  assert.equal(own.status, 403, "an agent cannot choose its own keys");

  // Deleting the entry falls back to the tenant's key; deleting the scope leaves nothing.
  assert.equal((await r.call("/v1/key-scopes/org_1/providers/openrouter", { method: "DELETE" })).status, 200);
  assert.equal((await r.call("/v1/key-scopes/org_1/providers/openrouter", { method: "DELETE" })).status, 404);
  assert.equal((await r.prompt(scoped, "Fallback")).outcome.result.reply, "tenant key");
  await put("org_1", "anthropic", { apiKey: "sk-ant-1234" });
  assert.equal((await r.call("/v1/key-scopes/org_1", { method: "DELETE" })).status, 200);
  assert.deepEqual((await r.call("/v1/key-scopes/org_1")).json, { scope: "org_1", providers: [] });

  // Scope calls are the tenant's own keys: counted in /v1/usage, and not as platform responses, as the four on the admin's key are.
  const usage = (await r.call("/v1/usage")).json;
  assert.deepEqual([usage.totals.responses, usage.totals.platformResponses], [7, 4], JSON.stringify(usage.totals));
});

test("a scope's model provider need not be the tenant's: an agent may be created on it, and Bedrock takes its key as a bearer token", async t => {
  const bedrock = await gateway(t, () => converse([
    ["messageStart", { role: "assistant" }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "From Bedrock." } }],
    ["contentBlockStop", { contentBlockIndex: 0 }],
    ["messageStop", { stopReason: "end_turn" }],
    ["metadata", { usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }, metrics: { latencyMs: 5 } }],
  ]));
  const r = await runtime(t, reply("unused"));
  const model = "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
  assert.equal((await r.call("/v1/agents", { body: { model, keyScope: "org_2" } })).status, 400, "no Bedrock key anywhere yet");
  const set = await r.call("/v1/key-scopes/org_2/providers/amazon-bedrock", { method: "PUT", body: { apiKey: "bedrock-api-key-wxyz", baseUrl: bedrock.url, region: "us-west-2" } });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.providers[0].region, "us-west-2");
  const created = await r.call("/v1/agents", { body: { model, keyScope: "org_2" } });
  assert.equal(created.status, 201, created.text);
  assert.equal((await r.prompt(created.json.id, "Hi")).outcome.result.reply, "From Bedrock.");
  const [request] = bedrock.requests;
  assert.equal(request.path, "/agent-runtime/llm/model/us.anthropic.claude-haiku-4-5-20251001-v1%3A0/converse-stream");
  assert.equal(request.headers.authorization, "Bearer bedrock-api-key-wxyz", "a bearer token, not SigV4");
  assert.ok(!request.headers["x-amz-date"]);
});
