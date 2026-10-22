import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { HostJournal } from "../src/pi-durable/host-journal.ts";
import { BASE_ADDRESS, JournalHistory } from "../src/pi-durable/history.ts";
import { loadSeedMarker, seedJournal } from "../src/pi-durable/seed.ts";
import { closeInterruptedTurn } from "../src/history.ts";
import { historyOf, NativeTranscript, setDualWrite, type TranscriptRecord } from "./fixtures/host-transcript.ts";
import type { AppendLog } from "../shared/append-log.ts";

// Sessions a release before the host transcript's removal seeded, as nodes ran it then.
setDualWrite(true);

const user = (content: string, requestId?: string) => ({ role: "user", content, timestamp: 1, ...(requestId ? { requestId } : {}) }) as AgentMessage;
const system = { role: "system", content: "Rules.", timestamp: 0 } as AgentMessage;
const roles = (messages: AgentMessage[] | undefined) => messages?.map(message => message.role);

/** A new session's journal, as a host seeds it, and its HostJournal. */
async function seeded(messages: AgentMessage[] = []) {
  const storage = new MemoryStorage();
  await seedJournal({ storage, sessionId: "test", model: [system as never], messages });
  return { storage, journal: (await HostJournal.open(storage))! };
}

test("seeding the same source again finds it seeded; another session's or source's is refused, and a failed seed leaves nothing", async () => {
  const storage = new MemoryStorage();
  const messages = [user("hi", "r")];
  assert.equal((await seedJournal({ storage, sessionId: "test", model: [system as never], messages })).status, "seeded");
  assert.equal((await seedJournal({ storage, sessionId: "test", model: [system as never], messages })).status, "existing");
  await assert.rejects(seedJournal({ storage, sessionId: "other", model: [system as never], messages }), /seed conflict/);
  await assert.rejects(seedJournal({ storage, sessionId: "test", model: [system as never], messages: [] }), /seed conflict/);
  const journal = (await HostJournal.open(storage))!;
  assert.equal(journal.total, 1, "an import's messages are history");
  assert.ok(await journal.hasRequest("r"), "and its requests are taken");
  const empty = new MemoryStorage();
  empty.commit = async () => { throw new Error("disk full"); };
  await assert.rejects(seedJournal({ storage: empty, sessionId: "test", model: [system as never] }), /disk full/);
  assert.equal(await loadSeedMarker(empty), undefined);
  await storage.close(context); await empty.close(context);
});

test("the host's records are history in Pi's journal: messages, a retraction (out of Pi's context too), turns and calls left waiting", async () => {
  const { storage, journal } = await seeded();
  await journal.setActive(true);
  await journal.append([user("one", "first"), fauxAssistantMessage(fauxToolCall("lookup", {}, { id: "call" }), { stopReason: "toolUse" })]);
  await journal.await(["call"]);
  assert.deepEqual([journal.total, journal.active, journal.turnStart, journal.awaiting, journal.callIndex("call")], [2, true, 0, ["call"], 1]);
  await journal.append([fauxAssistantMessage("taken back")]);
  await journal.retract();
  assert.equal(journal.total, 2);
  await journal.push({ role: "toolResult", toolCallId: "call", toolName: "lookup", content: [{ type: "text", text: "found" }], isError: false, timestamp: 2 } as AgentMessage);
  await journal.setActive(false);
  assert.deepEqual([journal.total, journal.active, journal.awaiting], [3, false, []]);
  assert.deepEqual(roles(await journal.history.messagesFrom(0)), ["user", "assistant", "toolResult"]);
  // Read again from the journal alone, as a node loading the agent does.
  const reloaded = (await HostJournal.open(storage))!;
  assert.deepEqual([reloaded.total, reloaded.active, reloaded.turnStart, reloaded.awaiting, reloaded.callIndex("call")], [3, false, 0, [], 1]);
  assert.ok(await reloaded.hasRequest("first"));
  // The retracted answer is out of Pi's context: an omit edit on its entry.
  const entries = (await storage.scanEntries({ conversationId: 1 as never, order: "ascending" }, 256, undefined, context)).items;
  const taken = entries.find(entry => entry.model?.some(message => message.role === "assistant" && JSON.stringify(message).includes("taken back")))!;
  assert.ok(entries.some(entry => entry.edits?.some(edit => edit.target === taken.id && edit.action === "omit")));
  await storage.close(context);
});

test("a turn interrupted mid-step is closed from its latest step: its open calls answered as unknown, once", async () => {
  const { storage, journal } = await seeded();
  await journal.setActive(true);
  await journal.append([user("both"), fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "a" }), fauxToolCall("lookup", {}, { id: "b" })], { stopReason: "toolUse" }),
    { role: "toolResult", toolCallId: "a", toolName: "lookup", content: [{ type: "text", text: "A" }], isError: false, timestamp: 2 } as AgentMessage]);
  assert.equal(await closeInterruptedTurn(journal), true);
  assert.equal(await closeInterruptedTurn(journal), false, "a closed turn is left alone");
  const messages = (await journal.history.messagesFrom(0))!;
  assert.deepEqual(roles(messages), ["user", "assistant", "toolResult", "toolResult", "user"]);
  assert.equal((messages[3] as { toolCallId: string }).toolCallId, "b");
  assert.equal(journal.active, false);
  await storage.close(context);
});

test("once the index holds a settled history grown well past its base, later loads read the journal from a new base", async () => {
  const { storage, journal } = await seeded();
  for (let index = 0; index < 150; index++) {
    await journal.setActive(true);
    await journal.append([user(`q${index}`), fauxAssistantMessage(`a${index}`)]);
    await journal.setActive(false);
  }
  assert.equal(await journal.rebase(100), false, "not while the index lacks messages before it");
  assert.equal(await journal.rebase(300), true);
  const document = await storage.findDocument(BASE_ADDRESS, "current", context);
  const base = (await storage.document(document!.id, "current", context))!.value as { entry: number };
  const history = (await JournalHistory.open(storage))!;
  assert.equal(history.baseId, base.entry);
  assert.deepEqual([history.baseTotal, history.total, history.heldFrom], [300, 300, 300]);
  await journal.setActive(true);
  await journal.append([user("after")]);
  await history.refresh();
  assert.equal(history.total, 301);
  assert.deepEqual(await history.messagesFrom(300), [user("after")]);
  await storage.close(context);
});

/** A session as a release before the host transcript's removal seeded it from `records`. */
async function earlier(records: TranscriptRecord[], options: { legacy?: AppendLog<TranscriptRecord> } = {}) {
  const storage = new MemoryStorage();
  assert.ok(await NativeTranscript.seed(storage, { sessionId: "test", records, ...options }));
  return storage;
}

test("retiring indexes the settled history before the base the index lacks, keeps the running turn's in the journal, and is done once", async () => {
  const answer = (text: string) => fauxAssistantMessage(text);
  const records: TranscriptRecord[] = [
    { t: "turn", active: true }, { t: "message", message: user("q1") }, { t: "message", message: answer("a1") }, { t: "turn", active: false },
    { t: "turn", active: true }, { t: "message", message: user("q2") }, { t: "message", message: answer("half") }, { t: "retract" },
    { t: "message", message: fauxAssistantMessage(fauxToolCall("lookup", {}, { id: "c" }), { stopReason: "toolUse" }) },
  ];
  const storage = await earlier(records);
  const chunks: { from: number; messages: AgentMessage[]; turns: number[] }[] = [];
  const retired = await HostJournal.retire(storage, { indexed: 1, index: async (from, messages, turns) => { chunks.push({ from, messages, turns }); return from + messages.length; } });
  assert.equal(retired, true);
  assert.deepEqual(chunks.map(chunk => [chunk.from, roles(chunk.messages)]), [[1, ["assistant"]]], "from where the index ends, to the running turn");
  assert.equal(await HostJournal.retire(storage, { indexed: 2, index: async () => { throw new Error("retired once"); } }), false);
  const journal = (await HostJournal.open(storage))!;
  assert.deepEqual([journal.total, journal.active, journal.turnStart, journal.history.heldFrom], [4, true, 2, 2]);
  assert.deepEqual(roles(await journal.turnMessages()), ["user", "assistant"], "the running turn's messages are the journal's");
  // A retraction within them, and the turn closed from its latest step.
  await journal.retract();
  assert.equal(await closeInterruptedTurn(journal), true);
  assert.deepEqual(roles(await journal.history.messagesFrom(2)), ["user", "user"]);
  assert.deepEqual(historyOf(records).slice(0, 2).map(message => message.role), ["user", "assistant"]);
  await storage.close(context);
});

test("retiring a session whose import is in its legacy log indexes from that log first", async () => {
  const records: TranscriptRecord[] = [{ t: "message", message: user("imported", "old") }, { t: "message", message: fauxAssistantMessage("answer") }];
  const kept: TranscriptRecord[] = [];
  const legacy: AppendLog<TranscriptRecord> = { read: async () => kept, readBounded: async () => kept, append: record => { kept.push(record); }, flush: async () => {},
    rewrite: async snapshot => { kept.splice(0, kept.length, ...snapshot()); }, close: async () => {}, appendedSinceRewrite: 0 };
  await legacy.rewrite(() => records);
  const storage = await earlier(records, { legacy });
  const chunks: AgentMessage[][] = [];
  assert.ok(await HostJournal.retire(storage, { indexed: 0, index: async (from, messages) => { chunks.push(messages); return from + messages.length; }, legacy: () => legacy.read() as never }));
  assert.deepEqual(chunks, [historyOf(records)]);
  const journal = (await HostJournal.open(storage))!;
  assert.deepEqual([journal.total, journal.history.heldFrom], [2, 2]);
  assert.ok(await journal.hasRequest("old"));
  await storage.close(context);
});

test("a retraction of a message before the base (the running turn's) takes back that message, not one written after", async () => {
  const storage = await earlier([{ t: "turn", active: true }, { t: "message", message: user("q") }, { t: "message", message: fauxAssistantMessage("cut", { stopReason: "aborted" }) }]);
  assert.ok(await HostJournal.retire(storage));
  const journal = (await HostJournal.open(storage))!;
  await journal.retract();
  await journal.push(fauxAssistantMessage("again"));
  const messages = (await journal.history.messagesFrom(0))!;
  assert.deepEqual(messages.map(message => message.role === "assistant" ? (message.content[0] as { text: string }).text : (message as { content: unknown }).content), ["q", "again"]);
  // The same, read again from the journal.
  assert.deepEqual((await (await HostJournal.open(storage))!.history.messagesFrom(0))!, messages);
  await storage.close(context);
});
