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

test("a checkpointed history-none turn keeps its task in Pi through repeated threshold compaction", async t => {
  let reading = false, calls = 0, compactions = 0;
  const storage = new MemoryStorage();
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
    durable: { storage, leading: () => system,
      summaryStream: () => stream({ ...fauxAssistantMessage("SUMMARY-42: Continue reading records."), provider: model.provider, model: model.id }),
      onCompaction: () => { compactions++; },
    },
  });
  t.after(() => agent.close());
  await agent.prompt(user("PRIVATE-PRE-TURN", 1));
  requests.length = 0;
  reading = true;
  await agent.historyContext(fresh, system);
  await agent.prompt(fresh);
  assert.equal(agent.state.errorMessage, undefined);
  assert.ok(compactions > 1, "the turn crossed the native threshold");
  assert.ok(agent.state.messages.some(message => message.role === "user" && message.content === fresh.content), "the checkpoint retains the original task");
  const compacted = requests.filter(view => JSON.stringify(view).includes("SUMMARY-42"));
  assert.ok(compacted.length > 0, "a model request followed compaction");
  for (const view of requests) {
    assert.ok(view.messages.some((message: any) => message.role === "user" && message.content === fresh.content), "every request retains the task");
    assert.ok(!JSON.stringify(view).includes("PRIVATE-PRE-TURN"), "pre-turn history stays hidden");
  }
  const context = (await import("@earendil-works/chord/context")).BACKGROUND_CONTEXT;
  const head = await storage.findLatestHeadMarker(agent.conversationId, undefined, context);
  const held = await storage.scanEntries({ conversationId: agent.conversationId, minEntryId: head!.head }, 256, undefined, context);
  assert.ok(JSON.stringify(held.items).length < 40_000, "retained range stays bounded after many tool rounds");
  assert.ok(compacted.some(view => view.messages.some((message: any) => message.role === "toolResult")), "the summary retains subsequent tool results");
  await agent.historyContext();
  await agent.prompt(user("Normal turn", 100));
  assert.match(JSON.stringify(requests.at(-1)), /PRIVATE-PRE-TURN/);
  assert.match(JSON.stringify(requests.at(-1)), /History-none run.*Read all records for TASK-42/);
  assert.match(JSON.stringify(requests.at(-1)), /Final reply: Finished/);
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /SUMMARY-42|payload/);
});


test("short fixture journals send identical messages with a view or a checkpoint", async t => {
  const requests: any[][] = [];
  for (const checkpoint of [false, true]) {
    const bodies: any[] = [];
    const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "Fixture", reasoning: false,
      input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1000 } as any;
    let running = false;
    const agent = await DurableAgent.create({ initialState: { model },
      streamFn: (_model, view) => { bodies.push(structuredClone(view.messages)); return stream({ ...fauxAssistantMessage("Done"), provider: model.provider, model: model.id }); },
      durable: { storage: new MemoryStorage(), leading: () => system, view: checkpoint ? undefined : messages => freshView(messages, running ? fresh : undefined) },
    });
    t.after(() => agent.close());
    await agent.replaceContext([system]);
    await agent.prompt(user("Old task", 1));
    running = true;
    if (checkpoint) await agent.historyContext(fresh, system);
    await agent.prompt(fresh);
    requests.push(bodies.at(-1));
  }
  assert.deepEqual(requests[1], requests[0]);
});
