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
  queueMicrotask(() => { events.push({ type: "done", reason: message.stopReason as never, message }); events.end(message); });
  return events;
}

test("native compaction owns cuts, bounds retained context and preserves full history and request identity", async t => {
  const storage = new MemoryStorage();
  let generations = 0, summaries = 0, compactions = 0, tools = 0;
  const requests: any[] = [];
  const agent = await DurableAgent.create({
    initialState: { model: { ...model, contextWindow: 32768 }, messages: [{ role: "system", content: "", sections: { application: "Keep the customer instructions intact." }, timestamp: 1 }], tools: [{ name: "read", label: "Read", description: "Read", parameters: { type: "object", properties: {} },
      execute: async () => { tools++; return { content: [{ type: "text", text: "payload ".repeat(1000) }], details: null }; } }] },
    transformContext: async () => { throw new Error("The host compactor must not run"); },
    streamFn: (_model, view) => {
      requests.push(structuredClone(view));
      const content = generations < 40 ? [fauxToolCall("read", {}, { id: `read-${generations}` })] : "Finished";
      generations++;
      return stream({ ...fauxAssistantMessage(content, { stopReason: typeof content === "string" ? "stop" : "toolUse" }), provider: model.provider, model: model.id });
    },
    durable: { storage, nativeCompaction: true, contextWindow: 8192,
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
  assert.ok(Math.max(...requests.map(view => JSON.stringify(view).length)) < 8192 * 4, "native compaction respects the configured window below the model maximum");
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
    durable: { storage, nativeCompaction: true, summaryStream: () => {
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
