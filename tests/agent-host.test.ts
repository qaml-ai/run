import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getCurrentTools, getSystemMessageText, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import { forkCut, recordedMessages, Transcript, type TranscriptRecord } from "../src/transcript.ts";
import { fileAppendLog, type AppendLog } from "../shared/append-log.ts";
import type { ToolDefinition } from "../src/protocol.ts";

/**
 * The agent host on its own, without a supervisor or processes: a faux model, a transcript file, and crashes simulated
 * by writing the transcript a lost node would have left (or stopping a host mid-turn) and loading it in a new host.
 */
type Context = { after(fn: () => unknown): void };

async function setup(t: Context) {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-"));
  const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
  t.after(async () => { faux.unregister(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "transcript.jsonl");
  const tools: ToolDefinition[] = [
    { name: "lookup", description: "Look something up", parameters: { type: "object" }, exposure: "direct" },
    { name: "approve", description: "Needs a person", parameters: { type: "object" }, exposure: "direct" },
    { name: "delegate", description: "A sub-agent", parameters: { type: "object" }, exposure: "direct" },
  ];
  /** A host over the transcript file, as a node starting the agent: `call` answers its tools. */
  async function start(options: { resume?: boolean; call?: (name: string, host: ReturnType<typeof createAgentHost>) => unknown; log?: AppendLog<TranscriptRecord>; initialMessages?: AgentMessage[] } = {}) {
    const events: any[] = [];
    const log = options.log ?? fileAppendLog<TranscriptRecord>(path);
    const io: HostIO = {
      emit: event => events.push(event),
      tool: async name => (options.call ?? (() => "found"))(name, host),
      cancelTools: async () => null,
      runLimit: async () => undefined,
      transcript: log,
      file: async () => { throw new Error("no files"); },
      modelAuth: async () => { throw new Error("no per-call credentials"); },
      fs: async () => { throw new Error("no files"); },
    };
    const host = createAgentHost(io);
    const init = await host.handle("init", { id: "agent", directory, model: faux.getModel(), apiKey: "fixture", tools, ...(options.resume ? { resume: true } : {}), ...(options.initialMessages ? { initialMessages: options.initialMessages } : {}) });
    t.after(() => host.dispose(0));
    return { host, init, events, log };
  }
  /** Leave the transcript as a node lost mid-turn would: a turn opened and `messages` written, nothing after. */
  async function crashedTurn(messages: AgentMessage[], before: AgentMessage[] = []) {
    const transcript = new Transcript(fileAppendLog<TranscriptRecord>(path));
    await transcript.load();
    if (before.length) { await transcript.setActive(true); await transcript.append(before); await transcript.setActive(false); }
    await transcript.setActive(true);
    await transcript.append(messages);
    await transcript.log.close();
  }
  const history = async () => { const transcript = new Transcript(fileAppendLog<TranscriptRecord>(path)); await transcript.load(); await transcript.log.close(); return transcript; };
  const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
  return { faux, start, crashedTurn, history, respond, path };
}

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;
const answer = (content: Parameters<typeof fauxAssistantMessage>[0], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => fauxAssistantMessage(content, { stopReason });
const result = (toolCallId: string, toolName: string, text: string, details?: unknown) => ({ role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], ...(details !== undefined ? { details } : {}), isError: false, timestamp: 2 }) as AgentMessage;
const roles = (messages: AgentMessage[]) => messages.map(message => message.role);

test("resume: a turn lost after a tool call answers the call as unknown and continues; a failed response is taken back first", async t => {
  const fake = await setup(t);
  await fake.crashedTurn([user("look it up"), answer(fauxToolCall("lookup", {}, { id: "call_1" }), "toolUse"), answer("half an ans", "aborted")]);
  const { host, init } = await fake.start({ resume: true });
  assert.deepEqual(init.resume, { continue: true });
  assert.equal(init.recovered, true);
  const after = await fake.history();
  assert.equal(after.active, true, "the turn stays open for the next owner to continue");
  assert.deepEqual(roles(after.context), ["user", "assistant", "toolResult"], "the cut-off response is gone; the call has its result");
  assert.match(JSON.stringify(after.context[2]), /outcome is unknown/);
  fake.respond(answer("Done."));
  const run = await host.handle("continue", {});
  assert.equal(run.error, null);
  assert.equal(run.reply, "Done.");
  assert.equal((await fake.history()).active, false);
});

test("resume: a turn that had answered finishes with that answer, and one that had called final_output with its output", async t => {
  const fake = await setup(t);
  await fake.crashedTurn([user("hi"), answer("Hello there.")]);
  const answered = await fake.start({ resume: true });
  assert.deepEqual(answered.init.resume, { finished: { messages: 2, error: null, reply: "Hello there.", replyIndex: 1 } });
  assert.equal((await fake.history()).active, false);

  const structured = await setup(t);
  await structured.crashedTurn([user("count"), answer(fauxToolCall("final_output", { n: 3 }, { id: "out" }), "toolUse"), result("out", "final_output", "Accepted.", { output: { n: 3 } })]);
  const { init } = await structured.start({ resume: true });
  assert.deepEqual(init.resume.finished.output, { n: 3 });
  assert.equal((await structured.history()).active, false);
});

test("resume: a turn lost before anything of its own is closed with a runtime notice, as there is nothing to continue", async t => {
  const fake = await setup(t);
  // An earlier turn's answer is the last message: the lost turn wrote nothing.
  await fake.crashedTurn([], [user("hi"), answer("Hello.")]);
  const { init } = await fake.start({ resume: true });
  assert.equal(init.resume, undefined);
  const after = await fake.history();
  assert.equal(after.active, false);
  assert.match(JSON.stringify(after.context.at(-1)), /previous run was interrupted by a restart/);
});

test("uncertain: without resume, an interrupted turn is closed, its open calls answered as unknown, and the agent goes on", async t => {
  const fake = await setup(t);
  await fake.crashedTurn([user("look it up"), answer(fauxToolCall("lookup", {}, { id: "call_1" }), "toolUse")]);
  const { host, init } = await fake.start();
  assert.equal(init.recovered, true);
  assert.equal(init.resume, undefined);
  const after = await fake.history();
  assert.equal(after.active, false);
  assert.deepEqual(roles(after.context), ["user", "assistant", "toolResult", "user"]);
  assert.match(JSON.stringify(after.context[2]), /outcome is unknown/);
  fake.respond(answer("Ready."));
  assert.equal((await host.handle("prompt", { text: "next" })).reply, "Ready.");
});

test("repair: a turn lost while a call waited on a person keeps that call open and the others closed, and stays suspended", async t => {
  const fake = await setup(t);
  // One call suspended for input, the other still running when the node was lost.
  const calls = answer([fauxToolCall("approve", {}, { id: "ask" }), fauxToolCall("lookup", {}, { id: "run" })], "toolUse");
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(fake.path));
  await transcript.setActive(true);
  await transcript.append([user("do it"), calls]);
  await transcript.await(["ask"]);
  await transcript.log.close();
  const { init } = await fake.start({ resume: true });
  assert.deepEqual(init.resume, { finished: { messages: 3, error: null, stopped: "input_required" } });
  const after = await fake.history();
  assert.deepEqual(after.awaiting, ["ask"]);
  assert.equal(after.active, false);
  assert.deepEqual(after.context.filter(message => message.role === "toolResult").map(message => (message as { toolCallId: string }).toolCallId), ["run"]);
});

test("a node stopped while a tool call runs leaves a turn the next one resumes from its transcript", async t => {
  const fake = await setup(t);
  const running = Promise.withResolvers<void>();
  fake.respond(answer(fauxToolCall("lookup", {}, { id: "call_1" }), "toolUse"));
  const first = await fake.start({ call: () => { running.resolve(); return new Promise(() => {}); } });
  // The turn never settles: its node is gone, as a process killed mid-call would be.
  void first.host.handle("prompt", { text: "look it up" }).catch(() => {});
  await running.promise;
  await first.host.dispose(0);
  fake.respond(answer("Found it."));
  const { host, init } = await fake.start({ resume: true });
  assert.deepEqual(init.resume, { continue: true });
  assert.equal((await host.handle("continue", {})).reply, "Found it.");
  assert.deepEqual(roles((await fake.history()).context), ["user", "assistant", "toolResult", "assistant"]);
});

test("a write that fails leaves memory as the log has it, and the agent refuses runs until it is loaded again", async t => {
  const fake = await setup(t);
  const file = fileAppendLog<TranscriptRecord>(fake.path);
  let failing = false;
  const log: AppendLog<TranscriptRecord> = {
    read: () => file.read(), append: record => file.append(record), rewrite: snapshot => file.rewrite(snapshot), close: () => file.close(),
    get appendedSinceRewrite() { return file.appendedSinceRewrite; },
    flush: async durable => { if (failing) throw new Error("disk full"); return file.flush(durable); },
  };
  const { host } = await fake.start({ log });
  fake.respond(answer("One."));
  assert.equal((await host.handle("prompt", { text: "one" })).reply, "One.");
  const status = await host.handle("status", {});
  failing = true;
  fake.respond(answer("Two."));
  await host.handle("prompt", { text: "two" }).catch(() => {});
  assert.equal((await host.handle("status", {})).messages, status.messages, "nothing unwritten is held");
  await assert.rejects(host.handle("prompt", { text: "three" }), /Session persistence failed: Error: disk full/);
});

test("the leading system message is pinned in one commit with the first message, and a change follows it", async t => {
  const fake = await setup(t);
  const flushes: TranscriptRecord[][] = [];
  const file = fileAppendLog<TranscriptRecord>(fake.path);
  let pending: TranscriptRecord[] = [];
  const log: AppendLog<TranscriptRecord> = {
    read: () => file.read(), rewrite: snapshot => file.rewrite(snapshot), close: () => file.close(),
    append: record => { pending.push(record); file.append(record); },
    get appendedSinceRewrite() { return file.appendedSinceRewrite; },
    flush: async durable => { flushes.push(pending); pending = []; return file.flush(durable); },
  };
  const { host } = await fake.start({ log });
  fake.respond(answer("One."));
  await host.handle("prompt", { text: "one" });
  await host.handle("configure", { systemPrompt: "New rules" });
  const kinds = flushes.filter(batch => batch.some(record => record.t === "system")).map(batch => batch.map(record => record.t === "system" ? (record.leading ? "leading" : "change") : record.t));
  assert.deepEqual(kinds, [["leading", "message"], ["change"]]);
});

test("resume: a lost delegate call is made again (it finds the child its call started), while other open calls are closed as unknown", async t => {
  const fake = await setup(t);
  await fake.crashedTurn([user("research both"), answer([fauxToolCall("lookup", {}, { id: "look" }), fauxToolCall("delegate", { task: "dig" }, { id: "dig" })], "toolUse")]);
  const calls: string[] = [];
  const { host, init } = await fake.start({ resume: true, call: name => { calls.push(name); return { agentId: "client_child", status: "completed", text: "the child's answer" }; } });
  assert.deepEqual(init.resume, { continue: true });
  const repaired = await fake.history();
  assert.deepEqual(repaired.context.filter(message => message.role === "toolResult").map(message => (message as { toolCallId: string }).toolCallId), ["look"], "only the lookup is closed");
  fake.respond(answer("Both done."));
  const run = await host.handle("continue", {});
  assert.equal(run.reply, "Both done.");
  assert.deepEqual(calls, ["delegate"], "the delegate call ran again; the lookup did not");
  const results = (await fake.history()).context.filter(message => message.role === "toolResult") as { toolCallId: string; content: { text: string }[] }[];
  assert.deepEqual(results.map(message => message.toolCallId), ["look", "dig"]);
  assert.match(results[1].content[0].text, /the child's answer/);
});

for (const when of ["before the host has the run", "as the host begins it"]) {
  test(`an abort of a resumed turn ${when} settles it in the transcript, its lost delegate call closed as unknown, so a fork holds it`, async t => {
    const fake = await setup(t);
    await fake.crashedTurn([user("research it"), answer(fauxToolCall("delegate", { task: "dig" }, { id: "dig" }), "toolUse")], [user("hello"), answer("Hi.")]);
    const calls: string[] = [];
    let asked = 0;
    fake.respond(() => { asked++; return answer("Too late."); });
    const { host, init } = await fake.start({ resume: true, call: name => { calls.push(name); return { agentId: "client_child", status: "completed", text: "the child's answer" }; } });
    assert.deepEqual(init.resume, { continue: true });
    assert.equal((await fake.history()).active, true, "the turn is open for the continue");
    let result;
    // Aborted while its session waited to give it to the host (`aborted`), or while the host sets the continue up.
    if (when === "before the host has the run") result = await host.handle("continue", { aborted: true });
    else {
      const run = host.handle("continue", {});
      await host.handle("abort", {});
      result = await run;
    }
    assert.equal(result.error, "The run was aborted");
    assert.equal(result.code, "aborted");
    assert.deepEqual(calls, [], "the delegate call was not made again");
    assert.equal(asked, 0, "the model was never asked");
    const after = await fake.history();
    assert.equal(after.active, false, "the turn is settled before the run is seen to end");
    assert.deepEqual(roles(after.context), ["user", "assistant", "user", "assistant", "toolResult"]);
    assert.match(JSON.stringify(after.context.at(-1)), /outcome is unknown/);
    // A fork without a point ends with the last settled record: the aborted turn's prompt is in it.
    const records = await fileAppendLog<TranscriptRecord>(fake.path).read();
    const cut = forkCut(records);
    assert.equal(cut.through, 4);
    assert.ok(recordedMessages(cut.records).some(message => JSON.stringify(message).includes("research it")));
    // The next prompt starts a turn of its own.
    fake.respond(answer("Next."));
    assert.equal((await host.handle("prompt", { text: "again" })).reply, "Next.");
    assert.equal((await fake.history()).active, false);
  });
}

test("an abort that reaches a run before its model loop starts ends it, rather than finding nothing to stop", async t => {
  const fake = await setup(t);
  let asked = 0;
  fake.respond(() => { asked++; return answer("Too late."); });
  const { host } = await fake.start();
  // The abort arrives while the prompt is still being set up (its first await), before Pi's loop exists.
  const run = host.handle("prompt", { text: "go" });
  await host.handle("abort", {});
  const result = await run;
  assert.equal(result.error, "The run was aborted");
  assert.equal(asked, 0, "the model was never asked");
  assert.equal((await fake.history()).active, false);
  fake.respond(answer("Next."));
  assert.equal((await host.handle("prompt", { text: "again" })).reply, "Next.");
});
