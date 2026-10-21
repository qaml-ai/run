import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage, type EntryId, type StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { JournalHistory, type HistoryBase } from "../src/pi-durable/history.ts";
import { HOST_BOOTSTRAP_KIND, LEGACY_CONVERSATION_ID as conversationId } from "../src/pi-durable/migration.ts";
import { MARKER_KIND } from "../src/pi-durable/transcript.ts";

type Draft = { native: string; message: unknown } | { marker: Record<string, unknown> };

/** A journal: a host generation, then each draft as an entry, in order. A marker's `{ cursorOf: n }` names draft n's message. */
async function journal(drafts: Draft[]) {
  const storage = new MemoryStorage();
  const ids = [await storage.mintId<EntryId>()];
  for (let index = 0; index < drafts.length; index++) ids.push(await storage.mintId<EntryId>());
  const at = (n: number) => ({ entryId: ids[n + 1], index: 0 });
  const writes: StorageWrite[] = [{ type: "conversation", value: { id: conversationId } } as StorageWrite,
    { type: "entry", value: { id: ids[0] as EntryId, conversationId, kind: HOST_BOOTSTRAP_KIND } }];
  drafts.forEach((draft, index) => {
    const id = ids[index + 1] as EntryId;
    if ("native" in draft) writes.push({ type: "entry", value: { id, conversationId, kind: draft.native, model: [draft.message] as never } });
    else {
      const data = Object.fromEntries(Object.entries(draft.marker).map(([key, value]) =>
        [key, value && typeof value === "object" && "cursorOf" in value ? at((value as { cursorOf: number }).cursorOf) : value]));
      writes.push({ type: "entry", value: { id, conversationId, kind: MARKER_KIND, data: data as never } });
    }
  });
  await storage.commit(writes, BACKGROUND_CONTEXT);
  return storage;
}
const base = (total: number, through?: { cursorOf: number }, more: Partial<HistoryBase> = {}) =>
  ({ marker: { t: "base", total, ...(through ? { through } : {}), active: false, turnStart: 0, awaiting: [], ...more } });
const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const reply = (text: string) => fauxAssistantMessage(text);

test("journal history: a session without a base has none", async () => {
  assert.equal(await JournalHistory.open(await journal([{ native: "pi.user", message: user("hi") }])), undefined);
});

test("journal history: counts from the base on, and only messages past its cursor", async () => {
  const storage = await journal([
    { native: "pi.user", message: user("before") },
    base(10, { cursorOf: 0 }),
    { native: "pi.user", message: user("one") },
    { native: "pi.assistant", message: reply("two") },
  ]);
  const history = (await JournalHistory.open(storage))!;
  assert.equal(history.total, 12);
  assert.deepEqual((await history.messagesFrom(10))!.map(message => (message as { role: string }).role), ["user", "assistant"]);
  assert.equal(await history.messagesFrom(9), undefined, "before the base: the index's");
});

test("journal history: retractions, turns, waiting calls and skipped messages, as the host's records give them", async () => {
  const call = fauxAssistantMessage([fauxToolCall("approve", {}, { id: "ask" })], { stopReason: "toolUse" });
  const storage = await journal([
    base(4),
    { marker: { t: "turn", active: true } },
    { native: "pi.user", message: user("go") },
    { native: "pi.assistant", message: { ...fauxAssistantMessage(""), stopReason: "error" } },
    { marker: { t: "retract", index: 5 } },
    { native: "pi.assistant", message: call },
    { marker: { t: "awaiting", calls: ["ask"] } },
    { native: "pi.tool-result", message: { role: "toolResult", toolCallId: "lost", toolName: "x", content: [], isError: true, timestamp: 2 } },
    { marker: { t: "pi", cursor: { cursorOf: 7 }, after: { cursorOf: 5 } } },
    { marker: { t: "turn", active: false } },
  ]);
  const history = (await JournalHistory.open(storage))!;
  assert.equal(history.total, 6, "user and call; the failure taken back, the skipped result left out");
  assert.equal(history.active, false);
  assert.equal(history.turnStart, 4);
  assert.deepEqual(history.awaiting, ["ask"]);
  assert.equal(history.callIndex("ask"), 5);
});

test("journal history: refresh takes in what was committed since, and an answer ends the wait", async () => {
  const storage = await journal([base(0, undefined, { awaiting: ["ask"], calls: [["ask", 0]] })]);
  const history = (await JournalHistory.open(storage))!;
  assert.deepEqual(history.awaiting, ["ask"]);
  await storage.commit([{ type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "camel.message",
    model: [{ role: "toolResult", toolCallId: "ask", toolName: "approve", content: [], isError: false, timestamp: 3 }] as never } }], BACKGROUND_CONTEXT);
  await history.refresh();
  assert.deepEqual(history.awaiting, []);
  assert.equal(history.total, 1);
  assert.equal(history.callIndex("ask"), 0, "the base's calls are known");
});

test("journal history: an entry committed after one with a later ID is still taken in, in ID order", async () => {
  const storage = await journal([base(0)]);
  const history = (await JournalHistory.open(storage))!;
  // The host takes an ID for its retraction's marker, then Pi commits a later-numbered entry first.
  const failed = await storage.mintId<EntryId>(), retraction = await storage.mintId<EntryId>(), next = await storage.mintId<EntryId>();
  await storage.commit([{ type: "entry", value: { id: failed, conversationId, kind: "pi.assistant", model: [{ ...fauxAssistantMessage(""), stopReason: "error" }] as never } }], BACKGROUND_CONTEXT);
  await storage.commit([{ type: "entry", value: { id: next, conversationId, kind: "pi.assistant", model: [reply("next")] as never } }], BACKGROUND_CONTEXT);
  await history.refresh();
  assert.equal(history.total, 2, "the failure and the next response, so far");
  await storage.commit([{ type: "entry", value: { id: retraction, conversationId, kind: MARKER_KIND, data: { t: "retract", index: 0 } as never } }], BACKGROUND_CONTEXT);
  await history.refresh();
  assert.equal(history.total, 1, "the retraction took back the failure, which precedes it");
  assert.equal((await history.messagesFrom(0))!.length, 1);
  assert.equal(((await history.messagesFrom(0))![0] as { stopReason: string }).stopReason, "stop");
});

test("journal history: a compaction is not history, and the response its overflow refused is taken back by its marker", async () => {
  const overflow = { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "prompt is too long" };
  const storage = await journal([
    base(3),
    { native: "pi.user", message: user("a long one") },
    { native: "pi.assistant", message: overflow },
    { native: "camel.compaction.usage", message: reply("summary usage") },
    { native: "pi.compaction", message: { role: "user", content: "The conversation so far, summarized.", timestamp: 2 } },
    { marker: { t: "retract", index: 4 } },
    { native: "pi.assistant", message: reply("answered after the summary") },
  ]);
  const history = (await JournalHistory.open(storage))!;
  assert.equal(history.total, 5, "the user message and the answer: no summary, no refused response");
  assert.deepEqual((await history.messagesFrom(3))!.map(message => (message as { role: string }).role), ["user", "assistant"]);
});

test("journal history: refreshes that overlap (parallel tool calls asking for their call's index) count each entry once", async () => {
  const storage = await journal([base(0)]);
  const history = (await JournalHistory.open(storage))!;
  const call = fauxAssistantMessage([fauxToolCall("publish", {}, { id: "a" }), fauxToolCall("publish", {}, { id: "b" })], { stopReason: "toolUse" });
  await storage.commit([
    { type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "pi.user", model: [user("publish both")] as never } },
    { type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: "pi.assistant", model: [call] as never } },
  ], BACKGROUND_CONTEXT);
  await Promise.all([history.refresh(), history.refresh()]);
  assert.equal(history.total, 2);
  assert.equal(history.callIndex("a"), 1);
  assert.equal(history.callIndex("b"), 1);
});
