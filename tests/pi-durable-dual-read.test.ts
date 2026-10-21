import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStorage, type EntryId, type StorageWrite } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { dualReadHistory } from "../src/pi-durable/dual-read.ts";
import { HOST_BOOTSTRAP_KIND, LEGACY_CONVERSATION_ID as conversationId } from "../src/pi-durable/migration.ts";

/**
 * A journal: a host generation, then each entry given (`native` kinds hold one message; `record` a host record). A
 * record's `{ pi: n }` names the native message of the n-th entry given.
 */
async function journal(entries: ({ native: string; message: unknown } | { record: { pi?: number; record?: unknown } })[]) {
  const storage = new MemoryStorage();
  const writes: StorageWrite[] = [{ type: "conversation", value: { id: conversationId } } as StorageWrite];
  writes.push({ type: "entry", value: { id: await storage.mintId<EntryId>(), conversationId, kind: HOST_BOOTSTRAP_KIND } });
  const ids: number[] = [];
  for (let index = 0; index < entries.length; index++) ids.push(await storage.mintId<EntryId>());
  entries.forEach((entry, index) => {
    const id = ids[index] as EntryId;
    writes.push({ type: "entry", value: "native" in entry
      ? { id, conversationId, kind: entry.native, model: [entry.message] as never }
      : { id, conversationId, kind: "camel.host.record", data: (entry.record.pi === undefined ? entry.record : { pi: { entryId: ids[entry.record.pi], index: 0 } }) as never } });
  });
  await storage.commit(writes, BACKGROUND_CONTEXT);
  return { storage, ids };
}
const user = { role: "user", content: "hi", timestamp: 1 };
const reply = fauxAssistantMessage("hello");
const failed = { ...fauxAssistantMessage(""), stopReason: "error", errorMessage: "overloaded" };

test("dual read: a host history that records every native message, in order, matches", async () => {
  const both = await journal([{ native: "pi.user", message: user }, { native: "pi.assistant", message: reply },
    { record: { pi: 0 } }, { record: { pi: 1 } }]);
  assert.deepEqual((await dualReadHistory(both.storage, []))!.mismatches, []);
});

test("dual read: host-only messages, retractions and drift are told apart", async () => {
  const { storage } = await journal([
    { native: "pi.user", message: user },
    { record: { pi: 0 } },
    { native: "pi.assistant", message: failed },
    { record: { pi: 2 } },
    { record: { record: { t: "retract" } } },
    { record: { record: { t: "message", message: { role: "user", content: "an answer only the host wrote", timestamp: 2 } } } },
    { native: "pi.assistant", message: reply },
  ]);
  const categories = (await dualReadHistory(storage, []))!.mismatches.map(item => item.category);
  assert.deepEqual(categories.sort(), ["host_only_message", "index_drift", "retraction"],
    "the retracted failure is expected; the last reply was never recorded by the host (drift)");
});

test("dual read: calls waiting on a person are compared with the journal's placeholders", async () => {
  const call = fauxAssistantMessage([{ type: "toolCall", id: "ask", name: "approve", arguments: {} }], { stopReason: "toolUse" });
  const placeholder = { role: "toolResult", toolCallId: "ask", toolName: "approve", content: [], isError: false, details: { inputRequired: true }, timestamp: 2 };
  const { storage } = await journal([{ native: "pi.assistant", message: call }, { record: { pi: 0 } }, { native: "pi.tool-result", message: placeholder }]);
  assert.deepEqual((await dualReadHistory(storage, ["ask"]))!.mismatches, []);
  assert.deepEqual((await dualReadHistory(storage, []))!.mismatches.map(item => item.category), ["awaiting"]);
});
