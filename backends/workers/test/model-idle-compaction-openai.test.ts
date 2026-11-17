import assert from "node:assert/strict";
import test from "node:test";
import { openAIIdlePayload } from "../src/model-idle-compaction-openai.ts";

const prompt = "Summarize this conversation.";

test("Responses keeps prior serialized input, reasoning, and request cache settings", () => {
  const reasoning = { type: "configuration_update", reasoning: { effort: "high" } };
  const input = [
    { role: "developer", content: "Initial instructions." },
    { role: "user", content: [{ type: "input_text", text: "Previous input." }] },
    reasoning,
  ];
  const summary = { role: "user", content: [{ type: "input_text", text: prompt }] };
  const original = {
    model: "openai-test", input, stream: true, prompt_cache_key: "original-key",
    prompt_cache_options: { mode: "implicit", ttl: "30m" }, store: false, max_output_tokens: 12_000,
    tools: [{ type: "function", name: "work" }], reasoning: { effort: "low" },
  };
  const replay = { ...original, input: [...input.slice(0, -1), summary, reasoning], max_output_tokens: 4_096 };
  const baseline = openAIIdlePayload("openai-responses", original);
  const next = openAIIdlePayload("openai-responses", replay, prompt);
  assert.equal(baseline?.ttlMs, 30 * 60_000);
  assert.equal(next?.ttlMs, baseline.ttlMs);
  assert.equal(JSON.stringify(next?.prefix), JSON.stringify(baseline.prefix));
  assert.deepEqual(next?.payload, { ...replay, input: [...input, summary] });
  assert.notDeepEqual(openAIIdlePayload("openai-responses", { ...replay, prompt_cache_key: "other-key" }, prompt)?.prefix, baseline.prefix);
  assert.notDeepEqual(openAIIdlePayload("openai-responses", { ...replay, reasoning: { effort: "high" } }, prompt)?.prefix, baseline.prefix);
});

test("Chat Completions restores OpenRouter-style breakpoints before the new summary", () => {
  const cache = { type: "ephemeral", ttl: "1h" };
  const system = { role: "system", content: [{ type: "text", text: "System.", cache_control: { type: "ephemeral" } }] };
  const user = { role: "user", content: "Original question." };
  const assistant = { role: "assistant", content: [{ type: "text", text: "Answer.", cache_control: cache }] };
  const original = {
    model: "test", messages: [system, user, assistant], max_tokens: 8_192, stream: true,
    prompt_cache_retention: "24h", provider: { only: ["chosen-provider"] },
  };
  const replay = {
    ...original, max_tokens: 4_096,
    messages: [system, user, { role: "assistant", content: "Answer." },
      { role: "user", content: [{ type: "text", text: prompt, cache_control: cache }] }],
  };
  const baseline = openAIIdlePayload("openai-completions", original);
  const next = openAIIdlePayload("openai-completions", replay, prompt);
  assert.equal(baseline?.ttlMs, 5 * 60_000);
  assert.equal(next?.ttlMs, baseline.ttlMs);
  assert.equal(JSON.stringify(next?.prefix), JSON.stringify(baseline.prefix));
  assert.deepEqual(next?.payload, { ...replay, messages: [...original.messages, { role: "user", content: [{ type: "text", text: prompt }] }] });
});

test("Chat Completions accepts an exact summary after an implicit cache prefix", () => {
  const original = { model: "test", messages: [{ role: "user", content: "Original question." }] };
  const replay = { ...original, messages: [...original.messages, { role: "user", content: prompt }] };
  const baseline = openAIIdlePayload("openai-completions", original);
  const next = openAIIdlePayload("openai-completions", replay, prompt);
  assert.equal(baseline?.ttlMs, 5 * 60_000);
  assert.deepEqual(next?.prefix, baseline.prefix);
  assert.equal(next?.payload, replay);
  assert.equal(openAIIdlePayload("openai-completions", replay, "Different prompt."), undefined);
  for (const retention of ["in_memory", "24h"]) {
    assert.equal(openAIIdlePayload("openai-completions", { ...original, prompt_cache_retention: retention })?.ttlMs, 5 * 60_000);
  }
});

test("the Cloudflare binding passes its model separately from the Chat Completions payload", () => {
  const original = { messages: [{ role: "user", content: "Original question." }] };
  const replay = { messages: [...original.messages, { role: "user", content: prompt }] };
  assert.equal(openAIIdlePayload("openai-completions", original), undefined);
  assert.deepEqual(openAIIdlePayload("cloudflare-ai", replay, prompt), { prefix: original, ttlMs: 5 * 60_000, payload: replay });
});

test("Responses keeps modern explicit cache breakpoints outside the summary", () => {
  const marked = { type: "input_text", text: "Original question.", prompt_cache_breakpoint: { mode: "explicit" } };
  const summary = { role: "user", content: [{ type: "input_text", text: prompt }] };
  const input = [{ role: "user", content: [marked] }];
  const original = { model: "test", input, prompt_cache_options: { mode: "explicit", ttl: "12h" } };
  const replay = { ...original, input: [...input, summary] };
  const baseline = openAIIdlePayload("openai-responses", original);
  const next = openAIIdlePayload("openai-responses", replay, prompt);
  assert.equal(baseline?.ttlMs, 30 * 60_000);
  assert.deepEqual(next?.prefix, baseline.prefix);
  assert.equal(next?.payload, replay);
  const shorter = { ...marked, prompt_cache_breakpoint: { mode: "explicit", ttl: "30m" } };
  assert.equal(openAIIdlePayload("openai-responses", { ...original, input: [{ role: "user", content: [shorter] }] })?.ttlMs, 30 * 60_000);
});

test("OpenAI replay declines state, structured output, and ambiguous cache settings", () => {
  const input = [{ role: "user", content: [{ type: "input_text", text: "Previous input." }] }];
  const original = { model: "test", input };
  for (const fields of [
    { previous_response_id: "resp_old" }, { conversation: "conv_old" }, { store: true }, { background: true },
    { text: { format: { type: "json_schema" } } }, { cache_control: { type: "ephemeral" } },
    { tool_choice: "required" }, { prompt_cache_options: { mode: "explicit" } }, { prompt_cache_retention: "unknown" },
    { input: [{ type: "item_reference", id: "msg_old" }] },
  ]) {
    assert.equal(openAIIdlePayload("openai-responses", { ...original, ...fields }), undefined, JSON.stringify(fields));
  }
});
