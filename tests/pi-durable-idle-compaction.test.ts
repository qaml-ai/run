import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, fauxAssistantMessage, type AssistantMessage } from "@earendil-works/pi-ai";
import { DurableAgent, IDLE_SUMMARY_PROMPT } from "../src/pi-durable/agent.ts";

const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "Fixture", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 4096 } as any;
function response(text: string, stopReason: "stop" | "error" | "aborted" = "stop") {
  return { ...fauxAssistantMessage(text, { stopReason }), provider: model.provider, model: model.id };
}
function stream(message: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push(message.stopReason === "error" || message.stopReason === "aborted" ?
      { type: "error", reason: message.stopReason, error: message } : { type: "done", reason: "stop", message });
    events.end(message);
  });
  return events;
}
async function fixture(t: { after: (fn: () => unknown) => void }, extra: Record<string, unknown> = {}) {
  const storage = new MemoryStorage();
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    streamFn: () => stream(response("answer")),
    durable: { storage, ...extra },
  });
  t.after(() => agent.close());
  await agent.prompt(`early-history ${"x".repeat(120_000)}`);
  await agent.prompt(`recent-history ${"y".repeat(120_000)}`);
  return { agent, storage };
}
const deadline = (promise: Promise<unknown>) => Promise.race([promise, new Promise<never>((_resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("Foreground waited for idle summary")), 1000);
  timer.unref();
})]);

test("idle summary uses one native background task, preserves the cached request and full transcript", async t => {
  const summaries: { message: AssistantMessage; background?: boolean }[] = [];
  const compactions: any[] = [];
  const { agent, storage } = await fixture(t, {
    onSummary: (message: AssistantMessage, options?: { background?: boolean }) => summaries.push({ message, ...options }),
    onCompaction: (state: unknown) => { compactions.push(state); },
  });
  const history = await agent.recoverMessages();
  const held = structuredClone(agent.state.messages);
  // Normal Node turn settlement and history rebasing leave bookkeeping after the native answer.
  await agent.journalSession()!(async (tx, own) => {
    for (const data of [{ t: "turn", active: false }, { t: "base", active: false, total: 4, turnStart: 4, awaiting: [] }]) {
      const entry = await tx.appendEntry(agent.conversationId, { kind: "camel.history.marker", data: data as never });
      own(entry.id);
    }
  });
  const settled = Promise.withResolvers<void>();
  const requests: any[] = [];
  const summarize = (_model: any, view: any, options: any) => {
    requests.push(structuredClone(view));
    assert.ok(options.maxTokens <= 4096);
    assert.equal(options.maxRetries, 0);
    return stream(response("checkpoint"));
  };
  const admission = await Promise.all([
    agent.compactIdle(async () => true, summarize, settled.resolve),
    agent.compactIdle(async () => true, summarize),
  ]);
  assert.deepEqual(admission, [true, false]);
  await settled.promise;
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].messages.slice(0, -1), held.slice(0, -1), "replay is the last successful request, without its new answer");
  assert.equal(requests[0].messages.at(-1).content, IDLE_SUMMARY_PROMPT);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].background, true);
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].background, true);
  assert.ok(JSON.stringify(agent.state.messages).includes("checkpoint"));
  assert.ok(!JSON.stringify(agent.state.messages).includes("early-history"));
  assert.deepEqual(await agent.recoverMessages(), history, "summary checkpoints never replace the full transcript");
  const entries = await storage.scanEntries({ conversationId: agent.conversationId }, 1000, undefined, BACKGROUND_CONTEXT);
  const usage = entries.items.filter(entry => entry.kind === "camel.compaction.usage");
  assert.equal(usage.length, 1);
  assert.equal((usage[0].data as any).background, true);
  assert.equal(await agent.compactIdle(async () => true, summarize), false);
});

test("foreground input cancels a paused idle summary without waiting for an uncooperative provider", async t => {
  const summaries: { background?: boolean }[] = [];
  const { agent, storage } = await fixture(t, { onSummary: (_message: unknown, options: { background?: boolean }) => { summaries.push(options); } });
  const entered = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  const pending = createAssistantMessageEventStream();
  let signal: AbortSignal | undefined;
  assert.equal(await agent.compactIdle(async () => true, (_model, _view, options) => {
    signal = options?.signal;
    entered.resolve();
    return pending;
  }, finished.resolve), true);
  await entered.promise;
  await deadline(agent.prompt("follow-up"));
  assert.equal(signal?.aborted, true);
  await finished.promise;
  pending.end(response("late checkpoint"));
  await new Promise<void>(resolve => setImmediate(resolve));
  const entries = await storage.scanEntries({ conversationId: agent.conversationId }, 1000, undefined, BACKGROUND_CONTEXT);
  assert.equal(entries.items.filter(entry => entry.kind === "pi.compaction").length, 0);
  assert.ok((await agent.recoverMessages()).some(item => item.message.role === "user" && item.message.content === "follow-up"));
  assert.deepEqual(summaries, [{ background: true }], "late usage remains a background receipt exactly once");
  assert.equal(entries.items.filter(entry => entry.kind === "camel.compaction.usage").length, 1);
});

test("changed configuration and a failed idle summary leave foreground compaction state clean", async t => {
  const { agent } = await fixture(t);
  let calls = 0;
  assert.equal(await agent.compactIdle(async () => false, () => { calls++; return stream(response("unexpected")); }), false);
  const finished = Promise.withResolvers<void>();
  assert.equal(await agent.compactIdle(async () => true, () => {
    calls++;
    return stream({ ...response("", "error"), errorMessage: "summary unavailable" });
  }, finished.resolve), true);
  await finished.promise;
  assert.equal(calls, 1);
  await agent.prompt("continue after failed summary");
  assert.equal(agent.state.errorMessage, undefined);
  await agent.reload();
  assert.equal(await agent.compactIdle(async () => true, () => { calls++; return stream(response("unexpected")); }), false);
});

for (const mutation of ["reload", "syncContext", "replaceContext", "abortIdleCompaction"] as const) test(`${mutation} cancels an idle summary before changing the native context`, async t => {
  const { agent, storage } = await fixture(t);
  const entered = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  const pending = createAssistantMessageEventStream();
  let signal: AbortSignal | undefined;
  assert.equal(await agent.compactIdle(async () => true, (_model, _view, options) => {
    signal = options?.signal;
    entered.resolve();
    return pending;
  }, finished.resolve), true);
  await entered.promise;
  await deadline(mutation === "replaceContext" ? agent.replaceContext([{ role: "user", content: "replacement", timestamp: 1 }]) : agent[mutation]());
  assert.equal(signal?.aborted, true);
  await finished.promise;
  pending.end(response("cancelled", "aborted"));
  await new Promise<void>(resolve => setImmediate(resolve));
  const entries = await storage.scanEntries({ conversationId: agent.conversationId }, 1000, undefined, BACKGROUND_CONTEXT);
  assert.equal(entries.items.filter(entry => entry.kind === "pi.compaction").length, 0);
});

test("a host system change after the cached answer invalidates idle admission", async t => {
  const { agent } = await fixture(t);
  await agent.journalSession()!(async (tx, own) => {
    const entry = await tx.appendEntry(agent.conversationId, { kind: "camel.system", model: [{ role: "system", content: "new instructions", timestamp: 1 }] });
    own(entry.id);
  });
  let calls = 0;
  assert.equal(await agent.compactIdle(async () => true, () => { calls++; return stream(response("unexpected")); }), false);
  assert.equal(calls, 0);
});

test("a reopened host aborts durable idle work instead of replaying an expired cached request", async t => {
  const { agent, storage } = await fixture(t);
  const originalClose = storage.close.bind(storage);
  storage.close = async () => {};
  t.after(() => originalClose(BACKGROUND_CONTEXT));
  const entered = Promise.withResolvers<void>();
  const pending = createAssistantMessageEventStream();
  assert.equal(await agent.compactIdle(async () => true, () => { entered.resolve(); return pending; }), true);
  await entered.promise;
  const id = agent.conversationId;
  await agent.close();
  let summaries = 0;
  const reopened = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] }, streamFn: () => stream(response("resumed")),
    durable: { storage, conversationId: id, summaryStream: () => { summaries++; return stream(response("unexpected")); } },
  });
  t.after(() => reopened.close());
  await deadline(reopened.prompt("after restart"));
  assert.equal(summaries, 0);
  const entries = await storage.scanEntries({ conversationId: id }, 1000, undefined, BACKGROUND_CONTEXT);
  assert.equal(entries.items.filter(entry => entry.kind === "pi.compaction").length, 0);
});
