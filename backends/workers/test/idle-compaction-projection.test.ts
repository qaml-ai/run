import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import type { AgentRuntime } from "../src/agent-runtime.ts";
import { onViewImpl, projectMessageImpl } from "../src/agent-turn-loop.ts";
import { IdleCompactionDoc } from "../src/idle-compaction-schedule.ts";

test("idle checkpoints reserve their history ordinal without emitting a requester turn", async () => {
  const events: unknown[] = [];
  const projected: { index: number; message: unknown }[] = [];
  let invalidated = 0;
  const host = {
    active: "follow-up",
    lastEntry: 40,
    nextMessage: 6,
    harness: {
      pi: async () => ({
        snapshot: async (doc: unknown, conversation: number) => {
          assert.equal(doc, IdleCompactionDoc);
          assert.equal(conversation, 1);
          return { taskId: 17 };
        },
      }),
      storage: async () => ({
        submissionByRequest: async (conversation: number, requestId: string) => {
          assert.equal(conversation, 1);
          assert.equal(requestId, "compaction:17");
          return { entry: 41 };
        },
      }),
    },
    ctx: { storage: { get: async () => undefined, list: async () => new Map() } },
    requestForInputs: async () => undefined,
    historyIndex: { changed: () => { invalidated++; } },
    projectMessage: projectMessageImpl,
    messageProjection: { events: (message: unknown) => {
      projected.push({ index: host.nextMessage, message });
      return [];
    } },
    emit: async (event: unknown) => { events.push(event); },
  };
  const idle = { role: "user", content: "Idle checkpoint", timestamp: 1 };
  const foreground = { role: "user", content: "Existing foreground compaction", timestamp: 2 };
  const view = {
    conversation: { id: 1 },
    docs: {},
    entries: [
      { id: 41, kind: "pi.compaction", model: [idle] },
      { id: 42, kind: "pi.compaction", model: [foreground] },
    ],
  } as unknown as ConversationView;

  await onViewImpl.call(host as unknown as AgentRuntime, view);
  assert.deepEqual(events, [{ type: "event", requestId: "follow-up", event: { type: "turn_opened", index: 7 } }]);
  assert.deepEqual(projected, [{ index: 7, message: { ...foreground, requestId: "follow-up" } }]);
  assert.equal(host.nextMessage, 8);
  assert.equal(host.lastEntry, 42);
  assert.equal(invalidated, 2);
});
