import assert from "node:assert/strict";
import test from "node:test";
import { configuration } from "../src/api-contract.ts";
import { resolveModel, routeModel, modelHeadersInput, runLimitsInput } from "../src/model-policy.ts";
import { callSettings } from "../src/model-catalog.ts";
import { boundedModel } from "../src/model-context.ts";
import { importedHistory } from "../src/history-policy.ts";

test("configuration retains provider settings, imports history and rejects reserved headers", () => {
  const { config } = configuration({ maxOutputTokens: 300, temperature: 0.3, dataCollection: "deny", language: "pt-br", modelHeaders: { "cf-aig-metadata": "fixture" }, runLimits: { contextTokens: 24000, maxResponses: 3 }, importMessages: { format: "openai-chat", messages: [{ role: "user", content: "Remember Ada" }, { role: "assistant", content: "Hello" }] } }, "test/echo");
  assert.equal(config.language, "pt-BR");
  assert.equal(config.maxOutputTokens, 300);
  assert.equal(config.temperature, 0.3);
  assert.deepEqual(config.runLimits, { contextTokens: 24000, maxResponses: 3 });
  assert.deepEqual(importedHistory(config.initialMessages as never).messages.map(message => message.role), ["user", "assistant"]);
  assert.throws(() => modelHeadersInput({ Authorization: "secret" }), /runtime sets/);
  assert.throws(() => runLimitsInput({ contextTokens: 19999 }), /at least 20000/);
  assert.throws(() => configuration({ initialMessages: [{ role: "robot" }] }, "test/echo"), /INVALID_HISTORY/);
});
test("configuration keeps attached tools, normalizes delegation, and clears optional model settings", () => {
  const tool = { name: "sum", inputSchema: { type: "object", properties: { a: { type: "number" } } } };
  const { config } = configuration({ mcp: { tools: [tool] }, delegate: { agents: ["helper"], maxDepth: 3 }, temperature: null, maxOutputTokens: null }, "test/echo");
  assert.deepEqual(config.mcp?.tools, [tool]);
  assert.deepEqual(config.delegate?.agents, [{ name: "helper", definition: "helper" }]);
  assert.ok(config.builtins?.includes("delegate"));
  assert.equal(config.temperature, null);
});
test("OpenRouter pass-through and virtual routes use shared ECS policy", () => {
  const novel = resolveModel("openrouter/new-vendor/future-model");
  assert.equal(novel.id, "new-vendor/future-model");
  assert.equal(novel.api, "openai-responses");
  assert.equal(resolveModel("openrouter/anthropic/future-model").api, "anthropic-messages");
  const selection = resolveModel("camelrun/default");
  const first = routeModel(selection, { reason: "user" })!;
  const next = routeModel(selection, { reason: "retry", failed: { provider: first.provider, id: first.id } })!;
  assert.notEqual(first.id, next.id);
  assert.equal(routeModel(selection, { reason: "continuation", previous: { provider: next.provider, id: next.id } })?.id, next.id);
  assert.throws(() => resolveModel("unknown/model"), /Unknown model/);
  assert.deepEqual(callSettings({ ...novel, reasoning:false, maxTokens:1024 }, { maxOutputTokens:2048, temperature:0.3 }, "off"), {maxTokens:1024,temperature:0.3});
});

test("native Pi compaction sees the agent context cap without mutating the catalog", () => {
  const model = resolveModel("openrouter/new-vendor/future-model");
  assert.equal(boundedModel(model, 24000).contextWindow, 24000);
  assert.equal(boundedModel(model, model.contextWindow * 2).contextWindow, model.contextWindow);
  assert.equal(model.contextWindow, 128000);
});
