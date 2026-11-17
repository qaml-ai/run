import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import type { Db } from "../src/db.ts";
import { IDLE_SUMMARY_PROMPT } from "../src/model-idle-compaction.ts";
import { idleCompactionWindow } from "../src/idle-compaction.ts";
import { supervisorMessages } from "./fixtures/journal-messages.ts";
import { testDatabase } from "./database.ts";

async function until(check: () => unknown | Promise<unknown>, message: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

async function fixture(t: TestContext, options: { cacheTokens?: number; blockSummary?: boolean; db?: Db } = {}) {
  const requests: any[] = [];
  const events: any[] = [];
  const gate = Promise.withResolvers<void>();
  const summary = (body: any) => JSON.stringify(body.messages).includes(IDLE_SUMMARY_PROMPT);
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    const idle = summary(body);
    if (idle && options.blockSummary) await gate.promise;
    if (res.destroyed) return;
    const reply = idle ? "IDLE-SUMMARY preserves the earliest customer requirement." : "ack";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: reply }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 70_100, completion_tokens: idle ? 20 : 1, prompt_tokens_details: { cached_tokens: options.cacheTokens ?? 70_000 } } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const root = await mkdtemp(join(tmpdir(), "idle-compaction-"));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, ...(options.db ? { db: options.db } : {}) });
  t.after(async () => {
    gate.resolve();
    await supervisor.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const model: Model<Api> = {
    id: "fixture", name: "Fixture", provider: "openai", api: "openai-completions", reasoning: false,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, input: ["text"],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 0 }, contextWindow: 500_000, maxTokens: 8_192,
  };
  const initialMessages = Array.from({ length: 12 }, (_, index) => [
    { role: "user" as const, timestamp: index * 2, content: [{ type: "text" as const, text: `ORIGINAL-${index} ${"history ".repeat(1_500)}` }] },
    { ...fauxAssistantMessage(`ANSWER-${index}`, { timestamp: index * 2 + 1 }), provider: model.provider, model: model.id },
  ]).flat();
  const attempts: any[] = [];
  const bridge = {
    definitions: [], async call() { return null; }, background: (event: unknown) => events.push(event),
    modelAttempt: async (event: unknown) => { attempts.push(event); return true; },
  };
  return { supervisor, root, model, initialMessages, bridge, attempts, events, requests,
    summaries: () => requests.filter(summary), chats: () => requests.filter(body => !summary(body)), release: () => gate.resolve() };
}

test("idle compaction starts before cache expiry and the node's unload deadline", () => {
  assert.deepEqual(idleCompactionWindow(0, 300_000, 10_000, 300_000), { dueAt: 240_000, expiresAt: 300_000 });
  assert.deepEqual(idleCompactionWindow(0, 3_600_000, 10_000, 300_000), { dueAt: 250_000, expiresAt: 3_600_000 });
  assert.deepEqual(idleCompactionWindow(0, 300_000, 260_000, 300_000), { dueAt: 240_000, expiresAt: 300_000 });
});

test("existing agents compact by default while idle, preserve history and resume from the summary", async t => {
  const f = await fixture(t);
  await f.supervisor.start("existing", { model: f.model, apiKey: "fixture", idleTimeoutMs: 150, initialMessages: f.initialMessages }, f.bridge);
  const turn = await f.supervisor.request("existing", "prompt", { text: "Finish this turn", requestId: "first" });
  assert.equal(turn.error, null);
  await until(() => f.events.some(event => event.type === "idle_compaction_finished"), "idle compaction finished");
  assert.equal(f.summaries().length, 1);
  const before = f.chats()[0], summary = f.summaries()[0];
  assert.deepEqual(summary.messages.slice(0, -1), before.messages, "the serialized cached prefix is unchanged");
  assert.equal(summary.max_tokens ?? summary.max_completion_tokens, 4_096);
  assert.ok(f.events.some(event => event.type === "compaction_usage" && event.background === true));
  assert.ok(f.events.some(event => event.type === "compaction_end" && event.background === true));
  const attempt = f.attempts.find(event => event.type === "begin" && event.kind === "compaction");
  assert.equal(attempt.background, true);
  assert.equal(attempt.estimate.cachedTokens, Math.min(attempt.estimate.inputTokens, 70_000));
  const history = await supervisorMessages(f.supervisor, "existing");
  assert.equal(history.length, f.initialMessages.length + 2);
  assert.match(JSON.stringify(history[0]), /ORIGINAL-0/);
  assert.doesNotMatch(JSON.stringify(history), /IDLE-SUMMARY|Only output the checkpoint/);
  await f.supervisor.stop("existing");
  await f.supervisor.start("existing", { model: f.model, apiKey: "fixture" }, f.bridge);
  assert.equal((await f.supervisor.request("existing", "prompt", { text: "Resume later" })).error, null);
  assert.match(JSON.stringify(f.chats().at(-1)), /IDLE-SUMMARY/);
  assert.doesNotMatch(JSON.stringify(f.chats().at(-1)), /ORIGINAL-0/);
});

for (const setting of ["agent", "runtime", "small-cache"] as const) test(`idle compaction skips ${setting}`, async t => {
  const f = await fixture(t, setting === "small-cache" ? { cacheTokens: 1_000 } : {});
  await f.supervisor.start("skip", { model: f.model, apiKey: "fixture", idleTimeoutMs: 40, initialMessages: f.initialMessages,
    ...(setting === "agent" ? { idleCompaction: false } : {}), ...(setting === "runtime" ? { idleCompactionEnabled: false } : {}) }, f.bridge);
  assert.equal((await f.supervisor.request("skip", "prompt", { text: "Done" })).error, null);
  if (setting === "runtime") await f.supervisor.request("skip", "configure", { idleCompaction: true });
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.equal(f.summaries().length, 0);
});

test("configuration changes cancel the idle timer", async t => {
  const f = await fixture(t);
  await f.supervisor.start("configured", { model: f.model, apiKey: "fixture", idleTimeoutMs: 250, initialMessages: f.initialMessages }, f.bridge);
  assert.equal((await f.supervisor.request("configured", "prompt", { text: "Done" })).error, null);
  await f.supervisor.request("configured", "configure", { idleCompaction: false });
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(f.summaries().length, 0);
});

test("foreground input cancels a running idle summary and its usage stays in the background", async t => {
  const f = await fixture(t, { blockSummary: true });
  await f.supervisor.start("concurrent", { model: f.model, apiKey: "fixture", idleTimeoutMs: 100, initialMessages: f.initialMessages }, f.bridge);
  await f.supervisor.request("concurrent", "prompt", { text: "First" });
  await until(() => f.summaries().length === 1, "summary began");
  const foreground: any[] = [];
  const next = await f.supervisor.request("concurrent", "prompt", { text: "Follow-up" }, event => foreground.push(event));
  assert.equal(next.error, null);
  f.release();
  assert.equal(foreground.filter(event => event.type === "compaction_usage").length, 0);
  assert.equal(f.chats().length, 2);
  assert.doesNotMatch(JSON.stringify(f.chats()[1]), /IDLE-SUMMARY/);
  assert.equal((await supervisorMessages(f.supervisor, "concurrent")).length, f.initialMessages.length + 4);
});

test("Node sessions meter idle summaries separately and commit background usage receipts", async t => {
  const { db } = await testDatabase();
  const f = await fixture(t, { db });
  const usage: any[] = [], attempts: any[] = [];
  const sessions = new ClientSessions(f.supervisor, {
    db, root: join(f.root, "sessions"), secret: "idle-compaction-billing-fixture-secret", idleMs: 1_000,
    apiKeyFor: () => "fixture",
    onUsage: (_tenant, _agent, message) => usage.push(message),
    modelAttempt: async (_tenant, _agent, _platform, _priced, event) => { attempts.push(event); return false; },
  });
  t.after(() => sessions.close());
  const { id } = await sessions.create([], { model: f.model, initialMessages: f.initialMessages }, "idle-billing", {}, "tenant");
  await sessions.submit(id, "tenant", { id: "finished-turn", method: "prompt", params: { text: "Done" } });
  await until(() => sessions.sessions.get(id)?.requests.get("finished-turn")?.state === "completed", "foreground turn finished");
  await until(() => usage.some(message => message.type === "compaction_usage"), "background summary usage arrived");
  const summary = usage.find(message => message.type === "compaction_usage");
  assert.equal(summary.kind, "compaction");
  assert.equal(summary.requestId, undefined);
  assert.equal(summary.background, true);
  const begin = attempts.find(event => event.type === "begin" && event.kind === "compaction");
  assert.equal(begin.context.requestId, undefined);
  assert.equal(begin.background, true);
  const receipts = (await db.query("select message from pi_usage_receipts where session_id=$1 and message->>'kind'='compaction'", [id])).rows;
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].message.requestId, undefined);
  assert.equal(receipts[0].message.usage.cacheRead, 70_000);
});

test("background admission rejects an expired session before billing and after asynchronous admission waits", async t => {
  const { db } = await testDatabase();
  const f = await fixture(t, { db });
  const attempts: any[] = [];
  let duringAdmission: (() => void) | undefined;
  const sessions = new ClientSessions(f.supervisor, {
    db, root: join(f.root, "sessions"), secret: "idle-compaction-expiry-fixture-secret", idleCompaction: false,
    apiKeyFor: () => "fixture",
    modelAttempt: async (_tenant, _agent, _platform, _priced, event) => {
      attempts.push(event);
      duringAdmission?.();
      return false;
    },
  });
  t.after(() => sessions.close());
  const { id } = await sessions.create([], { model: f.model }, "idle-expiry", {}, "tenant");
  await sessions.submit(id, "tenant", { id: "foreground", method: "prompt", params: { text: "Done" } });
  await until(() => sessions.sessions.get(id)?.requests.get("foreground")?.state === "completed", "foreground turn finished");
  const session = sessions.sessions.get(id)!;
  const originalExpiry = session.header.expiresAt;
  const admit = f.supervisor.agents.get(id)!.bridge.modelAttempt!;
  const begin = { type: "begin", id: "background-expiry", provider: "openai", model: "fixture", kind: "compaction", background: true, at: Date.now(), keyHash: "fixture" } as const;
  const count = attempts.length;
  try {
    session.header.expiresAt = Date.now() - 1;
    await assert.rejects(admit(begin), /Session expired/);
    assert.equal(attempts.length, count, "an expired background request acquires no billing hold");

    session.header.expiresAt = Date.now() + 60_000;
    duringAdmission = () => { session.header.expiresAt = Date.now() - 1; };
    await assert.rejects(admit(begin), /Session expired/);
    assert.equal(attempts.length, count + 1, "expiry is rechecked after the billing hook resolves");

    duringAdmission = undefined;
    session.header.expiresAt = Date.now() + 60_000;
    t.mock.method(sessions as any, "leased", async () => { session.header.expiresAt = Date.now() - 1; });
    await assert.rejects(admit(begin), /Session expired/);
    assert.equal(attempts.length, count + 2, "expiry is rechecked after ownership admission resolves");
  } finally { session.header.expiresAt = originalExpiry; }
  assert.equal(f.summaries().length, 0);
});
