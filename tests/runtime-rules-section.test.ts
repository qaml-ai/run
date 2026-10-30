import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, getCurrentSystemMessage, getSystemMessageText, type Message, type SystemMessage } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { EntryId, Storage as PiStorage } from "@earendil-works/pi-durable";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import { convertToLlm, createCompactionSummaryMessage } from "../src/pi-harness/messages.ts";
import { SESSION_CONVERSATION_ID as root, seedJournal } from "../src/pi-durable/seed.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { SENDER_INSTRUCTIONS } from "../src/sender.ts";
import { RUNTIME, runtimeRules } from "../src/system-prompt.ts";
import { commitWrites } from "@earendil-works/pi-durable/testing";

/**
 * The runtime's rules (tools, files, results, who sent a message) are the system message's first section, untagged. As
 * its content they were lost at Pi's first compaction: its baseline writes sections only.
 */
const WINDOW = 8192;
const tool = (name: string, exposure?: string) => ({ name, description: name, parameters: { type: "object", properties: {} }, ...exposure ? { exposure } : {} });
const CONFIGS: Record<string, Record<string, unknown>> = {
  code: {},
  "code, tools, mounts, language": { tools: [tool("crm__find"), tool("ask", "direct")], mounts: [{ path: "/workspace", mode: "rw", workspace: true }], systemPrompt: "Be a CRM helper.", language: "es" },
  direct: { codeMode: false, tools: [tool("lookup")], systemPromptAppend: "Extra." },
  bare: { codeMode: false, tools: [] },
};

/** A host over `directory` answering every turn, its requests' messages kept (summaries apart). `seed` writes its journal first. */
async function setup(t: { after(fn: () => unknown): void }, init: Record<string, unknown> = {}, seed?: (storage: PiStorage) => Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "runtime-rules-"));
  const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
  const storage = await openPiStorage({ sessionId: "agent", directory });
  await seed?.(storage);
  const requests: Message[][] = [];
  let summaries = 0;
  faux.setResponses(Array.from({ length: 200 }, () => (request: { messages: Message[] }) => {
    if (JSON.stringify(request.messages[0]).includes("context summarization assistant")) return fauxAssistantMessage(`SUMMARY-${++summaries}`);
    requests.push(structuredClone(request.messages));
    return fauxAssistantMessage("Answer.");
  }));
  const io: HostIO = {
    emit: () => {}, tool: async () => "ok", cancelTools: async () => null, runLimit: async () => undefined,
    legacyLog: { empty: async () => true }, piStorage: async () => storage,
    file: async () => { throw new Error("no files"); }, modelAuth: async () => { throw new Error("no per-call credentials"); }, fs: async () => { throw new Error("no files"); },
  };
  const host = createAgentHost(io);
  t.after(async () => { await host.dispose(); await storage.close(context).catch(() => {}); faux.unregister(); await rm(directory, { recursive: true, force: true }); });
  await host.handle("init", { id: "agent", directory, model: { ...faux.getModel(), contextWindow: WINDOW, maxTokens: 1000 }, apiKey: "fixture", tools: [], ...init });
  return { host, requests, summaries: () => summaries };
}

/** The system prompt a request carries, its system messages folded as a provider without mid-conversation ones sends it. */
const systemText = (messages: Message[]) => getSystemMessageText(getCurrentSystemMessage(messages)!);
/** The same message as the code before this change made it: the rules as its content, and no section for them. */
function asContent(leading: SystemMessage): SystemMessage {
  const { [RUNTIME]: rules, ...sections } = leading.sections!;
  return { ...leading, content: rules!, sections };
}
/** Prompts large enough that a few fill the window. */
const large = (index: number) => ({ text: `Note ${index}: ${"the customer asked about the order status again. ".repeat(60)}` });

/** Some history: an agent without any has its leading message rebuilt from its configuration. */
const history = [{ role: "user", content: "earlier", timestamp: 1 }, fauxAssistantMessage("Earlier answer.")] as never[];

/** A fresh agent's first request and the leading system message it starts with. */
async function fresh(t: { after(fn: () => unknown): void }, init: Record<string, unknown>) {
  const { host, requests } = await setup(t, init);
  await host.handle("prompt", { text: "hello" });
  return { request: requests[0], leading: requests[0][0] as SystemMessage };
}

for (const [name, init] of Object.entries(CONFIGS)) test(`a new agent's system prompt is the same text as when the rules were its content (${name})`, async t => {
  const { request, leading } = await fresh(t, init);
  assert.equal(leading.role, "system");
  assert.equal(leading.content, "");
  assert.equal(Object.keys(leading.sections!)[0], RUNTIME);
  assert.equal(leading.sections![RUNTIME], runtimeRules(init as never));
  assert.equal(getSystemMessageText(leading), getSystemMessageText(asContent(leading)));
  assert.equal(request.filter(message => message.role === "system").length, 1, "no system change on the first request");
  assert.ok(systemText(request).startsWith(runtimeRules(init as never)));
});

test("the runtime's rules are in every request after native compactions, first, as before them", async t => {
  const { host, requests, summaries } = await setup(t);
  for (let index = 0; index < 12; index++) await host.handle("prompt", large(index));
  assert.ok(summaries() >= 2, `${summaries()} summaries`);
  const first = systemText(requests[0]);
  assert.ok(first.startsWith(runtimeRules({ tools: [] })) && first.includes(SENDER_INSTRUCTIONS));
  for (const [index, request] of requests.entries()) assert.equal(systemText(request), first, `request ${index}`);
  assert.ok(requests.some(request => request.some(message => JSON.stringify(message).includes("SUMMARY-"))), "a request after a compaction");
});

test("an agent made before the rules were a section keeps its prompt unchanged, and its rules through a compaction", async t => {
  // A new agent's leading message, as the code before made it: the rules as content.
  const { leading } = await fresh(t, {});
  const old = asContent(leading);
  const { host, requests, summaries } = await setup(t, {}, storage => seedJournal({ storage, sessionId: "agent", model: convertToLlm([old]), messages: history }));
  await host.handle("prompt", { text: "hello" });
  assert.deepEqual(requests[0].filter(message => message.role === "system"), [old], "its system messages unchanged: nothing new is declared");
  const before = systemText(requests[0]);
  for (let index = 0; index < 12; index++) await host.handle("prompt", large(index));
  assert.ok(summaries() >= 2, `${summaries()} summaries`);
  for (const [index, request] of requests.entries()) assert.equal(systemText(request), before, `request ${index}`);
});

test("an agent whose rules a compaction dropped gets them back, first, on its next request", async t => {
  const { leading } = await fresh(t, {});
  const expected = getSystemMessageText(leading);
  // What a compaction left before: its sections and none for the rules, after a summary.
  const { [RUNTIME]: _, ...sections } = leading.sections!;
  const dropped = { ...leading, content: "", sections } as SystemMessage;
  const summary = createCompactionSummaryMessage("SUMMARY-0", 10_000, 1);
  const { host, requests } = await setup(t, {}, storage => seedJournal({ storage, sessionId: "agent", model: convertToLlm([dropped, summary as never]), messages: history }));
  assert.ok(!getSystemMessageText(dropped).includes(SENDER_INSTRUCTIONS));
  await host.handle("prompt", { text: "hello" });
  await host.handle("prompt", { text: "again" });
  for (const [index, request] of requests.entries()) assert.equal(systemText(request), expected, `request ${index}`);
});

test("an agent whose rules a compaction dropped, with Pi's baseline written since, gets them back first", async t => {
  const { leading } = await fresh(t, {});
  const expected = getSystemMessageText(leading);
  const { [RUNTIME]: _, ...sections } = leading.sections!;
  // As Pi leaves it: the summary at its head, then its baseline system entry, its sections and none for the rules.
  const summary = createCompactionSummaryMessage("SUMMARY-0", 10_000, 1);
  const baseline = { role: "system", content: "", sections, toolsAdded: leading.toolsAdded, timestamp: 2 } as SystemMessage;
  const { host, requests } = await setup(t, {}, async storage => {
    await seedJournal({ storage, sessionId: "agent", model: convertToLlm([summary as never]), messages: history });
    const id = await storage.mintId() as EntryId;
    await commitWrites(storage, [{ type: "entry", value: { id, conversationId: root, kind: "pi.system", model: [baseline] } }], context);
  });
  await host.handle("prompt", { text: "hello" });
  await host.handle("prompt", { text: "again" });
  for (const [index, request] of requests.entries()) assert.equal(systemText(request), expected, `request ${index}`);
});
