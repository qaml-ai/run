import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, type Message } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { EntryId, EntryRecord, Storage as PiStorage } from "@earendil-works/pi-durable";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import { contextRangeSize, openPiStorage } from "../src/pi-durable/storage.ts";
import { SESSION_CONVERSATION_ID as root } from "../src/pi-durable/seed.ts";

/**
 * Messages that land without a turn (a credit-stopped agent's notices, notices past the wake cap): Pi compacts only as
 * it prepares a request, so the host starts its background compaction once the context is past Pi's threshold.
 */
// Window 8192, reserve min(15%, 1000 + 16k) = 1228: Pi compacts before a request past 6964 tokens.
const WINDOW = 8192, THRESHOLD = 8192 - 1228;
const STOP = { stopped: "spend_limit", message: "Out of credit: the message is in history, but no turn ran" };
const notice = (index: number) => ({ text: `Notice ${index}: ${"the sub-agent reported progress on its task. ".repeat(10)}`, landOnly: STOP });

async function setup(t: { after(fn: () => unknown): void }, summarize: (index: number) => Promise<string> | string = index => `SUMMARY-${index}`, init: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "landed-compaction-"));
  const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
  const storages: PiStorage[] = [];
  const open = async () => { storages.push(await openPiStorage({ sessionId: "agent", directory })); return storages.at(-1)!; };
  const storage = await open();
  const events: any[] = [], requests: Message[][] = [];
  let summaries = 0, summarizing = 0, overlapping = 0;
  // Summaries and turns share the faux queue: each call answers by what it was asked. A small window splits one
  // compaction's summary into parts, asked one after another.
  const respond = async (request: { messages: Message[] }) => {
    if (!JSON.stringify(request.messages[0]).includes("context summarization assistant")) {
      requests.push(structuredClone(request.messages));
      return fauxAssistantMessage("Answer.");
    }
    if (summarizing++) overlapping++;
    try { return fauxAssistantMessage(await summarize(++summaries)); }
    finally { summarizing--; }
  };
  faux.setResponses(Array.from({ length: 500 }, () => respond));
  const io: HostIO = {
    emit: event => events.push(event),
    tool: async () => "ok", cancelTools: async () => null, runLimit: async () => undefined,
    legacyLog: { empty: async () => true },
    piStorage: async () => storages.at(-1),
    file: async () => { throw new Error("no files"); },
    modelAuth: async () => { throw new Error("no per-call credentials"); },
    fs: async () => { throw new Error("no files"); },
  };
  const hosts = new Set<ReturnType<typeof createAgentHost>>();
  /** A host over the agent's storage, as a node starting it; `stop` closes one, as a node leaving mid-summary. */
  const start = async (reopen = false) => {
    if (reopen) await open();
    const host = createAgentHost(io);
    hosts.add(host);
    await host.handle("init", { id: "agent", directory, model: { ...faux.getModel(), contextWindow: WINDOW, maxTokens: 1000 }, apiKey: "fixture", tools: [], ...init });
    return host;
  };
  const stop = async (host: ReturnType<typeof createAgentHost>) => { hosts.delete(host); await host.dispose(); };
  const host = await start();
  t.after(async () => { for (const host of hosts) await host.dispose(); for (const opened of storages) await opened.close(context).catch(() => {}); faux.unregister(); await rm(directory, { recursive: true, force: true }); });
  return { host, start, stop, storage, current: () => storages.at(-1)!, events, requests, summaries: () => summaries, overlapping: () => overlapping };
}

/** Pi's context now: its newest head marker and the entries from its head on (no edits here), with their token estimate. */
async function held(storage: PiStorage) {
  const marker = await storage.findLatestHeadMarker(root, undefined, context);
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId: root, order: "ascending", ...(marker ? { minEntryId: marker.head as EntryId } : {}) }, 500, cursor, context);
    entries.push(...page.items.filter(entry => entry.head === undefined));
    cursor = page.next;
  } while (cursor !== undefined);
  const messages = [...marker?.model ?? [], ...entries.flatMap(entry => entry.model ?? [])] as Message[];
  return { marker, tokens: messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0), bytes: (await contextRangeSize(storage, root)).bytes };
}

const compactions = async (storage: PiStorage) => {
  const found: EntryRecord[] = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId: root }, 500, cursor, context);
    found.push(...page.items.filter(entry => entry.kind === "pi.compaction"));
    cursor = page.next;
  } while (cursor !== undefined);
  return found;
};

async function until(check: () => Promise<boolean>, what: string, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (await check()) return;
  assert.fail(`timed out waiting for ${what}`);
}

test("a credit-stopped agent receiving 1000 messages stays bounded: each landing past Pi's threshold compacts in the background", async t => {
  const { host, storage, events, summaries, overlapping } = await setup(t);
  let peak = 0;
  for (let index = 0; index < 1000; index++) {
    const landed = await host.handle("prompt", notice(index));
    assert.equal(landed.stopped, "spend_limit");
    // Notices arrive apart, not in one synchronous burst: the summarizer's stream gets its turns.
    await new Promise(resolve => setTimeout(resolve, 1));
    if (index % 50 === 49) peak = Math.max(peak, (await held(storage)).bytes);
  }
  // The last compaction settles: then what Pi holds is under its threshold.
  await until(async () => (await held(storage)).tokens <= THRESHOLD, "the context under Pi's threshold");
  const now = await held(storage);
  assert.ok(now.tokens <= THRESHOLD, `held ${now.tokens} tokens`);
  // 1000 notices are ~150k tokens and ~600 KB: the range never holds more than a few windows' worth.
  assert.ok(peak < 200_000, `peak range ${peak} bytes`);
  assert.ok(now.bytes < 100_000, `range ${now.bytes} bytes`);
  const placed = await compactions(storage);
  assert.ok(placed.length >= 10, `${placed.length} compactions`);
  assert.equal(overlapping(), 0, "one compaction at a time");
  // Pi's own compaction, started as `compact()` starts one.
  assert.ok(placed.every(entry => (entry.data as { reason?: string }).reason === "manual"));
  // Model-visible only through the summary text: the newest marker is Pi's summary.
  assert.equal(now.marker?.kind, "pi.compaction");
  assert.match(JSON.stringify(now.marker?.model), /SUMMARY-\d+/);
  // No run carries them: they are the agent's background work, billed as such.
  const usage = events.filter(event => event.type === "compaction_usage");
  assert.equal(usage.length, summaries());
  assert.ok(usage.every(event => event.background === true));
  assert.ok(events.filter(event => event.type === "compaction_end").every(event => event.background === true));
});

test("messages landing under Pi's threshold start no compaction", async t => {
  const { host, storage, requests, summaries } = await setup(t);
  for (let index = 0; index < 10; index++) await host.handle("prompt", notice(index));
  // A run waits for the landings' checks before it starts.
  assert.equal((await host.handle("prompt", { text: "go on" })).reply, "Answer.");
  assert.equal(summaries(), 0);
  assert.deepEqual(await compactions(storage), []);
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /Notice 9:/);
});

test("a turn starting while a landed compaction runs waits for its summary instead of compacting again", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { host, storage, requests, summaries, events } = await setup(t, async index => { await gate; return `SUMMARY-${index}`; });
  for (let index = 0; !summaries(); index++) {
    assert.ok(index < 200, "the landings crossed the threshold");
    await host.handle("prompt", notice(index));
    if ((await held(storage)).tokens > THRESHOLD) await until(async () => summaries() > 0, "the summary request");
  }
  const turn = host.handle("prompt", { text: "What happened?" });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(requests.length, 0, "the turn waits for the summary");
  release();
  const done = await turn;
  assert.equal(done.reply, "Answer.");
  assert.equal((await compactions(storage)).length, 1, "the turn did not compact the same context again");
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /<summary>\\n+SUMMARY-\d+/);
  assert.match(JSON.stringify(requests[0]), /What happened\?/);
  // The summary landed during the turn: its usage is the run's, on its stream.
  assert.ok(events.some(event => event.type === "compaction_usage"));
});

test("a compaction a closed host left listed is restarted by the next landing", async t => {
  const hold = new Promise<string>(() => {});
  const { host, start, stop, storage, current, summaries, events } = await setup(t, index => index === 1 ? hold : `SUMMARY-${index}`);
  for (let index = 0; !summaries(); index++) {
    assert.ok(index < 200, "the landings crossed the threshold");
    await host.handle("prompt", notice(index));
    if ((await held(storage)).tokens > THRESHOLD) await until(async () => summaries() > 0, "the summary request");
  }
  await stop(host);
  const next = await start(true);
  assert.deepEqual(await compactions(current()), []);
  await next.handle("prompt", notice(1000));
  await until(async () => (await compactions(current())).length === 1, "the restarted compaction placed");
  assert.ok(events.some(event => event.type === "compaction_end"));
});

test("a summarizer that fails is not asked again on every landing", async t => {
  const { host, summaries, storage } = await setup(t, () => { throw new Error("402 payment required"); });
  for (let index = 0; index < 120; index++) {
    await host.handle("prompt", notice(index));
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  assert.equal(summaries(), 1);
  assert.deepEqual(await compactions(storage), []);
});

test("a range too large to load is never read for a landing: no compaction, logged", async t => {
  const logged: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
  t.after(() => { console.error = log; });
  const { host, summaries } = await setup(t, undefined, { contextRangeMaxBytes: 20_000 });
  for (let index = 0; index < 80; index++) await host.handle("prompt", notice(index));
  assert.equal(summaries(), 0);
  assert.ok(logged.some(line => line.includes('"type":"compaction_skipped"') && line.includes("context")), "the skip is logged");
});
