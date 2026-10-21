import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import { fileAppendLog } from "../shared/append-log.ts";
import { nativeTranscriptRecords } from "../src/pi-durable/transcript.ts";
import { Transcript, type TranscriptRecord } from "../src/transcript.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { compactionNeed, contextTokens, explicitKeyStream, runCompaction } from "../src/compaction.ts";
import { readTranscript } from "../src/transcript.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { fileStorage, memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Ownership } from "../src/ownership.ts";

type Body = { messages: { role: string; content: unknown }[] };
const text = (body: Body) => JSON.stringify(body.messages);
const isSummarization = (body: Body) => text(body).includes("context summarization assistant");

/**
 * An OpenAI-compatible provider that reports no usage, like some proxies, unless `usage` is set. With `gated`,
 * summaries wait until `release()`; `inflight` counts summaries asked for and not yet answered.
 */
async function provider(t: { after(fn: () => Promise<void>): void }, options: { overflowAboveChars?: number; usage?: boolean; gated?: boolean; turnInput?: (body: Body) => number } = {}) {
  const requests: Body[] = [];
  let summaries = 0;
  let toolNext = false;
  let gate = Promise.withResolvers<void>();
  const state = { inflight: 0, maxInflight: 0 };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Body;
    requests.push(body);
    if (isSummarization(body)) {
      state.maxInflight = Math.max(state.maxInflight, ++state.inflight);
      if (options.gated) await gate.promise;
      res.once("finish", () => state.inflight--);
    }
    if (!isSummarization(body) && options.overflowAboveChars && text(body).length > options.overflowAboveChars) {
      res.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: `This endpoint's maximum context length is 8000 tokens. However, you requested about ${Math.round(text(body).length / 4)} tokens`, type: "invalid_request_error" } }));
      return;
    }
    const tool = !isSummarization(body) && toolNext;
    if (tool) toolNext = false;
    const reply = isSummarization(body) ? `## Goal\nSUMMARY-MARKER-${++summaries}` : "ack";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: tool ? { role: "assistant", tool_calls: [{ index: 0, id: "lookup-1", type: "function", function: { name: "lookup", arguments: "{}" } }] } : { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
    const usage = options.usage ? { usage: isSummarization(body) ? { prompt_tokens: 3000, completion_tokens: 200 } : { prompt_tokens: options.turnInput?.(body) ?? 10, completion_tokens: 1 } } : {};
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }], ...usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { gate.resolve(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  /** Answer the summaries waiting, and let later ones wait again. */
  const release = () => { gate.resolve(); gate = Promise.withResolvers<void>(); };
  const model = (contextWindow: number, id = "fixture") => ({
    id, name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    reasoning: false, input: ["text"], cost: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 1000,
  }) as Model<Api>;
  return { requests, model, release, state, toolNext: () => { toolNext = true; }, chat: () => requests.filter(body => !isSummarization(body)), summarizations: () => requests.filter(isSummarization) };
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "compaction-test-"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  return supervisor;
}
const bridge = { definitions: [], async call() { return null; } };
const turn = (index: number) => `TURN-${index} ${"x".repeat(9000)}`;

test("long conversations compact into a summary; history stays complete and the working set survives restarts", async t => {
  const fake = await provider(t);
  const supervisor = await fixture(t);
  const model = fake.model(8000);
  const events: any[] = [];
  await supervisor.start("long", { model, apiKey: "fixture" }, { ...bridge, background: event => events.push(event) });
  for (let index = 0; index < 5; index++) {
    const result = await supervisor.request("long", "prompt", { text: turn(index) }, event => events.push(event));
    assert.equal(result.error, null);
  }
  assert.ok(fake.summarizations().length >= 1, "a summary was requested");
  assert.ok(events.some(event => event.type === "compaction_end" && event.summarizedMessages > 0));
  assert.equal(events.filter(event => event.type === "context_trimmed").length, 0, "compaction, not trimming, bounded the context");
  const last = text(fake.chat().at(-1)!);
  assert.match(last, /SUMMARY-MARKER/);
  assert.match(last, /compacted into the following summary/);
  assert.doesNotMatch(last, /TURN-0 /, "the oldest turn now lives only in the summary");
  assert.match(last, /TURN-4 /);
  await until(() => fake.state.inflight === 0 && events.filter(event => event.type === "compaction_start").length === events.filter(event => event.type === "compaction_end").length, "background compaction is adopted before the reload snapshot");
  const status = await supervisor.request("long", "status");
  assert.equal(status.compacted, true);
  assert.equal(status.messages, 10);
  assert.ok(status.contextMessages < status.messages);
  // History is the full conversation, read from the log.
  const history = (await supervisor.request("long", "history")).messages;
  assert.equal(history.length, 10);
  assert.match(JSON.stringify(history[0]), /TURN-0 /);

  await supervisor.stop("long");
  const restarted = await supervisor.start("long", { model, apiKey: "fixture" }, bridge);
  assert.equal(restarted.messages, 10);
  const after = await supervisor.request("long", "status");
  assert.equal(after.contextMessages, status.contextMessages, "only the working set is loaded");
  await supervisor.request("long", "prompt", { text: "After restart" });
  assert.match(text(fake.chat().at(-1)!), /SUMMARY-MARKER/);
});

test("a message whose request the history already holds is not taken again, even once compaction folded it away and the agent restarted", async t => {
  // A prompt sent with whileRunning: "steer" that a running turn took stays queued until that turn ends; if the node
  // stops first, the next owner runs the prompt, which must find its message in the history, not only in the working set.
  const fake = await provider(t);
  const supervisor = await fixture(t);
  const model = fake.model(8000);
  await supervisor.start("steered", { model, apiKey: "fixture" }, bridge);
  await supervisor.request("steered", "prompt", { text: turn(0), requestId: "steer-1" });
  for (let index = 1; index < 5; index++) await supervisor.request("steered", "prompt", { text: turn(index) });
  assert.doesNotMatch(text(fake.chat().at(-1)!), /TURN-0 /, "compaction folded the message out of the working set");
  await supervisor.stop("steered");
  await supervisor.start("steered", { model, apiKey: "fixture" }, bridge);
  const calls = fake.chat().length;
  const again = await supervisor.request("steered", "prompt", { text: turn(0), requestId: "steer-1" });
  assert.equal(again.taken, true);
  assert.equal(fake.chat().length, calls, "no model call");
  const history = (await supervisor.request("steered", "history")).messages;
  assert.equal(history.filter((message: any) => message.requestId === "steer-1").length, 1, "recorded once");
});

test("a transcript written by pi 0.80.6 loads, replays its tool history and summary, and keeps compacting", async t => {
  const fake = await provider(t);
  const root = await mkdtemp(join(tmpdir(), "compaction-legacy-"));
  const directory = join(root, "agents", "legacy");
  await mkdir(directory, { recursive: true });
  // Recorded by the runtime on pi 0.80.6: an image prompt, tool calls with thinking, and two compactions.
  await copyFile(new URL("./fixtures/pi-0.80.6-transcript.jsonl", import.meta.url), join(directory, "transcript.jsonl"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  const before = await readTranscript(directory);
  assert.equal(before.length, 20);
  const inspect = { definitions: [{ name: "inspect", description: "Inspect", parameters: { type: "object" }, exposure: "direct" as const }], async call() { return "inspected"; } };
  // Compactions between runs report to the bridge, as no run's stream carries them.
  const events: any[] = [];
  const started = await supervisor.start("legacy", { model: fake.model(8000), apiKey: "fixture" }, { ...inspect, background: (event: any) => events.push(event) });
  assert.equal(started.messages, 20);
  assert.deepEqual((await supervisor.request("legacy", "history")).messages, before);
  const result = await supervisor.request("legacy", "prompt", { text: "After the upgrade" });
  assert.equal(result.error, null);
  const sent = text(fake.chat().at(-1)!);
  assert.match(sent, /SUMMARY-write-4/, "the stored summary is the context's start");
  assert.doesNotMatch(sent, /TURN-0 /);
  assert.match(sent, /"name":"inspect"/, "stored tool calls replay");
  assert.match(sent, /"role":"tool"/, "stored tool results replay");
  for (let index = 0; index < 3; index++) assert.equal((await supervisor.request("legacy", "prompt", { text: turn(index) }, event => events.push(event))).error, null);
  await until(() => events.some(event => event.type === "compaction_end" && event.summarizedMessages > 0), "a compaction ran");
  assert.match(text(fake.summarizations()[0]), /SUMMARY-write-4/, "the stored summary seeds the next one");
  assert.deepEqual((await supervisor.request("legacy", "history")).messages.slice(0, 20), before);
});

test("a transcript written by pi 0.87.1 loads on pi 1.0, replays its summary, tool history and system change, and keeps compacting", async t => {
  const fake = await provider(t);
  const root = await mkdtemp(join(tmpdir(), "compaction-087-"));
  const directory = join(root, "agents", "legacy");
  await mkdir(directory, { recursive: true });
  // Recorded by the runtime on pi 0.87.1 (long turns shortened): an import with a compactionSummary, an image prompt,
  // tool calls with thinking, a failed tool call, a prompt change, and a compaction that folded the change in.
  await copyFile(new URL("./fixtures/pi-0.87.1-transcript.jsonl", import.meta.url), join(directory, "transcript.jsonl"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  const before = await readTranscript(directory);
  assert.equal(before.length, 26);
  assert.deepEqual(before.filter(message => message.role === "toolResult" && message.isError).map(message => (message as { toolName: string }).toolName), ["fails"]);
  const definitions = ["inspect", "fails"].map(name => ({ name, description: name, parameters: { type: "object" }, exposure: "direct" as const }));
  // Compactions between runs report to the bridge, as no run's stream carries them.
  const events: any[] = [];
  const started = await supervisor.start("legacy", { model: fake.model(8000), apiKey: "fixture", systemPrompt: "Changed rules" }, { definitions, async call() { return "inspected"; }, background: event => events.push(event) });
  assert.equal(started.messages, 26);
  assert.deepEqual((await supervisor.request("legacy", "history")).messages, before);
  assert.equal((await supervisor.request("legacy", "status")).compacted, true);
  assert.equal((await supervisor.request("legacy", "prompt", { text: "After the upgrade" })).error, null);
  const sent = fake.chat().at(-1)!;
  assert.match(text(sent), /compacted into the following summary:\\n\\n<summary>\\n## Goal\\nSUMMARY-087-2/, "the stored summary is the context's start");
  assert.match(JSON.stringify(sent.messages[0]), /Changed rules/, "the folded prompt change leads the context");
  assert.doesNotMatch(text(sent), /IMPORTED-|TOOL FAIL/, "what the summary covers stays out");
  assert.match(text(sent), /"name":"inspect"/, "stored tool calls replay");
  assert.match(text(sent), /"role":"tool"/, "stored tool results replay");
  for (let index = 0; index < 3; index++) assert.equal((await supervisor.request("legacy", "prompt", { text: turn(index) }, event => events.push(event))).error, null);
  await until(() => events.some(event => event.type === "compaction_end" && event.summarizedMessages > 0), "a compaction ran");
  assert.match(text(fake.summarizations()[0]), /SUMMARY-087-2/, "the stored summary seeds the next one");
  assert.deepEqual((await supervisor.request("legacy", "history")).messages.slice(0, 26), before);
});

test("an imported history larger than one summarization request is summarized in chunks", async t => {
  const fake = await provider(t);
  const supervisor = await fixture(t);
  const initialMessages = Array.from({ length: 12 }, (_, index) => [
    { role: "user", content: turn(index), timestamp: index * 2 },
    { role: "assistant", content: [{ type: "text", text: `answer ${index}` }], api: "openai-completions", provider: "openai", model: "fixture", stopReason: "stop", timestamp: index * 2 + 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ]).flat() as any[];
  await supervisor.start("imported", { model: fake.model(8000), apiKey: "fixture", initialMessages }, bridge);
  const result = await supervisor.request("imported", "prompt", { text: "What happened so far?" });
  assert.equal(result.error, null);
  const summarizations = fake.summarizations();
  assert.ok(summarizations.length >= 2, `expected chunked summaries, got ${summarizations.length}`);
  // Each later chunk builds on the previous chunk's summary.
  assert.match(text(summarizations[1]), /SUMMARY-MARKER-1/);
  for (const request of summarizations) assert.ok(text(request).length < 8000 * 4, `each summarization request fits the window (${text(request).length} characters)`);
  assert.ok(text(fake.chat().at(-1)!).length < 8000 * 4, "the model request fits the context window");
});

test("a context overflow from the provider compacts and retries the turn once", async t => {
  const fake = await provider(t, { overflowAboveChars: 24_000 });
  const supervisor = await fixture(t);
  // The configured window is huge, so only the provider's rejection reveals the real limit.
  await supervisor.start("overflow", { model: fake.model(1_000_000), apiKey: "fixture", retry: { maxAttempts: 0, baseDelayMs: 1 } }, bridge);
  const events: any[] = [];
  for (let index = 0; index < 3; index++) {
    const result = await supervisor.request("overflow", "prompt", { text: turn(index) }, event => events.push(event));
    assert.equal(result.error, null, `turn ${index}`);
  }
  assert.ok(events.some(event => event.type === "compaction_end" && event.reason === "overflow" && event.summarizedMessages > 0));
  const history = (await supervisor.request("overflow", "history")).messages;
  assert.equal(history.filter((message: any) => message.stopReason === "error").length, 0, "the rejected attempt is not history");
  assert.equal(history.length, 6);
  // A subscriber folding the stream counts the same: the rejected attempt ended, and was taken back.
  const ended = events.filter(event => event.type === "message_end").length;
  const retracted = events.filter(event => event.type === "message_retracted").length;
  assert.equal(ended - retracted, history.length);
});

test("compaction summaries bill their tokens and cost to the tenant, apart from the agent's turns", async t => {
  // The turns report the input they sent (about four characters a token): Pi decides to compact from the usage the
  // provider reports, so one that reported 10 tokens for every turn would never be compacted.
  const turnInput = (body: Body) => Math.ceil(text(body).length / 4);
  const fake = await provider(t, { usage: true, turnInput });
  const supervisor = await fixture(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db });
  const root = await mkdtemp(join(tmpdir(), "compaction-usage-"));
  const sessions = new ClientSessions(supervisor, { db, root, secret: "compaction-usage-secret-32-characters", apiKeyFor: () => "fixture", onUsage: (tenant, agent, message) => accounts.recordUsage(tenant, agent, message) });
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const { id } = await sessions.create([], { model: fake.model(8000, "turns") }, "billed", {}, "acme");
  for (let index = 0; index < 4; index++) {
    await sessions.submit(id, "acme", { id: `turn-${index}`, method: "prompt", params: { text: turn(index) } });
    await until(() => sessions.sessions.get(id)!.requests.get(`turn-${index}`)!.state === "completed", "the turn finishes");
    assert.equal((sessions.sessions.get(id)!.requests.get(`turn-${index}`)!.outcome as any).result.error, null);
  }
  // A summary may still be made in the background after the last turn.
  await until(async () => fake.state.inflight === 0 && (await accounts.usage("acme", Date.now() - 86_400_000)).totals.responses === 4 + fake.summarizations().length, "every response was billed");
  const summaries = fake.summarizations().length;
  assert.ok(summaries >= 1, "a summary was requested");
  const usage = await accounts.usage("acme", Date.now() - 86_400_000);
  const compaction = usage.days.filter(row => row.kind === "compaction");
  const turns = usage.days.filter(row => row.kind === "turn");
  assert.deepEqual(compaction.map(row => [row.model, row.responses, row.input, row.output]), [["openai/turns", summaries, 3000 * summaries, 200 * summaries]]);
  assert.ok(Math.abs(compaction[0].cost - summaries * (3000 * 1 + 200 * 10) / 1e6) < 1e-12, "priced at the summarizing model's rates");
  assert.deepEqual(turns.map(row => [row.model, row.responses, row.input]), [["openai/turns", 4, fake.chat().reduce((sum, body) => sum + turnInput(body), 0)]]);
  assert.equal(usage.totals.responses, 4 + summaries);
});

test("a prompt or tool change on an agent with history is appended after the cached prefix, and reloads and compaction keep it", async t => {
  const fake = await provider(t);
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "configure-cache-"));
  const storage = fileStorage(join(root, "state"));
  const nodes: AgentSupervisor[] = [];
  const node = (name: string) => {
    const supervisor = new AgentSupervisor(join(root, name), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage, db });
    nodes.push(supervisor);
    return supervisor;
  };
  t.after(async () => { for (const supervisor of nodes) await supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const model = { ...fake.model(8000), compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } } as Model<Api>;
  const lookup = { name: "lookup", description: "Look something up", parameters: { type: "object" }, exposure: "direct" as const };
  const tools = (definitions: typeof lookup[]) => ({ definitions, async call() { return "found"; } });
  const last = () => fake.chat().at(-1) as Body & { tools: unknown[] };
  const updates = (body: Body) => body.messages.filter(message => JSON.stringify(message).includes('Updated system prompt section \\"instructions\\"'));

  const a = node("a");
  await a.start("agent", { model, apiKey: "fixture", systemPrompt: "Original rules" }, tools([]));
  await a.request("agent", "prompt", { text: "one" });
  const first = last();
  assert.match(text(first), /Original rules/);
  await a.request("agent", "configure", { systemPrompt: "New rules", tools: [lookup] });
  await a.request("agent", "prompt", { text: "two" });
  const second = last();
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages, "the prefix the provider cached is byte-identical");
  assert.deepEqual(second.tools, first.tools, "the added tool is declared in place, not in the request's tool list");
  const change = second.messages.slice(first.messages.length + 1, -1);
  assert.match(JSON.stringify(change), /"name":"lookup"/);
  assert.equal(updates(second).length, 1);
  assert.match(JSON.stringify(updates(second)), /New rules/);
  assert.match(JSON.stringify(second.messages.at(-1)), /"role":"user".*"two"/);
  assert.ok((await a.request("agent", "history")).messages.every((message: any) => message.role !== "system"), "system messages are not history");

  // Another node loads the agent with its current configuration, as the stored header gives it.
  await a.stop("agent");
  const b = node("b");
  await b.start("agent", { model, apiKey: "fixture", systemPrompt: "New rules" }, tools([lookup]));
  await b.request("agent", "prompt", { text: "three" });
  const third = last();
  assert.deepEqual(third.messages.slice(0, second.messages.length), second.messages, "the reloaded context is the same");
  assert.equal(third.messages.length, second.messages.length + 2, "nothing was declared again");
  assert.deepEqual(third.tools, second.tools);

  // Compaction folds the change into the leading system message.
  const events: any[] = [];
  for (let index = 0; !events.some(event => event.type === "compaction_end" && event.summarizedMessages > 0); index++) {
    assert.ok(index < 6, "compaction ran");
    assert.equal((await b.request("agent", "prompt", { text: turn(index) }, event => events.push(event))).error, null);
  }
  // Background summaries can land after the request that triggered them; inspect the next request.
  await b.request("agent", "prompt", { text: "after compaction" });
  const compacted = last();
  assert.equal(updates(compacted).length, 0);
  assert.match(JSON.stringify(compacted.messages[0]), /New rules/);
  assert.doesNotMatch(JSON.stringify(compacted.messages[0]), /Original rules/);
  assert.match(JSON.stringify(compacted.tools), /"name":"lookup"/);
  await b.stop("agent");
  const c = node("c");
  await c.start("agent", { model, apiKey: "fixture", systemPrompt: "New rules" }, tools([lookup]));
  await c.request("agent", "prompt", { text: "after reload" });
  assert.deepEqual(last().messages[0], compacted.messages[0]);
  assert.deepEqual(last().tools, compacted.tools);
});

test("model calls require the agent's explicit key and never read provider keys from the environment", async () => {
  process.env.OPENAI_API_KEY = "host-key-that-must-not-be-used";
  try {
    const stream = explicitKeyStream();
    const model = { id: "gpt-4o", provider: "openai", api: "openai-completions", baseUrl: "http://127.0.0.1:9" } as Model<Api>;
    assert.throws(() => stream(model, normalizeContext({ messages: [] }), {}), /No openai API key/);
    assert.throws(() => stream(model, normalizeContext({ messages: [] }), { apiKey: "  " }), /No openai API key/);
  } finally { delete process.env.OPENAI_API_KEY; }
});

test("model and summarization requests carry only the tenant's key, whatever provider credentials the host has", async t => {
  const hostEnv = {
    OPENAI_API_KEY: "host-openai", OPENROUTER_API_KEY: "host-openrouter",
    ANTHROPIC_API_KEY: "host-anthropic", ANTHROPIC_OAUTH_TOKEN: "host-anthropic-oauth", ANTHROPIC_AUTH_TOKEN: "host-anthropic-bearer",
  };
  const headers: Record<string, string | string[] | undefined>[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    headers.push(req.headers);
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "fixture", type: "authentication_error" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  Object.assign(process.env, hostEnv);
  try {
    // Catalog models, so requests take pi-ai's built-in provider path.
    const models = [
      ["anthropic", "claude-sonnet-5", base], ["openrouter", "anthropic/claude-sonnet-5", base],
      ["openrouter", "openai/gpt-5.6-luna", `${base}/v1`], ["openai", "gpt-5.5", `${base}/v1`],
    ].map(([provider, id, baseUrl]) => ({ ...(getModel as (provider: string, id: string) => Model<Api>)(provider, id), baseUrl }));
    const context = normalizeContext({ systemPrompt: "fixture", messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
    for (const model of models) await (await explicitKeyStream()(model, context, { apiKey: `tenant-${model.provider}`, maxRetries: 0 })).result();
    // Compaction's summaries go through a separate pi-ai path.
    const turns = Array.from({ length: 6 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: index % 2 ? [{ type: "text", text: "x".repeat(4000) }] : "y".repeat(4000), timestamp: Date.now(), ...(index % 2 ? { api: models[0].api, provider: models[0].provider, model: models[0].id, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } : {}) })) as any[];
    await assert.rejects(runCompaction({ context: turns, offset: 0, model: models[0], apiKey: "tenant-anthropic", keepRecentTokens: 1_000 }), /fixture|401/);
    assert.equal(headers.length, models.length + 1);
    const sent = JSON.stringify(headers);
    for (const secret of Object.values(hostEnv)) assert.ok(!sent.includes(secret), `a request carried the host's ${secret}`);
    for (const [index, model] of [...models, models[0]].entries()) {
      const key = headers[index]["x-api-key"] ?? String(headers[index].authorization).replace(/^Bearer /, "");
      assert.equal(key, `tenant-${model.provider}`, `${model.provider}/${model.id}`);
    }
  } finally { for (const name of Object.keys(hostEnv)) delete process.env[name]; }
});

// Background compaction ---------------------------------------------------------------------------------------

/** Wait until `done()` holds, polling; fails after 30 s (a deadline, not a count of polls: a busy runner is slow). */
async function until(done: () => boolean | Promise<boolean>, what: string) {
  for (const deadline = Date.now() + 30_000; !await done(); await new Promise(resolve => setTimeout(resolve, 25))) {
    assert.ok(Date.now() < deadline, `timed out waiting until ${what}`);
  }
}
const small = (index: number) => `TURN-${index} ${"y".repeat(3000)}`;
type Records = Array<{ t: string; cut?: number; message?: { content?: unknown } }>;
const records = (log: { read(): Promise<unknown[]> }) => log.read() as Promise<Records>;

/** An agent of `fake`'s with an 8,000-token window, its background events collected, its turns run until a summary is asked for. */
async function nearLimit(t: { after(fn: () => Promise<void>): void }, fake: Awaited<ReturnType<typeof provider>>, supervisor: AgentSupervisor, id: string, extra: Record<string, unknown> = {}) {
  const background: any[] = [];
  await supervisor.start(id, { model: fake.model(8000), apiKey: "fixture" }, { ...bridge, background: (event: any) => background.push(event), ...extra } as never);
  const turns: any[] = [];
  for (let index = 0; !fake.state.inflight; index++) {
    assert.ok(index < 12, "the context reached the background threshold");
    const result = await supervisor.request(id, "prompt", { text: small(index) }, event => turns.push(event));
    assert.equal(result.error, null);
    // The summary is asked for as the turn ends.
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(background.some(event => event.type === "compaction_start" && event.background), "started in the background");
  assert.equal(turns.filter(event => event.type === "compaction_start").length, 0, "no turn waited for a summary");
  return background;
}

test("usage a response reported before the summary was written does not count against the context that replaced it", () => {
  const usage = (input: number) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const answer = (timestamp: number, input: number) => ({ role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "openai", model: "fixture", stopReason: "stop", usage: usage(input), timestamp }) as any;
  const summary = { role: "compactionSummary", summary: "S".repeat(400), tokensBefore: 100_000, timestamp: 2_000 } as any;
  const user = { role: "user", content: "next", timestamp: 2_500 } as any;
  // Made while the summary was being written (before it), from the whole context: about 100k tokens.
  assert.ok(contextTokens([summary, answer(1_500, 100_000), user]) < 200);
  // Once a request carried the summary, its report is the measure.
  assert.ok(contextTokens([summary, answer(1_500, 100_000), user, answer(3_000, 5_000)]) >= 5_010);
});

test("runLimits.contextTokens compacts a large-window model's context below it, where the window alone would not", async t => {
  const fake = await provider(t);
  const supervisor = await fixture(t);
  const background: any[] = [], unbounded: any[] = [];
  await supervisor.start("bounded", { model: fake.model(1_000_000), apiKey: "fixture", runLimits: { contextTokens: 20_000 } }, { ...bridge, background: (event: any) => background.push(event) } as never);
  await supervisor.start("unbounded", { model: fake.model(1_000_000), apiKey: "fixture" }, { ...bridge, background: (event: any) => unbounded.push(event) } as never);
  // About 2,250 tokens a turn: past 14,000 (20,000 less its reserve and background margin) after seven. A compaction is
  // in the background (legacy) or in the turn's own stream (Pi).
  for (let index = 0; index < 9; index++) {
    for (const id of ["bounded", "unbounded"]) assert.equal((await supervisor.request(id, "prompt", { text: turn(index) }, event => (id === "bounded" ? background : unbounded).push(event))).error, null);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await until(() => background.some(event => event.type === "compaction_end"), "the bounded agent compacted");
  const ended = background.find(event => event.type === "compaction_end");
  assert.ok(ended.summarizedMessages > 0 && ended.tokensBefore < 20_000, JSON.stringify(ended));
  assert.equal(unbounded.filter(event => event.type.startsWith("compaction")).length, 0, "the window alone is far off");
  assert.equal((await supervisor.request("bounded", "status")).compacted, true);
  assert.equal((await supervisor.request("unbounded", "status")).compacted, false);
  await supervisor.request("bounded", "prompt", { text: "AFTER" });
  const sent = text(fake.chat().at(-1)!);
  assert.match(sent, /SUMMARY-MARKER-[0-9]+[\s\S]*AFTER/, `the summary took over: ${sent.match(/TURN-[0-9]+|SUMMARY-MARKER-[0-9]+|AFTER/g)}`);
  assert.doesNotMatch(sent, /TURN-0 /);
});

test("a mount added after the first message is appended after the cached prefix, not rebuilt into the leading system message", async t => {
  const fake = await provider(t);
  const root = await mkdtemp(join(tmpdir(), "mount-cache-"));
  const storage = fileStorage(join(root, "state"));
  const { db } = await testDatabase();
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage, db });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const model = { ...fake.model(100_000), compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true } } as Model<Api>;
  const workspace = { path: "/workspace", mode: "rw" as const };
  await supervisor.start("agent", { model, apiKey: "fixture", systemPrompt: "Rules", mounts: [workspace] }, bridge);
  await supervisor.request("agent", "prompt", { text: "one" });
  const first = fake.chat().at(-1)!;
  assert.match(text(first), /\/workspace \(read-write\)/);
  assert.doesNotMatch(text(first), /\/bot/);
  // A mount change starts the agent again with its new mounts, which its environment section describes.
  await supervisor.stop("agent");
  await supervisor.start("agent", { model, apiKey: "fixture", systemPrompt: "Rules", mounts: [{ path: "/bot", mode: "rw" }, workspace] }, bridge);
  await supervisor.request("agent", "prompt", { text: "two" });
  const second = fake.chat().at(-1)!;
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages, "the prefix the provider cached is byte-identical");
  assert.match(JSON.stringify(second.messages.slice(first.messages.length)), /Updated system prompt section \\"environment\\"[\s\S]*\/bot \(read-write\)/);
  // The agent's records, from whichever store its engine keeps them in.
  const log = await supervisor.records("agent");
  assert.equal(log.filter(record => record.t === "system" && (record as { leading?: boolean }).leading).length, 1, "pinned once, with the first message");
});

test("under runLimits.contextTokens, a context whose fixed part nearly fills the limit is not summarized again on every turn", async t => {
  const fake = await provider(t);
  const supervisor = await fixture(t);
  const background: any[] = [];
  // About 9,000 tokens of system prompt: with the summary and recent messages, near the 20,000 limit's background threshold.
  await supervisor.start("tight", { model: fake.model(1_000_000), apiKey: "fixture", systemPrompt: `Rules ${"r".repeat(36_000)}`, runLimits: { contextTokens: 20_000 } }, { ...bridge, background: (event: any) => background.push(event) } as never);
  const turns = 16;
  for (let index = 0; index < turns; index++) {
    // At the limit a turn waits for its summary (its own stream); below it, the summary is made in the background.
    assert.equal((await supervisor.request("tight", "prompt", { text: turn(index) }, event => background.push(event))).error, null);
    await until(() => !background.some(event => event.type === "compaction_start") || background.filter(event => event.type === "compaction_end").length === background.filter(event => event.type === "compaction_start").length, "the compaction ended");
  }
  const ended = background.filter(event => event.type === "compaction_end" && event.summarizedMessages > 0);
  assert.ok(ended.length >= 2, `it compacts: ${ended.length}`);
  // A quarter of the limit (5,000 tokens) is about two turns: never a summary on every turn.
  assert.ok(ended.length <= turns / 2, `${ended.length} compactions in ${turns} turns`);
});

test("the system prompt counts once: a provider's usage report already includes it, a bare estimate does not", async t => {
  const fake = await provider(t);
  const model = fake.model(25_000);
  const usage = (input: number) => ({ input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const user = { role: "user", content: "next", timestamp: 1 } as any;
  const answer = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "openai", model: "fixture", stopReason: "stop", usage: usage(15_000), timestamp: 2 } as any;
  // 15,000 reported (system prompt included) is below the 17,500 where a 25,000 window starts compacting in the background.
  assert.equal(contextTokens([user, answer], 9_000), 15_010);
  assert.equal(compactionNeed([user, answer], model, 9_000), undefined);
  // With no report, the estimate is all there is: the system prompt is added to it.
  assert.ok(contextTokens([user], 9_000) >= 9_000);
  const long = [{ role: "user", content: "x".repeat(40_000), timestamp: 1 } as any];
  assert.equal(compactionNeed(long, model), undefined, "about 10,000 estimated");
  assert.equal(compactionNeed(long, model, 9_000), "background", "and 9,000 more for the system prompt");
});

test("a compaction whose cut keeps every message makes no summary call and writes nothing", async t => {
  const fake = await provider(t);
  const context = [
    { role: "user", content: "Remember the task code PELICAN-42.", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "noted" }], api: "openai-completions", provider: "openai", model: "fixture", stopReason: "stop", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { role: "user", content: "next", timestamp: 3 },
  ] as any[];
  const outcome = await runCompaction({ context, offset: 0, model: fake.model(25_000), apiKey: "fixture" });
  assert.ok("skipped" in outcome, JSON.stringify(outcome));
  assert.equal(fake.summarizations().length, 0);
});

test("compaction persists each summary attempt and settles before reporting usage", async t => {
  const fake = await provider(t, { usage: true });
  const { db } = await testDatabase();
  const account = new Accounts({ tenants: new Tenants({ read: async () => '{"tenants":{}}' }), db });
  const { ModelAttempts } = await import("../src/model-attempts.ts");
  const attempts = new ModelAttempts(db, account);
  const context = [
    { role:"user",content:"x".repeat(20000),timestamp:1 },
    { role:"assistant",content:[{type:"text",text:"noted"}],api:"openai-completions",provider:"openai",model:"fixture",stopReason:"stop",timestamp:2,
      usage:{input:5000,output:1,cacheRead:0,cacheWrite:0,totalTokens:5001,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} },
    { role:"user",content:"next",timestamp:3 },
  ] as any[];
  context.splice(2, 0, { ...context[0], timestamp: 3 }, { ...context[1], timestamp: 4 });
  let reported = 0;
  const outcome = await runCompaction({context,offset:0,model:fake.model(25000),apiKey:"fixture",keepRecentTokens:1000,
    attempt:event=>attempts.event("tenant","agent",false,false,event),
    onResponse:message=>{assert.ok((message.usage as any).billingAttemptId);reported++;account.recordUsage("tenant","agent",{...message,kind:"compaction"});}});
  assert.ok("state" in outcome, JSON.stringify(outcome));assert.ok(reported>0);
  await account.flushUsage();
  const rows=(await db.query("select kind,state from model_attempts")).rows;
  assert.equal(rows.length,reported);assert.ok(rows.every(row=>row.kind==="compaction" && row.state==="settled"));
  assert.equal(Number((await db.query("select sum(responses) n from usage")).rows[0].n),reported);
});


test("Pi applies a lowered context limit to an already loaded host", async t => {
  const fake = await provider(t);
  const supervisor = await fixture(t);
  await supervisor.start("live-pi-context", { model: fake.model(128000), apiKey: "fixture", codeMode: false }, bridge);
  await supervisor.request("live-pi-context", "prompt", { text: "Before the limit changes" });
  await supervisor.request("live-pi-context", "configure", { runLimits: { contextTokens: 20000 } });
  for (let index = 0; index < 4; index++) {
    const result = await supervisor.request("live-pi-context", "prompt", { text: `live-context-${index} ${"x".repeat(30000)}` });
    assert.equal(result.error, null);
  }
  assert.ok(fake.summarizations().length > 0, "the new limit compacts without restarting the host");
  assert.equal((await supervisor.request("live-pi-context", "status")).compacted, true);
  assert.equal((await supervisor.request("live-pi-context", "history")).messages.length, 10);
});


/** Direct host with deterministic provider gates: assert the actual host projection as well as Pi's journal. */
async function backgroundHost(t: { after(fn: () => Promise<void>): void }, fake: Awaited<ReturnType<typeof provider>>, options: {
  runLimit?: HostIO["runLimit"]; tool?: HostIO["tool"];
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-background-"));
  const storage = new MemoryStorage();
  const log = fileAppendLog<TranscriptRecord>(join(directory, "transcript.jsonl"));
  const events: any[] = [], attempts: any[] = [];
  const host = createAgentHost({
    emit: event => events.push(event), transcript: log, piStorage: async () => storage,
    tool: options.tool ?? (async () => "found"), cancelTools: async () => {},
    runLimit: options.runLimit ?? (async () => undefined),
    modelAttempt: async event => { attempts.push(event); return true; },
    file: async () => { throw new Error("no files"); }, fs: async () => { throw new Error("no files"); },
    modelAuth: async () => ({ apiKey: "fixture" }),
  });
  t.after(async () => { fake.release(); await host.dispose(0); await rm(directory, { recursive: true, force: true }); });
  // Together with the host prompt, inside the 8,192-window background band and below its blocking threshold.
  const initialMessages = Array.from({ length: 16 }, (_, index) => index % 2 === 0
    ? { role: "user", content: `OLD-${index} ${"x".repeat(1980)}`, timestamp: index + 1 }
    : { role: "assistant", content: [{ type: "text", text: `ACK-${index}` }], api: "openai-completions", provider: "openai", model: "fixture", stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: index + 1 });
  await host.handle("init", { id: "background", directory, model: fake.model(100_000), runLimits: { contextTokens: 8192 }, apiKey: "fixture",
    dataCollection: "deny", initialMessages, tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} }, exposure: "direct" }] });
  const history = async () => { const transcript = new Transcript(undefined as never); for (const record of (await nativeTranscriptRecords(storage))!) transcript.apply(record); return transcript; };
  return { host, storage, events, attempts, history, initialMessages };
}

for (const duringTool of [false, true]) test(`native background summary lands ${duringTool ? "during a tool round" : "between turns"} without losing host messages`, async t => {
  const fake = await provider(t, { gated: true });
  const toolStarted = Promise.withResolvers<void>(), finishTool = Promise.withResolvers<void>();
  t.after(async () => { finishTool.resolve(); fake.release(); });
  const f = await backgroundHost(t, fake, { tool: async () => { toolStarted.resolve(); await finishTool.promise; return "TOOL-RESULT"; } });
  const first = f.host.handle("prompt", { text: "FIRST" });
  await until(() => fake.state.inflight === 1 && fake.chat().length === 1, "summary and turn requests run concurrently");
  assert.equal((await first).error, null, "the turn ends before the summary is released");
  assert.equal(f.events.filter(event => event.type === "compaction_end").length, 0);
  assert.ok(f.events.some(event => event.type === "compaction_start" && event.background === true));
  let second: Promise<any> | undefined;
  if (duringTool) {
    fake.toolNext();
    second = f.host.handle("prompt", { text: "SECOND" });
    await toolStarted.promise;
  }
  fake.release();
  await until(() => f.events.some(event => event.type === "compaction_usage"), "summary completed and was accounted");
  if (duringTool) finishTool.resolve();
  if (second) assert.equal((await second).error, null);
  await until(() => f.events.some(event => event.type === "compaction_end"), "summary adopted by host");
  const end = f.events.find(event => event.type === "compaction_end");
  assert.equal(end.background, true);
  assert.ok(end.keptMessages > 0 && end.summarizedMessages > 0);
  const projected = await f.history();
  const all = await f.host.handle("history", {});
  const history = all.messages;
  assert.equal(history.length, f.initialMessages.length + (duringTool ? 6 : 2));
  assert.equal(history.filter((item: any) => JSON.stringify(item).includes('"FIRST"')).length, 1);
  if (duringTool) {
    assert.equal(history.filter((item: any) => JSON.stringify(item).includes('"SECOND"')).length, 1);
    assert.equal(history.filter((item: any) => item.role === "toolResult").length, 1);
  }
  assert.deepEqual(projected.context, history.slice(projected.offset), "the host keeps exactly the unsummarized tail");
  assert.equal(projected.compaction?.cut, end.summarizedMessages);
  const entries = await f.storage.scanEntries({ conversationId: 1 as never }, 1000, undefined, BACKGROUND_CONTEXT);
  assert.equal(entries.items.filter(entry => entry.kind === "camel.compaction.usage").length, 1);
  const compactionAttempts = f.attempts.filter(event => event.type === "begin" && event.kind === "compaction");
  assert.equal(compactionAttempts.length, 1, "background requests use compaction billing attempts");
  assert.equal(f.events.filter(event => event.type === "compaction_usage" && event.background === true).length, 1);
  assert.ok(f.attempts.some(event => event.type === "finish" && event.id === compactionAttempts[0].id && event.completed), "the background billing attempt settles");
  await f.host.handle("prompt", { text: "AFTER" });
  const sent = text(fake.chat().at(-1)!);
  assert.match(sent, /SUMMARY-MARKER/);
  assert.match(sent, /FIRST/);
  assert.doesNotMatch(sent, /OLD-0 /);
  if (duringTool) assert.match(sent, /TOOL-RESULT/);
});

test("native background compaction declines before any summary request when the host spend limit is reached", async t => {
  const fake = await provider(t);
  let checks = 0;
  const f = await backgroundHost(t, fake, { runLimit: async () => { checks++; return { stopped: "spend_limit", message: "Cap reached", limit: "agent" }; } });
  assert.equal((await f.host.handle("prompt", { text: "FIRST" })).error, null);
  await until(() => checks > 0, "background compactor checks spend");
  const tasks = await f.storage.scanTasks({ kind: "pi.compaction" }, 100, undefined, BACKGROUND_CONTEXT);
  assert.ok(tasks.items.some(task => task.background && task.state.status === "terminal" && task.state.outcome.status === "completed"));
  assert.equal(fake.summarizations().length, 0);
  assert.equal(f.attempts.filter(event => event.type === "begin" && event.kind === "compaction").length, 0);
  assert.equal(f.events.filter(event => event.type.startsWith("compaction_")).length, 0);
  assert.equal((await f.host.handle("history", {})).messages.length, f.initialMessages.length + 2);
});
