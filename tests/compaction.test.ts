import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { contextTokens, explicitKeyStream, runCompaction } from "../src/compaction.ts";
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
async function provider(t: { after(fn: () => Promise<void>): void }, options: { overflowAboveChars?: number; usage?: boolean; gated?: boolean } = {}) {
  const requests: Body[] = [];
  let summaries = 0;
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
    const reply = isSummarization(body) ? `## Goal\nSUMMARY-MARKER-${++summaries}` : "ack";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
    const usage = options.usage ? { usage: isSummarization(body) ? { prompt_tokens: 3000, completion_tokens: 200 } : { prompt_tokens: 10, completion_tokens: 1 } } : {};
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...usage })}\n\n`);
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
  return { requests, model, release, state, chat: () => requests.filter(body => !isSummarization(body)), summarizations: () => requests.filter(isSummarization) };
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
  await supervisor.start("long", { model, apiKey: "fixture" }, bridge);
  const events: any[] = [];
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
  for (let tries = 0; !events.some(event => event.type === "compaction_end" && event.summarizedMessages > 0); tries++) {
    assert.ok(tries < 200, "a compaction ran");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
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
  const fake = await provider(t, { usage: true });
  const supervisor = await fixture(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db });
  const root = await mkdtemp(join(tmpdir(), "compaction-usage-"));
  const sessions = new ClientSessions(supervisor, { db, root, secret: "compaction-usage-secret-32-characters", apiKeyFor: () => "fixture", onUsage: (tenant, agent, message) => accounts.recordUsage(tenant, agent, message) });
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const { id } = await sessions.create([], { model: fake.model(8000, "turns") }, "billed", {}, "acme");
  for (let index = 0; index < 4; index++) {
    await sessions.submit(id, "acme", { id: `turn-${index}`, method: "prompt", params: { text: turn(index) } });
    for (let tries = 0; sessions.sessions.get(id)!.requests.get(`turn-${index}`)!.state !== "completed"; tries++) {
      assert.ok(tries < 400, "the turn finishes");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
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
  assert.deepEqual(turns.map(row => [row.model, row.responses, row.input]), [["openai/turns", 4, 40]]);
  assert.equal(usage.totals.responses, 4 + summaries);
});

test("a prompt or tool change on an agent with history is appended after the cached prefix, and reloads and compaction keep it", async t => {
  const fake = await provider(t);
  const root = await mkdtemp(join(tmpdir(), "configure-cache-"));
  const storage = fileStorage(join(root, "state"));
  const nodes: AgentSupervisor[] = [];
  const node = (name: string) => {
    const supervisor = new AgentSupervisor(join(root, name), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage });
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

/** Wait until `done()` holds, polling; fails after about 5 s. */
async function until(done: () => boolean | Promise<boolean>, what: string) {
  for (let tries = 0; !await done(); tries++) {
    assert.ok(tries < 200, `timed out waiting until ${what}`);
    await new Promise(resolve => setTimeout(resolve, 25));
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

test("past the threshold, the next turn starts at once with the whole context while the summary is made in the background", async t => {
  const fake = await provider(t, { gated: true });
  const supervisor = await fixture(t);
  const background = await nearLimit(t, fake, supervisor, "eager");
  const before = fake.chat().length;
  const started = Date.now();
  const events: any[] = [];
  const result = await supervisor.request("eager", "prompt", { text: "NEXT-TURN" }, event => events.push(event));
  assert.equal(result.error, null);
  assert.ok(Date.now() - started < 2_000, "the turn did not wait for the summary");
  assert.equal(fake.chat().length, before + 1);
  assert.match(text(fake.chat().at(-1)!), /TURN-0 /, `it went with the whole context: ${text(fake.chat().at(-1)!).match(/TURN-[0-9]+|SUMMARY[^\\]*/g)}`);
  assert.equal(events.filter(event => event.type.startsWith("compaction")).length, 0, "the run's stream carries no compaction");
  assert.equal(fake.state.inflight, 1, "the summary is still being made");
  assert.equal((await supervisor.request("eager", "status")).compacted, false);

  fake.release();
  await until(() => background.some(event => event.type === "compaction_end"), "the compaction ended");
  const ended = background.find(event => event.type === "compaction_end");
  assert.ok(ended.summarizedMessages > 0 && ended.background, JSON.stringify(ended));
  assert.ok(background.some(event => event.type === "compaction_usage" && event.background));
  assert.equal((await supervisor.request("eager", "status")).compacted, true);
  await supervisor.request("eager", "prompt", { text: "AFTER" });
  assert.match(text(fake.chat().at(-1)!), /SUMMARY-MARKER-1/, "the summary took over");
  assert.doesNotMatch(text(fake.chat().at(-1)!), /TURN-0 /);
});

test("messages appended while a background summary is made follow its cut: the summary replaces only the prefix it covered", async t => {
  const fake = await provider(t, { gated: true });
  const root = await mkdtemp(join(tmpdir(), "compaction-concurrent-"));
  const storage = fileStorage(join(root, "state"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
  const background = await nearLimit(t, fake, supervisor, "concurrent");
  const summarizing = (await supervisor.request("concurrent", "status")).messages;
  // Two more turns while the summary is made: their messages land after everything it read.
  for (const marker of ["CONCURRENT-A", "CONCURRENT-B"]) assert.equal((await supervisor.request("concurrent", "prompt", { text: marker })).error, null);
  fake.release();
  await until(() => background.some(event => event.type === "compaction_end"), "the compaction ended");
  const log = await records(storage.log(AgentSupervisor.transcriptKey("concurrent")));
  const compactions = log.filter(record => record.t === "compaction");
  assert.equal(compactions.length, 1);
  assert.ok(compactions[0].cut! < summarizing, "the cut is within what the summary read");
  const status = await supervisor.request("concurrent", "status");
  assert.equal(status.messages, summarizing + 4);
  assert.equal(status.contextMessages, status.messages - compactions[0].cut!, "everything after the cut stays in the working set");
  await supervisor.request("concurrent", "prompt", { text: "AFTER" });
  const sent = text(fake.chat().at(-1)!);
  assert.match(sent, /SUMMARY-MARKER-1/);
  assert.match(sent, /CONCURRENT-A[\s\S]*CONCURRENT-B[\s\S]*AFTER/, "the turns made meanwhile are kept, in order");
  assert.doesNotMatch(text(fake.summarizations()[0]), /CONCURRENT-/, "and were not summarized");
  // After a restart, the log replays to the same working set.
  await supervisor.stop("concurrent");
  await supervisor.start("concurrent", { model: fake.model(8000), apiKey: "fixture" }, bridge);
  assert.equal((await supervisor.request("concurrent", "status")).contextMessages, status.contextMessages + 2);
  assert.equal((await supervisor.request("concurrent", "history")).messages.length, status.messages + 2);
});

test("a turn that would not fit waits for the background summary instead of starting another, and one with none running compacts first", async t => {
  const fake = await provider(t, { gated: true });
  const supervisor = await fixture(t);
  const background = await nearLimit(t, fake, supervisor, "waits");
  const before = fake.chat().length;
  const events: any[] = [];
  // Past the window less its reserve: this turn cannot go until the context is compacted.
  const pending = supervisor.request("waits", "prompt", { text: `HUGE ${"z".repeat(6000)}` }, event => events.push(event));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(fake.chat().length, before, "it waits for the summary");
  fake.release();
  assert.equal((await pending).error, null);
  assert.equal(fake.state.maxInflight, 1, "one compaction at a time");
  assert.equal(events.filter(event => event.type === "compaction_start").length, 0, "the summary that made it fit was the background one");
  assert.ok(background.some(event => event.type === "compaction_end" && event.summarizedMessages > 0));
  assert.match(text(fake.chat().at(-1)!), /SUMMARY-MARKER-1[\s\S]*HUGE/);

  // Without one running, a turn that would not fit compacts first, on its own stream.
  const fresh = await provider(t);
  const initialMessages = Array.from({ length: 6 }, (_, index) => [
    { role: "user", content: `IMPORTED-${index} ${"w".repeat(3000)}`, timestamp: index * 2 },
    { role: "assistant", content: [{ type: "text", text: `answer ${index}` }], api: "openai-completions", provider: "openai", model: "fixture", stopReason: "stop", timestamp: index * 2 + 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ]).flat() as any[];
  const forced: any[] = [];
  await supervisor.start("forced", { model: fresh.model(8000), apiKey: "fixture", initialMessages }, bridge);
  assert.equal((await supervisor.request("forced", "prompt", { text: `HUGE ${"z".repeat(9000)}` }, event => forced.push(event))).error, null);
  const start = forced.find(event => event.type === "compaction_start");
  assert.ok(start && !start.background, "the turn compacted first");
  assert.ok(forced.findIndex(event => event.type === "compaction_end") < forced.findIndex(event => event.type === "message_update"), "before its model request");
  assert.ok(fresh.requests.findIndex(isSummarization) < fresh.requests.findIndex(body => !isSummarization(body)));
  assert.doesNotMatch(text(fresh.chat().at(-1)!), /IMPORTED-0 /);
});

test("a node lost mid-compaction cannot write its summary: the next owner serves the agent, compacts once, and history stays whole", async t => {
  const fake = await provider(t, { gated: true });
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const root = await mkdtemp(join(tmpdir(), "compaction-failover-"));
  const owners = [new Ownership(db, { node: "http://a" }), new Ownership(db, { node: "http://b" })];
  const [a, b] = ["a", "b"].map(name => new AgentSupervisor(join(root, name), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage }));
  for (const owner of owners) await owner.start();
  t.after(async () => {
    fake.release();
    for (const node of [a, b]) await node.close().catch(() => {});
    for (const owner of owners) await owner.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const id = "failover";
  const claim = async (owner: Ownership) => { const taken = await owner.acquire(id); assert.ok("claim" in taken); return taken.claim; };
  const model = fake.model(8000);
  const onA: any[] = [];
  await a.start(id, { model, apiKey: "fixture" }, { ...bridge, background: (event: any) => onA.push(event) } as never, await claim(owners[0]));
  for (let index = 0; !fake.state.inflight; index++) {
    assert.ok(index < 12, "the context reached the background threshold");
    assert.equal((await a.request(id, "prompt", { text: small(index) })).error, null);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const total = (await a.request(id, "status")).messages;

  // A's heartbeat lapses while its summary is being made, and B takes the agent over: A's claim is no longer current.
  await db.query("update actor_owners set node = null, session = null where actor = $1", [id]);
  const onB: any[] = [];
  const started = await b.start(id, { model, apiKey: "fixture" }, { ...bridge, background: (event: any) => onB.push(event) } as never, await claim(owners[1]));
  assert.equal(started.messages, total, "B loads the whole history");
  assert.equal((await b.request(id, "prompt", { text: "ON-B" })).error, null, "B serves the agent meanwhile");
  await until(() => fake.state.inflight === 2, "B began its own summary");

  fake.release();
  await until(() => onA.some(event => event.type === "compaction_end") && onB.some(event => event.type === "compaction_end"), "both compactions ended");
  assert.ok(onA.find(event => event.type === "compaction_end").error, "A's write was fenced");
  assert.ok(onB.find(event => event.type === "compaction_end").summarizedMessages > 0, "B's summary was written");
  const log = await records(storage.log(AgentSupervisor.transcriptKey(id)));
  assert.equal(log.filter(record => record.t === "compaction").length, 1, "one compaction, B's");
  assert.equal(log.filter(record => record.t === "message").length, total + 2);
  assert.equal((await b.request(id, "prompt", { text: "AFTER" })).error, null);
  assert.match(text(fake.chat().at(-1)!), /SUMMARY-MARKER-\d[\s\S]*ON-B[\s\S]*AFTER/);
  assert.equal((await b.request(id, "history")).messages.length, total + 4);
});

test("a background compaction is billed like any: to the tenant as compaction, outside any run, and against the agent's spend limit", async t => {
  const fake = await provider(t, { usage: true });
  const supervisor = await fixture(t);
  const { db } = await testDatabase();
  const accounts = new Accounts({ tenants: new Tenants({ read: async () => JSON.stringify({ tenants: {} }) }), db });
  const root = await mkdtemp(join(tmpdir(), "compaction-background-usage-"));
  const recorded: any[] = [];
  const sessions = new ClientSessions(supervisor, { db, root, secret: "compaction-usage-secret-32-characters", apiKeyFor: () => "fixture", onUsage: (tenant, agent, message) => { recorded.push(message); accounts.recordUsage(tenant, agent, message); } });
  t.after(async () => { await sessions.close(); await rm(root, { recursive: true, force: true }); });
  const { id } = await sessions.create([], { model: fake.model(8000, "turns") }, "billed", {}, "acme");
  const run = async (request: string, method: string, params: Record<string, unknown>) => {
    await sessions.submit(id, "acme", { id: request, method, params });
    await until(() => sessions.sessions.get(id)!.requests.get(request)!.state === "completed", `${request} finished`);
    return (sessions.sessions.get(id)!.requests.get(request)!.outcome as any).result;
  };
  await run("budget", "configure", { spendLimit: { usd: 100 } });
  for (let index = 0; !recorded.some(message => message.kind === "compaction"); index++) {
    assert.ok(index < 12, "a compaction ran");
    assert.equal((await run(`turn-${index}`, "prompt", { text: small(index) })).error, null);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await until(() => fake.state.inflight === 0 && recorded.filter(message => message.kind === "compaction").length === fake.summarizations().length, "every summary was billed");
  const summaries = recorded.filter(message => message.kind === "compaction");
  assert.ok(summaries.every(message => message.requestId === undefined && message.background), "made between runs, by no run");
  const turns = recorded.filter(message => message.kind !== "compaction").length;
  const usage = await accounts.usage("acme", Date.now() - 86_400_000);
  assert.deepEqual(usage.days.filter(row => row.kind === "compaction").map(row => [row.model, row.responses, row.input, row.output]), [["openai/turns", summaries.length, 3000 * summaries.length, 200 * summaries.length]]);
  const [{ spent }] = (await db.query("select spent from agent_spend_limits where agent = $1", [id])).rows;
  assert.ok(Math.abs(Number(spent) - (summaries.length * 5000 + turns * 20) / 1e6) < 1e-9, `the agent's spend counts the summaries: ${spent}`);
});

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
  // About 2,250 tokens a turn: past 14,000 (20,000 less its reserve and background margin) after seven.
  for (let index = 0; index < 9; index++) {
    for (const id of ["bounded", "unbounded"]) assert.equal((await supervisor.request(id, "prompt", { text: turn(index) })).error, null);
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
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage });
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
  const log = await records(storage.log(AgentSupervisor.transcriptKey("agent")));
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
