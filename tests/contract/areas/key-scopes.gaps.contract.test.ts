import {portedTest} from '../ported.ts';
const test = portedTest("keys", "tests/key-scopes.test.ts");
import assert from 'node:assert/strict';
import {fakeModel,runtime,until} from '../support.ts';
import {anthropic,converse,gateway,responses} from '../../provider-fixtures.ts';

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

const reply = (text: string) => () => ({ role: "assistant", content: text, usage: { prompt_tokens: 10, completion_tokens: 2 } });

test("a scope's model provider need not be the tenant's: an agent may be created on it, and Bedrock takes its key as a bearer token", async t => {
  const bedrock = await gateway(t, () => converse([
    ["messageStart", { role: "assistant" }],
    ["contentBlockDelta", { contentBlockIndex: 0, delta: { text: "From Bedrock." } }],
    ["contentBlockStop", { contentBlockIndex: 0 }],
    ["messageStop", { stopReason: "end_turn" }],
    ["metadata", { usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }, metrics: { latencyMs: 5 } }],
  ]));
  const r = await runtime(t, reply("unused"), LOCAL);
  const model = "amazon-bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0";
  // No Bedrock key anywhere yet: the agent is made, and its run says where to set one.
  const early = await r.call("/v1/agents", { body: { model, keyScope: "org_2" } });
  assert.equal(early.status, 201, early.text);
  const accepted = await r.call(`/v1/agents/${early.json.id}/prompt`, { body: { text: "Hi" } });
  const failed = await until(async () => { const got = (await r.call(`/v1/agents/${early.json.id}/requests/${accepted.json.id}`)).json; return got.state === "completed" && got; }, "the run to fail");
  assert.match(failed.error, /No amazon-bedrock API key is configured for key scope org_2.*PUT \/v1\/key-scopes\/org_2\/providers\/amazon-bedrock/);
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
  const r = await runtime(t, reply("unused"), LOCAL);
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
  const r = await runtime(t, reply("unused"), LOCAL);
  const put = (body: object) => r.call("/v1/key-scopes/org_3/providers/amazon-bedrock", { method: "PUT", body });
  const set = await put({ apiKey: "bedrock-key", baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com" });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.json.providers[0].region, "eu-west-1");
  assert.equal((await put({ apiKey: "bedrock-key", baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com", region: "us-east-1" })).status, 400);
  assert.equal((await put({ apiKey: "bedrock-key" })).status, 400, "a region is needed");
  assert.equal((await put({ baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com" })).status, 400, "Bedrock needs its key");
});

test("a scope's baseUrl is a public address the runtime may call, checked when saved and at every call", async t => {
  const gateway = await fakeModel(t, reply("gateway"));
  const put = (r: Awaited<ReturnType<typeof runtime>>, baseUrl: string) => r.call("/v1/key-scopes/org_1/providers/openrouter", { method: "PUT", body: { apiKey: "k", baseUrl } });
  // Plain http, a loopback or private address: refused unless the operator allows them (as for MCP servers and web_fetch).
  const strict = await runtime(t, reply("unused"));
  for (const baseUrl of [gateway.url, "https://127.0.0.1:9/v1", "https://10.0.0.5/v1", "https://169.254.169.254/latest"]) {
    const refused = await put(strict, baseUrl);
    assert.equal(refused.status, 400, baseUrl);
  }
  const http = await runtime(t, reply("unused"), { AGENT_OUTBOUND_ALLOW_HTTP: "true" });
  assert.match((await put(http, gateway.url)).json.error, /127\.0\.0\.1/, "http is allowed there, the loopback address still is not");
  // Allowed, the call goes through the same guard from the agent's process.
  const allowed = await runtime(t, reply("tenant key"), LOCAL);
  assert.equal((await put(allowed, gateway.url)).status, 200);
  const agent = (await allowed.call("/v1/agents", { body: { keyScope: "org_1" } })).json.id;
  assert.equal((await allowed.prompt(agent, "Hi")).outcome.result.reply, "gateway");
});
