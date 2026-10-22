import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage, type EntryId, type StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contextAt, contextSummary, forkCount, journalForkCut } from "../src/pi-durable/fork.ts";
import { JournalHistory } from "../src/pi-durable/history.ts";
import { HOST_BOOTSTRAP_KIND, SESSION_CONVERSATION_ID as conversationId } from "../src/pi-durable/seed.ts";
import { MARKER_KIND } from "../src/pi-durable/transcript.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../src/pi-harness/messages.ts";

const user = (text: string, requestId?: string) => ({ role: "user", content: text, timestamp: 1, ...(requestId ? { requestId } : {}) }) as AgentMessage;
const reply = (text: string) => fauxAssistantMessage(text) as AgentMessage;
const call = (id: string) => fauxAssistantMessage([fauxToolCall("lookup", {}, { id })], { stopReason: "toolUse" }) as AgentMessage;
const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "lookup", content: [{ type: "text", text: "found" }], isError: false, timestamp: 2 }) as AgentMessage;
const settled = { total: 0, active: false, turnStart: 0, awaiting: [] as string[] };

test("fork count: the last ended turn by default, a message with its results, a request's whole turn", () => {
  const messages = [user("one", "r1"), call("a"), result("a"), reply("done"), user("two", "r2"), call("b")];
  const running = { ...settled, total: 6, active: true, turnStart: 4 };
  assert.equal(forkCount(running, messages, [0, 4]), 4, "up to the running turn");
  assert.equal(forkCount(running, messages, [0, 4], 1), 3, "the call and the result answering it");
  assert.equal(forkCount(running, messages, [0, 4], "r1"), 4, "request r1's whole turn");
  assert.throws(() => forkCount(running, messages, [0, 4], 5), /not ended/);
  assert.throws(() => forkCount(running, messages, [0, 4], "r2"), /not ended/);
  assert.throws(() => forkCount(running, messages, [0, 4], 9), /history index/);
  assert.throws(() => forkCount(running, messages, [0, 4], "nope"), /No message/);
  const ended = { ...settled, total: 6, active: false, turnStart: 4 };
  assert.throws(() => forkCount(ended, [...messages.slice(0, 5), call("b")], [0, 4], 5), /not ended/, "a call left without its result");
  assert.equal(forkCount(ended, messages.slice(0, 4), [0], undefined), 6);
});

/** A journal: a host generation, then the drafts in order (`head: "self"` makes a head marker of the entry). */
async function journal(drafts: { kind: string; model?: unknown[]; data?: unknown; headOf?: number; self?: boolean; omit?: number }[]) {
  const storage = new MemoryStorage();
  const ids = [await storage.mintId<EntryId>()];
  for (let index = 0; index < drafts.length; index++) ids.push(await storage.mintId<EntryId>());
  const writes: StorageWrite[] = [{ type: "conversation", value: { id: conversationId } } as StorageWrite,
    { type: "entry", value: { id: ids[0] as EntryId, conversationId, kind: HOST_BOOTSTRAP_KIND } }];
  drafts.forEach((draft, index) => {
    const id = ids[index + 1] as EntryId;
    writes.push({ type: "entry", value: { id, conversationId, kind: draft.kind, ...(draft.model ? { model: draft.model as never } : {}), ...(draft.data ? { data: draft.data as never } : {}),
      ...(draft.self ? { head: id } : draft.headOf !== undefined ? { head: ids[draft.headOf + 1] as EntryId } : {}),
      ...(draft.omit !== undefined ? { edits: [{ target: ids[draft.omit + 1] as EntryId, action: "omit" as const }] } : {}) } });
  });
  await storage.commit(writes, BACKGROUND_CONTEXT);
  return { storage, at: (n: number) => ({ entryId: ids[n + 1], index: 0 }) };
}
const system = { role: "system", content: "Be brief.", timestamp: 0 };
const summary = (text: string) => ({ role: "user", content: `${COMPACTION_SUMMARY_PREFIX}${text}${COMPACTION_SUMMARY_SUFFIX}`, timestamp: 5 });
const roles = (messages: { role: string }[]) => messages.map(message => message.role);

test("context at a cut: the checkpoint it follows, the entries through the cut, edits applied", async () => {
  const { storage, at } = await journal([
    { kind: "camel.legacy.context", model: [system], self: true },
    { kind: "camel.context.message", model: [user("one")] },
    { kind: "pi.assistant", model: [call("a")] },
    { kind: "pi.tool-result", model: [{ ...result("a"), details: { inputRequired: true } }] },
    { kind: "camel.message", model: [result("a")], omit: 3 },
    { kind: "pi.assistant", model: [reply("done")] },
    { kind: "pi.user", model: [user("later")] },
  ]);
  assert.deepEqual(roles(await contextAt(storage, at(5))), ["system", "user", "assistant", "toolResult", "assistant"], "the placeholder is omitted; nothing after the cut");
});

test("context at a cut after a compaction: its summary leads, then what it kept", async () => {
  const { storage, at } = await journal([
    { kind: "camel.legacy.context", model: [system], self: true },
    { kind: "camel.context.message", model: [user("old")] },
    { kind: "pi.assistant", model: [reply("old answer")] },
    { kind: "pi.user", model: [user("kept")] },
    { kind: "pi.compaction", model: [summary("We talked about old things.")], headOf: 3 },
    { kind: "pi.assistant", model: [reply("after")] },
  ]);
  const model = await contextAt(storage, at(5));
  assert.deepEqual(roles(model), ["user", "user", "assistant"]);
  assert.deepEqual(contextSummary(model), { summary: "We talked about old things.", kept: 2, at: 5 });
});

test("a journal fork cut keeps the history to the cut and starts its host transcript from Pi's context", async () => {
  const { storage } = await journal([
    { kind: MARKER_KIND, data: { t: "base", total: 0, active: false, turnStart: 0, awaiting: [] } },
    { kind: "camel.legacy.context", model: [system], self: true },
    { kind: "pi.user", model: [user("one", "r1")] },
    { kind: "pi.assistant", model: [reply("first")] },
    { kind: "pi.user", model: [user("two", "r2")] },
    { kind: "pi.compaction", model: [summary("One was asked and answered.")], headOf: 4 },
    { kind: "pi.assistant", model: [reply("second")] },
  ]);
  const history = (await JournalHistory.open(storage))!;
  const messages = (await history.messagesFrom(0))!;
  const cut = (await journalForkCut(storage, history, messages, "r2"))!;
  assert.equal(cut.through, 3);
  assert.deepEqual(cut.records, [{ t: "reset", messages, compaction: { summary: "One was asked and answered.", cut: 2, tokensBefore: 0, at: 5 } }]);
  assert.deepEqual(roles(cut.model), ["user", "user", "assistant"]);
  assert.equal(await journalForkCut(storage, history, messages.slice(1), "r2"), undefined, "a history that is not the journal's whole is not cut here");
});

test("forks before the newest head are refused even before reclaim; a compaction's retained head is valid", async () => {
  const { storage, at } = await journal([
    { kind: "camel.legacy.context", model: [system], self: true },
    { kind: "pi.user", model: [user("old")] },
    { kind: "pi.assistant", model: [reply("old answer")] },
    { kind: "pi.user", model: [user("kept")] },
    { kind: "pi.compaction", model: [summary("old summary")], headOf: 3 },
    { kind: "pi.assistant", model: [reply("after")] },
  ]);
  await assert.rejects(contextAt(storage, at(2)), { code: "FORK_POINT_INVALID", status: 400 });
  const atHead = await contextAt(storage, at(3));
  assert.deepEqual(roles(atHead), ["user", "user"]);
  assert.equal((atHead[1] as { content: string }).content, "kept");
  assert.deepEqual(contextSummary(atHead), { summary: "old summary", kept: 1, at: 5 });
  assert.deepEqual(roles(await contextAt(storage, at(5))), ["user", "user", "assistant"]);
});

test("forks before a newer checkpoint are refused, while its head and later entries work", async () => {
  const { storage, at } = await journal([
    { kind: "camel.legacy.context", model: [system], self: true },
    { kind: "pi.user", model: [user("old")] },
    { kind: "camel.legacy.context", model: [system], self: true },
    { kind: "camel.context.message", model: [user("kept")] },
  ]);
  await assert.rejects(contextAt(storage, at(1)), error =>
    (error as { code?: string }).code === "FORK_POINT_INVALID" && /fork at a later message/.test((error as Error).message));
  assert.deepEqual(roles(await contextAt(storage, at(2))), ["system"]);
  assert.deepEqual(roles(await contextAt(storage, at(3))), ["system", "user"]);
});
