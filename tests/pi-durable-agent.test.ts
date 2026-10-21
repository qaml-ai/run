import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentOptions, AgentTool } from "@earendil-works/pi-agent-core";
import { DurableAgent, recoverDurableMessages } from "../src/pi-durable/agent.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { testDatabase } from "./database.ts";
import { forkCut, Transcript, type TranscriptRecord } from "../src/transcript.ts";

const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "Fixture", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1000 } as any;
const answer = (text: string) => ({ ...fauxAssistantMessage(text), provider: model.provider, model: model.id });
const call = (...names: string[]) => ({ ...fauxAssistantMessage(names.map((name, i) => fauxToolCall(name, {}, { id: `call-${i}` })), { stopReason: "toolUse" }), provider: model.provider, model: model.id });
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

async function fixture(responses: AssistantMessage[], options: Partial<AgentOptions> = {}, supplied: Storage = new MemoryStorage()) {
  const events: any[] = [], requests: any[] = [];
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    streamFn: (_model, context) => {
      requests.push(structuredClone(context));
      const response = responses.shift();
      if (!response) throw new Error("Unexpected model request");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...response, content: [] } });
        stream.push({ type: "done", reason: response.stopReason as never, message: response }); stream.end(response);
      });
      return stream;
    },
    ...options, durable: { storage: supplied },
  });
  agent.subscribe(event => { events.push(event); });
  return { agent, events, requests, storage: supplied };
}

const tool = (name: string, execute: AgentTool["execute"] = async () => ({ content: [{ type: "text", text: "found" }], details: { saved: true } })): AgentTool => ({
  name, label: name, description: name, parameters: { type: "object", properties: {} }, execute,
});

test("fork cuts never copy a source journal cursor into the new session's native ID domain", () => {
  const input = { ...user("source request"), requestId: "source-request" } as AgentMessage;
  const records: TranscriptRecord[] = [
    { t: "turn", active: true },
    { t: "message", message: input, pi: { entryId: 1_000_000, index: 0 } },
    { t: "message", message: answer("source response"), pi: { entryId: 1_000_001, index: 0 } },
    { t: "turn", active: false },
    { t: "pi", cursor: { entryId: 1_000_002, index: 0 } },
  ];
  for (const at of [undefined, 1, "source-request"]) {
    const cut = forkCut(records, at);
    const fork = new Transcript(undefined as never);
    for (const record of cut.records) {
      assert.notEqual(record.t, "pi");
      if (record.t === "message") assert.equal(record.pi, undefined);
      fork.apply(record);
    }
    assert.equal(cut.through, 1);
    assert.equal(fork.piCursor, undefined);
    assert.deepEqual(fork.context, [input, records[2].t === "message" ? records[2].message : undefined]);
  }
  assert.equal(records[1].t === "message" && records[1].pi?.entryId, 1_000_000, "the source transcript remains unchanged");
});

test("Pi adapter executes native durable generations/tools and projects cursor-addressed original input", async t => {
  const read = tool("read");
  const fake = await fixture([call("read"), answer("Done")], { initialState: { model, tools: [read], messages: [] } });
  t.after(() => fake.agent.close());
  const input = { ...user("Read it"), sender: { id: "person", name: "Person" }, requestId: "req-1" } as AgentMessage;
  await fake.agent.prompt(input);
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(fake.agent.state.messages.map(message => message.role), ["system", "user", "assistant", "toolResult", "assistant"]);
  const messages = await fake.agent.recoverMessages();
  assert.deepEqual(messages[0].message, input);
  assert.deepEqual(messages.map(item => item.message), fake.agent.state.messages.filter(message => message.role !== "system"));
  assert.equal(fake.events.filter(event => event.type === "tool_execution_start").length, 1);
  assert.equal(fake.events.filter(event => event.type === "turn_end").length, 2);
  assert.equal(fake.events.filter(event => event.type === "agent_end").length, 1);
  assert.ok(fake.events.filter(event => event.type === "message_end").every(event => event.durable));
  assert.equal((await recoverDurableMessages(fake.storage, fake.agent.conversationId, messages[1].cursor)).length, 2);
});

for (const mode of ["parallel", "sequential"] as const) test(`Pi adapter honors finishTurn after every ${mode} tool result without another provider request`, async t => {
  const finished: string[][] = [];
  const tools = [tool("first"), { ...tool("second"), executionMode: mode }];
  const fake = await fixture([call("first", "second")], {
    initialState: { model, messages: [], tools }, toolExecution: mode,
    finishTurn: turn => { finished.push(turn.toolResults.map(result => result.toolName)); return { action: "end" }; },
  });
  t.after(() => fake.agent.close());
  await fake.agent.prompt("Work");
  assert.deepEqual(finished, [["first", "second"]]);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.agent.state.pendingToolCalls.size, 0);
  assert.equal(fake.events.filter(event => event.type === "message_end").length, 4);
});

test("Pi adapter finishTurn includes invalid and unavailable tool results", async t => {
  const requiresNumber = { ...tool("read"), parameters: { type: "object", required: ["count"], properties: { count: { type: "number" } } } };
  const fake = await fixture([call("read", "missing")], {
    initialState: { model, messages: [], tools: [requiresNumber] },
    finishTurn: turn => { assert.equal(turn.toolResults.length, 2); assert.ok(turn.toolResults.every(result => result.isError)); return { action: "end" }; },
  });
  t.after(() => fake.agent.close());
  await fake.agent.prompt("Work");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.events.filter(event => event.type === "tool_execution_start").length, 0);
});

test("Pi adapter injects queued steering at the post-tools boundary", async t => {
  let agent: DurableAgent;
  const read = tool("read", async () => { agent.steer({ ...user("change direction"), sender: { id: "steerer" } } as AgentMessage); return { content: [], details: null }; });
  const fake = await fixture([call("read"), answer("Changed")], { initialState: { model, messages: [], tools: [read] } });
  agent = fake.agent;
  t.after(() => agent.close());
  await agent.prompt("Start");
  assert.equal(fake.requests.length, 2);
  assert.ok(fake.requests[1].messages.some((message: any) => message.content === "change direction"));
  assert.equal(agent.hasQueuedMessages(), false);
});

test("Pi adapter leaves steering queued when finishTurn stops for a run limit", async t => {
  let agent: DurableAgent;
  const read = tool("read", async () => { agent.steer(user("later")); return { content: [], details: null }; });
  const fake = await fixture([call("read")], { initialState: { model, messages: [], tools: [read] }, finishTurn: () => ({ action: "end" }) });
  agent = fake.agent;
  t.after(() => agent.close());
  await agent.prompt("Start");
  assert.equal(fake.requests.length, 1);
  assert.equal(agent.hasQueuedMessages(), true);
  assert.deepEqual(agent.peekQueuedMessages(), [user("later")]);
});

test("Pi adapter streams an input-required placeholder but excludes it from recovery history", async t => {
  const approve = tool("approve", async () => ({ content: [], details: { inputRequired: true } }));
  const fake = await fixture([call("approve")], { initialState: { model, messages: [], tools: [approve] }, finishTurn: () => ({ action: "end" }) });
  t.after(() => fake.agent.close());
  await fake.agent.prompt("Start");
  assert.ok(fake.events.some(event => event.type === "tool_execution_end" && event.result.details?.inputRequired));
  const recovered = await fake.agent.recoverMessages();
  assert.deepEqual(recovered.map(item => item.message.role), ["user", "assistant"]);
  assert.ok(fake.agent.latestCursor!.entryId > recovered.at(-1)!.cursor.entryId);
});

test("Pi adapter continuation uses a replaced context without exposing context markers as new history", async t => {
  const fake = await fixture([answer("Done")]);
  t.after(() => fake.agent.close());
  fake.agent.state.messages = [user("continue this history")];
  await fake.agent.continue();
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0].messages[0].content, "continue this history");
  assert.deepEqual((await fake.agent.recoverMessages()).map(item => item.message.role), ["assistant"]);
});

test("Pi adapter abort cancels a running tool without running the next provider request", async t => {
  let started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  let executions = 0;
  const slow = tool("slow", async (_id, _args, signal) => {
    executions++; started();
    await new Promise<void>(resolve => signal?.addEventListener("abort", () => resolve(), { once: true }));
    return { content: [], details: null };
  });
  const fake = await fixture([call("slow")], { initialState: { model, messages: [], tools: [slow] } });
  t.after(() => fake.agent.close());
  const running = fake.agent.prompt("Start");
  await began;
  fake.agent.abort();
  await running;
  assert.equal(executions, 1);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.agent.state.isStreaming, false);
  assert.equal(fake.events.filter(event => event.type === "agent_end").length, 1);
  const recovered = (await fake.agent.recoverMessages()).map(item => item.message).find(message => message.role === "toolResult");
  assert.equal(recovered?.role, "toolResult");
  assert.equal(recovered.isError, true);
  assert.match(JSON.stringify(recovered.content), /outcome is unknown/);
  const live = fake.events.find(event => event.type === "tool_execution_end");
  assert.deepEqual(live.result.content, recovered.content, "live events and cold history use the same unknown-outcome projection");
});

test("Pi adapter close seals writes and returns even when a tool ignores cancellation", async () => {
  let started!: () => void, release!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const slow = tool("slow", async () => { started(); await blocked; return { content: [{ type: "text", text: "late effect" }], details: null }; });
  const fake = await fixture([call("slow")], { initialState: { model, messages: [], tools: [slow] } });
  const running = fake.agent.prompt("Start");
  // A caller owns the run's rejected result; close itself must still finish.
  running.catch(() => {});
  await began;
  await fake.agent.close(10);
  const before = fake.events.length;
  release();
  await Promise.allSettled([running]);
  assert.equal(fake.events.length, before, "late tool completions cannot emit after disposal");
  await assert.rejects(fake.agent.prompt("New"), /closed/);
});

test("Pi adapter checkpoints the host's context only when it changes, not after every run or reload", async () => {
  const { db } = await testDatabase(), sessionId = randomUUID();
  const open = () => openPiStorage({ sessionId, directory: "unused", db });
  const checkpoints = async (conversationId: any) => {
    const storage = await open();
    let count = 0, cursor;
    do {
      const page = await storage.scanEntries({ conversationId }, 256, cursor, BACKGROUND_CONTEXT);
      count += page.items.filter(entry => entry.kind === "camel.legacy.context").length;
      cursor = page.next;
    } while (cursor !== undefined);
    return count;
  };
  const system = { role: "system", content: "Be brief.", timestamp: 0 } as AgentMessage;
  const first = await fixture([answer("one"), answer("two")], { initialState: { model, tools: [], messages: [system] } }, await open());
  await first.agent.prompt(user("first"));
  const id = first.agent.conversationId;
  assert.equal(await checkpoints(id), 1, "a new conversation takes the host's system message once");
  // Hosts reassign an equal working set (fresh copies) after every run.
  first.agent.state.messages = structuredClone(first.agent.state.messages);
  await first.agent.prompt(user("second"));
  assert.equal(await checkpoints(id), 1);
  const kept = structuredClone(first.agent.state.messages);
  await first.agent.close();

  const reopened = await fixture([answer("three"), answer("four")], { initialState: { model, tools: [], messages: kept } }, await open());
  await reopened.agent.prompt(user("third"));
  assert.equal(await checkpoints(id), 1, "a reload whose Pi context matches the host's writes none");
  const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text).join("");
  assert.deepEqual(reopened.requests[0].messages.map(text), ["Be brief.", "first", "one", "second", "two", "third"]);
  // A host-side change still reaches Pi's context.
  reopened.agent.state.messages = [...reopened.agent.state.messages, { ...user("landed without a model call"), timestamp: 99 }];
  await reopened.agent.prompt(user("fourth"));
  assert.equal(await checkpoints(id), 2);
  assert.deepEqual(reopened.requests[1].messages.map(text).slice(-3), ["three", "landed without a model call", "fourth"]);
  // So does a message whose content changed under the same role, time and position (a stub, a placeholder).
  const messages = reopened.agent.state.messages, at = messages.findIndex(message => text(message) === "landed without a model call");
  reopened.agent.state.messages = messages.map((message, index) => index === at ? { ...message, content: "[archived]" } as AgentMessage : message);
  const more = await fixture([answer("five")], { initialState: { model, tools: [], messages: reopened.agent.state.messages } }, await open());
  await reopened.agent.close();
  await more.agent.prompt(user("fifth"));
  assert.equal(await checkpoints(id), 3);
  assert.ok(more.requests[0].messages.map(text).includes("[archived]"));
  assert.ok(!more.requests[0].messages.map(text).includes("landed without a model call"));
  await more.agent.close();
});

test("Pi adapter checks the host's context in again after a reload settles an interrupted run", async () => {
  const { db } = await testDatabase(), sessionId = randomUUID();
  const open = () => openPiStorage({ sessionId, directory: "unused", db });
  const system = { role: "system", content: "Be brief.", timestamp: 0 } as AgentMessage;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const hang = tool("hang", () => { started(); return new Promise(() => {}); });
  const first = await fixture([call("hang")], { initialState: { model, tools: [hang], messages: [system] } }, await open());
  void first.agent.prompt(user("start")).catch(() => {});
  await running;
  // The node is lost mid-tool: another one opens the session with a working set equal to Pi's context, which closes
  // the open call as missing until a run is settled.
  const assistant = first.agent.state.messages.at(-1) as AssistantMessage;
  const kept = [...first.agent.state.messages, { role: "toolResult", toolCallId: "call-0", toolName: "hang",
    content: [{ type: "text", text: "Tool result unavailable: history ends before this call completed." }], isError: true, details: { reason: "missing_result" }, timestamp: assistant.timestamp } as AgentMessage];
  const second = await fixture([answer("recovered")], { initialState: { model, tools: [hang], messages: kept } }, await open());
  const checkpoints = async () => {
    const storage = await open();
    let count = 0, cursor;
    do {
      const page = await storage.scanEntries({ conversationId: second.agent.conversationId }, 256, cursor, BACKGROUND_CONTEXT);
      count += page.items.filter(entry => entry.kind === "camel.legacy.context").length;
      cursor = page.next;
    } while (cursor !== undefined);
    return count;
  };
  assert.equal((second.agent as any).dirty, false, "opening alone finds Pi's context equal to the host's");
  const before = await checkpoints();
  await second.agent.discardInterruptedRun();
  await second.agent.prompt(user("again"));
  assert.equal(await checkpoints(), before + 1, "the settled run's native results are replaced by the host's working set");
  assert.equal(second.requests.length, 1);
  await second.agent.close();
});
