import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultModels } from "../src/model.ts";
import { anthropic, gateway } from "./provider-fixtures.ts";
import { OPERATOR, OTHER_OPERATOR, runtime } from "./runtime-server.ts";
import { createHash } from "node:crypto";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
// As production: Claude Sonnet 5.5 on Anthropic heads the list, and no AGENT_BASE_URL.
const PRODUCTION = { ...LOCAL, AGENT_PROVIDER: "anthropic", AGENT_MODEL: "claude-sonnet-5-5", AGENT_BASE_URL: "" };
const NOBODY = "nobody-operator-token-at-least-24-chars";

test("the default models are AGENT_MODEL, then the same model on other providers, or AGENT_MODEL_FALLBACKS", () => {
  const head = { provider: "anthropic", id: "claude-sonnet-5-5" } as never;
  assert.deepEqual(defaultModels(head, undefined).map(model => `${model.provider}/${model.id}`), [
    "anthropic/claude-sonnet-5-5", "openrouter/anthropic/claude-sonnet-5.5", "amazon-bedrock/global.anthropic.claude-sonnet-5-5", "openrouter/openai/gpt-6-luna",
  ]);
  const other = { provider: "openrouter", id: "openai/gpt-4o-mini" } as never;
  assert.deepEqual(defaultModels(other, " anthropic/claude-sonnet-5-5 , openrouter/openai/gpt-4o-mini").map(model => `${model.provider}/${model.id}`), [
    "openrouter/openai/gpt-4o-mini", "anthropic/claude-sonnet-5-5",
  ], "the head stays first, once");
  assert.equal(defaultModels(other, "").length, 1, "no fallbacks");
  assert.throws(() => defaultModels(other, "nope/unknown-model"), /AGENT_MODEL_FALLBACKS/);
});

test("an agent that names no model gets the first default its tenant or key scope has a key for, and /v1/me says which", async t => {
  const provider = await gateway(t, () => anthropic([{ type: "text", text: "Via OpenRouter." }], "end_turn"));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), PRODUCTION, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" } },
    bob: { tokenSha256: sha(OTHER_OPERATOR), apiKeys: { anthropic: "fixture-model-key", openrouter: "fixture-model-key" } },
    carol: { tokenSha256: sha(NOBODY) },
  } });
  const model = async (agent: string, token?: string) => (await r.call(`/v1/agents/${agent}`, { token })).json.model;

  // OpenRouter only: Sonnet 5.5 there.
  assert.equal((await r.call("/v1/me")).json.defaultModel, "openrouter/anthropic/claude-sonnet-5.5");
  const agent = (await r.call("/v1/agents", { body: {} })).json.id;
  assert.equal(await model(agent), "openrouter/anthropic/claude-sonnet-5.5");
  // Both keys: the head.
  assert.equal((await r.call("/v1/me", { token: OTHER_OPERATOR })).json.defaultModel, "anthropic/claude-sonnet-5-5");
  assert.equal(await model((await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR })).json.id, OTHER_OPERATOR), "anthropic/claude-sonnet-5-5");
  // No keys at all: the head, which an agent is made on all the same.
  assert.equal((await r.call("/v1/me", { token: NOBODY })).json.defaultModel, "anthropic/claude-sonnet-5-5");
  assert.equal(await model((await r.call("/v1/agents", { body: {}, token: NOBODY })).json.id, NOBODY), "anthropic/claude-sonnet-5-5");

  // A key scope's own providers count too: a tenant with no keys runs the default through its scope's.
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", token: NOBODY, body: { apiKey: "sk-or", baseUrl: `${provider.url}/openrouter` } });
  const scoped = (await r.call("/v1/agents", { body: { keyScope: "hosted" }, token: NOBODY })).json.id;
  assert.equal(await model(scoped, NOBODY), "openrouter/anthropic/claude-sonnet-5.5");
  assert.equal((await r.prompt(scoped, "Hi", NOBODY)).outcome.result.reply, "Via OpenRouter.");
  // A named model is the agent's, whatever else the tenant has keys for.
  assert.equal(await model((await r.call("/v1/agents", { body: { model: "openrouter/anthropic/claude-sonnet-5.5" }, token: OTHER_OPERATOR })).json.id, OTHER_OPERATOR), "openrouter/anthropic/claude-sonnet-5.5");
});
