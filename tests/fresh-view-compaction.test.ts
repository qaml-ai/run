import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import { freshView } from "../src/agent-host.ts";
import { DurableAgent } from "../src/pi-durable/agent.ts";
import { COMPACTION_SUMMARY_PREFIX, createCompactionSummaryMessage } from "../src/pi-harness/messages.ts";

const user = (content: string, timestamp: number) => ({ role: "user" as const, content, timestamp });
const system = { role: "system" as const, content: "Instructions", timestamp: 0 };
const fresh = { ...user("Read all records for TASK-42", 42), history: "none" };
function stream(message: AssistantMessage) {
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => { events.push({ type: "done", reason: message.stopReason as never, message }); events.end(message); });
  return events;
}

test("fresh views keep the latest native or imported summary, and fall back to a surviving turn marker", () => {
  const old = user("Private earlier task", 1), later = user("Continue this task", 43);
  const summary = user(`${COMPACTION_SUMMARY_PREFIX}Latest progress`, 44);
  assert.deepEqual(freshView([system, old, fresh, later], fresh), [system, fresh, later]);
  assert.deepEqual(freshView([system, old, summary, later], fresh), [system, fresh, summary, later]);
  const imported = createCompactionSummaryMessage("Imported progress", 100, 45);
  assert.deepEqual(freshView([system, old, summary, imported, later], fresh), [system, fresh, imported, later]);
  assert.deepEqual(freshView([system, old, later], fresh), [system, fresh, later]);
  assert.deepEqual(freshView([system, old], fresh), [system, fresh]);
  assert.throws(() => freshView([system]), /context_lost:.*no user message/);
});

test("a history-none turn still sends its task and summary after threshold compaction removes its first message", async t => {
  let reading = false, calls = 0, compactions = 0;
  const requests: any[] = [];
  const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "Fixture", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1000 } as any;
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [{ name: "read", label: "Read", description: "Read", parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "payload ".repeat(1000) }], details: null }) }] },
    streamFn: (_model, view) => {
      requests.push(structuredClone(view));
      const content = reading && calls++ < 12 ? [fauxToolCall("read", {}, { id: `read-${calls}` })] : "Finished";
      return stream({ ...fauxAssistantMessage(content, { stopReason: typeof content === "string" ? "stop" : "toolUse" }), provider: model.provider, model: model.id });
    },
    durable: { storage: new MemoryStorage(), leading: () => system,
      view: messages => freshView(messages, reading ? fresh : undefined),
      summaryStream: () => stream({ ...fauxAssistantMessage("SUMMARY-42: Continue reading records."), provider: model.provider, model: model.id }),
      onCompaction: () => { compactions++; },
    },
  });
  t.after(() => agent.close());
  await agent.prompt(user("PRIVATE-PRE-TURN", 1));
  requests.length = 0;
  reading = true;
  await agent.prompt(fresh);
  assert.equal(agent.state.errorMessage, undefined);
  assert.ok(compactions > 0, "the turn crossed the native threshold");
  assert.ok(!agent.state.messages.some(message => message.role === "user" && message.content === fresh.content), "compaction removed the original task");
  const compacted = requests.filter(view => JSON.stringify(view).includes("SUMMARY-42"));
  assert.ok(compacted.length > 0, "a model request followed compaction");
  for (const view of requests) {
    assert.ok(view.messages.some((message: any) => message.role === "user" && message.content === fresh.content), "every request retains the task");
    assert.ok(!JSON.stringify(view).includes("PRIVATE-PRE-TURN"), "pre-turn history stays hidden");
  }
  assert.ok(compacted.some(view => view.messages.some((message: any) => message.role === "toolResult")), "the summary retains subsequent tool results");
});
