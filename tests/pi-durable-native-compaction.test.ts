import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, getCurrentSystemMessage, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { ContextLimitDoc, DurableAgent } from "../src/pi-durable/agent.ts";

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

test("a 400k-token Luna history uses the catalog window without compaction", async t => {
  const { getModel, withCatalogPrices } = await import("../src/pi-catalog.ts");
  const luna = withCatalogPrices({ ...getModel("openrouter", "openai/gpt-6-luna")!, contextWindow: 1_050_000 });
  let summaries = 0, calls = 0;
  const agent = await DurableAgent.create({
    initialState: { model: luna, messages: [], tools: [] },
    streamFn: () => { calls++; assert.equal(summaries, 0); return stream(fauxAssistantMessage("done")); },
    durable: { storage: new MemoryStorage(), summaryStream: () => { summaries++; return stream(fauxAssistantMessage("summary")); } },
  });
  t.after(() => agent.close());
  await agent.replaceContext(Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `${i} ${"x".repeat(40_000)}`, timestamp: i })) as any);
  await agent.prompt("continue");
  assert.equal(calls, 1);
});

for (const [output, below, above] of [[undefined, 900_000, 923_000], [32_000, 923_000, 1_019_000], [200_000, 890_000, 923_000]] as const) test(`native compaction reserves Luna output tokens (${output ?? "catalog"})`, async t => {
  let summaries = 0, compactions = 0;
  const agent = await DurableAgent.create({
    initialState: { model: { ...model, contextWindow: 1_050_000, maxTokens: 128_000 }, messages: [], tools: [] },
    streamFn: () => stream(fauxAssistantMessage("done")),
    durable: { storage: new MemoryStorage(), maxOutputTokens: output,
      summaryStream: () => { summaries++; return stream(fauxAssistantMessage("summary")); },
      onCompaction: () => { compactions++; },
    },
  });
  t.after(() => agent.close());
  const history = (tokens: number) => Array.from({ length: 40 }, (_, i) => ({ role: "user", content: "x".repeat(tokens * 3.5 / 40), timestamp: i })) as any;
  await agent.replaceContext(history(below));
  await agent.prompt("continue");
  assert.equal(compactions, 0, "context below the output reservation still fits");
  await agent.replaceContext(history(above));
  await agent.prompt("continue");
  assert.equal(compactions, 1, "context crossing the output reservation compacts once");
  assert.ok(summaries > 0);
  assert.ok(agent.contextTokens.sent < 100_000, "retained context leaves headroom for another turn");
});

test("an overflow limit survives reopen and images are not counted as base64 text", async t => {
  const storage = new MemoryStorage();
  let summaries = 0;
  const options = {
    initialState: { model: { ...model, contextWindow: 65_536 }, messages: [], tools: [] },
    streamFn: () => stream({ ...fauxAssistantMessage("", { stopReason: "error" }), errorMessage: "maximum context length exceeded" }),
    durable: { storage, summaryStream: () => { summaries++; return stream(fauxAssistantMessage("summary")); } },
  };
  const closeStorage = storage.close.bind(storage);
  storage.close = async () => {};
  t.after(() => closeStorage(BACKGROUND_CONTEXT));
  const agent = await DurableAgent.create(options);
  await agent.prompt([{ role: "user", content: [{ type: "text", text: "x".repeat(40_000) }, { type: "image", data: "a".repeat(1_600_000), mimeType: "image/png" }], timestamp: 1 }] as any);
  const page = await storage.scanEntries({ conversationId: agent.conversationId }, 1000, undefined, BACKGROUND_CONTEXT);
  const limit = await (agent as any).harness.snapshot(ContextLimitDoc, agent.conversationId, BACKGROUND_CONTEXT);
  assert.equal(limit.window, 32_768, "image bytes do not inflate the limit, and small refusals cannot shrink below the floor");
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
  await reopened.prompt("y".repeat(150_000));
  assert.equal(calls, 1);
});


for (const byteRefusal of [false, "413 request_too_large: request too large", "status 413: maximum context length exceeded", "HTTP 413: maximum context length exceeded"] as const) test(byteRefusal ? "byte-size refusals do not learn token limits" : "a failed optional limit commit still lets Pi compact the overflow", async t => {
  const storage = new MemoryStorage();
  let failed = false, calls = 0, summaries = 0;
  const backend = new Proxy(storage, { get(target, key) {
    if (key === "commit") return async (batches: any, receive: any, context: any) => {
      if (!byteRefusal && batches.flat().some((write: any) => write.type === "document.create" && write.record?.kind === "camel.context.limit")) {
        failed = true;
        throw new Error("optional limit write failed");
      }
      return target.commit(batches, receive, context);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const agent = await DurableAgent.create({
    initialState: { model: { ...model, contextWindow: 65_536 }, messages: [], tools: [] },
    streamFn: () => stream(++calls === 1 ? { ...fauxAssistantMessage("", { stopReason: "error" }), errorMessage: byteRefusal || "maximum context length exceeded: 1,050,413 tokens" } : fauxAssistantMessage("done")),
    durable: { storage: backend, summaryStream: () => { summaries++; return stream(fauxAssistantMessage("summary")); } },
  });
  t.after(() => agent.close());
  await agent.replaceContext(Array.from({ length: 12 }, (_, i) => [{ role: "user", content: "x".repeat(8_000), timestamp: i }, fauxAssistantMessage("ack")]).flat() as any);
  await agent.prompt("hello");
  assert.equal(calls, 2, agent.state.errorMessage);
  assert.ok(summaries > 0);
  const limit = await (agent as any).harness.snapshot(ContextLimitDoc, agent.conversationId, BACKGROUND_CONTEXT);
  assert.equal(limit, undefined);
  assert.equal(failed, !byteRefusal);
  assert.equal(agent.state.errorMessage, undefined);
});


test("a dense Luna history compacts in bounded chunks against a persisted 272k limit", async t => {
  const { getModel } = await import("../src/pi-catalog.ts");
  const luna = getModel("openrouter", "openai/gpt-6-luna")!;
  const storage = new MemoryStorage();
  const closeStorage = storage.close.bind(storage);
  storage.close = async () => {};
  t.after(() => closeStorage(BACKGROUND_CONTEXT));
  const requests: any[][] = [];
  const options: Parameters<typeof DurableAgent.create>[0] = {
    initialState: { model: luna, messages: [], tools: [] },
    streamFn: () => stream(fauxAssistantMessage("done")),
    durable: { storage, summaryStream: (_model, view, options) => {
      requests.push(view.messages);
      const texts = view.messages.map(message => typeof message.content === "string" ? message.content : message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n"));
      const input = texts.reduce((sum, text) => sum + Math.ceil(text.length / 2.5), 0);
      const part = texts.at(-1)!.match(/<conversation>\n([\s\S]*)\n<\/conversation>/)![1];
      assert.ok(part.length / 2.5 <= 272_000 / 2, "each part uses at most half the effective window");
      assert.ok(input + (options?.maxTokens ?? 0) + 512 <= 272_000, `request has ${input} input tokens`);
      return stream(fauxAssistantMessage("retained earlier facts"));
    } },
  };
  const seed = await DurableAgent.create(options);
  await seed.replaceContext(Array.from({ length: 50 }, (_, i) => ({ role: "user", content: `${i}: ${"漢字{\"key\":\"YWJjZGVm\"}".repeat(2_000)}`, timestamp: i })) as any);
  await (seed as any).conversation.commit(async (tx: any) => {
    Object.assign(await tx.doc(ContextLimitDoc, seed.conversationId), { provider: luna.provider, model: luna.id, window: 272_000 });
  }, BACKGROUND_CONTEXT);
  const id = seed.conversationId;
  await seed.close();
  const agent = await DurableAgent.create({ ...options, durable: { ...options.durable, conversationId: id } });
  t.after(() => agent.close());
  await agent.prompt("continue");
  assert.ok(requests.length >= 2, agent.state.errorMessage);
  assert.ok(JSON.stringify(requests[1]).includes("retained earlier facts"));
  assert.equal(agent.state.errorMessage, undefined);
});

for (const error of ["server_error", "OpenAI Responses stream ended before a terminal response event", "Network connection lost"]) {
  for (const [size, output, recover] of [[300_000, 0, true], [470_000, 0, true], [200_000, 0, false], [300_000, 1, false]] as const) {
    test(`Luna ${error}: ${size} prompt tokens, ${output} output tokens`, async t => {
      let calls = 0, summaries = 0;
      const agent = await DurableAgent.create({
        initialState: { model: { ...model, id: "openai/gpt-6-luna", provider: "openrouter", contextWindow: 1_050_000 }, messages: [], tools: [] },
        streamFn: () => {
          if (++calls > 1) return stream(fauxAssistantMessage("done"));
          const failed = { ...fauxAssistantMessage("", { stopReason: "error" }), errorMessage: error };
          failed.usage.output = output;
          return stream(failed);
        },
        durable: { storage: new MemoryStorage(), summaryStream: () => { summaries++; return stream(fauxAssistantMessage("summary")); } },
      });
      t.after(() => agent.close());
      await agent.replaceContext(Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "x".repeat(size * 3.5 / 30), timestamp: i })) as any);
      await agent.prompt("continue");
      const limit = await (agent as any).harness.snapshot(ContextLimitDoc, agent.conversationId, BACKGROUND_CONTEXT);
      if (recover) {
        assert.equal(calls, 2);
        assert.ok(summaries > 0);
        assert.equal(limit, undefined, "a first inferred Luna overflow recovers without persisting a limit");
        assert.equal(agent.state.errorMessage, undefined);
      } else {
        assert.equal(calls, 1);
        assert.equal(summaries, 0);
        assert.equal(limit, undefined);
        assert.equal(agent.state.errorMessage, error);
      }
    });
  }
}

for (const elapsedHours of [1, 25]) test(`inferred Luna overflow evidence survives reopen and expires after 24h (${elapsedHours}h)`, async t => {
  const storage = new MemoryStorage();
  const closeStorage = storage.close.bind(storage);
  storage.close = async () => {};
  t.after(() => closeStorage(BACKGROUND_CONTEXT));
  let now = Date.now(), calls = 0;
  t.mock.method(Date, "now", () => now);
  const options: Parameters<typeof DurableAgent.create>[0] = {
    initialState: { model: { ...model, id: "openai/gpt-6-luna", provider: "openrouter", contextWindow: 1_050_000 }, messages: [], tools: [] },
    streamFn: () => {
      if (++calls % 2 === 0) return stream(fauxAssistantMessage("done"));
      const failed = { ...fauxAssistantMessage("", { stopReason: "error" }), errorMessage: "server_error" };
      failed.usage.output = 0;
      return stream(failed);
    },
    durable: { storage, summaryStream: () => stream(fauxAssistantMessage("summary")) },
  };
  const history = () => Array.from({ length: 30 }, (_, i) => ({ role: "user", content: "x".repeat(35_000), timestamp: i })) as any;
  const first = await DurableAgent.create(options);
  await first.replaceContext(history());
  await first.prompt("continue");
  assert.equal(calls, 2, first.state.errorMessage);
  assert.equal(await (first as any).harness.snapshot(ContextLimitDoc, first.conversationId, BACKGROUND_CONTEXT), undefined);
  const id = first.conversationId;
  await first.close();
  now += elapsedHours * 60 * 60 * 1_000;
  const second = await DurableAgent.create({ ...options, durable: { ...options.durable, conversationId: id } });
  t.after(() => second.close());
  await second.replaceContext(history());
  await second.prompt("continue");
  assert.equal(calls, 4, second.state.errorMessage ?? "both failures compact and retry");
  const limit = await (second as any).harness.snapshot(ContextLimitDoc, id, BACKGROUND_CONTEXT);
  assert.equal(limit?.window, elapsedHours === 1 ? 244_800 : undefined);
});

for (const window of [244_800, 244_799]) test(`a learned Luna limit ${window} survives a restart`, async t => {
  const storage = new MemoryStorage();
  const closeStorage = storage.close.bind(storage);
  storage.close = async () => {};
  t.after(() => closeStorage(BACKGROUND_CONTEXT));
  const options: Parameters<typeof DurableAgent.create>[0] = {
    initialState: { model: { ...model, id: "openai/gpt-6-luna", provider: "openrouter", contextWindow: 1_050_000 }, messages: [], tools: [] },
    streamFn: () => stream(fauxAssistantMessage("done")), durable: { storage },
  };
  const seed = await DurableAgent.create(options);
  await (seed as any).conversation.commit(async (tx: any) => {
    Object.assign(await tx.doc(ContextLimitDoc, seed.conversationId), { provider: "openrouter", model: "openai/gpt-6-luna", window });
  }, BACKGROUND_CONTEXT);
  const id = seed.conversationId;
  await seed.close();
  const agent = await DurableAgent.create({ ...options, durable: { storage, conversationId: id } });
  t.after(() => agent.close());
  assert.equal((agent as any).overflowWindow, window);
});
