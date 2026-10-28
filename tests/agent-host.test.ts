import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage, getCurrentTools, getSystemMessageText, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import type { ToolDefinition } from "../src/protocol.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { APPLICATION, applicationInstructions } from "../src/system-prompt.ts";
import type { Storage as PiStorage } from "@earendil-works/pi-durable";
import { openPiJournalReader, openPiStorage } from "../src/pi-durable/storage.ts";
import { JournalHistory } from "../src/pi-durable/history.ts";
import { journalForkCut } from "../src/pi-durable/fork.ts";
import { hostTranscriptSession, setDualWrite, type TranscriptRecord } from "./fixtures/host-transcript.ts";
import { journalMessages } from "./fixtures/journal-history.ts";

// Sessions a release before the host transcript's removal left (a node lost mid-turn), as nodes ran it then
// (AGENT_PI_DUAL_WRITE=1): their first load retires the host transcript.
setDualWrite(true);

/**
 * The agent host on its own, without a supervisor or processes: a faux model, its Pi storage, and crashes simulated by
 * stopping a host mid-turn, or seeding the history a lost node of the release before left, and loading the agent in a
 * new host.
 */
type Context = { after(fn: () => unknown): void };

async function setup(t: Context) {
  const directory = await mkdtemp(join(tmpdir(), "agent-host-"));
  const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
  t.after(async () => { faux.unregister(); await rm(directory, { recursive: true, force: true }); });
  const tools: ToolDefinition[] = [
    { name: "lookup", description: "Look something up", parameters: { type: "object" }, exposure: "direct" },
    { name: "approve", description: "Needs a person", parameters: { type: "object" }, exposure: "direct" },
    { name: "delegate", description: "A sub-agent", parameters: { type: "object" }, exposure: "direct" },
    { name: "fetch", description: "Fetch something, alongside other calls", parameters: { type: "object" }, exposure: "direct", executionMode: "parallel" },
  ];
  /** A host over the agent's Pi storage, as a node starting the agent: `call` answers its tools. */
  async function start(options: { resume?: boolean; call?: (name: string, host: ReturnType<typeof createAgentHost>) => unknown; storage?: (storage: PiStorage) => PiStorage; initialMessages?: AgentMessage[]; tenant?: string; history?: HostIO["history"] } = {}) {
    const events: any[] = [];
    const opened = await openPiStorage({ sessionId: "agent", directory });
    const storage = options.storage?.(opened) ?? opened;
    const io: HostIO = {
      emit: event => events.push(event),
      tool: async name => (options.call ?? (() => "found"))(name, host),
      cancelTools: async () => null,
      runLimit: async () => undefined,
      legacyLog: { empty: async () => true },
      piStorage: async () => storage,
      file: async () => { throw new Error("no files"); },
      modelAuth: async () => { throw new Error("no per-call credentials"); },
      fs: async () => { throw new Error("no files"); },
      ...(options.history ? { history: options.history } : {}),
    };
    const host = createAgentHost(io);
    const init = await host.handle("init", { id: "agent", directory, model: faux.getModel(), apiKey: "fixture", tools, ...(options.tenant ? { tenant: options.tenant } : {}), ...(options.resume ? { resume: true } : {}), ...(options.initialMessages ? { initialMessages: options.initialMessages } : {}) });
    t.after(async () => { await host.dispose(0); await opened.close(BACKGROUND_CONTEXT); });
    return { host, init, events };
  }
  /**
   * Leave the agent as a node of the release before the host transcript's removal lost mid-turn would: a turn opened and
   * `messages` written, nothing after (`records`, its whole history so far).
   */
  async function crashedTurn(messages: AgentMessage[], before: AgentMessage[] = [], after: TranscriptRecord[] = []) {
    const records: TranscriptRecord[] = [];
    const message = (message: AgentMessage): TranscriptRecord => ({ t: "message", message });
    if (before.length) records.push({ t: "turn", active: true }, ...before.map(message), { t: "turn", active: false });
    records.push({ t: "turn", active: true }, ...messages.map(message), ...after);
    await hostTranscriptSession({ sessionId: "agent", directory }, records);
  }
  /** The agent's history and turn, as its journal gives them (`context`: every message). */
  const history = async () => {
    const storage = await openPiStorage({ sessionId: "agent", directory });
    try {
      const journal = (await JournalHistory.openAny(storage))!;
      return { active: journal.active, awaiting: journal.awaiting, total: journal.total, turnStart: journal.turnStart, context: await journalMessages({ sessionId: "agent", directory }) };
    } finally { await storage.close(BACKGROUND_CONTEXT); }
  };
  const respond = (...steps: FauxResponseStep[]) => faux.setResponses(steps);
  return { faux, start, crashedTurn, history, respond, directory };
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
  assert.deepEqual(answered.init.resume, { finished: { messages: 2, error: null, reply: "Hello there.", replyIndex: 1, servedModel: "faux/faux-1" } });
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
  await fake.crashedTurn([user("do it"), calls], [], [{ t: "awaiting", calls: ["ask"] }]);
  const { init } = await fake.start({ resume: true });
  assert.deepEqual(init.resume, { finished: { messages: 3, error: null, stopped: "input_required" } });
  const after = await fake.history();
  assert.deepEqual(after.awaiting, ["ask"]);
  assert.equal(after.active, false);
  assert.deepEqual(after.context.filter(message => message.role === "toolResult").map(message => (message as { toolCallId: string }).toolCallId), ["run"]);
});

test("a node stopped while a tool call runs leaves a turn the next one resumes from its journal", async t => {
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

test("a write that fails leaves memory as the journal has it, and the agent refuses runs until it is loaded again", async t => {
  const fake = await setup(t);
  let failing = false;
  const { host } = await fake.start({ storage: storage => {
    const commit = storage.commit.bind(storage);
    storage.commit = async (writes, adopt, context) => { if (failing) throw new Error("disk full"); return commit(writes, adopt, context); };
    return storage;
  } });
  fake.respond(answer("One."));
  assert.equal((await host.handle("prompt", { text: "one" })).reply, "One.");
  const status = await host.handle("status", {});
  failing = true;
  fake.respond(answer("Two."));
  await host.handle("prompt", { text: "two" }).catch(() => {});
  assert.equal((await host.handle("status", {})).messages, status.messages, "nothing unwritten is held");
  await assert.rejects(host.handle("prompt", { text: "three" }), /Session persistence failed: .*disk full/);
});

test("the leading system message is the agent's first context, and a change follows it as a system message of its own", async t => {
  const fake = await setup(t);
  const written: string[][] = [];
  const { host } = await fake.start({ storage: storage => {
    const commit = storage.commit.bind(storage);
    storage.commit = async (writes, adopt, context) => {
      const kinds = writes.flatMap(write => write.type === "entry" && ["camel.system", "camel.legacy.context"].includes(write.value.kind) ? [write.value.kind] : []);
      if (kinds.length) written.push(kinds);
      return commit(writes, adopt, context);
    };
    return storage;
  } });
  fake.respond(answer("One."));
  await host.handle("prompt", { text: "one" });
  await host.handle("configure", { systemPrompt: "New rules" });
  assert.deepEqual(written, [["camel.legacy.context"], ["camel.system"]], "the seed's checkpoint holds the leading message; the change is appended, never a checkpoint");
  let seen: AgentMessage[] = [];
  fake.respond(context => { seen = context.messages as AgentMessage[]; return answer("Two."); });
  await host.handle("prompt", { text: "two" });
  assert.match(JSON.stringify(seen.at(-2)), /New rules/, "the change is in the context where it was made");
  assert.equal(seen[0].role, "system");
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
  test(`an abort of a resumed turn ${when} settles it in the journal, its lost delegate call closed as unknown, so a fork holds it`, async t => {
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
    // A fork without a point ends with the last turn that ended: the aborted turn's prompt is in it.
    const storage = await openPiStorage({ sessionId: "agent", directory: fake.directory });
    try {
      const cut = await journalForkCut(storage, (await JournalHistory.openAny(storage))!, after.context);
      assert.equal(cut.through, 4);
      assert.ok(cut.messages.some(message => JSON.stringify(message).includes("research it")));
    } finally { await storage.close(BACKGROUND_CONTEXT); }
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

test("a conversation a later release re-keyed to the application section keeps that key: rolled back, its instructions are not declared twice", async t => {
  const fake = await setup(t);
  // As the release that renames the section leaves a conversation: its instructions under `application`.
  const instructions = applicationInstructions();
  const leading = { role: "system", content: "Runtime rules.", sections: { [APPLICATION]: instructions }, timestamp: 0 } as SystemMessage;
  await hostTranscriptSession({ sessionId: "agent", directory: fake.directory }, [
    { t: "system", message: leading, leading: true }, { t: "turn", active: true },
    { t: "message", message: user("earlier") }, { t: "message", message: answer("Earlier answer.") }, { t: "turn", active: false },
  ]);
  const { host } = await fake.start();
  let seen: AgentMessage[] = [];
  fake.respond(context => { seen = context.messages as AgentMessage[]; return answer("Done."); });
  assert.equal((await host.handle("prompt", { text: "again" })).error, null);
  const sections = getCurrentSystemMessage(seen as never)?.sections ?? {};
  assert.equal(sections.instructions, undefined, "no second instructions section");
  assert.equal(sections[APPLICATION], instructions);
  assert.equal(getSystemMessageText(getCurrentSystemMessage(seen as never)!).split(instructions).length - 1, 1, "the instructions appear once");
});

test("a conversation still under the old instructions key is re-keyed to application as it loads, its instructions sent once", async t => {
  const fake = await setup(t);
  const instructions = applicationInstructions();
  const leading = { role: "system", content: "Runtime rules.", sections: { instructions }, timestamp: 0 } as SystemMessage;
  await hostTranscriptSession({ sessionId: "agent", directory: fake.directory }, [
    { t: "system", message: leading, leading: true }, { t: "turn", active: true },
    { t: "message", message: user("earlier") }, { t: "message", message: answer("Earlier answer.") }, { t: "turn", active: false },
  ]);
  const { host } = await fake.start();
  const seen: AgentMessage[][] = [];
  const capture = (reply: string) => (context: any) => { seen.push(context.messages); return answer(reply); };
  fake.respond(capture("One."), capture("Two."));
  await host.handle("prompt", { text: "one" });
  await host.handle("prompt", { text: "two" });
  for (const messages of seen) {
    const system = getCurrentSystemMessage(messages as never)!;
    assert.deepEqual(Object.keys(system.sections ?? {}), ["application", "environment"]);
    assert.equal(getSystemMessageText(system).split(instructions).length - 1, 1, "the instructions appear once");
  }
});

test("a session's host transcript is retired once, at its first load: a base where it stood, and an earlier release refuses it", async t => {
  const fake = await setup(t);
  await fake.crashedTurn([], [user("hi"), answer("Hello.")]);
  const markers = async () => {
    const reader = (await openPiJournalReader({ sessionId: "agent", directory: fake.directory }))!;
    try {
      const kinds: string[] = [];
      for (let cursor; ;) {
        const page = await reader.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, cursor, BACKGROUND_CONTEXT);
        for (const entry of page.items) if (entry.kind === "camel.host.disabled" || entry.kind === "camel.history.marker" && (entry.data as { t?: string }).t === "base") kinds.push(entry.kind === "camel.host.disabled" ? "disabled" : "base");
        if (!(cursor = page.next)) break;
      }
      return kinds;
    } finally { await reader.close(BACKGROUND_CONTEXT); }
  };
  const first = await fake.start();
  assert.deepEqual(await markers(), ["base", "disabled"]);
  fake.respond(answer("One."));
  assert.equal((await first.host.handle("prompt", { text: "one" })).messages, 5, "the old history, the interrupted turn's notice, and the new turn");
  await first.host.dispose(0);
  const second = await fake.start();
  fake.respond(answer("Two."));
  assert.equal((await second.host.handle("prompt", { text: "two" })).messages, 7);
  assert.deepEqual(await markers(), ["base", "disabled"], "a later load keeps the base and retires nothing again");
  const storage = await openPiStorage({ sessionId: "agent", directory: fake.directory });
  try {
    const document = await storage.findDocument({ kind: "camel.host.snapshot", scope: { kind: "session" } }, "current", BACKGROUND_CONTEXT);
    const value = (await storage.document(document!.id, "current", BACKGROUND_CONTEXT))!.value as { enabled: boolean; retired: string };
    assert.equal(value.enabled, false, "an earlier release opens no host generation");
    assert.equal(value.retired, "journal", "and says why, refusing the session as newer (#374)");
  } finally { await storage.close(BACKGROUND_CONTEXT); }
  assert.deepEqual(roles((await fake.history()).context), ["user", "assistant", "user", "user", "assistant", "user", "assistant"]);
});

test("a host transcript no release retired is refused at load, logged, its journal untouched", async t => {
  const fake = await setup(t);
  await hostTranscriptSession({ sessionId: "agent", directory: fake.directory }, [{ t: "turn", active: true }, { t: "message", message: user("hi") }, { t: "message", message: answer("Hello.") }, { t: "turn", active: false }], { unretired: true });
  const entries = async () => {
    const storage = await openPiStorage({ sessionId: "agent", directory: fake.directory });
    try { return (await storage.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, undefined, BACKGROUND_CONTEXT)).items.length; }
    finally { await storage.close(BACKGROUND_CONTEXT); }
  };
  const before = await entries();
  const logged: string[] = [];
  const error = console.error;
  console.error = (line: unknown) => { logged.push(String(line)); };
  try { await assert.rejects(fake.start(), /AGENT_NOT_MIGRATED: .*host_transcript/); }
  finally { console.error = error; }
  assert.ok(logged.some(line => JSON.parse(line).type === "legacy_format_refused" && JSON.parse(line).kind === "host_transcript"));
  assert.equal(await entries(), before);
});

test("the history index takes its chunks from the journal", async t => {
  const fake = await setup(t);
  const chunks: { start: number; messages: AgentMessage[]; turns: number[] }[] = [];
  let indexed = 0;
  const history = { indexed: async () => indexed,
    write: async (chunk: { start: number; messages: AgentMessage[]; turns: number[] }) => { chunks.push(chunk); indexed = chunk.start + chunk.messages.length; return indexed; } };
  const { host } = await fake.start({ history });
  fake.respond(answer(fauxToolCall("lookup", {}, { id: "look" }), "toolUse"), answer("Found."), answer("Again."));
  await host.handle("prompt", { text: "look it up" });
  await host.handle("prompt", { text: "again" });
  await host.handle("historyFlush", {});
  assert.deepEqual(chunks.flatMap(chunk => chunk.messages).map(message => message.role), ["user", "assistant", "toolResult", "assistant", "user", "assistant"]);
  assert.deepEqual(chunks.flatMap(chunk => chunk.turns), [0, 4]);
});

test("two calls of one response that ask for their message index at once read the journal history once each (it fails a run that counts twice)", async t => {
  const fake = await setup(t);
  // Journal reads that take a while, as Postgres's do: the two calls' refreshes overlap.
  const { host } = await fake.start({ storage: storage => {
    const scan = storage.scanEntries.bind(storage);
    storage.scanEntries = async (...args) => { await new Promise(resolve => setTimeout(resolve, 5)); return scan(...args); };
    return storage;
  } });
  fake.respond(answer([fauxToolCall("fetch", {}, { id: "a" }), fauxToolCall("fetch", {}, { id: "b" })], "toolUse"), answer("Done."));
  const run = await host.handle("prompt", { text: "fetch both" });
  assert.equal(run.error, null);
  assert.equal(run.reply, "Done.");
  assert.equal(run.messages, 5);
});

test("a history tail is the journal's: what Pi committed is in it at once", async t => {
  const fake = await setup(t);
  const noIndex = { indexed: async () => 0, write: async () => 0 } as unknown as HostIO["history"];
  let journal!: PiStorage;
  const { host } = await fake.start({ history: noIndex, storage: storage => (journal = storage) });
  fake.respond(answer("One."));
  await host.handle("prompt", { text: "one" });
  // Pi's next response is committed; its event is still on its way to the host.
  await journal.commit([{ type: "entry", value: { id: await journal.mintId(), conversationId: 1 as never, kind: "pi.assistant", model: [answer("Two.")] as never } }], () => {}, BACKGROUND_CONTEXT);
  const tail = await host.handle("historyTail", {});
  assert.deepEqual(tail.messages.map((message: AgentMessage) => message.role), ["user", "assistant", "assistant"]);
});
