import assert from "node:assert/strict";
import test from "node:test";
import { createAI } from "agents/models/pi-ai";
import { otherIdlePayload } from "../src/model-idle-compaction-other.ts";
import { modelIdlePayload, readModelIdleCache, type ModelIdleCache } from "../src/model-idle-compaction-payload.ts";

const prompt = "Summarize the earlier part of this conversation.";
const google = {
  model: "gemini-2.5-pro",
  config: {
    systemInstruction: "System instructions",
    tools: [{ functionDeclarations: [{ name: "read" }] }],
    thinkingConfig: { includeThoughts: true, thinkingBudget: 128 },
    maxOutputTokens: 1024,
    abortSignal: new AbortController().signal,
  },
  contents: [
    { role: "user", parts: [{ text: "First input" }] },
    { role: "model", parts: [{ text: "First answer", thoughtSignature: "opaque" }] },
    { role: "user", parts: [{ text: "Latest input" }] },
  ],
};
const googleSummary = {
  ...google,
  config: { ...google.config, maxOutputTokens: 512, abortSignal: new AbortController().signal },
  contents: [...google.contents, { role: "user", parts: [{ text: prompt }] }],
};

for (const api of ["google-generative-ai", "google-vertex"] as const) {
  test(`${api} compares the original native contents and keeps the summary as a separate message`, () => {
    const cache = otherIdlePayload(api, google);
    assert.equal(cache?.ttlMs, 300_000);
    const replay = otherIdlePayload(api, googleSummary, prompt);
    assert.deepEqual(replay?.prefix, cache?.prefix);
    assert.equal(replay?.payload, googleSummary);
    const changed = { ...googleSummary, config: { ...googleSummary.config, systemInstruction: "Changed system" } };
    assert.notDeepEqual(otherIdlePayload(api, changed, prompt)?.prefix, cache.prefix);
    assert.equal(otherIdlePayload(api, googleSummary, "different instruction"), undefined);
    assert.equal(otherIdlePayload(api, { ...google, config: { ...google.config, responseMimeType: "application/json" } }), undefined);
  });
}

function bedrock(ttl?: "1h" | "5m") {
  const point = { cachePoint: { type: "default", ...(ttl && { ttl }) } };
  const history = [
    { role: "user", content: [{ text: "First input" }] },
    { role: "assistant", content: [{ toolUse: { toolUseId: "read1", name: "read", input: {} } }] },
  ];
  const latest = { role: "user", content: [{ toolResult: { toolUseId: "read1", content: [{ text: "Tool response" }] } }] };
  const before = {
    modelId: "global.anthropic.claude-sonnet-4-5",
    system: [{ text: "System instructions" }, point],
    toolConfig: { tools: [{ toolSpec: { name: "read" } }] },
    inferenceConfig: { maxTokens: 1024, temperature: 0.5 },
    messages: [...history, { ...latest, content: [...latest.content, point] }],
  };
  const summary = {
    ...before,
    inferenceConfig: { maxTokens: 512, temperature: 0.5 },
    messages: [...history, latest, { role: "user", content: [{ text: prompt }, point] }],
  };
  return { before, summary, point };
}

for (const ttl of [undefined, "5m", "1h"] as const) {
  test(`Bedrock keeps the ${ttl ?? "default"} checkpoint after the original tool results`, () => {
    const { before, summary, point } = bedrock(ttl);
    const original = structuredClone(summary);
    const cache = otherIdlePayload("bedrock-converse-stream", before);
    assert.equal(cache?.ttlMs, ttl === "1h" ? 3_600_000 : 300_000);
    const replay = otherIdlePayload("bedrock-converse-stream", summary, prompt);
    assert.equal(replay?.ttlMs, cache.ttlMs);
    assert.deepEqual(replay?.prefix, cache.prefix);
    assert.deepEqual(replay?.payload, {
      ...summary,
      messages: [...before.messages, { role: "user", content: [{ text: prompt }] }],
    });
    assert.deepEqual(summary, original);
    assert.deepEqual(summary.messages.at(-1)?.content.at(-1), point);
  });
}

test("Bedrock accepts an implicit cache prefix and skips system-only explicit caching", () => {
  const { before, summary } = bedrock();
  const withoutPoint = { ...before, messages: summary.messages.slice(0, -1) };
  assert.equal(otherIdlePayload("bedrock-converse-stream", withoutPoint), undefined);
  const implicit = { ...withoutPoint, modelId: "openai.gpt-6.1-sol", system: [{ text: "System instructions" }] };
  const cache = otherIdlePayload("bedrock-converse-stream", implicit);
  assert.equal(cache?.ttlMs, 300_000);
  const replay = { ...implicit, messages: [...implicit.messages, { role: "user", content: [{ text: prompt }] }] };
  assert.deepEqual(otherIdlePayload("bedrock-converse-stream", replay, prompt)?.prefix, cache.prefix);
  assert.equal(otherIdlePayload("bedrock-converse-stream", replay, prompt)?.payload, replay);
  const altered = { ...replay, messages: [...implicit.messages, { role: "user", content: [{ text: prompt, extra: true }] }] };
  assert.equal(otherIdlePayload("bedrock-converse-stream", altered, prompt), undefined);
});

test("native APIs without a Workers request path have no idle compaction adapter", () => {
  assert.equal(otherIdlePayload("mistral-conversations", {}), undefined);
  assert.equal(otherIdlePayload("pi-messages", {}), undefined);
});

test("Workers AI reports cached tokens and keeps session affinity through the binding", async () => {
  const modelId = "@cf/moonshotai/kimi-k2.5";
  const sessionId = "idle-prefix-check";
  const calls: Array<{ input: unknown; affinity?: string }> = [];
  const ai = createAI({ binding: {
    async run(model: string, input: unknown, options?: { extraHeaders?: Record<string, string> }) {
      assert.equal(model, modelId);
      calls.push({ input, affinity: options?.extraHeaders?.["x-session-affinity"] });
      const chunks = [
        { response: "OK" },
        { response: "", usage: { prompt_tokens: 5000, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 4000 } } },
      ].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`);
      return new Response(`${chunks.join("")}data: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    },
  } as unknown as Ai });
  const model = ai(modelId);
  const user = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });
  const input = user("Initial conversation");
  let cache: ModelIdleCache | undefined;
  const generation = await ai.complete(model, { messages: [input] }, {
    sessionId,
    maxTokens: 1024,
    onPayload(payload, model) {
      cache = readModelIdleCache(model.api, payload);
    },
  });
  assert.equal(generation.stopReason, "stop");
  assert.equal(generation.usage.cacheRead, 4000);
  assert.equal(generation.usage.input, 1000);
  assert.ok(cache);
  const replay = await ai.complete(model, { messages: [input, user(prompt)] }, {
    sessionId,
    maxTokens: 512,
    onPayload(payload, model) {
      const verified = modelIdlePayload(model.api, payload, cache!, prompt);
      assert.ok(verified);
      return verified;
    },
  });
  assert.equal(replay.stopReason, "stop");
  assert.equal(replay.usage.cacheRead, 4000);
  assert.deepEqual(calls.map(call => call.affinity), [sessionId, sessionId]);
  assert.doesNotMatch(JSON.stringify(calls[0]?.input), /Summarize/);
  assert.match(JSON.stringify(calls[1]?.input), /Summarize/);
});
