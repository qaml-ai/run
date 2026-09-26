import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedContext, interruptedTurnRepairs, recoverInterruptedTurn, validateInitialMessages, validateUserMessages } from "../src/history.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAppendLog } from "../shared/append-log.ts";
import { readTranscriptLog, Transcript, type TranscriptRecord } from "../src/transcript.ts";

test("context bounds discard whole older turns without mutating durable history", () => {
  const messages = [
    { role: "user", content: "x".repeat(5000), timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "old result" }], timestamp: 2 },
    { role: "user", content: "Latest instruction", timestamp: 3 },
  ] as AgentMessage[];
  assert.deepEqual(boundedContext(messages, 1024), messages.slice(3));
  assert.equal(messages.length, 4);
  assert.throws(() => boundedContext(messages.slice(0, 3), 1024), /current turn exceeds/);
});

test("interrupted-turn recovery preserves settled native results and marks only missing tool ids unknown", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "write", arguments: {} }] },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "verified" }], timestamp: 2 },
  ] as AgentMessage[];
  const recovered = recoverInterruptedTurn(messages);
  assert.equal(recovered.filter((m: AgentMessage) => m.role === "toolResult").length, 2);
  assert.equal(recovered[1], messages[1]);
  assert.equal(recovered[2].role, "toolResult");
  assert.match(JSON.stringify(recovered[2]), /outcome is unknown/);
  assert.equal(recovered.at(-1)!.role, "user");
  assert.throws(() => validateInitialMessages([{ role: "system" }] as any), /native/);
});

test("scoped callers can submit user text and images but never assistant or tool history", () => {
  validateUserMessages([{ role: "user", content: "hi", timestamp: 1 }, { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 2 }] as AgentMessage[]);
  assert.throws(() => validateUserMessages([{ role: "assistant", content: [], timestamp: 1 }] as any), /Only user messages/);
  assert.throws(() => validateUserMessages([{ role: "toolResult", toolCallId: "x", toolName: "y", content: [], timestamp: 1 }] as any), /Only user messages/);
  assert.throws(() => validateUserMessages([{ role: "user", content: [{ type: "toolCall", id: "x", name: "y", arguments: {} }], timestamp: 1 }] as any), /text and images/);
});

test("system messages keep their place in the transcript across reloads, retractions and compaction, and never enter history", async t => {
  const root = await mkdtemp(join(tmpdir(), "transcript-system-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = () => fileAppendLog<TranscriptRecord>(join(root, "transcript.jsonl"));
  const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;
  const system = (fields: Partial<SystemMessage>) => ({ role: "system", content: "", timestamp: 2, ...fields }) as SystemMessage;
  const loaded = async () => { const transcript = new Transcript(log()); await transcript.load(); return transcript; };
  const leading = system({ content: "base", sections: { instructions: "old" } });
  const change = system({ sections: { instructions: "new" } });

  const transcript = await loaded();
  await transcript.append([user("u0"), user("u1")]);
  await transcript.declareSystem(leading, true);
  await transcript.declareSystem(change);
  await transcript.push(user("u2"));
  await transcript.push(user("failed"));
  await transcript.retract();
  assert.deepEqual(transcript.view(), [user("u0"), user("u1"), change, user("u2")]);
  const reloaded = await loaded();
  assert.deepEqual(reloaded.view(), transcript.view());
  assert.deepEqual(reloaded.system, leading);
  assert.deepEqual(await readTranscriptLog(log()), [user("u0"), user("u1"), user("u2")]);

  // A change at the end stays at the end when the message before it is retracted.
  await transcript.push(user("u3"));
  const late = system({ sections: { instructions: "newer" } });
  await transcript.declareSystem(late);
  await transcript.retract();
  assert.deepEqual(transcript.view().at(-1), late);

  // Compaction folds changes before its cut into the leading message and keeps later ones.
  const folded = system({ content: "base", sections: { instructions: "new" } });
  await transcript.compact({ summary: "S", cut: 2, tokensBefore: 10, at: 3 }, folded);
  assert.deepEqual(transcript.view().slice(1), [user("u2"), late]);
  assert.deepEqual(transcript.system, folded);
  const after = await loaded();
  assert.deepEqual(after.view(), transcript.view());
  assert.deepEqual(after.system, folded);
});

test("calls awaiting human input stay open across a reload, and leave the wait once answered or released", async () => {
  const directory = await mkdtemp(join(tmpdir(), "awaiting-"));
  try {
    const path = join(directory, "transcript.jsonl");
    const transcript = new Transcript(fileAppendLog<TranscriptRecord>(path));
    await transcript.append([
      { role: "user", content: "go", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "ask", name: "ask_user", arguments: {} }, { type: "toolCall", id: "other", name: "read", arguments: {} }, { type: "toolCall", id: "approve", name: "delete", arguments: {} }] } as AgentMessage,
    ]);
    await transcript.await(["ask"]);
    await transcript.await(["approve"]);
    const reloaded = new Transcript(fileAppendLog<TranscriptRecord>(path));
    await reloaded.load();
    assert.deepEqual(reloaded.awaiting, ["ask", "approve"]);
    assert.deepEqual(interruptedTurnRepairs(reloaded.context, false, reloaded.awaiting).map(message => (message as { toolCallId: string }).toolCallId), ["other"], "only the call nobody waits on is closed as unknown");
    await reloaded.await(["approve"], true);
    await reloaded.push({ role: "toolResult", toolCallId: "ask", toolName: "ask_user", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 2 } as AgentMessage);
    assert.deepEqual(reloaded.awaiting, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
