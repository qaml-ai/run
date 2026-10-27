import { test } from "node:test";
import assert from "node:assert/strict";
import { listModels } from "../src/catalog.ts";
import { getModel, getModels, reasoningFloor } from "../src/pi-catalog.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { resolveModel } from "../src/session-config.ts";
import { fakeModel, runtime } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const FLASH_1017 = "deepseek/deepseek-v4.1-flash-1017";

test("GPT-6.1 Terra is listed on OpenAI, Azure and OpenRouter with Sol's capabilities and window", () => {
  for (const provider of ["openai", "azure", "openrouter"]) {
    const prefix = provider === "openrouter" ? "openai/" : "";
    const id = `${prefix}gpt-6.1-terra`;
    const sol = getModel(provider, `${prefix}gpt-6.1-sol`)!;
    const model = getModel(provider, id)!;
    assert.equal(getModels(provider).filter(entry => entry.id === id).length, 1);
    assert.equal(model.name, `${provider === "openrouter" ? "OpenAI: " : ""}GPT-6.1 Terra`);
    assert.equal(model.contextWindow, sol.contextWindow, "the window the provider grants Sol, not a larger one it refuses at");
    assert.equal(model.maxTokens, 128_000);
    assert.deepEqual([model.api, model.baseUrl, model.reasoning, model.input, model.thinkingLevelMap, model.compat, model.inputLimits],
      [sol.api, sol.baseUrl, true, sol.input, sol.thinkingLevelMap, sol.compat, sol.inputLimits]);
    assert.equal(reasoningFloor(model), "low");
    const info = listModels(provider).find(entry => entry.id === `${provider}/${id}`)!;
    assert.deepEqual([info.api, info.contextWindow, info.toolCallStreaming],
      [provider === "azure" ? "azure-openai-responses" : "openai-responses", sol.contextWindow, "unknown"]);
    const resolved = resolveModel(`${provider}/${id}`);
    assert.equal(resolved.id, id);
    assert.equal(resolved.api, info.api);
  }
});

test("DeepSeek V4.1 Flash 1017 is Pi's OpenRouter entry at its own id, name and list price", () => {
  const base = getModel("openrouter", "deepseek/deepseek-v4.1-flash")!;
  const model = getModel("openrouter", FLASH_1017)!;
  assert.equal(model.id, FLASH_1017);
  assert.equal(model.name, "DeepSeek: DeepSeek V4.1 Flash 1017");
  assert.deepEqual(model.cost, { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 });
  assert.equal(model.contextWindow, 1_048_576);
  assert.deepEqual([model.api, model.baseUrl, model.reasoning, model.input, model.maxTokens], [base.api, base.baseUrl, true, ["text", "image"], 131_072]);
  assert.deepEqual(model.thinkingLevelMap, base.thinkingLevelMap);
  assert.deepEqual(model.compat, base.compat);
  assert.equal((model.compat as { thinkingFormat?: string }).thinkingFormat, "openrouter");
  // It can reason not at all: a call asking for none gets none.
  assert.equal(reasoningFloor(model), undefined);
  // Listed once: pi-ai 1.4.0 ships it, so the runtime adds none of its own.
  assert.equal(getModels("openrouter").filter(entry => entry.id === FLASH_1017).length, 1);
});

test("GET /v1/models lists it, unmeasured for tool-call streaming, and a response on it costs its list price", () => {
  const info = listModels("openrouter").find(model => model.id === `openrouter/${FLASH_1017}`)!;
  assert.deepEqual([info.api, info.contextWindow, info.cost.input, info.cost.output, info.toolCallStreaming], ["openai-completions", 1_048_576, 0.15, 0.6, "unknown"]);
  const { usage, known } = platformUsage({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 } as never, "openrouter", FLASH_1017);
  assert.equal(known, true);
  assert.ok(Math.abs((usage as { cost: { total: number } }).cost.total - 0.753) < 1e-12);
  const resolved = resolveModel(`openrouter/${FLASH_1017}`);
  assert.deepEqual([resolved.id, resolved.api], [FLASH_1017, "openai-completions"]);
});

test("an agent on it calls OpenRouter's Chat Completions with the 1017 id and the reasoning it asks for", async t => {
  const model = await fakeModel(t, () => ({ role: "assistant", content: "Snapshot." }));
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), LOCAL);
  await r.call("/v1/key-scopes/hosted/providers/openrouter", { method: "PUT", body: { apiKey: "sk-or", baseUrl: model.url } });
  const agent = (await r.call("/v1/agents", { body: { model: `openrouter/${FLASH_1017}`, keyScope: "hosted", thinkingLevel: "high" } })).json.id;
  const done = await r.prompt(agent, "Hi");
  assert.equal(done.outcome.result.reply, "Snapshot.");
  const sent = model.bodies.at(-1)!;
  assert.ok(Array.isArray(sent.messages), "Chat Completions (deepseek-replay.ts)");
  assert.equal(sent.model, FLASH_1017);
  assert.equal(sent.reasoning?.effort, "high");
  assert.deepEqual(sent.provider, { only: ["morph", "deepseek", "together", "inference-net", "makora", "atlas-cloud"] }, "its hosts (pi-catalog.ts OPENROUTER_HOSTS), nothing else of routing");
  // No more than every host of its full context serves (DeepInfra's, Prime Intellect's and InferenceNet's 131,072).
  const most = sent.max_completion_tokens ?? sent.max_tokens;
  assert.ok(most <= 131_072, String(most));
});
