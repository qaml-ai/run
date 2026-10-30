import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage, StorageRequestError, type Storage } from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentMessage, AgentOptions, AgentTool } from "@earendil-works/pi-agent-core";
import { DurableAgent, recoverDurableMessages, type DurableAgentOptions } from "../src/pi-durable/agent.ts";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { randomUUID } from "node:crypto";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { testDatabase } from "./database.ts";

const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "Fixture", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1000 } as any;
const answer = (text: string) => ({ ...fauxAssistantMessage(text), provider: model.provider, model: model.id });
const call = (...names: string[]) => ({ ...fauxAssistantMessage(names.map((name, i) => fauxToolCall(name, {}, { id: `call-${i}` })), { stopReason: "toolUse" }), provider: model.provider, model: model.id });
const user = (text: string) => ({ role: "user" as const, content: text, timestamp: 1 });

async function fixture(responses: AssistantMessage[], options: Partial<AgentOptions> = {}, supplied: Storage = new MemoryStorage(), durable: Partial<DurableAgentOptions["durable"]> = {}) {
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
    ...options, durable: { storage: supplied, ...durable },
  });
  agent.subscribe(event => { events.push(event); });
  return { agent, events, requests, storage: supplied };
}

const tool = (name: string, execute: AgentTool["execute"] = async () => ({ content: [{ type: "text", text: "found" }], details: { saved: true } })): AgentTool => ({
  name, label: name, description: name, parameters: { type: "object", properties: {} }, execute,
});

test("context telemetry estimates held before preparation and sent after conversion on every request", async t => {
  const expectedHeld: number[] = [], measured: { held: number; sent: number }[] = [];
  const fake = await fixture([answer("Old reply"), call("read"), answer("Done")], {
    initialState: { model, messages: [], tools: [tool("read")] },
    convertToLlm: messages => messages.map(message => message.role === "user" ? { ...message, content: "hydrated request" } : message) as any,
    // A request that sends less than Pi holds: only the latest user message.
    prepareRequest: async ({ context }) => {
      expectedHeld.push(context.messages.reduce((sum, message) => sum + estimateMessageTokens(message as any), 0));
      return { context: { ...context, messages: [context.messages.findLast(message => message.role === "user")!] } };
    },
  }, new MemoryStorage(), {
    onContextRequest: (held, sent) => measured.push({ held, sent }),
  });
  t.after(() => fake.agent.close());
  await fake.agent.prompt("old history ".repeat(200));
  await fake.agent.prompt("current task");
  assert.equal(measured.length, 3);
  assert.deepEqual(measured.map(item => item.held), expectedHeld);
  assert.deepEqual(measured.map(item => item.sent), fake.requests.map(request =>
    request.messages.reduce((sum: number, message: any) => sum + estimateMessageTokens(message), 0)));
  assert.ok(measured.every(item => item.held > item.sent));
  assert.ok(measured[2].held > measured[1].held, "committed tool calls and results contribute to the next request");
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
  // Asked for the first call whose result is final (its end holds for the round's other calls), then for the round.
  assert.equal(finished.length, 2);
  assert.deepEqual(finished.at(-1), ["first", "second"]);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.agent.state.pendingToolCalls.size, 0);
  assert.equal(fake.events.filter(event => event.type === "message_end").length, 4);
});

for (const order of ["ender first", "ender last"] as const) test(`Pi adapter ends the round when only one call ends it (${order}), without another provider request`, async t => {
  // One call settles before the call that ends the run: its result asked for nothing, so Pi alone would go on.
  const slow = (ms: number) => async () => { await new Promise(resolve => setTimeout(resolve, ms)); return { content: [{ type: "text" as const, text: "ok" }], details: null }; };
  const tools = [tool("ender", slow(order === "ender first" ? 1 : 30)), tool("other", slow(order === "ender first" ? 30 : 1))];
  const fake = await fixture([call("ender", "other"), answer("extra"), answer("again")], {
    initialState: { model, messages: [], tools },
    finishTurn: turn => turn.toolResults.some(result => result.toolName === "ender") ? { action: "end" } : undefined,
  });
  t.after(() => fake.agent.close());
  await fake.agent.prompt("Work");
  assert.equal(fake.requests.length, 1);
  // The next run is not limited.
  await fake.agent.prompt("More");
  assert.equal(fake.requests.length, 2);
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
  assert.deepEqual((agent as any).queued, [user("later")]);
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
  await fake.agent.replaceContext([user("continue this history")]);
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

test("Pi adapter's context is Pi's own: runs and reloads write no checkpoint, and a reload settling an interrupted run sends its result", async () => {
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
  const text = (message: any) => typeof message.content === "string" ? message.content : message.content.map((part: any) => part.text ?? "").join("");
  const system = { role: "system", content: "Be brief.", timestamp: 0 } as AgentMessage;
  let started!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const hang = tool("hang", () => { started(); return new Promise(() => {}); });
  const first = await fixture([answer("one"), call("hang")], { initialState: { model, tools: [hang], messages: [] } }, await open());
  await first.agent.replaceContext([system]);
  const id = first.agent.conversationId;
  await first.agent.prompt(user("first"));
  assert.equal(await checkpoints(id), 1, "the host's leading system message, once");
  void first.agent.prompt(user("second")).catch(() => {});
  await running;
  // The node is lost mid-tool: another one opens the session, and Pi settles the call it left open.
  const second = await fixture([answer("recovered")], { initialState: { model, tools: [hang], messages: [] } }, await open());
  await second.agent.discardInterruptedRun();
  await second.agent.prompt(user("again"));
  assert.equal(await checkpoints(id), 1, "nothing is checked in again");
  assert.equal(text(second.requests[0].messages[0]), "Be brief.");
  assert.deepEqual(second.requests[0].messages.filter((message: any) => message.role === "user").map(text), ["first", "second", "again"]);
  assert.equal(second.requests[0].messages.filter((message: any) => message.role === "toolResult").length, 1, "the lost call has a result");
  await second.agent.close();
});

test("Pi adapter commits a streaming answer's progress about once a second, not on every delta", async () => {
  const storage = new MemoryStorage();
  let commits = 0, streaming = false;
  const commit = storage.commit.bind(storage);
  storage.commit = async (writes, adopt, at) => { if (streaming) commits++; return commit(writes, adopt, at); };
  const response = answer("x".repeat(30));
  const fake = await fixture([], { streamFn: () => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const partial = { ...response, content: [{ type: "text" as const, text: "" }] };
      stream.push({ type: "start", partial });
      stream.push({ type: "text_start", contentIndex: 0, partial });
      streaming = true;
      for (let i = 0; i < 30; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        partial.content[0].text += "x";
        stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
      }
      streaming = false;
      stream.push({ type: "done", reason: "stop", message: response }); stream.end(response);
    })();
    return stream;
  } }, storage);
  await fake.agent.prompt(user("Stream"));
  assert.ok(fake.events.filter(event => event.type === "message_update").length >= 30, "every delta still reaches the host live");
  assert.ok(commits <= 3, `1.5 s of deltas commit progress ${commits} times`);
  await fake.agent.close();
});

test("Pi adapter fails a run whose generation faulted instead of ending it as answered", async t => {
  let thrown = false;
  const fake = await fixture([call("read")], { initialState: { model, tools: [tool("read")], messages: [] },
    // Throws once, inside Pi's tool phase: the generation faults; the run loop's own check after it passes.
    finishTurn: async () => { if (!thrown) { thrown = true; throw new Error("policy broke"); } } });
  t.after(() => fake.agent.close());
  await fake.agent.prompt(user("Read it"));
  assert.equal(fake.agent.state.messages.at(-1)?.role, "toolResult", "no answer was made");
  assert.equal(fake.agent.state.errorMessage, "policy broke");
});

test("Pi adapter stops a model request when Pi ends the generation, not only when the host aborts the run", { timeout: 10_000 }, async () => {
  let started!: () => void, requestSignal: AbortSignal | undefined;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    streamFn: (_model, _context, options) => {
      const stream = createAssistantMessageEventStream();
      requestSignal = options?.signal;
      // A provider that answers only once its request is cancelled.
      options?.signal?.addEventListener("abort", () => {
        const aborted = { ...answer(""), stopReason: "aborted" } as AssistantMessage;
        stream.push({ type: "error", reason: "aborted", error: aborted }); stream.end(aborted);
      });
      started();
      return stream;
    },
    durable: { storage: new MemoryStorage() },
  });
  const run = agent.prompt(user("Go")).catch(() => {});
  await requested;
  // Pi aborts the conversation's work on its own (as a failed storage or another handle would): the host never aborts.
  await (agent as any).conversation.abort(BACKGROUND_CONTEXT);
  await run;
  assert.equal(requestSignal?.aborted, true);
  await agent.close();
});

test("Pi adapter reports only the storage failures that fail Pi's Session", async () => {
  const failures: unknown[] = [];
  const storage = new MemoryStorage();
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    streamFn: () => { throw new Error("Unexpected model request"); },
    durable: { storage, onStorageFailure: error => { failures.push(error); } },
  });
  // An invalid read fails only that call: Pi keeps its Session, and the host keeps the agent.
  await assert.rejects((agent as any).conversation.entries({}, 10, { bogus: true }, BACKGROUND_CONTEXT), StorageRequestError);
  assert.deepEqual(failures, []);
  // Closing ends Pi's commit observer `failed` ("session closed"): the agent's own close is no failure.
  const closeFailures: unknown[] = [];
  const closed = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    streamFn: () => { throw new Error("Unexpected model request"); },
    durable: { storage: new MemoryStorage(), onStorageFailure: error => { closeFailures.push(error); } },
  });
  await closed.close();
  assert.deepEqual(closeFailures, []);
  // A failed write fails the Session, and is reported.
  storage.commit = async () => { throw new Error("disk gone"); };
  await assert.rejects(agent.prompt(user("Hello")));
  assert.equal(failures.length, 1);
  await agent.close().catch(() => {});
});

test("Pi input writes keep the whole message, as earlier readers take data.message whole", async t => {
  const fake = await fixture([answer("Done")], {}, new MemoryStorage());
  t.after(() => fake.agent.close());
  const input = user("rollback safe");
  await fake.agent.prompt(input);
  const entry = (await fake.storage.scanEntries({ conversationId: fake.agent.conversationId, order: "ascending" }, 100, undefined, BACKGROUND_CONTEXT)).items.find(entry => entry.kind === "camel.user")!;
  assert.deepEqual((entry.data as any).message, input);
  assert.deepEqual((await fake.agent.recoverMessages())[0].message, input);
});

test("a round whose run ends still ends it after its node is lost mid-round, with no model request on the next owner", { timeout: 30_000 }, async () => {
  const { db } = await testDatabase(), sessionId = randomUUID();
  const open = () => openPiStorage({ sessionId, directory: "unused", db });
  let requests = 0;
  // The node is lost while "other" runs: it never answers there.
  const tools = (hang: boolean) => [tool("ender"), tool("other", async () => { if (hang) await new Promise(() => {}); return { content: [], details: null }; })];
  const first = await DurableAgent.create({
    initialState: { model, messages: [], tools: tools(true) },
    streamFn: (_model, _context) => {
      requests++;
      const response = call("ender", "other");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "start", partial: { ...response, content: [] } }); stream.push({ type: "done", reason: "toolUse", message: response }); stream.end(response); });
      return stream;
    },
    finishTurn: turn => turn.toolResults.some(result => result.toolName === "ender") ? { action: "end" } : undefined,
    durable: { storage: await open() },
  });
  void first.prompt(user("Go")).catch(() => {});
  const storage = await open();
  // Wait until the ending call's result and the round's end are committed.
  for (;;) {
    const entries = (await storage.scanEntries({ conversationId: first.conversationId as never }, 100, undefined, BACKGROUND_CONTEXT)).items;
    if (entries.some(entry => entry.kind === "pi.tool-result")) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // The next owner knows nothing of the host's decision: only what Pi and the adapter committed.
  const next = await fixture([answer("extra")], { initialState: { model, messages: [], tools: tools(false) }, finishTurn: () => undefined }, await open(),
    { retry: () => ({ retry: true, delayMs: 0 }) });
  try {
    await next.agent.continue();
    assert.equal(requests, 1);
    assert.equal(next.requests.length, 0, "the round still ends the run");
  } finally {
    await next.agent.close(100).catch(() => {});
    await first.close(100).catch(() => {});
  }
});

test("Pi adapter asks again in a resumed run whose model request a lost node left in flight, as its retry decision says", { timeout: 20_000 }, async () => {
  const { db } = await testDatabase(), sessionId = randomUUID();
  const open = () => openPiStorage({ sessionId, directory: "unused", db });
  let requests = 0;
  const hanging = (storage: Storage) => DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    // The request "kills the node": it never answers, and the next node opens the session while it is running.
    streamFn: () => { requests++; return createAssistantMessageEventStream(); },
    durable: { storage },
  });
  const reports: string[] = [];
  const report = console.error;
  console.error = (line: unknown) => { if (typeof line === "string" && line.includes("pi_report")) reports.push(line); };
  const agents: DurableAgent[] = [];
  try {
    const first = await hanging(await open());
    agents.push(first);
    void first.prompt(user("Go")).catch(() => {});
    while (requests < 1) await new Promise(resolve => setTimeout(resolve, 5));
    // The interrupted request is a failed attempt: the host's retry decision has it made again.
    const next = await fixture([answer("back")], {}, await open(), { retry: failed => failed.reason === "interrupted" ? { retry: true, delayMs: 0 } : undefined });
    agents.push(next.agent);
    await next.agent.continue();
    assert.equal(requests, 1, "the lost node's request was not resent by Pi itself");
    assert.equal(next.requests.length, 1, "asked again once");
    assert.equal(next.agent.state.errorMessage, undefined);
    assert.ok(!reports.some(line => line.includes("task_interrupted")), "retried, not ended");
  } finally {
    console.error = report;
    for (const agent of agents.reverse()) await agent.close(100).catch(() => {});
  }
});

for (const [kind, errorMessage] of [["transient (Pi makes it again)", "503 Service Unavailable"], ["refused (the adapter makes it again)", "400 image_rejected"]] as const) test(`a failed response the host has made again, ${kind}, is kept in Pi's journal but not in the history`, async t => {
  const failed = { ...answer(""), content: [], stopReason: "error" as const, errorMessage };
  const decisions: string[] = [];
  const fake = await fixture([failed, answer("Recovered")], {}, new MemoryStorage(), {
    // Asked for an interrupted request whenever Pi reads its retry policy: only model errors are counted.
    retry: attempt => { if (attempt.reason !== "model_error") return { retry: true, delayMs: 0 }; decisions.push(attempt.reason); return decisions.length === 1 ? { retry: true, delayMs: 5 } : { retry: false }; },
  });
  t.after(() => fake.agent.close());
  await fake.agent.prompt("Go");
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(decisions, ["model_error"]);
  assert.equal((fake.agent as any).retryPlan, undefined, "the decision ends once Pi commits the response it was for");
  assert.equal(fake.agent.state.errorMessage, undefined);
  assert.deepEqual((await fake.agent.recoverMessages()).map(item => item.message.role), ["user", "assistant"]);
  assert.deepEqual(fake.agent.state.messages.filter(message => message.role !== "system").map(message => message.role), ["user", "assistant"]);
  const entries = (await fake.storage.scanEntries({ conversationId: fake.agent.conversationId as never }, 100, undefined, BACKGROUND_CONTEXT)).items;
  const assistants = entries.filter(entry => entry.kind === "pi.assistant").map(entry => (entry.model![0] as any));
  console.log(JSON.stringify({ kind, journal: assistants.map(message => ({ stopReason: message.stopReason, retried: message.retried })) }));
});

test("a failed summary's decision never overrides a generation's pending one, which ends once Pi commits the response", async t => {
  const fake = await fixture([answer("ok")], {}, new MemoryStorage(), { retry: () => ({ retry: true, delayMs: 0 }) });
  t.after(() => fake.agent.close());
  const agent = fake.agent as any;
  agent.retryPlan = { retry: true, delayMs: 2_000 };
  agent.summaryPlan = { retry: false };
  assert.deepEqual(agent.retryPolicy(), { retry: true, delayMs: 2_000 });
  assert.equal(agent.retryDelayMs(), 2_000);
  agent.retryPlan = undefined;
  assert.deepEqual(agent.retryPolicy(), { retry: false });
  // A summary's decision lasts only for Pi's read as it resumes from the summary.
  await new Promise(resolve => setImmediate(resolve));
  agent.summaryPlan = undefined;
  assert.deepEqual(agent.retryPolicy(), { retry: true, delayMs: 0 }, "an interrupted request: the host's decision");
});

test("a failed response the host does not make again ends the run and stays in the history", async t => {
  const failed = { ...answer(""), content: [], stopReason: "error" as const, errorMessage: "503 Service Unavailable" };
  const fake = await fixture([failed, answer("never")], {}, new MemoryStorage(), { retry: () => ({ retry: false }) });
  t.after(() => fake.agent.close());
  await fake.agent.prompt("Go");
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.agent.state.errorMessage, "503 Service Unavailable");
  assert.deepEqual((await fake.agent.recoverMessages()).map(item => item.message.role), ["user", "assistant"]);
});

test("a partial answer a lost node left in flight is not in the history once the request is made again", { timeout: 20_000 }, async () => {
  const { db } = await testDatabase(), sessionId = randomUUID();
  const open = () => openPiStorage({ sessionId, directory: "unused", db });
  let requests = 0;
  const first = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    // The request streams part of an answer, then "kills the node": it never ends.
    streamFn: () => {
      requests++;
      const stream = createAssistantMessageEventStream();
      const partial = { ...answer("half an answer"), stopReason: "stop" as const };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...partial, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...partial, content: [{ type: "text", text: "" }] } } as any);
        stream.push({ type: "text_delta", contentIndex: 0, delta: "half an answer", partial } as any);
      });
      return stream;
    },
    durable: { storage: await open() },
  });
  void first.prompt(user("Go")).catch(() => {});
  while (requests < 1) await new Promise(resolve => setTimeout(resolve, 5));
  // Pi commits a partial answer about once a second.
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const next = await fixture([answer("whole answer")], {}, await open(), { retry: failed => failed.reason === "interrupted" ? { retry: true, delayMs: 0 } : undefined });
  try {
    await next.agent.continue();
    const history = (await next.agent.recoverMessages()).map(item => item.message as any);
    console.log(JSON.stringify({ history: history.map(message => ({ role: message.role, stopReason: message.stopReason, text: message.content?.[0]?.text ?? message.content })) }));
    const storage = await open();
    const entries = (await storage.scanEntries({ conversationId: next.agent.conversationId as never }, 100, undefined, BACKGROUND_CONTEXT)).items;
    const journal = entries.filter(entry => entry.kind === "pi.assistant").map(entry => entry.model![0] as any);
    // The lost node's partial is in Pi's journal, as an aborted response marked retried.
    assert.ok(journal.some(message => message.stopReason === "aborted" && message.retried === true), JSON.stringify(journal));
    assert.deepEqual(history.map(message => message.role), ["user", "assistant"]);
    assert.equal(history[1].content[0].text, "whole answer");
  } finally {
    await next.agent.close(100).catch(() => {});
    await first.close(100).catch(() => {});
  }
});

test("Pi adapter's model requests carry no pi attribution (no OpenRouter/NVIDIA/OpenCode origin headers)", async () => {
  const { getIdentityHeaders } = await import("@earendil-works/pi-ai/utils/identity");
  let identity: any;
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    streamFn: (_model, _context, options) => {
      identity = (options as any)?.identity;
      const response = answer("ok"), stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: response }); stream.end(response); });
      return stream;
    },
    durable: { storage: new MemoryStorage() },
  });
  await agent.prompt(user("Hi"));
  await agent.close();
  assert.equal(identity?.attribution, null);
  const headers = getIdentityHeaders({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" } as any, identity);
  assert.deepEqual(Object.keys(headers), ["User-Agent"]);
});

test("a request that sends less than Pi holds starts Pi's compaction in the background, once a run", async t => {
  let agent!: DurableAgent, summaries = 0;
  const summary = { ...fauxAssistantMessage("Summary of the long history."), provider: model.provider, model: model.id };
  const fake = await fixture([answer("One"), answer("Two"), answer("Three"), call("read"), answer("Done")], {
    initialState: { model, messages: [], tools: [tool("read")] },
    // As the host's image budget does: each request of the last run leaves out part of what Pi holds.
    convertToLlm: messages => { if (compacting) agent.compactSoon(); return messages as any; },
  }, new MemoryStorage(), {
    summaryStream: () => {
      summaries++;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: summary }); stream.end(summary); });
      return stream;
    },
  });
  agent = fake.agent;
  t.after(() => agent.close());
  let compacting = false;
  for (const text of ["first", "second", "third"]) await agent.prompt(`${text} ${"long history ".repeat(2_000)}`);
  compacting = true;
  await agent.prompt("current task");
  const compacted = async () => (await fake.storage.scanEntries({ conversationId: agent.conversationId, order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT)).items.some(entry => entry.kind === "pi.compaction");
  for (let tries = 0; tries < 100 && !await compacted(); tries++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await compacted(), true, "Pi compacted what the requests left out");
  assert.equal(summaries, 1, "one compaction for the run's two requests");
});

test("a prompt of several messages under one request id sends them all in its first request, and is recorded once", async t => {
  const fake = await fixture([answer("Both")]);
  t.after(() => fake.agent.close());
  const one = { ...user("one"), requestId: "r-1" } as AgentMessage, two = { ...user("two"), requestId: "r-1" } as AgentMessage;
  await fake.agent.prompt([one, two]);
  assert.deepEqual(fake.requests[0].messages.filter((message: any) => message.role === "user").map((message: any) => message.content), ["one", "two"]);
  assert.deepEqual((await fake.agent.recoverMessages()).map(item => item.message).slice(0, 2), [one, two]);
  assert.ok(await fake.storage.submissionByRequest(fake.agent.conversationId, "r-1", BACKGROUND_CONTEXT));
});

test("steers given while no run is active go in with the next run's input, before its first request", async t => {
  const fake = await fixture([answer("Done")]);
  t.after(() => fake.agent.close());
  fake.agent.steer(user("held one"));
  fake.agent.steer(user("held two"));
  await fake.agent.prompt("Start");
  assert.deepEqual(fake.requests[0].messages.filter((message: any) => message.role === "user").map((message: any) => message.content), ["Start", "held one", "held two"]);
  assert.equal(fake.agent.hasQueuedMessages(), false);
});
