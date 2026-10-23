import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, getCurrentSystemMessage, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { DurableAgent } from "../src/pi-durable/agent.ts";

const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "Fixture", reasoning: false,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1000 } as any;
function stream(message: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push(message.stopReason === "error" ? { type: "error", reason: "error", error: message } : { type: "done", reason: message.stopReason as never, message });
    events.end(message);
  });
  return events;
}

test("native compaction owns cuts, bounds retained context and preserves full history and request identity", async t => {
  const storage = new MemoryStorage();
  let generations = 0, summaries = 0, compactions = 0, tools = 0;
  let contextWindow = 32768;
  const requests: any[] = [];
  // The host's system message, as its configuration makes it: Pi's context has none yet.
  const leading = { role: "system", content: "", sections: { application: "Keep the customer instructions intact." }, timestamp: 1 } as const;
  const agent = await DurableAgent.create({
    initialState: { model: { ...model, contextWindow: 32768 }, messages: [], tools: [{ name: "read", label: "Read", description: "Read", parameters: { type: "object", properties: {} },
      execute: async () => { tools++; return { content: [{ type: "text", text: "payload ".repeat(1000) }], details: null }; } }] },
    streamFn: (_model, view) => {
      requests.push(structuredClone(view));
      const content = generations < 40 ? [fauxToolCall("read", {}, { id: `read-${generations}` })] : "Finished";
      generations++;
      // An already loaded agent can lower its context limit between requests.
      contextWindow = 8192;
      return stream({ ...fauxAssistantMessage(content, { stopReason: typeof content === "string" ? "stop" : "toolUse" }), provider: model.provider, model: model.id });
    },
    durable: { storage, leading: () => leading as never, get contextWindow() { return contextWindow; },
      summaryStream: () => { summaries++; return stream({ ...fauxAssistantMessage("Retain the task identifier and continue reading."), provider: model.provider, model: model.id }); },
      onCompaction: state => { compactions++; assert.ok(state.keptMessages < 20); assert.ok(state.summary.length); },
    },
  });
  t.after(() => agent.close());
  const input = { role: "user", content: "Read all records", timestamp: 42, requestId: "stable-request", sender: { id: "person", name: "Person" } } as any;
  await agent.prompt(input);
  assert.equal(tools, 40);
  assert.ok(requests.every(view => getCurrentSystemMessage(view.messages)?.sections?.application === "Keep the customer instructions intact."), "application instructions survive every request and native compaction");
  assert.ok(compactions > 2);
  assert.ok(Math.max(...requests.map(view => JSON.stringify(view).length)) < 8192 * 4, "native compaction follows a lowered live context window below the model maximum");
  assert.equal(summaries, compactions, "blocking compaction does not discard speculative summaries");
  const entries = await storage.scanEntries({ conversationId: agent.conversationId, order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
  assert.equal(entries.items.filter(entry => entry.kind === "camel.compaction.usage").length, summaries, "every summary response has a durable accounting source");
  assert.ok(agent.state.messages.length < 20, "only native working context is retained");
  const history = await agent.recoverMessages();
  assert.equal(history.length, 82);
  assert.deepEqual(history[0].message, input);
  assert.ok(await storage.submissionByRequest(agent.conversationId, input.requestId, BACKGROUND_CONTEXT));
  assert.equal(requests[0].messages.find((message: any) => message.role === "user").sender.name, "Person");
  assert.ok(requests.slice(1).some(view => JSON.stringify(view).includes("Retain the task identifier")));
});

test("failed native summary stops the run with an error and retains completed tools", async t => {
  let calls = 0, summaries = 0;
  const storage = new MemoryStorage();
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [{ name: "read", label: "read", description: "read", parameters: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "x".repeat(10000) }], details: null }) }] },
    streamFn: () => stream({ ...fauxAssistantMessage([fauxToolCall("read", {}, { id: `read-${++calls}` })], { stopReason: "toolUse" }), provider: model.provider, model: model.id }),
    durable: { storage, summaryStream: () => {
      summaries++;
      return stream({ ...fauxAssistantMessage("", { stopReason: "error" }), errorMessage: "summary unavailable", provider: model.provider, model: model.id });
    } },
  });
  t.after(() => agent.close());
  await agent.prompt("read");
  assert.equal(summaries, 1);
  assert.match(agent.state.errorMessage ?? "", /summary unavailable/);
  assert.ok(calls < 10);
  const history = await agent.recoverMessages();
  assert.equal(history.filter(item => item.message.role === "toolResult").length, calls);
});

test("a compaction's kept messages are counted as it left them, whatever was committed since", async t => {
  const storage = new MemoryStorage();
  let generations = 0;
  const kept: number[] = [];
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [{ name: "read", label: "Read", description: "Read", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "payload ".repeat(1000) }], details: null }) }] },
    streamFn: () => {
      const content = generations < 12 ? [fauxToolCall("read", {}, { id: `read-${generations}` })] : "Finished";
      generations++;
      return stream({ ...fauxAssistantMessage(content, { stopReason: typeof content === "string" ? "stop" : "toolUse" }), provider: model.provider, model: model.id });
    },
    durable: { storage,
      summaryStream: () => stream({ ...fauxAssistantMessage("Summary."), provider: model.provider, model: model.id }),
      onCompaction: state => { kept.push(state.keptMessages); },
    },
  });
  t.after(() => agent.close());
  await agent.prompt({ role: "user", content: "Read all records", timestamp: 1 } as any);
  assert.ok(kept.length > 0, "the run compacted");
  const page = await storage.scanEntries({ conversationId: agent.conversationId }, 1000, undefined, BACKGROUND_CONTEXT);
  const compaction = page.items.find(entry => entry.kind === "pi.compaction")!;
  // Messages land after the compaction before the host adopts it.
  await (agent as any).conversation.commit((tx: any) => tx.appendEntry(agent.conversationId, { kind: "camel.message", model: [{ role: "user", content: "later", timestamp: 2 }] }), BACKGROUND_CONTEXT);
  const counted: number[] = [];
  (agent as any).options.durable.onCompaction = (state: { keptMessages: number }) => { counted.push(state.keptMessages); };
  await (agent as any).adoptCompaction(compaction);
  assert.deepEqual(counted, [kept.at(-1)]);
});

test("a 400k-token Luna history compacts before the provider request", async t => {
  const { getModel, withCatalogPrices } = await import("../src/pi-catalog.ts");
  const luna = withCatalogPrices({ ...getModel("openrouter", "openai/gpt-6-luna")!, contextWindow: 1_050_000 });
  let summaries = 0, calls = 0;
  const agent = await DurableAgent.create({
    initialState: { model: luna, messages: [], tools: [] },
    streamFn: () => { calls++; assert.ok(summaries > 0); return stream(fauxAssistantMessage("done")); },
    durable: { storage: new MemoryStorage(), summaryStream: () => { summaries++; return stream(fauxAssistantMessage("summary")); } },
  });
  t.after(() => agent.close());
  await agent.replaceContext(Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `${i} ${"x".repeat(40_000)}`, timestamp: i })) as any);
  await agent.prompt("continue");
  assert.equal(calls, 1);
});

test("an overflow limit survives reopen and images are not counted as base64 text", async t => {
  const storage = new MemoryStorage();
  let summaries = 0;
  const options = {
    initialState: { model: { ...model, contextWindow: 1_050_000 }, messages: [], tools: [] },
    streamFn: () => stream({ ...fauxAssistantMessage("", { stopReason: "error" }), errorMessage: "maximum context length exceeded" }),
    durable: { storage, summaryStream: () => { summaries++; return stream(fauxAssistantMessage("summary")); } },
  };
  const closeStorage = storage.close.bind(storage);
  storage.close = async () => {};
  t.after(() => closeStorage(BACKGROUND_CONTEXT));
  const agent = await DurableAgent.create(options);
  await agent.prompt([{ role: "user", content: [{ type: "text", text: "x".repeat(40_000) }, { type: "image", data: "a".repeat(1_600_000), mimeType: "image/png" }], timestamp: 1 }] as any);
  const page = await storage.scanEntries({ conversationId: agent.conversationId }, 1000, undefined, BACKGROUND_CONTEXT);
  const limits = page.items.filter(entry => entry.kind === "camel.context.limit").map(entry => (entry.data as any).window);
  assert.ok(limits.length > 0);
  assert.ok(Math.max(...limits) < 20_000, "image bytes do not inflate the learned window");
  const id = agent.conversationId;
  await agent.close();
  // Keep the backing store open while closing the first harness, as separate persistent handles would.
  let calls = 0;
  const reopened = await DurableAgent.create({ ...options,
    streamFn: () => { calls++; assert.ok(summaries > before); return stream(fauxAssistantMessage("done")); },
    durable: { ...options.durable, conversationId: id },
  });
  t.after(() => reopened.close());
  const before = summaries;
  await reopened.prompt("y".repeat(50_000));
  assert.equal(calls, 1);
});
