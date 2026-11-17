import assert from "node:assert/strict";
import { test } from "node:test";
import { readModelIdleCache, modelIdlePayload } from "../src/model-idle-compaction-payload.ts";
import { IDLE_SUMMARY_PROMPT as prompt, idleRequestOptions } from "../src/model-idle-compaction.ts";

const marker = { type: "ephemeral", ttl: "1h" };
const text = { type: "text", text: "Old transcript" };
const user = { role: "user", content: [text] };
const instruction = { role: "user", content: [{ type: "text", text: prompt }] };
const fixtures = [
  { api: "anthropic-messages", original: { model: "m", max_tokens: 9000, system: [{ type: "text", text: "System" }], messages: [{ ...user, content: [{ ...text, cache_control: marker }] }] },
    replay: { model: "m", max_tokens: 4096, system: [{ type: "text", text: "System" }], messages: [user, { ...instruction, content: [{ ...instruction.content[0], cache_control: marker }] }] }, ttl: 3_600_000 },
  ...["openai-completions", "openai-responses", "azure-openai-responses", "openai-codex-responses"].map(api => {
    const responses = api !== "openai-completions";
    const field = responses ? "input" : "messages";
    const part = { type: responses ? "input_text" : "text", text: "Old transcript" };
    const summary = { role: "user", content: [{ ...part, text: prompt }] };
    return { api, original: { model: "m", [field]: [{ role: "user", content: [part] }], [responses ? "max_output_tokens" : "max_tokens"]: 9000 },
      replay: { model: "m", [field]: [{ role: "user", content: [part] }, summary], [responses ? "max_output_tokens" : "max_tokens"]: 4096 }, ttl: 300_000 };
  }),
  ...["google-generative-ai", "google-vertex"].map(api => ({ api,
    original: { model: "m", contents: [{ role: "user", parts: [{ text: "Old transcript" }] }], config: { maxOutputTokens: 9000, systemInstruction: "System" } },
    replay: { model: "m", contents: [{ role: "user", parts: [{ text: "Old transcript" }] }, { role: "user", parts: [{ text: prompt }] }], config: { maxOutputTokens: 4096, systemInstruction: "System" } }, ttl: 300_000 })),
  { api: "bedrock-converse-stream", original: { modelId: "m", messages: [{ role: "user", content: [{ text: "Old transcript" }, { cachePoint: { type: "default", ttl: "1h" } }] }], inferenceConfig: { maxTokens: 9000 } },
    replay: { modelId: "m", messages: [{ role: "user", content: [{ text: "Old transcript" }] }, { role: "user", content: [{ text: prompt }, { cachePoint: { type: "default", ttl: "1h" } }] }], inferenceConfig: { maxTokens: 4096 } }, ttl: 3_600_000 },
  { api: "mistral-conversations", original: { model: "m", messages: [user], maxTokens: 9000, promptCacheKey: "session", reasoningEffort: "medium" },
    replay: { model: "m", messages: [user, instruction], maxTokens: 4096, promptCacheKey: "session", reasoningEffort: "medium" }, ttl: 300_000 },
  { api: "pi-messages", original: { model: "m", context: { messages: [{ ...user, timestamp: 1 }] }, options: { maxTokens: 9000, sessionId: "session", reasoning: "medium" } },
    replay: { model: "m", context: { messages: [{ ...user, timestamp: 1 }, { ...instruction, timestamp: 2 }] }, options: { maxTokens: 4096, sessionId: "session", reasoning: "medium" } }, ttl: 300_000 },
];

for (const fixture of fixtures) test(`${fixture.api} retains the exact old prefix and expiry`, () => {
  const before = structuredClone(fixture);
  const cache = readModelIdleCache(fixture.api, fixture.original);
  assert.ok(cache);
  assert.equal(cache.ttlMs, fixture.ttl);
  assert.ok(modelIdlePayload(fixture.api, fixture.replay, cache, prompt));
  assert.equal(modelIdlePayload(fixture.api, { ...fixture.replay, model: "drifted" }, cache, prompt), undefined);
  assert.deepEqual(fixture, before);
});

test("OpenRouter Anthropic cache marker remains before the summary", () => {
  const fixture = fixtures[0]!;
  const cache = readModelIdleCache(fixture.api, fixture.original)!;
  const replay = modelIdlePayload(fixture.api, fixture.replay, cache, prompt)!;
  assert.deepEqual(replay.messages, [{ role: "user", content: [{ ...text, cache_control: marker }, { type: "text", text: prompt }] }]);
});

test("cache guards reject changed routing, tools, settings, and forced output", () => {
  const original = { model: "m", messages: [user], provider: { only: ["anthropic"], data_collection: "deny" }, tools: [{ type: "function", function: { name: "run" } }] };
  const cache = readModelIdleCache("openai-completions", original)!;
  const replay = { ...original, messages: [user, instruction] };
  assert.ok(modelIdlePayload("openai-completions", replay, cache, prompt));
  for (const override of [
    { provider: { only: ["amazon-bedrock"], data_collection: "deny" } },
    { tools: [] },
    { temperature: 0.5 },
    { messages: [{ ...user, content: [{ type: "text", text: "Changed" }] }, instruction] },
  ]) assert.equal(modelIdlePayload("openai-completions", { ...replay, ...override }, cache, prompt), undefined);
  assert.equal(readModelIdleCache("openai-completions", { ...original, tool_choice: "required" }), undefined);
  assert.equal(readModelIdleCache("mistral-conversations", { ...original, toolChoice: "required" }), undefined);
  assert.equal(readModelIdleCache("pi-messages", { model: "m", context: { messages: [user] }, options: { toolChoice: "required" } }), undefined);
  assert.equal(readModelIdleCache("openai-completions", { ...original, models: ["fallback"] }), undefined);
});

test("saved request options contain prompt settings without credentials and transport state", () => {
  const input = { apiKey: "secret", headers: { Authorization: "secret" }, signal: new AbortController().signal,
    sessionId: "session", cacheRetention: "long" as const, reasoning: "high" as const, thinkingBudgets: { high: 1000 },
    temperature: 0.5, samplingParams: { top_p: 0.9 }, maxTokens: 9000 };
  const saved = idleRequestOptions(input);
  assert.deepEqual(saved, { sessionId: "session", cacheRetention: "long", reasoning: "high", thinkingBudgets: { high: 1000 }, temperature: 0.5, samplingParams: { top_p: 0.9 } });
  assert.notEqual(saved.thinkingBudgets, input.thinkingBudgets);
});
