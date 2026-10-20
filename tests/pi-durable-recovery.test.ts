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
import type { AgentEngine } from "../src/pi-durable/config.ts";
import type { ToolDefinition } from "../src/protocol.ts";

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
  async function start(options: { engine?: AgentEngine; resume?: boolean; log?: AppendLog<TranscriptRecord>; inputRequired?: boolean; fault?: "flush" | "torn" } = {}) {
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
    const init = await host.handle("init", { id: "public-session", directory, engine: options.engine ?? "pi-durable", resume: options.resume,
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

for (const engine of ["pi-durable", "legacy"] as const) {
  for (const mode of ["flush", "torn"] as const) {
    test(`native WAL recovers a ${mode} history projection once on ${engine} restart, preserving request and tool identity`, { timeout: 20_000 }, async t => {
      const f = await fixture(t);
      f.responses(answer(fauxToolCall("lookup", { key: "saved" }, { id: "lookup-once" }), "toolUse"), answer("durable final answer"));
      const first = await f.start({ fault: mode });
      assert.equal(first.init.engine, "pi-durable");
      await assert.rejects(first.host.handle("prompt", { text: "look it up", requestId: "request-once" }), /Session persistence failed:.*projection disk unavailable/);
      assert.deepEqual(f.calls, ["lookup"]);
      assert.equal(f.asked(), 2);
      assert.doesNotMatch(await readFile(f.path, "utf8").catch(() => ""), /durable final answer/, "normal native work never appends the legacy transcript");
      const native = await recoverDurableMessages(first.storage, 1);
      assert.equal(native.filter(item => text(item.message) === "durable final answer").length, 1, "the answer already exists in the authoritative native WAL");
      await first.host.dispose(0).catch(() => {});

      const second = await f.start({ engine, resume: true });
      assert.equal(second.init.engine, engine);
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

      const third = await f.start({ engine, resume: true });
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

test("an active legacy session finishes on its existing engine, then migrates on the next idle reopen", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(f.path));
  await transcript.setActive(true);
  await transcript.push(user("unfinished legacy request", "active-request"));
  await transcript.log.close();
  const first = await f.start({ resume: true });
  assert.equal(first.init.engine, "legacy");
  assert.equal(first.init.migration?.state, "deferred");
  assert.equal(first.init.migration?.reason, "active");
  assert.equal(await loadLegacyMigration(first.storage), undefined);
  f.responses(answer("completed by legacy"));
  assert.equal((await first.host.handle("continue", {})).reply, "completed by legacy");
  await first.host.dispose(0);
  await first.storage.close(context);
  const before = await f.history();
  const second = await f.start();
  assert.equal(second.init.engine, "pi-durable");
  assert.equal(second.init.migration?.state, "migrated");
  assert.deepEqual(await f.history(), before);
  assert.deepEqual(await second.host.handle("prompt", { text: "unfinished legacy request", requestId: "active-request" }), { messages: 2, error: null, taken: true });
  f.responses(answer("new native work"));
  assert.equal((await second.host.handle("prompt", { text: "new", requestId: "new-native" })).reply, "new native work");
});

test("legacy human waits retain the open call and answer on legacy before migrating without rerunning the tool", { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(f.path));
  await transcript.setActive(true);
  await transcript.append([user("needs approval", "waiting-request"), answer(fauxToolCall("lookup", { key: "saved" }, { id: "waiting-call" }), "toolUse")]);
  await transcript.await(["waiting-call"]);
  await transcript.log.close();
  const first = await f.start({ resume: true });
  assert.equal(first.init.engine, "legacy");
  assert.equal(first.init.migration?.state, "deferred");
  assert.equal(first.init.migration?.reason, "awaiting");
  assert.equal(await loadLegacyMigration(first.storage), undefined);
  assert.equal(first.init.resume?.finished?.stopped, "input_required");
  f.responses(answer("human answer accepted"));
  const resumed = await first.host.handle("resume", { calls: [{ toolCallId: "waiting-call", result: { content: [{ type: "text", text: "already approved" }], isError: false } }] });
  assert.equal(resumed.reply, "human answer accepted");
  assert.deepEqual(f.calls, [], "the supplied human result settles the old call without another side effect");
  await first.host.dispose(0);
  await first.storage.close(context);
  const before = await f.history();
  assert.equal(before.filter(message => message.role === "toolResult" && message.toolCallId === "waiting-call").length, 1);
  const second = await f.start();
  assert.equal(second.init.engine, "pi-durable");
  assert.equal(second.init.migration?.state, "migrated");
  assert.deepEqual(await f.history(), before);
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
  assert.equal(second.init.engine, "pi-durable");
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
