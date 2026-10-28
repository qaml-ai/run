import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage, type EntryId, type StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contextAt, forkCount, journalForkCut } from "../src/pi-durable/fork.ts";
import { JournalHistory, MARKER_KIND } from "../src/pi-durable/history.ts";
import { HOST_BOOTSTRAP_KIND, seedJournal, SESSION_CONVERSATION_ID as conversationId } from "../src/pi-durable/seed.ts";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../src/pi-harness/messages.ts";
import { DurableAgent } from "../src/pi-durable/agent.ts";

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
  await storage.commit(writes, () => {}, BACKGROUND_CONTEXT);
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
  assert.match(JSON.stringify(model[0]), /We talked about old things/);
});

test("a journal fork cut keeps the history to the cut, and its model starts from Pi's context there", async () => {
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
  const cut = await journalForkCut(storage, history, messages, "r2");
  assert.equal(cut.through, 3);
  assert.deepEqual(cut.messages, messages);
  assert.deepEqual(cut.turns, [], "where its turns began, as the journal marks them (this one marks none)");
  assert.deepEqual(roles(cut.model), ["user", "user", "assistant"]);
  assert.equal(cut.fromHistory, undefined, "the retained-context fast path");
  await assert.rejects(journalForkCut(storage, history, messages.slice(1), "r2"), /has 3 messages, its journal 4/, "a history that is not the journal's whole is not cut");
  const early = await journalForkCut(storage, history, messages, 1);
  assert.equal(early.through, 1);
  assert.equal(early.fromHistory, true);
  assert.deepEqual(early.messages, messages.slice(0, 2));
  assert.deepEqual(early.model, messages.slice(0, 2), "raw messages, without the later summary or system checkpoint");
});

test("context lookup signals a cut before the newest head; a compaction's retained head is valid", async () => {
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
  assert.match(JSON.stringify(atHead[0]), /old summary/);
  assert.deepEqual(roles(await contextAt(storage, at(5))), ["user", "user", "assistant"]);
});

test("context lookup signals a cut before a newer checkpoint, while its head and later entries work", async () => {
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

test("a fork before the journal base uses indexed history with the same request and tool-result cuts", async () => {
  const indexed = [user("old", "r1"), call("a"), result("a"), reply("done")];
  const { storage } = await journal([
    { kind: MARKER_KIND, data: { t: "base", total: indexed.length, active: false, turnStart: indexed.length, awaiting: [] } },
    { kind: "camel.legacy.context", model: [summary("Imported summary")], self: true },
    { kind: MARKER_KIND, data: { t: "turn", active: true } },
    { kind: "pi.user", model: [user("running", "r2")] },
  ]);
  const history = (await JournalHistory.open(storage))!;
  const messages = [...indexed, ...(await history.messagesFrom(indexed.length))!];
  for (const [at, count] of [[1, 3], ["r1", 4]] as const) {
    const cut = await journalForkCut(storage, history, messages, at);
    assert.equal(cut.through, count - 1);
    assert.equal(cut.fromHistory, true);
    assert.deepEqual(cut.messages, indexed.slice(0, count));
    assert.deepEqual(cut.model, cut.messages);
  }
  for (const at of [4, "r2"]) await assert.rejects(journalForkCut(storage, history, messages, at), { status: 409, code: "FORK_POINT_RUNNING" });
  for (const at of [5, "unknown"]) await assert.rejects(journalForkCut(storage, history, messages, at), { status: 400, code: "FORK_POINT_INVALID" });
});

for (const measured of [false, true]) test(`an over-window raw fork seed compacts in chunks${measured ? " after a provider overflow with old usage counts" : " before its first model generation"}`, async t => {
  const storage = new MemoryStorage();
  const raw = Array.from({ length: 24 }, (_, index) => [user(`old-${index} ${"word ".repeat(1000)}`),
    { ...fauxAssistantMessage(`answer-${index}`), ...(measured ? { usage: { ...fauxAssistantMessage("").usage, input: 1, totalTokens: 1 } } : {}) } as AgentMessage]).flat();
  await seedJournal({ storage, sessionId: "raw-fork", model: raw as never, before: { total: raw.length }, requests: [] });
  assert.deepEqual(await contextAt(storage, { entryId: Number.MAX_SAFE_INTEGER, index: -1 }), raw, "the seed keeps every raw message");
  const model = { id: "fixture", provider: "fixture", api: "openai-completions", name: "Fixture", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1000 } as any;
  const stream = (text: string, error = false) => {
    const message = { ...fauxAssistantMessage(text), provider: model.provider, model: model.id,
      ...(error ? { stopReason: "error" as const, errorMessage: "maximum context length exceeded" } : {}) };
    const events = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (error) events.push({ type: "error", reason: "error", error: message });
      else events.push({ type: "done", reason: "stop", message });
      events.end(message);
    });
    return events;
  };
  let summaries = 0, generations = 0;
  const agent = await DurableAgent.create({
    initialState: { model, messages: [], tools: [] },
    streamFn: (_model, view) => {
      generations++;
      // Old usage counts can understate a raw history's size. The normal overflow path must compact and retry.
      if (measured && generations === 1) {
        assert.ok(JSON.stringify(view.messages).length > model.contextWindow * 4);
        return stream("", true);
      }
      assert.ok(summaries > 1, "chunked compaction ran before generation");
      assert.ok(JSON.stringify(view.messages).length < model.contextWindow * 4, "generation fits the model window");
      return stream("done");
    },
    durable: { storage, conversationId,
      summaryStream: (_model, view) => {
        summaries++;
        assert.ok(JSON.stringify(view.messages).length < model.contextWindow * 4, "each summary chunk fits the model window");
        return stream("Summary of the old conversation.");
      },
    },
  });
  t.after(() => agent.close());
  await agent.prompt("Continue the fork");
  assert.equal(agent.state.errorMessage, undefined);
  assert.equal(generations, measured ? 2 : 1);
});
