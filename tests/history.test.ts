import { test } from "node:test";
import assert from "node:assert/strict";
import { interruptedTurnRepairs, step, validateInitialMessages, validateUserMessages } from "../src/history.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { HostJournal } from "../src/pi-durable/host-journal.ts";
import { seedJournal } from "../src/pi-durable/seed.ts";
import { durableEntryMessages } from "../src/pi-durable/agent.ts";

test("interrupted-turn recovery preserves settled native results and marks only missing tool ids unknown", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "write", arguments: {} }] },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "verified" }], timestamp: 2 },
  ] as AgentMessage[];
  const recovered = [...messages, ...interruptedTurnRepairs(messages)];
  assert.equal(recovered.filter((m: AgentMessage) => m.role === "toolResult").length, 2);
  assert.equal(recovered[1], messages[1]);
  assert.equal(recovered[2].role, "toolResult");
  assert.match(JSON.stringify(recovered[2]), /outcome is unknown/);
  assert.equal(recovered.at(-1)!.role, "user");
  assert.throws(() => validateInitialMessages([{ role: "system" }] as any), /INVALID_HISTORY: initialMessages\[0\] has role "system"/);
});

test("scoped callers can submit user text and images but never assistant or tool history", () => {
  validateUserMessages([{ role: "user", content: "hi", timestamp: 1 }, { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 2 }] as AgentMessage[]);
  assert.throws(() => validateUserMessages([{ role: "assistant", content: [], timestamp: 1 }] as any), /Only user messages/);
  assert.throws(() => validateUserMessages([{ role: "toolResult", toolCallId: "x", toolName: "y", content: [], timestamp: 1 }] as any), /Only user messages/);
  assert.throws(() => validateUserMessages([{ role: "user", content: [{ type: "toolCall", id: "x", name: "y", arguments: {} }], timestamp: 1 }] as any), /text and images/);
});

/** A new session's journal, as a host seeds it, and its HostJournal. */
async function journal() {
  const storage = new MemoryStorage();
  await seedJournal({ storage, sessionId: "test", model: [{ role: "system", content: "base", timestamp: 0 }] });
  return { storage, journal: (await HostJournal.open(storage))! };
}

test("system messages keep their place in Pi's context across retractions and reloads, and never enter history", async t => {
  const { storage, journal: host } = await journal();
  t.after(() => storage.close(context));
  const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;
  const change = { role: "system", content: "", timestamp: 2, sections: { instructions: "new" } } as SystemMessage;
  await host.append([user("u0"), user("u1")]);
  await host.system(change);
  await host.push(user("u2"));
  await host.push(user("failed"));
  await host.retract();
  assert.deepEqual(await host.history.messagesFrom(0), [user("u0"), user("u1"), user("u2")]);
  const reloaded = (await HostJournal.open(storage))!;
  assert.deepEqual(await reloaded.history.messagesFrom(0), [user("u0"), user("u1"), user("u2")]);
  // In Pi's context, where it was declared.
  const harness = await Harness.open(storage, { registry: createRegistry(), models: { getModel: () => undefined, getAuth: () => undefined } as never }, context);
  try {
    const view = await (await harness.root(context)).context(context);
    assert.deepEqual(view.messages.map(message => message.role === "system" ? `system:${JSON.stringify((message as SystemMessage).sections ?? message.content)}` : (message as { content: string }).content),
      ["system:\"base\"", "u0", "u1", "system:{\"instructions\":\"new\"}", "u2"]);
  } finally { await harness.close(context); }
});

test("calls awaiting human input stay open across a reload, and leave the wait once answered or released", async t => {
  const { storage, journal: host } = await journal();
  t.after(() => storage.close(context));
  await host.append([
    { role: "user", content: "go", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "ask", name: "ask_user", arguments: {} }, { type: "toolCall", id: "other", name: "read", arguments: {} }, { type: "toolCall", id: "approve", name: "delete", arguments: {} }] } as AgentMessage,
  ]);
  await host.await(["ask"]);
  await host.await(["approve"]);
  const reloaded = (await HostJournal.open(storage))!;
  assert.deepEqual(reloaded.awaiting, ["ask", "approve"]);
  assert.deepEqual(interruptedTurnRepairs(await reloaded.since(step), false, reloaded.awaiting).map(message => (message as { toolCallId: string }).toolCallId), ["other"], "only the call nobody waits on is closed as unknown");
  await reloaded.await(["approve"], true);
  await reloaded.push({ role: "toolResult", toolCallId: "ask", toolName: "ask_user", content: [{ type: "text", text: "{}" }], isError: false, timestamp: 2 } as AgentMessage);
  assert.deepEqual(reloaded.awaiting, []);
});

test("host user entries read both whole and deduplicated messages (content only in the model message)", async t => {
  const { storage, journal: host } = await journal();
  t.after(() => storage.close(context));
  const message = { role: "user", content: [{ type: "text", text: "question" }], timestamp: 7, from: { id: "sender" }, metadata: { tag: "kept" }, requestId: "request" } as Extract<AgentMessage, { role: "user" }>;
  await host.push(message);
  const page = await storage.scanEntries({ conversationId: 1 as never, order: "ascending" }, 100, undefined, context);
  const entry = page.items.find(entry => entry.kind === "camel.user")!;
  assert.deepEqual(entry.model![0].content, message.content);
  assert.deepEqual(await (await HostJournal.open(storage))!.history.messagesFrom(0), [message]);
  const { content: _content, ...metadata } = message;
  assert.deepEqual(durableEntryMessages({ ...entry, data: { message: metadata } as never })[0].message, message, "deduplicated entries (written by AGENT_PI_DEDUPE_USER_ENTRIES) still read their content");
});

test("default host writes remain readable by the previous release", async t => {
  const { storage, journal: host } = await journal();
  t.after(() => storage.close(context));
  const message = { role: "user", content: "rollback safe", timestamp: 1 } as AgentMessage;
  await host.push(message);
  const entry = (await storage.scanEntries({ conversationId: 1 as never, order: "ascending" }, 100, undefined, context)).items.find(entry => entry.kind === "camel.user")!;
  // The previous reader takes data.message whole, without falling back to model content.
  assert.deepEqual((entry.data as any).message, message);
});
