import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { explicitKeyStream } from "../src/compaction.ts";
import { IDLE_COMPACTION_CALL, IDLE_SUMMARY_PROMPT, type CachedRequest } from "../src/model-idle-compaction.ts";
import type { ModelAttemptEvent } from "../src/model-attempt.ts";
import type { Credentials } from "../src/protocol.ts";

const usage = { input: 50, output: 7, cacheRead: 64_000, cacheWrite: 0, totalTokens: 64_057,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function sse(events: object[]): Response {
  const body = events.map(event => `${"type" in event ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function response(api: Api): Response {
  if (api === "anthropic-messages") return sse([
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "fixture", content: [], stop_reason: null,
      usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 64_000, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checkpoint" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ]);
  if (api === "google-generative-ai" || api === "google-vertex") return sse([
    { candidates: [{ index: 0, content: { role: "model", parts: [{ text: "Checkpoint" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 64_050, cachedContentTokenCount: 64_000, candidatesTokenCount: 7, totalTokenCount: 64_057 } },
  ]);
  if (api === "pi-messages") return sse([
    { type: "text_start", contentIndex: 0 },
    { type: "text_delta", contentIndex: 0, delta: "Checkpoint" },
    { type: "text_end", contentIndex: 0, content: "Checkpoint" },
    { type: "done", reason: "stop", usage },
  ]);
  if (api.endsWith("responses")) {
    const item = { id: "msg_fixture", type: "message", role: "assistant", content: [{ type: "output_text", text: "Checkpoint" }] };
    return sse([
      { type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Checkpoint" },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp_fixture", status: "completed", usage: {
        input_tokens: 64_050, input_tokens_details: { cached_tokens: 64_000 }, output_tokens: 7, total_tokens: 64_057,
      } } },
    ]);
  }
  return sse([
    { id: "gen-fixture", provider: "Anthropic", choices: [{ index: 0, delta: { role: "assistant", content: "Checkpoint" }, finish_reason: null }] },
    { id: "gen-fixture", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: {
      prompt_tokens: 64_050, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 64_000 }, total_tokens: 64_057,
    } },
  ]);
}

async function fixture(t: TestContext, api: Api, provider: string) {
  const requests: { headers: Headers; body?: Record<string, unknown> }[] = [];
  const attempts: ModelAttemptEvent[] = [];
  let credentials: Credentials = { apiKey: "fixture-key", ...(provider === "amazon-bedrock" ? { region: "us-east-1" } : {}) };
  if (provider === "azure") credentials = { apiKey: "fixture-key", baseUrl: "https://azure.example/openai", deployments: { fixture: "fixture-deployment" } };
  if (provider === "openai-codex") credentials.apiKey = ["{}", JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } }), "signature"].map(part => Buffer.from(part).toString("base64url")).join(".");
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.headers.get("content-encoding") === "zstd" ? undefined : JSON.parse(await request.text());
    requests.push({ headers: request.headers, body });
    return response(api);
  });
  if (api === "bedrock-converse-stream") t.mock.method(BedrockRuntimeClient.prototype, "send", async (command: { input: Record<string, unknown> }) => {
    requests.push({ headers: new Headers(), body: command.input });
    return { $metadata: {}, stream: (async function* () {
      yield { messageStart: { role: "assistant" } };
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Checkpoint" } } };
      yield { contentBlockStop: { contentBlockIndex: 0 } };
      yield { messageStop: { stopReason: "end_turn" } };
      yield { metadata: { usage: { inputTokens: 64_050, outputTokens: 7, cacheReadInputTokens: 64_000, totalTokens: 64_057 } } };
    })() };
  });
  const model = { id: "fixture", name: "Fixture", api, provider, baseUrl: provider === "openrouter" ? "https://openrouter.ai/api/v1" : "https://api.example/v1",
    reasoning: false, input: ["text"], contextWindow: 200_000, maxTokens: 10_000,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } } as Model<Api>;
  const stream = explicitKeyStream(async () => credentials, undefined, undefined, undefined, undefined, undefined,
    async event => { attempts.push(event); return true; });
  const context = normalizeContext({ systemPrompt: "Rules", messages: [{ role: "user", content: "Old transcript ".repeat(100), timestamp: 1 }] });
  let cached: CachedRequest | undefined;
  const options = { apiKey: "agent-key", maxRetries: 0, transport: "sse" as const, maxTokens: 9000, sessionId: "stable-session", cacheRetention: "short" as const };
  const answer = await (await stream(model, context, { ...options,
    [IDLE_COMPACTION_CALL]: { capture: (request: CachedRequest) => { cached = request; } },
  } as typeof options)).result();
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.ok(cached, `${api} captured`);
  assert.equal(cached.cachedTokens, 64_000);
  const replayContext = normalizeContext({ messages: [...context.messages, { role: "user", content: IDLE_SUMMARY_PROMPT, timestamp: 2 }] });
  const replay = (overrides: Partial<typeof replayContext> = {}, stillIdle: () => boolean | Promise<boolean> = () => true, signal?: AbortSignal) => stream(model, { ...replayContext, ...overrides }, {
    ...options, ...cached!.options, signal, [IDLE_COMPACTION_CALL]: { replay: cached!, stillIdle },
  } as typeof options);
  return { model, context, cached, requests, attempts, replay, rotate: () => { credentials = { ...credentials, apiKey: "rotated-key" }; } };
}

for (const [api, provider] of [
  ["openai-completions", "openai"], ["openai-responses", "openai"], ["azure-openai-responses", "azure"],
  ["openai-codex-responses", "openai-codex"], ["anthropic-messages", "anthropic"],
  ["google-generative-ai", "google"], ["google-vertex", "google-vertex"],
  ["bedrock-converse-stream", "amazon-bedrock"], ["mistral-conversations", "mistral"], ["pi-messages", "radius"],
  ["openai-completions", "openrouter"], ["anthropic-messages", "openrouter"],
]) test(`${provider} ${api} replays the native serializer's cached prefix`, async t => {
  const fake = await fixture(t, api, provider);
  const answer = await (await fake.replay()).result();
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(fake.requests.length, 2);
  const begin = fake.attempts.filter(event => event.type === "begin");
  assert.equal(begin.at(-1)?.kind, "compaction");
  assert.ok((begin.at(-1)?.estimate?.cachedTokens ?? 0) > 0);
  assert.equal(begin.at(-1)?.estimate?.maxOutputTokens, 4096);
  if (provider === "openrouter") {
    assert.equal(fake.requests[0]!.headers.get("x-session-id"), "stable-session");
    assert.equal(fake.requests[1]!.headers.get("x-session-id"), "stable-session");
    assert.deepEqual(fake.requests[1]!.body!.provider, { allow_fallbacks: false });
  }
});

test("expired, active, and credential-changed replays create no attempt or outbound request", async t => {
  const fake = await fixture(t, "openai-completions", "openai");
  await assert.rejects(Promise.resolve(fake.replay({}, () => false)), /Idle compaction skipped/);
  assert.equal(fake.attempts.filter(event => event.type === "begin").length, 1);
  const originalAt = fake.cached.at;
  fake.cached.at = Date.now() - fake.cached.cache.ttlMs;
  await assert.rejects(Promise.resolve(fake.replay()), /Idle compaction skipped/);
  fake.cached.at = originalAt;
  fake.rotate();
  await assert.rejects(Promise.resolve(fake.replay()), /Idle compaction skipped/);
  assert.equal(fake.attempts.filter(event => event.type === "begin").length, 1);
  assert.equal(fake.requests.length, 1);
});

test("a serialized prefix mismatch sends no request and settles zero provider usage", async t => {
  const fake = await fixture(t, "openai-completions", "openai");
  const answer = await (await fake.replay({ messages: [{ role: "user", content: "Changed prefix", timestamp: 1 }, { role: "user", content: IDLE_SUMMARY_PROMPT, timestamp: 2 }] })).result();
  assert.equal(answer.stopReason, "error");
  assert.match(answer.errorMessage!, /Idle compaction skipped/);
  assert.equal(fake.requests.length, 1);
  const finish = fake.attempts.filter(event => event.type === "finish").at(-1)!;
  assert.equal(finish.completed, false);
  assert.equal(finish.usage.input + finish.usage.output + finish.usage.cacheRead + finish.usage.cacheWrite, 0);
});

test("cancellation during the final idle guard does not estimate unsent input as billable", async t => {
  const fake = await fixture(t, "openai-completions", "openai");
  const controller = new AbortController();
  let checks = 0;
  const answer = await (await fake.replay({}, () => {
    if (++checks === 2) { controller.abort(); return false; }
    return true;
  }, controller.signal)).result();
  assert.equal(answer.stopReason, "aborted");
  assert.equal(fake.requests.length, 1);
  const finish = fake.attempts.filter(event => event.type === "finish").at(-1)!;
  assert.equal(finish.usage.estimatedInputTokens, undefined);
  assert.equal(finish.usage.input + finish.usage.output + finish.usage.cacheRead + finish.usage.cacheWrite, 0);
});
