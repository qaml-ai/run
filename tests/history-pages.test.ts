import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Db } from "../src/db.ts";
import { AgentHistory } from "../src/history-pages.ts";
import { HostJournal } from "../src/pi-durable/host-journal.ts";
import { JournalHistory } from "../src/pi-durable/history.ts";
import { seedJournal } from "../src/pi-durable/seed.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { fileStorage, type Storage } from "../shared/storage.ts";
import { testDatabase } from "./database.ts";
import { AgentRuntime } from "../clients/typescript.ts";
import { lastUser, OPERATOR, OTHER_OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }) as unknown as AgentMessage;
const system = { role: "system", content: "Rules.", timestamp: 0 } as never;

/** An agent row, and its Pi storage seeded with `archive` before its base (a fork's), then `turns` run through its journal. */
async function agentWith(db: Db, root: string, agent: string, archive: { messages: AgentMessage[]; turns: number[] } | undefined, turns: AgentMessage[][], before = archive?.messages.length ?? 0) {
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, 't', '{}', 'a', 'general', 'm', null, false, 1)", [agent]);
  const storage = await openPiStorage({ sessionId: agent, directory: join(root, agent), db });
  await seedJournal({ storage, sessionId: agent, model: [system], before: { total: before }, ...(archive ? { archive } : {}) });
  const journal = (await HostJournal.open(storage))!;
  for (const messages of turns) {
    await journal.setActive(true);
    await journal.append(messages);
    await journal.setActive(false);
  }
  return { storage, journal };
}

/** Every page, newest first, then joined oldest first: each message once, at its index. */
async function allPages(index: AgentHistory, agent: string, options: { limit: number; maxBytes?: number }) {
  const pages = [];
  for (let before: number | null | undefined; before !== null;) {
    const page = await index.page(agent, { ...options, ...(before !== undefined ? { before } : {}) });
    pages.unshift(page);
    before = page.next;
  }
  return pages;
}

test("pages by ordinal hold the journal's history: whole turns, newest first, each message once, across a fork's archive and the journal", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new AgentHistory(db);
  const archive = [user("a"), assistant("A"), user("b"), assistant("B1"), assistant("B2")];
  const { storage } = await agentWith(db, root, "client_pages", { messages: archive, turns: [0, 2] }, [[user("c"), assistant("C")], [user("d"), assistant("D1"), assistant("D2"), assistant("D3")]]);
  const history = (await JournalHistory.openAny(storage))!;
  const whole = [...archive, ...(await history.messagesFrom(history.heldFrom))!];
  assert.equal(whole.length, 11);
  assert.deepEqual(await index.messages("client_pages"), whole, "the full read is the archive, then the journal's");
  assert.deepEqual(await index.messages("client_pages", 3, 8), whole.slice(3, 8), "a range across both");
  assert.deepEqual(await index.allTurns("client_pages"), [0, 2, 5, 7]);
  for (const limit of [1, 2, 3, 50]) {
    const pages = await allPages(index, "client_pages", { limit });
    assert.deepEqual(pages.flatMap(page => page.entries.map(entry => entry.message)), whole, `limit ${limit}: every message once`);
    assert.deepEqual(pages.flatMap(page => page.entries.map(entry => entry.index)), whole.map((_, at) => at));
    for (const page of pages) {
      assert.equal(page.total, 11);
      assert.equal(page.entries[0].message.role, "user", "a page starts at a turn");
      assert.ok(page.entries.length >= Math.min(limit, page.entries.at(-1)!.index + 1));
    }
  }
  assert.deepEqual((await allPages(index, "client_pages", { limit: 1 })).map(page => page.entries.length), [2, 3, 2, 4]);
  // The journal's cursor of a message, and none for an archived one.
  assert.equal(await index.cursorAt("client_pages", 2), undefined);
  assert.ok((await index.cursorAt("client_pages", 6))!.entryId > 0);
  await storage.close(BACKGROUND_CONTEXT);
});

test("every read is bounded before it reads: past its byte limit it is refused (413), nothing loaded", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new AgentHistory(db);
  const { storage } = await agentWith(db, root, "client_bounds", undefined, [[user("x".repeat(4000)), assistant("y".repeat(4000))]]);
  let loads = 0;
  const query = db.query.bind(db);
  (db as { query: Db["query"] }).query = ((text: string, params?: unknown[]) => { if (/select id, record from/.test(text)) loads++; return query(text, params as never); }) as Db["query"];
  t.after(() => { (db as { query: Db["query"] }).query = query; });
  await assert.rejects(index.messages("client_bounds", 0, undefined, 4096), { status: 413 });
  assert.equal(loads, 0, "refused before any record was read");
  assert.equal((await index.messages("client_bounds", 0, undefined, 64 * 1024)).length, 2);
  assert.equal(loads, 1);
  await storage.close(BACKGROUND_CONTEXT);
});

test("an agent placed before ordinals is placed at its first read", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-lazy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new AgentHistory(db);
  const { storage } = await agentWith(db, root, "client_lazy", undefined, [[user("q"), assistant("a")]]);
  await db.query("update pi_durable_entries set msg_from = null, msg_count = null, msg_skip = 0, turn_start = false where session_id = 'client_lazy'");
  await db.query("update pi_durable_metadata set history_next = null, history_last_id = null where session_id = 'client_lazy'");
  assert.deepEqual((await index.page("client_lazy", { limit: 5 })).entries.map(entry => entry.message), [user("q"), assistant("a")]);
  assert.equal((await db.query("select history_next from pi_durable_metadata where session_id = 'client_lazy'")).rows[0].history_next, 2);
  assert.deepEqual(await index.page("missing", { limit: 5 }), { entries: [], next: null, total: 0 }, "no Pi storage: no history");
  await storage.close(BACKGROUND_CONTEXT);
});

test("byte-bounded pages count UTF-8 and the envelope, preserve cursors, and keep oversized messages", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new AgentHistory(db);
  const agent = `client_${"b".repeat(40)}`;
  const messages = [user("old"), assistant("🙂".repeat(1400)), user("middle"), assistant("界".repeat(2000)), user("new"), assistant("x".repeat(20_000))];
  const { storage } = await agentWith(db, root, agent, { messages: messages.slice(0, 4), turns: [0, 2] }, [messages.slice(4)]);
  const maxBytes = 16_384;
  const size = (page: unknown) => Buffer.byteLength(JSON.stringify(page));
  const normal = await index.page(agent, { limit: 50 });
  assert.deepEqual(normal.entries.map(entry => entry.message), messages, "the default still returns whole turns");
  const seen: typeof normal.entries = [];
  let before: number | undefined;
  while (true) {
    const page = await index.page(agent, { limit: 50, maxBytes, before });
    assert.ok(page.entries.length);
    assert.ok(size(page) <= maxBytes || page.entries.length === 1);
    if (before === undefined) {
      assert.deepEqual(page.entries.map(entry => entry.index), [5], "one oversized message is returned whole");
      assert.equal(page.split, true);
    }
    seen.unshift(...page.entries);
    if (page.next === null) break;
    assert.equal(page.next, page.entries[0].index);
    before = page.next;
  }
  assert.deepEqual(seen, normal.entries, "every message occurs exactly once across pages");
  const exact = await index.page(agent, { limit: 50, before: 4 });
  assert.equal((await index.page(agent, { limit: 50, before: 4, maxBytes: size(exact) })).entries.length, 4);
  const smaller = await index.page(agent, { limit: 50, before: 4, maxBytes: size(exact) - 1 });
  assert.equal(smaller.entries.length, 3, "one byte below the complete response drops its oldest message");
  assert.ok(size(smaller) <= size(exact) - 1);
  assert.equal(smaller.split, true);
  assert.deepEqual((await index.page(agent, { limit: 50, before: 0, maxBytes })).entries, []);
  await storage.close(BACKGROUND_CONTEXT);
});

/** Every page forward from 0, in the order a poller reads them: its nextAfter is the next call's after. */
async function afterPages(index: AgentHistory, agent: string, options: { limit: number; maxBytes?: number }) {
  const pages = [];
  for (let after = 0; ;) {
    const page = await index.pageAfter(agent, { ...options, after });
    pages.push(page);
    if (page.nextAfter === page.total) return pages;
    assert.ok(page.nextAfter! > after, `after ${after} moved on`);
    after = page.nextAfter!;
  }
}

test("a forward page starts at `after` and nextAfter reads every message once", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-after-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new AgentHistory(db);
  const archive = [user("a"), assistant("A"), user("b"), assistant("B1"), assistant("B2")];
  const { storage } = await agentWith(db, root, "client_after", { messages: archive, turns: [0, 2] }, [[user("c"), assistant("C")], [user("d"), assistant("D1"), assistant("D2"), assistant("D3")]]);
  const whole = await index.messages("client_after");
  assert.deepEqual(await index.allTurns("client_after"), [0, 2, 5, 7]);
  const first = await index.pageAfter("client_after", { after: 0, limit: 1 });
  assert.deepEqual(first.entries.map(entry => entry.index), [0, 1], "the first turn, from 0");
  assert.equal(first.next, null);
  assert.equal(first.nextAfter, 2);
  assert.equal(first.total, 11);
  assert.equal(first.split, undefined);
  assert.equal(first.truncated, undefined);
  for (const limit of [1, 2, 3, 50]) {
    const pages = await afterPages(index, "client_after", { limit });
    assert.deepEqual(pages.flatMap(page => page.entries.map(entry => entry.message)), whole, `limit ${limit}: every message once`);
    assert.deepEqual(pages.flatMap(page => page.entries.map(entry => entry.index)), whole.map((_, at) => at));
    for (const page of pages) {
      assert.equal(page.total, 11);
      assert.equal(page.nextAfter, page.entries.length ? page.entries.at(-1)!.index + 1 : 11);
      assert.equal(page.next, page.entries.length && page.entries[0].index > 0 ? page.entries[0].index : null);
      assert.equal(page.entries[0].message.role, "user", "a page starts at a turn");
    }
  }
  assert.deepEqual((await afterPages(index, "client_after", { limit: 1 })).map(page => page.entries.length), [2, 3, 2, 4]);
  // Caught up: nothing new, and the cursor stays where the history ends.
  assert.deepEqual(await index.pageAfter("client_after", { after: 11, limit: 5 }), { entries: [], next: null, total: 11, nextAfter: 11 });
  // Past the end (the history shrank): what exists, total for the caller to reset from, and the flag.
  assert.deepEqual(await index.pageAfter("client_after", { after: 99, limit: 5 }), { entries: [], next: null, total: 11, nextAfter: 11, truncated: true });
  // A limit past what is left is the rest of the history, whole turns and all.
  const rest = await index.pageAfter("client_after", { after: 5, limit: 500 });
  assert.deepEqual(rest.entries.map(entry => entry.index), [5, 6, 7, 8, 9, 10]);
  assert.equal(rest.nextAfter, 11);
  assert.equal(rest.next, 5);
  assert.equal((await index.pageAfter("client_after", { after: 3, limit: 1 })).entries[0].index, 3, "inside a turn: it starts there");
  assert.deepEqual(await index.pageAfter("missing", { after: 0, limit: 5 }), { entries: [], next: null, total: 0, nextAfter: 0 }, "no Pi storage: no history");
  // The backward page is what it was: the older page's before, and nothing new in the response.
  const newest = await index.page("client_after", { limit: 1 });
  assert.deepEqual(Object.keys(newest).sort(), ["entries", "next", "total"]);
  assert.deepEqual(newest.entries.map(entry => entry.index), [7, 8, 9, 10]);
  assert.equal(newest.next, 7);
  assert.deepEqual((await allPages(index, "client_after", { limit: 1 })).map(page => page.entries.length), [2, 3, 2, 4]);
  await storage.close(BACKGROUND_CONTEXT);
});

test("a byte-bounded forward page keeps the oldest messages that fit and resumes where it ended", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-after-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new AgentHistory(db);
  const agent = `client_${"a".repeat(40)}`;
  // Two turns, the first one big enough that a small page ends inside it.
  const messages = [user("q"), assistant("y".repeat(12_000)), assistant("z".repeat(12_000)), user("next"), assistant("n")];
  const { storage } = await agentWith(db, root, agent, { messages: messages.slice(0, 3), turns: [0] }, [messages.slice(3)]);
  const maxBytes = 16_384;
  const size = (page: unknown) => Buffer.byteLength(JSON.stringify(page));
  assert.deepEqual((await index.pageAfter(agent, { after: 0, limit: 50 })).entries.map(entry => entry.message), messages);
  const pages = await afterPages(index, agent, { limit: 50, maxBytes });
  assert.deepEqual(pages.flatMap(page => page.entries.map(entry => entry.message)), messages, "every message once, no gap where the turn split");
  assert.ok(pages.length > 1);
  for (const page of pages) assert.ok(size(page) <= maxBytes || page.entries.length === 1, "a page fits, or is one message");
  assert.deepEqual(pages.map(page => page.entries.map(entry => entry.index)), [[0, 1], [2, 3, 4]]);
  assert.equal(pages[0].split, true, "the page ends inside a turn");
  assert.equal(pages[0].nextAfter, 2);
  assert.equal(pages[1].split, true, "and the next one starts there");
  assert.equal(pages[1].nextAfter, 5);
  assert.equal((await index.pageAfter(agent, { after: 5, limit: 50, maxBytes })).nextAfter, 5, "caught up with a byte bound too");
  await storage.close(BACKGROUND_CONTEXT);
});

test("a forward page from before the history a journal still holds says truncated and starts where the history does", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-after-compact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new AgentHistory(db);
  // A journal whose base opens at 10 (compaction took the history before it): only 10 and 11 are kept.
  const { storage } = await agentWith(db, root, "client_compacted", undefined, [[user("n"), assistant("N")]], 10);
  assert.equal(await index.total("client_compacted"), 12);
  const page = await index.pageAfter("client_compacted", { after: 0, limit: 50 });
  assert.deepEqual(page.entries.map(entry => entry.index), [10, 11], "what exists, not an error");
  assert.equal(page.total, 12);
  assert.equal(page.next, 10);
  assert.equal(page.nextAfter, 12);
  assert.equal(page.truncated, true);
  const inside = await index.pageAfter("client_compacted", { after: 10, limit: 50 });
  assert.equal(inside.truncated, undefined, "10 is kept: nothing was skipped");
  assert.deepEqual(inside.entries.map(entry => entry.index), [10, 11]);
  await storage.close(BACKGROUND_CONTEXT);
});

test("history comes in pages of whole turns, newest first, from Pi storage wherever the agent runs or not", async t => {
  const r = await runtime(t, body => {
    const last = body.messages.at(-1);
    if (last.role === "tool") return { content: `done ${lastUser(body)}` };
    return lastUser(body).startsWith("tool") ? toolCall("js_exec", { code: "return 1" }, `call_${body.messages.length}`) : { content: `reply ${lastUser(body)}` };
  }, { AGENT_IDLE_MS: "1000" });
  const session = (await r.call("/v1/agents", { body: {} })).json;
  const agent = session.id as string;
  const prompts = ["one", "tool two", "three", "tool four", "five", "six"];
  for (const text of prompts) assert.equal((await r.prompt(agent, text)).outcome.error, undefined);
  const whole = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(whole.length, 16);

  const pages = async (limit: number, token?: string) => {
    const seen: any[] = [];
    for (let before: number | null | undefined; before !== null;) {
      const page = await r.call(`/v1/agents/${agent}/history?limit=${limit}${before !== undefined ? `&before=${before}` : ""}`, { token });
      assert.equal(page.status, 200, page.text);
      assert.equal(page.json.total, 16);
      assert.equal(page.json.entries[0].message.role, "user", "a page starts at a turn");
      assert.ok(page.json.entries.length >= Math.min(limit, page.json.entries.at(-1).index + 1));
      seen.unshift(page.json);
      before = page.json.next;
    }
    return seen;
  };
  const check = async () => {
    const byThree = await pages(3);
    assert.deepEqual(byThree.flatMap(page => page.entries.map((entry: any) => entry.index)), whole.map((_: unknown, index: number) => index));
    assert.deepEqual(byThree.flatMap(page => page.entries.map((entry: any) => entry.message)), whole);
    // Turns of 2 and 4 messages alternate: newest first, a page of 3 takes whole turns until it has 3.
    assert.deepEqual(byThree.map(page => page.entries.length), [2, 6, 4, 4]);
    assert.deepEqual((await pages(1)).map(page => page.entries.length), [2, 4, 2, 4, 2, 2]);
  };
  await check();
  // The same once the idle agent has stopped: nothing is indexed, pages are read from Pi storage.
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop", 20_000);
  await check();

  // The SDK pages the same way, with the agent's own token.
  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).connectAgent(session, { tools: {} });
  t.after(() => client.close());
  const newest = await client.historyPage({ limit: 3 });
  assert.deepEqual(newest.entries.map(entry => entry.index), [12, 13, 14, 15]);
  assert.deepEqual((await client.historyPage({ before: newest.next!, limit: 3 })).entries.map(entry => entry.index), [8, 9, 10, 11]);

  // A fork holds the history it copied (archived before its base), then its own.
  const fork = (await r.call(`/v1/agents/${agent}/fork`, { body: { key: "pages-fork" } })).json;
  assert.deepEqual((await r.call(`/v1/agents/${fork.id}/history`)).json.messages, whole);
  assert.deepEqual((await r.call(`/v1/agents/${fork.id}/history?limit=1`)).json.entries.map((entry: any) => entry.index), [14, 15]);

  // Another tenant's token gets no page.
  assert.equal((await r.call(`/v1/agents/${agent}/history?limit=3`, { token: OTHER_OPERATOR })).status, 404);
});

test("history maxBytes works alone on the API and through the SDK, with validated bounds", async t => {
  const r = await runtime(t, () => ({ content: "界".repeat(2000) }));
  const session = (await r.call("/v1/agents", { body: {} })).json;
  for (let turn = 0; turn < 3; turn++) await r.prompt(session.id, `question ${turn}`);
  const whole = (await r.call(`/v1/agents/${session.id}/history`)).json.messages;
  const normal = await r.call(`/v1/agents/${session.id}/history?limit=50`);
  assert.deepEqual(normal.json.entries.map((entry: any) => entry.message), whole);
  const bounded = await r.call(`/v1/agents/${session.id}/history?maxBytes=16384`);
  assert.equal(bounded.status, 200);
  assert.ok(Buffer.byteLength(bounded.text) <= 16_384);
  assert.ok(bounded.json.entries.length < normal.json.entries.length);
  assert.equal(bounded.json.entries.at(-1).index, whole.length - 1);
  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).connectAgent(session, { tools: {} });
  t.after(() => client.close());
  assert.deepEqual(await client.historyPage({ maxBytes: 16_384 }), bounded.json);
  const older = await client.historyPage({ maxBytes: 16_384, before: bounded.json.next });
  assert.deepEqual([...older.entries, ...bounded.json.entries].map(entry => entry.message), whole);
  for (const value of ["0", "16383", "4000001", "16384.5", "NaN", "Infinity", ""]) {
    const invalid = await r.call(`/v1/agents/${session.id}/history?maxBytes=${value}`);
    assert.equal(invalid.status, 400, value);
    await assert.rejects(client.historyPage({ maxBytes: Number(value) }), /maxBytes/);
  }
  assert.equal((await r.call(`/v1/agents/${session.id}/history?maxBytes=4000000`)).status, 200);
});

test("history after pages forward on the API and through the SDK; after with before is a 400", async t => {
  const r = await runtime(t, () => ({ content: "reply" }));
  const session = (await r.call("/v1/agents", { body: {} })).json;
  const agent = session.id as string;
  for (const text of ["one", "two"]) await r.prompt(agent, text);
  const whole = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(whole.length, 4);
  const seen: any[] = [];
  for (let after = 0;;) {
    const page = await r.call(`/v1/agents/${agent}/history?limit=1&after=${after}`);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.json.total, 4);
    if (page.json.entries.length) assert.equal(page.json.entries[0].message.role, "user", "a page starts at a turn");
    seen.push(...page.json.entries);
    if (page.json.nextAfter === page.json.total) break;
    assert.ok(page.json.nextAfter > after);
    after = page.json.nextAfter;
  }
  assert.deepEqual(seen.map(entry => entry.index), [0, 1, 2, 3]);
  assert.deepEqual(seen.map(entry => entry.message), whole);
  const firstPage = await r.call(`/v1/agents/${agent}/history?after=0&limit=1`);
  assert.deepEqual(firstPage.json.entries.map((entry: any) => entry.index), [0, 1]);
  assert.deepEqual([firstPage.json.next, firstPage.json.nextAfter, firstPage.json.total], [null, 2, 4]);
  assert.equal(firstPage.json.truncated, undefined);
  const caught = await r.call(`/v1/agents/${agent}/history?after=4`);
  assert.equal(caught.status, 200);
  assert.equal(caught.json.nextAfter, 4);
  assert.deepEqual(caught.json.entries, []);
  const past = await r.call(`/v1/agents/${agent}/history?after=9`);
  assert.equal(past.status, 200);
  assert.deepEqual(past.json.entries, []);
  assert.equal(past.json.total, 4);
  assert.equal(past.json.nextAfter, 4);
  assert.equal(past.json.truncated, true);
  assert.equal((await r.call(`/v1/agents/${agent}/history?after=4&maxBytes=16384`)).status, 200, "a byte bound alone pages too");

  const both = await r.call(`/v1/agents/${agent}/history?after=0&before=2`);
  assert.equal(both.status, 400, both.text);
  assert.match(both.json.error, /after or before/);
  for (const value of ["-1", "1.5", "NaN", "Infinity"])
    assert.equal((await r.call(`/v1/agents/${agent}/history?after=${value}`)).status, 400, value);

  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).connectAgent(session, { tools: {} });
  t.after(() => client.close());
  assert.deepEqual((await client.historyPage({ after: 2, limit: 1 })).entries.map(entry => entry.index), [2, 3]);
  assert.deepEqual(await client.historyPage({ after: 0, limit: 1 }), (await r.call(`/v1/agents/${agent}/history?after=0&limit=1`)).json);
  await assert.rejects(client.historyPage({ after: 0, before: 2 }), /after or before/);
  // The backward page is unchanged: its next is still the older page's before.
  const newest = await client.historyPage({ limit: 1 });
  assert.equal(newest.next, 2);
  assert.equal(newest.nextAfter, undefined);
  assert.deepEqual((await client.historyPage({ limit: 1, before: newest.next! })).entries.map(entry => entry.index), [0, 1]);
});

test("the newest page has the running turn's finished messages, at their indexes; purging removes the agent's history", async t => {
  const r = await runtime(t, body => {
    if (body.messages.at(-1).role === "tool") return { content: "finished", delayMs: lastUser(body) === "slow" ? 1500 : 0 };
    return lastUser(body) === "slow" ? toolCall("js_exec", { code: "return 2" }) : { content: `reply ${lastUser(body)}` };
  }, { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "first");
  await r.prompt(agent, "second");
  const running = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "slow" } });
  assert.equal(running.status, 202);
  const newest = await until(async () => {
    const page = (await r.call(`/v1/agents/${agent}/history?limit=1`)).json;
    return page.total === 7 && page;
  }, "the tool result of the running turn");
  assert.deepEqual(newest.entries.map((entry: any) => [entry.index, entry.message.role]), [[4, "user"], [5, "assistant"], [6, "toolResult"]]);
  assert.equal((await r.call(`/v1/agents/${agent}/requests/${running.json.id}`)).json.state, "running");
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${running.json.id}`)).json.state === "completed", "the turn to end");
  const settled = (await r.call(`/v1/agents/${agent}/history?limit=1`)).json;
  assert.deepEqual(settled.entries.map((entry: any) => entry.index), [4, 5, 6, 7]);

  assert.equal((await r.call(`/v1/agents/${agent}`, { method: "DELETE" })).status, 200);
  await until(async () => (await r.db.query("select count(*)::int as count from pi_durable_entries where session_id = $1", [agent])).rows[0].count === 0, "the agent's Pi storage to be purged");
  await until(async () => !(await readdir(join(r.root, "sessions", agent, "history")).catch(() => [])).length, "any chunk blobs to be purged");
});
