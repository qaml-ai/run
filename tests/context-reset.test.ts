import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SystemMessage } from "@earendil-works/pi-ai";
import type { EntryId, EntryRecord, Storage } from "@earendil-works/pi-durable";
import { JournalHistory } from "../src/pi-durable/history.ts";
import { currentSystemMessage, keptTail, resetContext } from "../src/pi-durable/reset.ts";
import { seedJournal, SESSION_CONVERSATION_ID as root } from "../src/pi-durable/seed.ts";
import { contextRangeSize, openPiStorage } from "../src/pi-durable/storage.ts";
import { COMPACTION_SUMMARY_PREFIX } from "../src/pi-harness/messages.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { testDatabase } from "./database.ts";
import { OTHER_OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

const system = (fields: Partial<SystemMessage>): SystemMessage => ({ role: "system", content: "", timestamp: 1, ...fields });
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 2 });
const assistant = (calls: string[], text = ""): AgentMessage => ({ role: "assistant", content: [...text ? [{ type: "text" as const, text }] : [], ...calls.map(id => ({ type: "toolCall" as const, id, name: "js_exec", arguments: {} }))],
  api: "openai-completions", provider: "openrouter", model: "m", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: calls.length ? "toolUse" : "stop", timestamp: 3 } as AgentMessage);
const result = (id: string, text: string): AgentMessage => ({ role: "toolResult", toolCallId: id, toolName: "js_exec", content: [{ type: "text", text }], isError: false, timestamp: 4 } as AgentMessage);

/** Every entry of the root from `from` on, read after the reset (the stubs restored). */
async function entriesFrom(storage: Storage, from: number) {
  const items: EntryRecord[] = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId: root, order: "ascending", minEntryId: from as EntryId }, 64, cursor, context);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

test("keptTail never starts on a tool result", () => {
  const messages = [user("a"), assistant(["c1"]), result("c1", "r1"), assistant(["c2", "c3"]), result("c2", "r2"), result("c3", "r3"), assistant([], "done")];
  assert.deepEqual(keptTail(messages, 0), []);
  assert.deepEqual(keptTail(messages, 1).map(message => message.role), ["assistant"]);
  assert.deepEqual(keptTail(messages, 3).map(message => message.role), ["assistant"], "its calls' results are dropped with it");
  assert.deepEqual(keptTail(messages, 4).map(message => message.role), ["assistant", "toolResult", "toolResult", "assistant"]);
  assert.deepEqual(keptTail(messages, 6).map(message => message.role), ["assistant", "toolResult", "assistant", "toolResult", "toolResult", "assistant"]);
});

for (const backend of ["sqlite", "postgres"] as const) test(`${backend} resets an oversized context from SQL alone, keeping its system message and history`, async t => {
  const directory = await mkdtemp(join(tmpdir(), "context-reset-"));
  const db = backend === "postgres" ? (await testDatabase()).db : undefined;
  const storage = await openPiStorage({ sessionId: "reset-test", directory, db });
  t.after(async () => { await storage.close(context); await rm(directory, { recursive: true, force: true }); });
  const tools = [{ name: "js_exec", description: "run", parameters: { type: "object", properties: {} } }, { name: "old", description: "gone", parameters: { type: "object", properties: {} } }];
  const leading = system({ content: "BASE INSTRUCTIONS", sections: { instructions: "be brief", environment: "env v1" }, toolsAdded: tools as never });
  const big = "x".repeat(40_000);
  const messages = [user("first"), assistant(["c1"]), result("c1", big), assistant(["c2"]), result("c2", big), assistant([], "done")];
  await seedJournal({ storage, sessionId: "reset-test", model: [leading], messages });
  // A configuration change since: Pi's context holds it after the checkpoint, and the reset keeps it.
  const ids = [await storage.mintId(), await storage.mintId(), await storage.mintId(), await storage.mintId(), await storage.mintId(), await storage.mintId()] as EntryId[];
  await storage.commit([
    { type: "entry", value: { id: ids[0], conversationId: root, kind: "camel.system", model: [system({ sections: { environment: "env v2" }, toolsRemoved: [{ name: "old" }] })] as never } },
    // An entry an edit omits counts for nothing, and a tool result's text naming a system message is not one.
    { type: "entry", value: { id: ids[1], conversationId: root, kind: "camel.system", model: [system({ sections: { omitted: "never" } })] as never } },
    { type: "entry", value: { id: ids[2], conversationId: root, kind: "pi.system", model: [system({ sections: { output: "json" } })] as never, edits: [{ target: ids[1], action: "omit" }] } as never },
    { type: "entry", value: { id: ids[3], conversationId: root, kind: "camel.context.message", model: [{ ...result("c0", "echo"), details: { role: "system", sections: { echoed: "no" } } }] as never } },
    // An omit from an entry that names no system message counts too.
    { type: "entry", value: { id: ids[4], conversationId: root, kind: "camel.system", model: [system({ sections: { dropped: "later" } })] as never } },
    { type: "entry", value: { id: ids[5], conversationId: root, kind: "camel.context.message", model: [user("plain")] as never, edits: [{ target: ids[4], action: "omit" }] } as never },
  ], () => {}, context);
  const before = await contextRangeSize(storage, root);
  assert.ok(before.bytes > 80_000);
  const history = await JournalHistory.openAny(storage);
  const all = await history!.messagesFrom(0);

  // keepMessages 0 reads nothing but SQL: no entry, scan or marker read.
  const { scanEntries, entry, findLatestHeadMarker } = storage;
  storage.scanEntries = async () => { throw new Error("range records must not be loaded"); };
  storage.entry = async () => { throw new Error("entries must not be read"); };
  storage.findLatestHeadMarker = async () => { throw new Error("markers must not be read"); };
  const folded = await currentSystemMessage(storage);
  assert.deepEqual(Object.keys(folded!.sections!), ["instructions", "environment", "output"], "in their order (jsonb would sort them)");
  assert.deepEqual(folded, { role: "system", content: "BASE INSTRUCTIONS", sections: { instructions: "be brief", environment: "env v2", output: "json" }, toolsAdded: [tools[0]], timestamp: 1 });
  await assert.rejects(resetContext(storage, { limit: 100, now: Date.UTC(2026, 9, 27) }), /past the 100 bytes/);
  const reset = await resetContext(storage, { limit: 64 * 1024, now: Date.UTC(2026, 9, 27) });
  Object.assign(storage, { scanEntries, entry, findLatestHeadMarker });

  assert.equal(reset.keptMessages, 0);
  assert.deepEqual(reset.before, before);
  assert.ok(reset.after.bytes < 4_000, JSON.stringify(reset.after));
  assert.deepEqual(await contextRangeSize(storage, root), reset.after);
  const head = await storage.findLatestHeadMarker(root, undefined, context);
  assert.equal(head?.kind, "camel.legacy.context");
  const checkpoint = await entriesFrom(storage, head!.id);
  assert.deepEqual(checkpoint.map(item => item.kind), ["camel.legacy.context", "camel.context.message"]);
  assert.deepEqual(checkpoint[0].model, [folded]);
  const summary = checkpoint[1].model![0] as { role: string; content: { text: string }[] };
  assert.equal(summary.role, "user");
  assert.equal(summary.content[0].text, `${COMPACTION_SUMMARY_PREFIX}Earlier conversation was reset by the operator on 2026-10-27; the full history remains in the agent's history and files.\n</summary>`);

  // The history is as it was: the checkpoint's entries are not history.
  const again = await JournalHistory.openAny(storage);
  assert.deepEqual(await again!.messagesFrom(0), all);

  // Kept messages come from the bounded history reader; the kept tail never starts on a tool result.
  const kept = await resetContext(storage, { limit: 256 * 1024, keepMessages: 2, summary: "Custom summary" });
  assert.equal(kept.keptMessages, 1, "the tool result without its call is left out");
  const second = await entriesFrom(storage, (await storage.findLatestHeadMarker(root, undefined, context))!.id);
  assert.deepEqual(second[0].model, [folded], "a second reset keeps the same system message");
  assert.match(JSON.stringify(second[1].model), /Custom summary/);
  assert.deepEqual(second.slice(2).map(item => item.model![0].role), ["assistant"]);
  const three = await resetContext(storage, { limit: 256 * 1024, keepMessages: 3 });
  assert.equal(three.keptMessages, 3);
  const third = await entriesFrom(storage, (await storage.findLatestHeadMarker(root, undefined, context))!.id);
  assert.deepEqual(third.slice(2).map(item => item.model![0].role), ["assistant", "toolResult", "assistant"]);
  assert.deepEqual(await (await JournalHistory.openAny(storage))!.messagesFrom(0), all);
});

test("a context too large to load resets over the API, and the next prompt runs from the new context", { timeout: 90_000 }, async t => {
  let mode: "answer" | "fill" | "slow" = "answer";
  let release: () => void = () => {};
  const r = await runtime(t, (_body, index) => mode === "fill" ? toolCall("js_exec", { code: 'return "x".repeat(8192)' }, `call_${index}`)
    : mode === "slow" ? { role: "assistant", content: "slow", wait: new Promise<void>(resolve => { release = resolve; }) } : { role: "assistant", content: "fine" }, {
    AGENT_CONTEXT_RANGE_MAX_BYTES: "65536", AGENT_IDLE_MS: "1000",
  });
  const agent = (await r.call("/v1/agents", { body: {} })).json;
  assert.equal((await r.prompt(agent.id, "first")).outcome.result?.error ?? null, null);
  mode = "fill";
  const filled = await r.prompt(agent.id, "go");
  assert.equal(filled.outcome.result.code, "context_too_large", JSON.stringify(filled));
  const calls = r.model.bodies.length;
  const refused = await r.prompt(agent.id, "again");
  assert.equal(refused.outcome.result.code, "context_too_large");
  assert.equal(r.model.bodies.length, calls, "the oversized context is refused before the model");
  const history = (await r.call(`/v1/agents/${agent.id}/history`)).json.messages as any[];

  // Only its tenant's operator resets it.
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {}, token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {}, token: null })).status, 401);
  const browser = (await r.call(`/v1/agents/${agent.id}/browser-tokens`, { body: {} })).json.token;
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {}, token: browser })).status, 403);
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: { keepMessages: 21 } })).status, 400);
  assert.equal((await r.call(`/v1/agents/${agent.id}/context/reset`, { body: { keep: 1 } })).status, 400);

  // A tail that starts on a tool result: the reset keeps one fewer, from its call on.
  const keep = [...Array(20).keys()].map(n => n + 1).find(n => history.at(-n).role === "toolResult" && history.at(-n - 1).role === "assistant")!;
  const reset = await r.call(`/v1/agents/${agent.id}/context/reset`, { body: { keepMessages: keep, summary: "The operator cleared a runaway loop." } });
  assert.equal(reset.status, 200, reset.text);
  assert.equal(reset.json.reset, true);
  assert.equal(reset.json.keptMessages, keep - 1);
  assert.ok(reset.json.before.bytes > 65536 && reset.json.after.bytes < 65536, JSON.stringify(reset.json));
  assert.deepEqual((await r.call(`/v1/agents/${agent.id}/history`)).json.messages, history, "the history is unchanged");

  mode = "answer";
  const next = await r.prompt(agent.id, "after");
  assert.equal(next.outcome.result?.error ?? null, null, JSON.stringify(next));
  const body = r.model.bodies.at(-1);
  assert.equal(body.messages[0].role, "system");
  assert.deepEqual(body.messages[0], r.model.bodies[0].messages[0], "the same system message as before the reset");
  assert.deepEqual(body.tools, r.model.bodies[0].tools, "and the same tools");
  const text = (message: any) => typeof message.content === "string" ? message.content : (message.content ?? []).map((part: any) => part.text ?? "").join("");
  assert.match(text(body.messages[1]), /The operator cleared a runaway loop\./);
  assert.notEqual(body.messages[2].role, "tool");
  assert.ok(!body.messages.some((message: any) => /^first$/.test(text(message))), "the old context is gone");
  assert.equal(body.messages.at(-1).role, "user");
  const after = (await r.call(`/v1/agents/${agent.id}/history`)).json.messages as any[];
  assert.deepEqual(after.slice(0, history.length), history);
  assert.equal(after.length, history.length + 2);

  // Refused while a run is open.
  mode = "slow";
  const accepted = await r.call(`/v1/agents/${agent.id}/prompt`, { body: { text: "slow" } });
  await until(() => r.model.bodies.at(-1) && text(r.model.bodies.at(-1).messages.at(-1)) === "slow", "the slow run to reach the model");
  const busy = await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {} });
  assert.equal(busy.status, 409, busy.text);
  assert.equal(busy.json.code, "AGENT_BUSY");
  release();
  await until(async () => (await r.call(`/v1/agents/${agent.id}/requests/${accepted.json.id}`)).json.state === "completed", "the slow run to end");
  // Reset again (idempotent-safe): the same history, and the agent runs on.
  const second = await r.call(`/v1/agents/${agent.id}/context/reset`, { body: {} });
  assert.equal(second.status, 200, second.text);
  mode = "answer";
  assert.equal((await r.prompt(agent.id, "once more")).outcome.result?.error ?? null, null);
});

test("kept messages before the journal's base come from the history index, and never with a gap", async t => {
  const directory = await mkdtemp(join(tmpdir(), "context-reset-index-"));
  const storage = await openPiStorage({ sessionId: "reset-index", directory });
  t.after(async () => { await storage.close(context); await rm(directory, { recursive: true, force: true }); });
  const indexed = [user("one"), assistant(["c1"]), result("c1", "r1")];
  await seedJournal({ storage, sessionId: "reset-index", model: [system({ content: "BASE" })], before: { total: 3 }, messages: [assistant([], "four")] });
  const reads: [number, number][] = [];
  const settled = async (end: number, from: number) => { reads.push([end, from]); return indexed.slice(from, end); };
  const kept = async () => (await entriesFrom(storage, (await storage.findLatestHeadMarker(root, undefined, context))!.id)).slice(2).map(item => item.model![0]);
  assert.equal((await resetContext(storage, { limit: 1 << 20, keepMessages: 3, settled })).keptMessages, 3);
  assert.deepEqual(reads, [[3, 1]]);
  assert.deepEqual((await kept()).map(message => message.role), ["assistant", "toolResult", "assistant"]);
  // An index that lacks some of them: only what the journal holds.
  assert.equal((await resetContext(storage, { limit: 1 << 20, keepMessages: 3, settled: async () => [] })).keptMessages, 1);
  assert.deepEqual((await kept()).map(message => message.role), ["assistant"]);
});

test("a reset refuses a context with replace edits, and writes nothing when its caller's last check fails", async t => {
  const directory = await mkdtemp(join(tmpdir(), "context-reset-checks-"));
  const storage = await openPiStorage({ sessionId: "reset-checks", directory });
  t.after(async () => { await storage.close(context); await rm(directory, { recursive: true, force: true }); });
  await seedJournal({ storage, sessionId: "reset-checks", model: [system({ content: "BASE" })], messages: [user("one"), assistant([], "two")] });
  const marker = async () => (await storage.findLatestHeadMarker(root, undefined, context))!.id;
  const first = await marker();
  await assert.rejects(resetContext(storage, { limit: 1 << 20, beforeCommit: () => { throw new Error("Agent is running"); } }), /Agent is running/);
  assert.equal(await marker(), first, "nothing was written");
  const id = await storage.mintId();
  await storage.commit([{ type: "entry", value: { id, conversationId: root, kind: "camel.context.message", model: [user("x")] as never, edits: [{ target: first, action: "replace", messages: [] }] } as never }], () => {}, context);
  await assert.rejects(currentSystemMessage(storage), /replace edits/);
});

test("the supervisor refuses a reset when a host started while it ran", async t => {
  const root2 = await mkdtemp(join(tmpdir(), "context-reset-supervisor-"));
  const supervisor = new AgentSupervisor(root2, {});
  const storage = await openPiStorage({ sessionId: "raced", directory: join(root2, "raced") });
  t.after(async () => { await supervisor.close(); await rm(root2, { recursive: true, force: true }); });
  await seedJournal({ storage, sessionId: "raced", model: [system({ content: "BASE" })], before: { total: 3 }, messages: [assistant([], "four")] });
  const first = (await storage.findLatestHeadMarker(root, undefined, context))!.id;
  await storage.close(context);
  // A steer starts a host during the reset (its history read is a moment in the middle).
  const settled = async () => { supervisor.starting.add("raced"); return []; };
  await assert.rejects(supervisor.resetContext("raced", undefined, { limit: 1 << 20, keepMessages: 3, settled }), /Agent is running/);
  supervisor.starting.delete("raced");
  const reopened = await openPiStorage({ sessionId: "raced", directory: join(root2, "raced") });
  assert.equal((await reopened.findLatestHeadMarker(root, undefined, context))!.id, first, "nothing was written");
  await reopened.close(context);
});
