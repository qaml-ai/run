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
import { explicitKeyStream, runCompaction } from "../src/compaction.ts";
import { readTranscript } from "../src/transcript.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { testDatabase } from "./database.ts";
import { fileStorage } from "../shared/storage.ts";

type Body = { messages: { role: string; content: unknown }[] };
const text = (body: Body) => JSON.stringify(body.messages);
const isSummarization = (body: Body) => text(body).includes("context summarization assistant");

/** An OpenAI-compatible provider that reports no usage, like some proxies, unless `usage` is set. */
async function provider(t: { after(fn: () => Promise<void>): void }, options: { overflowAboveChars?: number; usage?: boolean } = {}) {
  const requests: Body[] = [];
  let summaries = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Body;
    requests.push(body);
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
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const model = (contextWindow: number, id = "fixture") => ({
    id, name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    reasoning: false, input: ["text"], cost: { input: 1, output: 10, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 1000,
  }) as Model<Api>;
  return { requests, model, chat: () => requests.filter(body => !isSummarization(body)), summarizations: () => requests.filter(isSummarization) };
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
  const started = await supervisor.start("legacy", { model: fake.model(8000), apiKey: "fixture" }, inspect);
  assert.equal(started.messages, 20);
  assert.deepEqual((await supervisor.request("legacy", "history")).messages, before);
  const result = await supervisor.request("legacy", "prompt", { text: "After the upgrade" });
  assert.equal(result.error, null);
  const sent = text(fake.chat().at(-1)!);
  assert.match(sent, /SUMMARY-write-4/, "the stored summary is the context's start");
  assert.doesNotMatch(sent, /TURN-0 /);
  assert.match(sent, /"name":"inspect"/, "stored tool calls replay");
  assert.match(sent, /"role":"tool"/, "stored tool results replay");
  const events: any[] = [];
  for (let index = 0; index < 3; index++) assert.equal((await supervisor.request("legacy", "prompt", { text: turn(index) }, event => events.push(event))).error, null);
  assert.ok(events.some(event => event.type === "compaction_end" && event.summarizedMessages > 0));
  assert.match(text(fake.summarizations()[0]), /SUMMARY-write-4/, "the stored summary seeds the next one");
  assert.deepEqual((await supervisor.request("legacy", "history")).messages.slice(0, 20), before);
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
