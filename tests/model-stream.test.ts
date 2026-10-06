import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream, type Api, type Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { errorClass } from "../src/metrics.ts";
import { STREAM_TIMEOUTS, streamTimeouts, watchedStream } from "../src/model-stream.ts";
import { responses } from "./provider-fixtures.ts";

type T = { after: (fn: () => Promise<void> | void) => void };
const chunk = (delta: object, finish_reason: string | null = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;

/**
 * How a provider misbehaves on one request: `hang` never answers (no headers); `keepalive` answers 200 and sends only
 * SSE comments, as OpenRouter does while an upstream hangs; `partial` sends some text, then only comments; `answer` replies.
 */
type Mode = "hang" | "keepalive" | "partial" | "answer";

/** An OpenAI-compatible provider whose requests behave as `modes` says, in order (the last for the rest). */
async function provider(t: T, modes: Mode[], extra: Partial<Model<Api>> = {}) {
  const bodies: any[] = [];
  const open = new Set<ServerResponse>();
  const timers = new Set<ReturnType<typeof setInterval>>();
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const part of req) text += part;
    bodies.push(JSON.parse(text));
    const mode = modes[Math.min(bodies.length - 1, modes.length - 1)];
    if (mode === "hang") { open.add(res); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (mode === "answer") {
      res.write(chunk({ role: "assistant", content: `answer ${bodies.length}` }));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
      return;
    }
    if (mode === "partial") res.write(chunk({ role: "assistant", content: "half an ans" }));
    // Keep-alives forever: the connection is open, but nothing of the answer comes.
    const timer = setInterval(() => res.write(": OPENROUTER PROCESSING\n\n"), 100);
    timers.add(timer);
    res.on("close", () => { clearInterval(timer); timers.delete(timer); });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    for (const timer of timers) clearInterval(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const model = {
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024, ...extra,
  } as Model<Api>;
  return { model, bodies, open };
}

async function agent(t: T, model: Model<Api>, config: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "camelai-stream-test-"));
  const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME, maxAgents: 2, hosting: process.env.AGENT_HOSTING as Hosting | undefined });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  await supervisor.start("a", { model, apiKey: "fixture", retry: { maxAttempts: 2, baseDelayMs: 10 }, runLimits: { firstTokenSeconds: 1, idleSeconds: 1 }, ...config }, { definitions: [], async call() { return null; } });
  const events: any[] = [];
  const prompt = (text: string) => supervisor.request("a", "prompt", { text }, event => events.push(event));
  return { supervisor, events, prompt };
}

test("a model that sends only keep-alives before its first token times out, is retried, and the turn goes on", { timeout: 30_000 }, async t => {
  const { model, bodies } = await provider(t, ["keepalive", "answer"]);
  const { events, prompt } = await agent(t, model);
  const started = Date.now();
  const result = await prompt("Hello");
  assert.equal(result.error, null);
  assert.equal(result.reply, "answer 2");
  assert.equal(bodies.length, 2, "asked again once");
  assert.ok(Date.now() - started < 6_000, "the stall ended after its first-token timeout, not never");
  const stall = events.find(event => event.type === "model_stream_stalled");
  assert.equal(stall?.phase, "first_token");
  assert.ok(events.some(event => event.type === "auto_retry_start" && /^Model stream stalled/.test(event.errorMessage)));
  assert.ok(events.some(event => event.type === "auto_retry_end" && event.success));
});

test("a stream that stops partway goes quiet for idleSeconds, is retried, and the half answer never becomes history", { timeout: 30_000 }, async t => {
  const { model, bodies } = await provider(t, ["partial", "answer"]);
  const { supervisor, events, prompt } = await agent(t, model);
  const result = await prompt("Hello");
  assert.equal(result.error, null);
  assert.equal(result.reply, "answer 2");
  assert.equal(bodies.length, 2);
  assert.equal(events.find(event => event.type === "model_stream_stalled")?.phase, "idle");
  const history = (await supervisor.request("a", "history")).messages;
  assert.deepEqual(history.map((message: any) => message.role), ["user", "assistant"]);
  assert.doesNotMatch(JSON.stringify(history), /half an ans/);
});

test("a model that never answers fails the turn with model_stream_stalled once retries run out: never silent and busy", { timeout: 30_000 }, async t => {
  const { model, bodies } = await provider(t, ["hang"]);
  const { supervisor, events, prompt } = await agent(t, model);
  const started = Date.now();
  const result = await prompt("Hello");
  assert.match(result.error, /^Model stream stalled: openai\/fixture sent nothing within 1s of the request/);
  assert.equal(result.code, "model_stream_stalled");
  assert.equal(errorClass(result.error), "stream_stalled");
  assert.equal(bodies.length, 3, "the first request and both retries");
  assert.ok(Date.now() - started < 10_000);
  assert.ok(events.some(event => event.type === "auto_retry_end" && !event.success));
  assert.equal(events.filter(event => event.type === "model_stream_stalled").length, 3);
  // The agent is idle again, and takes the next message.
  assert.equal((await supervisor.request("a", "status")).busy, false);
});

test("a reasoning model on OpenRouter at thinking low that hangs (Mercury) errors within its timeout; the request asks for low", { timeout: 30_000 }, async t => {
  const { model, bodies } = await provider(t, ["keepalive"], {
    id: "inception/mercury-2.5", provider: "openrouter", reasoning: true, compat: { thinkingFormat: "openrouter", supportsDeveloperRole: false } as never,
    thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } as never,
  });
  const { prompt } = await agent(t, model, { thinkingLevel: "low", retry: { maxAttempts: 0, baseDelayMs: 10 } });
  const started = Date.now();
  const result = await prompt("Hello");
  assert.equal(result.code, "model_stream_stalled");
  assert.ok(Date.now() - started < 5_000, `errored after ${Date.now() - started} ms`);
  assert.deepEqual(bodies[0].reasoning, { effort: "low" }, "OpenRouter's reasoning object, which Mercury accepts");
});

test("an abort ends a model request in flight at once, even one the provider never answers", { timeout: 30_000 }, async t => {
  const { model } = await provider(t, ["hang"]);
  const { supervisor, prompt } = await agent(t, model, { runLimits: { firstTokenSeconds: 600 } });
  const running = prompt("Hello");
  await new Promise(resolve => setTimeout(resolve, 300));
  const aborted = Date.now();
  await supervisor.request("a", "abort");
  const result = await running;
  assert.ok(Date.now() - aborted < 2_000, "the turn ended at the abort");
  assert.equal(result.code, "aborted");
});

test("a model the runtime has no stall timeouts set for gets the defaults: longer before the first token for one thinking hard", () => {
  assert.deepEqual(streamTimeouts({ reasoning: false }, undefined), { firstTokenMs: STREAM_TIMEOUTS.firstTokenMs, idleMs: STREAM_TIMEOUTS.idleMs });
  assert.equal(streamTimeouts({ reasoning: true }, "low").firstTokenMs, 120_000);
  assert.equal(streamTimeouts({ reasoning: true }, "high").firstTokenMs, 300_000);
  assert.equal(streamTimeouts({ reasoning: false }, "high").firstTokenMs, 120_000, "a level a model without reasoning ignores");
  assert.deepEqual(streamTimeouts({ reasoning: true }, "high", { firstTokenSeconds: 30, idleSeconds: 10 }), { firstTokenMs: 30_000, idleMs: 10_000 }, "the agent's own");
  assert.deepEqual(streamTimeouts({ reasoning: false }, undefined, null, { firstTokenMs: 90_000, idleMs: 20_000 }), { firstTokenMs: 90_000, idleMs: 20_000 }, "the runtime's");
});

/** An OpenAI Responses provider: each request gets `reply(index)`'s events, the stream simply ending after the last. */
async function responsesProvider(t: T, reply: (index: number) => object[]) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* the body */ }
    const events = reply(requests++);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const event of events) res.write(`event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const model = {
    id: "fixture", name: "Fixture", api: "openai-responses", provider: "openai", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024,
  } as Model<Api>;
  return { model, requests: () => requests };
}
const message = (text: string) => ({ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] });
/** The events of a response cut off before its terminal event (response.completed), as a dropped provider stream leaves it. */
const cutOff = (text: string) => responses([message(text)]).events.slice(0, -1);

test("a provider stream that ends before its terminal event (OpenAI Responses) is retried, and past its retries fails the run: never silent", { timeout: 30_000 }, async t => {
  const { model, requests } = await responsesProvider(t, index => index === 0 ? cutOff("half an ans") : responses([message("whole answer")]).events);
  const { supervisor, events, prompt } = await agent(t, model);
  const result = await prompt("Hello");
  assert.equal(result.error, null);
  assert.equal(result.reply, "whole answer");
  assert.equal(requests(), 2);
  assert.ok(events.some(event => event.type === "auto_retry_start" && /ended before a terminal response event/.test(event.errorMessage)));
  assert.doesNotMatch(JSON.stringify((await supervisor.request("a", "history")).messages), /half an ans/);

  // Every attempt is cut off: the run ends with the provider's error, and the agent is idle for the next message.
  const always = await responsesProvider(t, () => cutOff("cut"));
  const second = await agent(t, always.model);
  const failed = await second.prompt("Hello");
  assert.match(failed.error, /ended before a terminal response event/);
  assert.equal(always.requests(), 3, "the first request and both retries");
  assert.ok(second.events.some(event => event.type === "auto_retry_end" && !event.success));
  assert.equal((await second.supervisor.request("a", "status")).busy, false);
});

test("a stream that ends with no terminal event at all is ended as a failure, not left waiting", async () => {
  const model = { id: "fixture", api: "openai-completions", provider: "openai" } as Model<Api>;
  const stream = watchedStream(model, () => {
    const inner = createAssistantMessageEventStream();
    queueMicrotask(() => inner.end());
    return inner;
  }, { firstTokenMs: 60_000, idleMs: 60_000 });
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage!, /ended without a final event/);
});
