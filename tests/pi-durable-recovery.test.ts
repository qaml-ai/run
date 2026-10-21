import { nativeTranscriptRecords } from "../src/pi-durable/transcript.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import { fileAppendLog, type AppendLog } from "../shared/append-log.ts";
import { Transcript, historyOf, readTranscript, type TranscriptRecord } from "../src/transcript.ts";
import { openPiJournalReader, openPiStorage } from "../src/pi-durable/storage.ts";
import { loadLegacyMigration } from "../src/pi-durable/migration.ts";
import { recoverDurableMessages } from "../src/pi-durable/agent.ts";
import type { ToolDefinition } from "../src/protocol.ts";
import { setDualWrite } from "../src/pi-durable/transcript.ts";

// The agent host as nodes run it with AGENT_PI_DUAL_WRITE=1 (plans/host-transcript-removal.md, phase 1).
setDualWrite(true);

const context = BACKGROUND_CONTEXT;
const user = (content: string, requestId?: string) => ({ role: "user", content, timestamp: 1, ...(requestId ? { requestId } : {}) }) as AgentMessage;
const answer = (content: Parameters<typeof fauxAssistantMessage>[0], stopReason: AssistantMessage["stopReason"] = "stop") => fauxAssistantMessage(content, { stopReason });
const text = (message: AgentMessage) => message.role === "assistant" ? message.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") : "";
type TestContext = { after(fn: () => unknown): void };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pi-durable-recovery-"));
  const path = join(directory, "transcript.jsonl");
  const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
  const calls: string[] = [];
  let asked = 0;
  const hosts: ReturnType<typeof createAgentHost>[] = [];
  const stores: Awaited<ReturnType<typeof openPiStorage>>[] = [];
  const tools: ToolDefinition[] = [{ name: "lookup", description: "Look up one saved value", parameters: { type: "object" }, exposure: "direct" }];
  const responses = (...steps: FauxResponseStep[]) => faux.setResponses(steps.map(step => (...args: any[]) => {
    asked++;
    return typeof step === "function" ? (step as (...args: any[]) => any)(...args) : step;
  }));
  async function start(options: { resume?: boolean; log?: AppendLog<TranscriptRecord>; inputRequired?: boolean; fault?: "flush" | "torn" } = {}) {
    const storage = await openPiStorage({ sessionId: "public-session", directory });
    stores.push(storage);
    if (options.fault) {
      const commit = storage.commit.bind(storage);
      let finalId: number | undefined;
      storage.commit = async (writes, context) => {
        for (const write of writes) if (write.type === "entry" && write.value.model?.some(message => text(message) === "durable final answer")) finalId = write.value.id;
        const target = writes.some(write => write.type === "entry" && write.value.kind === "camel.host.record" && (write.value.data as any)?.pi?.entryId === finalId && finalId !== undefined);
        if (target) {
          if (options.fault === "torn") await commit(writes, context); // committed, acknowledgement lost
          throw new Error("projection disk unavailable");
        }
        return commit(writes, context);
      };
    }
    const log = options.log ?? fileAppendLog<TranscriptRecord>(path);
    const events: any[] = [];
    const io: HostIO = {
      emit: event => events.push(event),
      tool: async name => { calls.push(name); return options.inputRequired ? { inputRequired: true, content: [{ type: "text", text: "Approval required" }] } : { value: "saved-value" }; },
      cancelTools: async () => null,
      runLimit: async () => undefined,
      transcript: log,
      piStorage: async () => storage,
      file: async () => { throw new Error("unexpected file read"); },
      modelAuth: async () => { throw new Error("unexpected credential lookup"); },
      fs: async () => { throw new Error("unexpected filesystem tool"); },
    };
    const host = createAgentHost(io);
    hosts.push(host);
    const init = await host.handle("init", { id: "public-session", directory, resume: options.resume,
      model: faux.getModel(), apiKey: "fixture", tools, codeMode: false });
    return { host, init, log, storage, events };
  }
  t.after(async () => {
    for (const host of hosts.reverse()) await host.dispose(0).catch(() => {});
    for (const storage of stores) await storage.close(context).catch(() => {});
    faux.unregister();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  });
  return { directory, path, calls, start, responses, asked: () => asked, history: async () => {
    const reader = await openPiJournalReader({ sessionId: "public-session", directory });
    try { const records = reader ? await nativeTranscriptRecords(reader) : undefined; return records ? historyOf(records) : readTranscript(directory); }
    finally { await reader?.close(context); }
  } };
}

{
  for (const mode of ["flush", "torn"] as const) {
    test(`native WAL recovers a ${mode} history projection once on restart, preserving request and tool identity`, { timeout: 20_000 }, async t => {
      const f = await fixture(t);
      f.responses(answer(fauxToolCall("lookup", { key: "saved" }, { id: "lookup-once" }), "toolUse"), answer("durable final answer"));
      const first = await f.start({ fault: mode });
      await assert.rejects(first.host.handle("prompt", { text: "look it up", requestId: "request-once" }), /Session persistence failed:.*projection disk unavailable/);
      assert.deepEqual(f.calls, ["lookup"]);
      assert.equal(f.asked(), 2);
      assert.doesNotMatch(await readFile(f.path, "utf8").catch(() => ""), /durable final answer/, "normal native work never appends the legacy transcript");
      const native = await recoverDurableMessages(first.storage, 1);
      assert.equal(native.filter(item => text(item.message) === "durable final answer").length, 1, "the answer already exists in the authoritative native WAL");
      await first.host.dispose(0).catch(() => {});

      const second = await f.start({ resume: true });
      assert.equal(second.init.resume?.finished?.reply, "durable final answer");
      const history = await f.history();
      assert.deepEqual(history.map(message => message.role), ["user", "assistant", "toolResult", "assistant"]);
      assert.equal(history.filter(message => (message as any).requestId === "request-once").length, 1);
      assert.equal(history.filter(message => message.role === "toolResult" && message.toolCallId === "lookup-once").length, 1);
      assert.equal(history.filter(message => text(message) === "durable final answer").length, 1);
      assert.deepEqual(f.calls, ["lookup"], "recovering never repeats the completed tool side effect");
      assert.equal(f.asked(), 2, "recovering a committed final response never asks the model again");
      assert.deepEqual(await second.host.handle("prompt", { text: "look it up", requestId: "request-once" }), { messages: 4, error: null, taken: true });
      assert.equal(f.asked(), 2);
      const repairedText = await readFile(f.path, "utf8").catch(() => "");
      assert.doesNotMatch(repairedText, /"text":"torn/);
      await second.host.dispose(0);

      const third = await f.start({ resume: true });
      assert.deepEqual(await f.history(), history, "a second restart cannot project the native response twice");
      assert.equal(f.asked(), 2);
      assert.deepEqual(f.calls, ["lookup"]);
      assert.equal(third.init.messages, 4);
      f.responses(answer("next response"));
      assert.equal((await third.host.handle("prompt", { text: "next", requestId: "request-next" })).reply, "next response");
      assert.equal((await f.history()).length, 6, "the recovered session accepts future work");
    });
  }
}

test("a legacy turn its node lost mid-run is imported as it stands, and the next owner continues it on Pi without taking its request twice", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  // As a node on the legacy engine left it: the turn open, its call made, the result never written.
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(f.path));
  await transcript.setActive(true);
  await transcript.append([user("unfinished legacy request", "active-request"), answer(fauxToolCall("lookup", { key: "saved" }, { id: "lost-call" }), "toolUse")]);
  await transcript.log.close();
  const legacy = await readFile(f.path, "utf8");
  const first = await f.start({ resume: true });
  assert.deepEqual(first.init.migration, { state: "migrated", from: "active" });
  assert.ok(await loadLegacyMigration(first.storage));
  assert.deepEqual(first.init.resume, { continue: true });
  const repaired = await f.history();
  assert.deepEqual(repaired.map(message => message.role), ["user", "assistant", "toolResult"]);
  assert.match(JSON.stringify(repaired[2]), /outcome is unknown/, "the lost call is answered as unknown, never made again");
  f.responses(answer("completed on Pi"));
  assert.equal((await first.host.handle("continue", {})).reply, "completed on Pi");
  assert.deepEqual(f.calls, []);
  assert.equal(await readFile(f.path, "utf8"), legacy, "the legacy log is not written");
  await first.host.dispose(0);
  const before = await f.history();
  const second = await f.start();
  assert.deepEqual(second.init.migration, { state: "existing" });
  assert.deepEqual(await f.history(), before);
  assert.deepEqual(await second.host.handle("prompt", { text: "unfinished legacy request", requestId: "active-request" }), { messages: 4, error: null, taken: true });
  f.responses(answer("new native work"));
  assert.equal((await second.host.handle("prompt", { text: "new", requestId: "new-native" })).reply, "new native work");
});

test("a legacy human wait is imported with its call open, and its answer resumes the turn on Pi without running the tool", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(f.path));
  await transcript.setActive(true);
  await transcript.append([user("needs approval", "waiting-request"), answer(fauxToolCall("lookup", { key: "saved" }, { id: "waiting-call" }), "toolUse")]);
  await transcript.await(["waiting-call"]);
  await transcript.log.close();
  const first = await f.start({ resume: true });
  assert.deepEqual(first.init.migration, { state: "migrated", from: "active" });
  assert.equal(first.init.resume?.finished?.stopped, "input_required");
  assert.equal((await f.history()).filter(message => message.role === "toolResult").length, 0, "the call stays open for its answer");
  await first.host.dispose(0);
  // Reopened while it waits: still waiting, now on Pi.
  const second = await f.start({ resume: true });
  assert.deepEqual(second.init.migration, { state: "existing" });
  f.responses(answer("human answer accepted"));
  const resumed = await second.host.handle("resume", { calls: [{ toolCallId: "waiting-call", result: { content: [{ type: "text", text: "already approved" }], isError: false } }] });
  assert.equal(resumed.reply, "human answer accepted");
  assert.deepEqual(f.calls, [], "the supplied human result settles the old call without another side effect");
  const after = await f.history();
  assert.equal(after.filter(message => message.role === "toolResult" && message.toolCallId === "waiting-call").length, 1);
  assert.deepEqual(after.map(message => message.role), ["user", "assistant", "toolResult", "assistant"]);
});

test("a legacy context Pi orders its own way imports whole and is checkpointed once, not on every run", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  // Results in completion order, not call order, and a failed response kept visible: Pi orders and leaves out these itself.
  const calls = answer([fauxToolCall("lookup", { key: "a" }, { id: "a" }), fauxToolCall("lookup", { key: "b" }, { id: "b" })], "toolUse");
  const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "lookup", content: [{ type: "text", text: id }], isError: false, timestamp: 2 }) as AgentMessage;
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(f.path));
  await transcript.setActive(true);
  await transcript.append([user("both"), calls, result("b"), result("a"), answer("Both."), user("again"), answer("", "error")]);
  await transcript.setActive(false);
  await transcript.log.close();
  const before = historyOf(await fileAppendLog<TranscriptRecord>(f.path).read());
  const { host, init, storage } = await f.start();
  assert.deepEqual(init.migration, { state: "migrated", from: "context_changed" });
  const checkpoints = async () => {
    let count = 0;
    for (let cursor; ;) {
      const page = await storage.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, cursor, context);
      count += page.items.filter(entry => entry.kind === "camel.legacy.context").length;
      if (!(cursor = page.next)) break;
    }
    return count;
  };
  assert.equal(await checkpoints(), 1, "the import's");
  for (const text of ["one", "two", "three"]) {
    f.responses(answer(`reply ${text}`));
    assert.equal((await host.handle("prompt", { text })).reply, `reply ${text}`);
  }
  assert.equal(await checkpoints(), 1, "runs append to Pi's context; none rewrites it");
  const history = await f.history();
  assert.deepEqual(history.slice(0, before.length), before, "the history is whole, in the order the legacy engine wrote it");
  assert.equal(history.length, before.length + 6);
});

test("a legacy wait between turns (no turn running) imports as awaiting, and a new message closes it first", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(f.path));
  await transcript.setActive(true);
  await transcript.append([user("needs approval", "waiting-request"), answer(fauxToolCall("lookup", { key: "saved" }, { id: "waiting-call" }), "toolUse")]);
  await transcript.await(["waiting-call"]);
  await transcript.setActive(false);
  await transcript.log.close();
  const first = await f.start();
  assert.deepEqual(first.init.migration, { state: "migrated", from: "awaiting" });
  f.responses(answer("moved on"));
  assert.equal((await first.host.handle("prompt", { text: "never mind", requestId: "next" })).reply, "moved on");
  const after = await f.history();
  assert.match(JSON.stringify(after.find(message => message.role === "toolResult")), /Not answered: the user sent a new message instead/);
  assert.deepEqual(f.calls, []);
});

test("a native human wait survives reopen and accepts its answer without projecting the temporary result or repeating its call", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.responses(answer(fauxToolCall("lookup", { key: "saved" }, { id: "native-waiting-call" }), "toolUse"));
  const first = await f.start({ inputRequired: true });
  const suspended = await first.host.handle("prompt", { text: "ask before acting", requestId: "native-waiting-request" });
  assert.equal(suspended.stopped, "input_required");
  assert.deepEqual(f.calls, ["lookup"]);
  assert.equal((await f.history()).filter(message => message.role === "toolResult").length, 0, "temporary native result is not public completed history");
  await first.host.dispose(0);
  const second = await f.start({ resume: true });
  assert.equal((second.init.resume?.finished ?? second.init.ended?.finished)?.stopped, "input_required");
  assert.deepEqual(f.calls, ["lookup"]);
  assert.equal((await f.history()).filter(message => message.role === "toolResult").length, 0);
  f.responses(answer("native human answer accepted"));
  const resumed = await second.host.handle("resume", { calls: [{ toolCallId: "native-waiting-call", result: { content: [{ type: "text", text: "approved answer" }], isError: false } }] });
  assert.equal(resumed.reply, "native human answer accepted");
  assert.deepEqual(f.calls, ["lookup"], "supplying a result never re-executes the suspended native tool");
  const before = await f.history();
  assert.equal(before.filter(message => message.role === "toolResult" && message.toolCallId === "native-waiting-call").length, 1);
  assert.doesNotMatch(JSON.stringify(before), /inputRequired/);
  await second.host.dispose(0);
  await f.start({ resume: true });
  assert.deepEqual(await f.history(), before);
});

test("an answer to a waiting call is written into Pi's journal with its host record, so the next run checks no context in again", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  f.responses(answer(fauxToolCall("lookup", { key: "saved" }, { id: "dual-written-call" }), "toolUse"));
  const host = await f.start({ inputRequired: true });
  assert.equal((await host.host.handle("prompt", { text: "ask first", requestId: "dual-written-request" })).stopped, "input_required");
  const kinds = async () => {
    const counts: Record<string, number> = {};
    for (let cursor; ;) {
      const page = await host.storage.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, cursor, context);
      for (const entry of page.items) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
      if (!(cursor = page.next)) break;
    }
    return counts;
  };
  const before = await kinds();
  f.responses(answer("answered"));
  assert.equal((await host.host.handle("resume", { calls: [{ toolCallId: "dual-written-call", result: { content: [{ type: "text", text: "approved" }], isError: false } }] })).reply, "answered");
  const after = await kinds();
  assert.equal(after["camel.message"] - (before["camel.message"] ?? 0), 1, "the host's answer is a native entry");
  assert.equal(after["camel.legacy.context"], before["camel.legacy.context"], "Pi's context already holds it: no whole-context checkpoint");
  assert.ok(after["camel.history.marker"] > (before["camel.history.marker"] ?? 0), "the turn's end is a marker");
});
