import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeModel, runtime } from "./runtime-server.ts";
import { anthropic, converse, gateway, responses } from "./provider-fixtures.ts";

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

test("a scope's baseUrl replaces the provider's root, a keyless entry sends only its gateway's headers, and an agent's modelHeaders come after them", async t => {
  const aiGateway = await gateway(t, body => body.model.startsWith("anthropic/")
    ? anthropic([{ type: "text", text: "Messages API." }], "end_turn")
    : responses([{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Responses API.", annotations: [] }] }]));
  const r = await runtime(t, reply("unused"));
  const put = await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { baseUrl: `${aiGateway.url}/openrouter`, headers: { "cf-aig-authorization": "Bearer gateway-token", "cf-aig-metadata": "scope" } } });
  assert.equal(put.status, 200, put.text);
  assert.equal(put.json.providers[0].last4, undefined);
  assert.equal((await r.call("/v1/key-scopes/hosted/providers/anthropic", { method: "PUT", body: {} })).status, 400, "a keyless entry needs a gateway");

  for (const modelHeaders of [{ Authorization: "Bearer x" }, { "cf-aig-authorization": "x" }, { "x-amz-date": "x" }]) {
    assert.equal((await r.call("/v1/agents", { body: { keyScope: "hosted", modelHeaders } })).status, 400, JSON.stringify(modelHeaders));
  }
  // OpenRouter's Anthropic models speak its Messages API, at <root>/messages; its others its Responses API, at <root>/responses.
  const claude = await r.call("/v1/agents", { body: { model: "openrouter/anthropic/claude-sonnet-4.5", keyScope: "hosted", modelHeaders: { "cf-aig-metadata": "thread-1" } } });
  assert.equal(claude.status, 201, claude.text);
  const gpt = (await r.call("/v1/agents", { body: { model: "openrouter/openai/gpt-6-luna", keyScope: "hosted", modelHeaders: { "cf-aig-metadata": "thread-9", "x-thread": "9" } } })).json.id;
  assert.equal((await r.prompt(claude.json.id, "Hi")).outcome.result.reply, "Messages API.");
  assert.equal((await r.prompt(gpt, "Hi")).outcome.result.reply, "Responses API.");
  const [messages, completions] = aiGateway.requests;
  assert.equal(messages.path, "/agent-runtime/llm/openrouter/messages?beta=true");
  assert.equal(completions.path, "/agent-runtime/llm/openrouter/responses");
  assert.equal(completions.body.model, "openai/gpt-6-luna");
  assert.equal(completions.headers["x-thread"], "9");
  for (const { headers } of [messages, completions]) {
    assert.ok(!headers.authorization && !headers["x-api-key"], "no provider key is sent");
    assert.equal(headers["cf-aig-authorization"], "Bearer gateway-token");
  }
  assert.deepEqual([messages.headers["cf-aig-metadata"], completions.headers["cf-aig-metadata"]], ["thread-1", "thread-9"]);
  assert.deepEqual((await r.call(`/v1/agents/${claude.json.id}`)).json.modelHeaders, { "cf-aig-metadata": "thread-1" });

  // PATCH replaces them whole, and null removes them; the agent's own token cannot.
  assert.equal((await r.call(`/v1/agents/${claude.json.id}/configuration`, { method: "PATCH", body: { modelHeaders: { "x-api-key": "k" } } })).status, 400);
  assert.equal((await r.call(`/clients/${claude.json.id}/requests`, { token: claude.json.token, body: { id: "self", method: "configure", params: { modelHeaders: { "cf-aig-metadata": "forged" } } } })).status, 403);
  await r.call(`/v1/agents/${claude.json.id}/configuration`, { method: "PATCH", body: { modelHeaders: { "cf-aig-metadata": "thread-2" } } });
  await r.prompt(claude.json.id, "Again");
  assert.equal(aiGateway.requests.at(-1)!.headers["cf-aig-metadata"], "thread-2");
  await r.call(`/v1/agents/${claude.json.id}/configuration`, { method: "PATCH", body: { modelHeaders: null } });
  await r.prompt(claude.json.id, "Once more");
  assert.equal(aiGateway.requests.at(-1)!.headers["cf-aig-metadata"], "scope");
  assert.equal((await r.call(`/v1/agents/${claude.json.id}`)).json.modelHeaders, null);
});

test("Bedrock's region comes from the entry or its regional endpoint", async t => {
  const r = await runtime(t, reply("unused"));
  const put = (body: object) => r.call("/v1/key-scopes/org_3/providers/amazon-bedrock", { method: "PUT", body });
  const set = await put({ apiKey: "bedrock-key", baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com" });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.providers[0].region, "eu-west-1");
  assert.equal((await put({ apiKey: "bedrock-key", baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com", region: "us-east-1" })).status, 400);
  assert.equal((await put({ apiKey: "bedrock-key" })).status, 400, "a region is needed");
  assert.equal((await put({ baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com" })).status, 400, "Bedrock needs its key");
});
