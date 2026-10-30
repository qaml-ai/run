import { test } from "node:test";
import assert from "node:assert/strict";
import { configuredModel, defaultModels } from "../src/model.ts";
import { anthropic, gateway } from "./provider-fixtures.ts";
import { OPERATOR, OTHER_OPERATOR, runtime } from "./runtime-server.ts";
import { createHash } from "node:crypto";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
// As production: DeepSeek V4.1 Flash on OpenRouter heads the list, and no AGENT_BASE_URL.
const FLAGSHIP = "openrouter/deepseek/deepseek-v4.1-flash-1017";
const PRODUCTION = { ...LOCAL, AGENT_PROVIDER: "openrouter", AGENT_MODEL: "deepseek/deepseek-v4.1-flash-1017", AGENT_BASE_URL: "" };
const NOBODY = "nobody-operator-token-at-least-24-chars";

test("the default is DeepSeek V4.1 Flash 1017 on OpenRouter, without :nitro; a runtime that names any part of its model keeps what that named", () => {
  const reference = (env: NodeJS.ProcessEnv) => { const model = configuredModel(env); return `${model.provider}/${model.id}`; };
  assert.equal(reference({}), FLAGSHIP);
  assert.equal(reference({ AGENT_PROVIDER: "openrouter" }), FLAGSHIP);
  assert.equal(reference({ AGENT_PROVIDER: "anthropic" }), "anthropic/claude-sonnet-5-5");
  assert.equal(reference({ AGENT_MODEL: "claude-sonnet-5" }), "anthropic/claude-sonnet-5");
  assert.equal(reference({ AGENT_BASE_URL: "https://llm.example.com" }), "anthropic/claude-sonnet-5-5");
  assert.equal(reference({ AGENT_PROVIDER: "anthropic", AGENT_MODEL: "claude-sonnet-5-5" }), "anthropic/claude-sonnet-5-5");
  assert.equal(configuredModel({ AGENT_BASE_URL: "https://llm.example.com" }).baseUrl, "https://llm.example.com");
});

test("the default models are AGENT_MODEL, then DeepSeek on Azure and Sonnet 5.5 for a tenant without its key, or AGENT_MODEL_FALLBACKS", () => {
  const head = configuredModel({});
  assert.deepEqual(defaultModels(head, undefined).map(model => `${model.provider}/${model.id}`), [
    FLAGSHIP, "azure/deepseek-v4.1-flash", "anthropic/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5", "amazon-bedrock/global.anthropic.claude-sonnet-5-5",
  ]);
  const other = { provider: "openrouter", id: "openai/gpt-4o-mini" } as never;
  assert.deepEqual(defaultModels(other, " anthropic/claude-sonnet-5-5 , openrouter/openai/gpt-4o-mini").map(model => `${model.provider}/${model.id}`), [
    "openrouter/openai/gpt-4o-mini", "anthropic/claude-sonnet-5-5",
  ], "the head stays first, once");
  assert.equal(defaultModels(other, "").length, 1, "no fallbacks");
  assert.throws(() => defaultModels(other, "nope/unknown-model"), /AGENT_MODEL_FALLBACKS/);
});

test("an agent that names no model gets the first default its tenant or key scope has a key for, and /v1/me says which", async t => {
  const provider = await gateway(t, () => anthropic([{ type: "text", text: "Via Anthropic." }], "end_turn"));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), PRODUCTION, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { anthropic: "fixture-model-key", openrouter: "fixture-model-key" } },
    carol: { tokenSha256: sha(NOBODY) },
  } });
  const model = async (agent: string, token?: string) => (await r.call(`/v1/agents/${agent}`, { token })).json.model;

  // OpenRouter's key: the head.
  assert.equal((await r.call("/v1/me")).json.defaultModel, FLAGSHIP);
  const agent = (await r.call("/v1/agents", { body: {} })).json.id;
  assert.equal(await model(agent), FLAGSHIP);
  // Both keys: the head.
  assert.equal((await r.call("/v1/me", { token: OTHER_OPERATOR })).json.defaultModel, FLAGSHIP);
  assert.equal(await model((await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR })).json.id, OTHER_OPERATOR), FLAGSHIP);
  // No keys at all: the head, which an agent is made on all the same.
  assert.equal((await r.call("/v1/me", { token: NOBODY })).json.defaultModel, FLAGSHIP);
  assert.equal(await model((await r.call("/v1/agents", { body: {}, token: NOBODY })).json.id, NOBODY), FLAGSHIP);

  // A key scope's own providers count too: a tenant with no keys runs the default through its scope's.
  await r.call("/v1/key-scopes/hosted/providers/anthropic", { method: "PUT", token: NOBODY, body: { apiKey: "sk-ant", baseUrl: `${provider.url}/anthropic` } });
  const scoped = (await r.call("/v1/agents", { body: { keyScope: "hosted" }, token: NOBODY })).json.id;
  assert.equal(await model(scoped, NOBODY), "anthropic/claude-sonnet-5-5");
  assert.equal((await r.prompt(scoped, "Hi", NOBODY)).outcome.result.reply, "Via Anthropic.");
  // A named model is the agent's, whatever else the tenant has keys for.
  assert.equal(await model((await r.call("/v1/agents", { body: { model: "openrouter/anthropic/claude-sonnet-5.5" }, token: OTHER_OPERATOR })).json.id, OTHER_OPERATOR), "openrouter/anthropic/claude-sonnet-5.5");
});

test("a tenant's own key comes before the platform's: only an Anthropic key is Sonnet 5.5 on it, never DeepSeek on the platform's credit", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), PRODUCTION, { tenants: {
    byok: { tokenSha256: sha(OPERATOR), apiKeys: { anthropic: "fixture-model-key" } },
    bedrock: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { "amazon-bedrock": "fixture-model-key" } },
    platform: { tokenSha256: sha(NOBODY) },
  }, platformKeys: { openrouter: "fixture-platform-key" } });
  assert.equal((await r.call("/v1/me")).json.defaultModel, "anthropic/claude-sonnet-5-5");
  assert.equal((await r.call("/v1/me", { token: OTHER_OPERATOR })).json.defaultModel, "amazon-bedrock/global.anthropic.claude-sonnet-5-5");
  assert.equal((await r.call("/v1/me", { token: NOBODY })).json.defaultModel, FLAGSHIP, "the platform's key serves the head");
  // A key scope's key counts as the tenant's own: its customer's key, not the platform's.
  await r.call("/v1/key-scopes/customer/providers/anthropic", { method: "PUT", token: NOBODY, body: { apiKey: "sk-ant" } });
  assert.equal((await r.call(`/v1/agents/${(await r.call("/v1/agents", { body: { keyScope: "customer" }, token: NOBODY })).json.id}`, { token: NOBODY })).json.model, "anthropic/claude-sonnet-5-5");
});

test("the default is for agents being made: an upsert or a definition applied that names no model leaves an existing agent's", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), PRODUCTION, { tenants: { alice: { tokenSha256: sha(OPERATOR), apiKeys: { anthropic: "fixture-model-key", openrouter: "fixture-model-key" } } } });
  const SONNET = "anthropic/claude-sonnet-5-5";
  const model = async (agent: string) => (await r.call(`/v1/agents/${agent}`)).json.model;
  const applied = async (agent: string, request: string) => {
    for (const started = Date.now(); Date.now() - started < 10_000; await new Promise(resolve => setTimeout(resolve, 50))) if ((await r.call(`/v1/agents/${agent}/requests/${request}`)).json.state === "completed") return;
    assert.fail("the request did not complete");
  };

  // Made on Sonnet 5.5, as an agent made before the default changed was.
  const made = (await r.call("/v1/agents", { body: { model: SONNET, name: "one" }, headers: { "Idempotency-Key": "keep" } })).json;
  const again = (await r.call("/v1/agents", { body: { name: "two" }, headers: { "Idempotency-Key": "keep" } })).json;
  assert.equal(again.id, made.id);
  await applied(made.id, again.reconfigured.id);
  assert.equal((await r.call(`/v1/agents/${made.id}`)).json.name, "two", "the rest of the upsert applied");
  assert.equal(await model(made.id), SONNET);
  // An upsert naming another model is still that model's.
  const named = (await r.call("/v1/agents", { body: { model: FLAGSHIP, name: "two" }, headers: { "Idempotency-Key": "keep" } })).json;
  await applied(made.id, named.reconfigured.id);
  assert.equal(await model(made.id), FLAGSHIP);

  // A definition with no model: its agents keep theirs through an apply, and through their upserts.
  const definition = (await r.call("/v1/definitions", { body: { name: "No model", systemPrompt: "v1" } })).json;
  const fromDefinition = (await r.call("/v1/agents", { body: { definition: definition.id }, headers: { "Idempotency-Key": "from-definition" } })).json.id;
  await r.call(`/v1/agents/${fromDefinition}/configuration`, { method: "PATCH", body: { model: SONNET } });
  const patched = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "v2", apply: "all" } });
  assert.equal(patched.status, 200);
  const upserted = (await r.call("/v1/agents", { body: { definition: definition.id }, headers: { "Idempotency-Key": "from-definition" } })).json;
  if (upserted.reconfigured) await applied(fromDefinition, upserted.reconfigured.id);
  assert.equal(await model(fromDefinition), SONNET);
  // A new agent of it gets the default.
  assert.equal(await model((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id), FLAGSHIP);
});
