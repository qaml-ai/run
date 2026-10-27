import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Api, Model } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { DocumentId, EntryId } from "@earendil-works/pi-durable";
import { baseWrites, JournalHistory } from "../src/pi-durable/history.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { boundaries, chunksOf, FULL_HISTORY_READ_BYTES, HistoryIndex } from "../src/history-pages.ts";
import { fileStorage } from "../shared/storage.ts";
import { testDatabase } from "./database.ts";
import { AgentRuntime } from "../clients/typescript.ts";
import { lastUser, OPERATOR, OTHER_OPERATOR, runtime, sleep, toolCall, until } from "./runtime-server.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }) as unknown as AgentMessage;
const indexedOf = async (r: { db: any }, agent: string) => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed as number | undefined;

test("what the history index lacks is chunked at turn starts, under its bound; one turn larger than it is split between messages", () => {
  const messages = [user("b"), assistant("B"), user("c"), assistant("C")];
  // A resumed run starts without a user message: no turn begins there.
  const backlog = { from: 2, messages, sizes: messages.map(message => JSON.stringify(message).length), turns: [2, 4, 5] };
  assert.deepEqual(boundaries(backlog.from, backlog.messages, backlog.turns), [2, 4]);
  assert.deepEqual(chunksOf(backlog).map(chunk => [chunk.start, chunk.messages.length, chunk.turns]), [[2, 4, [2, 4]]]);
  const big = "x".repeat(400_000);
  const sized = [user(big), assistant(big), user(big), assistant(big), assistant(big), assistant(big)];
  assert.deepEqual(chunksOf({ from: 0, messages: sized, sizes: sized.map(message => JSON.stringify(message).length), turns: [0, 2] }).map(chunk => [chunk.start, chunk.messages.length, chunk.turns]), [[0, 2, [0]], [2, 2, [2]], [4, 2, []]]);
});

test("full history checks all chunk bytes before reading any blob", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = fileStorage(root);
  const index = new HistoryIndex(db, storage);
  const agent = `client_${"c".repeat(40)}`;
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, 't', '{}', 'a', 'general', 'm', null, false, 1)", [agent]);
  await index.write(agent, undefined, { start: 0, messages: [user("first")], turns: [0] });
  await index.write(agent, undefined, { start: 1, messages: [user("second")], turns: [1] });
  let reads = 0;
  const read = storage.readBlob.bind(storage);
  storage.readBlob = key => { reads++; return read(key); };
  // Each chunk fits alone, but together they exceed the cap.
  await db.query("update agent_history_chunks set bytes = $2 where agent = $1", [agent, FULL_HISTORY_READ_BYTES / 2 + 1]);
  await assert.rejects(index.messages(agent, 2), { status: 413, message: `History is ${FULL_HISTORY_READ_BYTES + 2} bytes; full-history reads and forks are limited to ${FULL_HISTORY_READ_BYTES} bytes. Read it in pages with limit/before/maxBytes.` });
  assert.equal(reads, 0);
  assert.deepEqual(await index.messages(agent, 1), [user("first")], "only selected rows count");
  assert.equal(reads, 1);
  await db.query("update agent_history_chunks set bytes = $2 where agent = $1", [agent, FULL_HISTORY_READ_BYTES / 2]);
  assert.deepEqual(await index.messages(agent, 2), [user("first"), user("second")], "the exact cap is allowed");
  assert.equal(reads, 3);
});

test("ranged history reads select overlapping chunks and cap their bytes before reading", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-range-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = fileStorage(root);
  const index = new HistoryIndex(db, storage);
  const agent = `client_${"d".repeat(40)}`;
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, 't', '{}', 'a', 'general', 'm', null, false, 1)", [agent]);
  const messages = [user("old"), assistant("old"), user("middle"), assistant("middle"), user("new")];
  await index.write(agent, undefined, { start: 0, messages: messages.slice(0, 2), turns: [0] });
  await index.write(agent, undefined, { start: 2, messages: messages.slice(2, 4), turns: [2] });
  await index.write(agent, undefined, { start: 4, messages: messages.slice(4), turns: [4] });
  await db.query("update agent_history_chunks set bytes = $2 where agent = $1 and start in (0, 4)", [agent, FULL_HISTORY_READ_BYTES + 1]);
  const reads: string[] = [];
  const read = storage.readBlob.bind(storage);
  storage.readBlob = key => { reads.push(key); return read(key); };
  assert.deepEqual(await index.messages(agent, 3, 2), messages.slice(2, 3));
  assert.deepEqual(await index.messages(agent, 4, 3), messages.slice(3, 4));
  assert.equal(reads.length, 2, "only the overlapping chunk is read, including partial ranges");
  await assert.rejects(index.messages(agent, 4, 1), { status: 413 });
  assert.equal(reads.length, 2, "an oversized range reads no blobs");
});

test("a page behind the journal base reads only its missing indexed range", async t => {
  const r = await runtime(t, () => ({ content: "done" }), { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "first");
  await until(async () => await indexedOf(r, agent) === 2, "the first turn to be indexed separately", 20_000);
  await r.prompt(agent, "second");
  await until(async () => await indexedOf(r, agent) === 4, "the stopped agent to index its messages", 20_000);
  const storage = await openPiStorage({ sessionId: agent, directory: join(r.root, "agents", agent), db: r.db });
  try {
    const history = (await JournalHistory.openAny(storage))!;
    const document = await JournalHistory.baseDocument(storage);
    await storage.commit(baseWrites(await storage.mintId<EntryId>(), history.settledBase()!, {
      id: document ?? await storage.mintId<DocumentId>(), create: !document,
    }), BACKGROUND_CONTEXT);
  } finally { await storage.close(BACKGROUND_CONTEXT); }
  // The marker lags the journal base, but another writer has already stored the missing chunk.
  await r.db.query("update agent_history_index set indexed = 2 where agent = $1", [agent]);
  await r.db.query("update agent_history_chunks set bytes = $2 where agent = $1 and start = 0", [agent, FULL_HISTORY_READ_BYTES + 1]);
  const page = await r.call(`/v1/agents/${agent}/history?limit=1&maxBytes=16384`);
  assert.equal(page.status, 200, page.text);
  assert.equal(page.json.total, 4);
  assert.deepEqual(page.json.entries.map((entry: any) => entry.index), [0, 1, 2, 3]);
  assert.equal((await r.call(`/v1/agents/${agent}/history`)).status, 413);
});

test("byte-bounded pages count UTF-8 and the envelope, preserve cursors, and keep oversized messages", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-bytes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new HistoryIndex(db, fileStorage(root));
  const agent = `client_${"b".repeat(40)}`;
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, 't', '{}', 'a', 'general', 'm', null, false, 1)", [agent]);
  const messages = [user("old"), assistant("🙂".repeat(1400)), user("middle"), assistant("界".repeat(2000)), user("new"), assistant("x".repeat(20_000))];
  const backlog = { from: 0, messages, turns: [0, 2, 4] };
  const maxBytes = 16_384;
  const size = (page: unknown) => Buffer.byteLength(JSON.stringify(page));
  const check = async (tail?: typeof backlog) => {
    const normal = await index.page(agent, { limit: 50 }, tail);
    assert.deepEqual(normal.entries.map(entry => entry.message), messages, "the default still returns whole turns");
    const seen: typeof normal.entries = [];
    let before: number | undefined;
    while (true) {
      const page = await index.page(agent, { limit: 50, maxBytes, before }, tail);
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
    const exact = await index.page(agent, { limit: 50, before: 4 }, tail);
    assert.equal((await index.page(agent, { limit: 50, before: 4, maxBytes: size(exact) }, tail)).entries.length, 4);
    const smaller = await index.page(agent, { limit: 50, before: 4, maxBytes: size(exact) - 1 }, tail);
    assert.equal(smaller.entries.length, 3, "one byte below the complete response drops its oldest message");
    assert.ok(size(smaller) <= size(exact) - 1);
    assert.equal(smaller.split, true);
    assert.deepEqual((await index.page(agent, { limit: 50, before: 0, maxBytes }, tail)).entries, []);
  };
  await check(backlog);
  await index.write(agent, undefined, { start: 0, messages: messages.slice(0, 4), turns: [0, 2] });
  await check({ from: 4, messages: messages.slice(4), turns: [4] });
  await index.write(agent, undefined, { start: 4, messages: messages.slice(4), turns: [4] });
  await check();
});

test("history comes in pages of whole turns, newest first, from chunks rather than the log", async t => {
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
  // While the agent runs, what is not indexed yet comes from it.
  await check();
  assert.equal((await r.db.query("select count(*)::int as count from agent_history_chunks where agent = $1", [agent])).rows[0].count, 0, "nothing is written per turn");

  // The agent indexes its settled turns as it stops; then pages come from chunks, and its journal holds nothing past them.
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop", 20_000);
  await until(async () => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed === 16, "the stopping agent to index its turns");
  await check();

  // The SDK pages the same way, with the agent's own token.
  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR }).connectAgent(session, { tools: {} });
  t.after(() => client.close());
  const newest = await client.historyPage({ limit: 3 });
  assert.deepEqual(newest.entries.map(entry => entry.index), [12, 13, 14, 15]);
  assert.deepEqual((await client.historyPage({ before: newest.next!, limit: 3 })).entries.map(entry => entry.index), [8, 9, 10, 11]);

  // Another tenant's token gets no page.
  assert.equal((await r.call(`/v1/agents/${agent}/history?limit=3`, { token: OTHER_OPERATOR })).status, 404);
});

test("oversized indexed histories return 413 for unloaded reads, runs and forks while pages work", async t => {
  const r = await runtime(t, () => ({ content: "done" }), { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "first");
  const run = (await r.call("/v1/runs", { body: { input: "one run", wait: true } })).json;
  const runAgent = `client_${run.id.slice("run_".length)}`;
  for (const id of [agent, runAgent]) {
    await until(async () => await indexedOf(r, id) === 2, "the stopped agent to index its messages", 20_000);
    // Move the journal base past the indexed messages, as a long-lived agent's rebase does.
    const storage = await openPiStorage({ sessionId: id, directory: join(r.root, "agents", id), db: r.db });
    try {
      const history = (await JournalHistory.openAny(storage))!;
      const document = await JournalHistory.baseDocument(storage);
      await storage.commit(baseWrites(await storage.mintId<EntryId>(), history.settledBase()!, {
        id: document ?? await storage.mintId<DocumentId>(), create: !document,
      }), BACKGROUND_CONTEXT);
    } finally { await storage.close(BACKGROUND_CONTEXT); }
    await r.db.query("update agent_history_chunks set bytes = $2 where agent = $1", [id, FULL_HISTORY_READ_BYTES + 1]);
    if (id === runAgent) continue; // Ephemeral runs are read through /v1/runs, not agent routes.
    const full = await r.call(`/v1/agents/${id}/history`);
    assert.equal(full.status, 413, full.text);
    assert.match(full.text, /limit\/before\/maxBytes/);
    const page = await r.call(`/v1/agents/${id}/history?limit=1&maxBytes=16384`);
    assert.equal(page.status, 200, page.text);
    assert.equal(page.json.entries.at(-1).index, 1);
  }
  const messages = await r.call(`/v1/runs/${run.id}/messages`);
  assert.equal(messages.status, 413, messages.text);
  const fork = await r.call(`/v1/agents/${agent}/fork`, { body: { key: "oversized-fork" } });
  assert.equal(fork.status, 413, fork.text);
  assert.match(fork.text, /forks/);
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

test("the newest page has the running turn; an index behind reads the rest from the journal; purging removes its chunks", async t => {
  const r = await runtime(t, body => {
    if (body.messages.at(-1).role === "tool") return { content: "finished", delayMs: lastUser(body) === "slow" ? 1500 : 0 };
    return lastUser(body) === "slow" ? toolCall("js_exec", { code: "return 2" }) : { content: `reply ${lastUser(body)}` };
  }, { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "first");
  await until(async () => await indexedOf(r, agent) === 2, "the first turn to be indexed separately", 20_000);
  await r.prompt(agent, "second");
  // An index behind what the agent's runs reported (its stop could not write the last chunks) reads the rest from the
  // journal; the agent's next start indexes it.
  await until(async () => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed === 4, "the stopping agent to index its turns", 20_000);
  await r.db.query("delete from agent_history_chunks where agent = $1", [agent]);
  await r.db.query("update agent_history_index set indexed = 0 where agent = $1", [agent]);
  const rebuilt = await r.call(`/v1/agents/${agent}/history?limit=2`);
  assert.deepEqual(rebuilt.json.entries.map((entry: any) => entry.index), [2, 3]);
  assert.equal(rebuilt.json.next, 2);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/history?before=2&limit=2`)).json.entries.map((entry: any) => entry.message.role), ["user", "assistant"]);
  assert.equal(await indexedOf(r, agent), 0);

  // While a turn runs, its finished messages are on the newest page, at their indexes.
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
  await until(async () => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0].indexed === 8, "the settled turn to be indexed as the agent stops", 20_000);

  // Deleting the agent purges its chunks with everything else.
  assert.equal((await r.call(`/v1/agents/${agent}`, { method: "DELETE" })).status, 200);
  await until(async () => (await r.db.query("select count(*)::int as count from agent_history_chunks where agent = $1", [agent])).rows[0].count === 0, "the chunks to be purged");
  await until(async () => !(await readdir(join(r.root, "sessions", agent, "history")).catch(() => [])).length, "the chunk blobs to be purged");
});


test("a chunk a failed writer left in Storage is never served under another writer's row", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-blobs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const index = new HistoryIndex(db, fileStorage(root));
  const agent = `client_${"c".repeat(40)}`;
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, 't', '{}', 'a', 'general', 'm', null, false, 1)", [agent]);
  const lost = { actor: agent, session: "00000000-0000-0000-0000-000000000000", epoch: 1 } as any;
  // Its blob lands, then its claim turns out lost: no row.
  await assert.rejects(index.write(agent, lost, { start: 0, messages: [user("stale"), assistant("stale")], turns: [0] }));
  assert.equal(await index.write(agent, undefined, { start: 0, messages: [user("fresh"), assistant("fresh")], turns: [0] }), 2);
  const page = await index.page(agent, { limit: 10 });
  assert.deepEqual(page.entries.map(entry => (entry.message as any).content[0].text), ["fresh", "fresh"]);
});

test("stopping many agents waits once for their history, not once per agent", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-stop-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const provider = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [content, finish] of [[{ role: "assistant", content: "hi" }, null], [{}, "stop"]]) res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: content, finish_reason: finish }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  provider.listen(0, "127.0.0.1"); await once(provider, "listening");
  t.after(async () => { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); });
  const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>;
  // A chunk store that stalls, as S3 or the database might.
  const storage = fileStorage(join(root, "data"));
  const stall = new Promise<never>(() => {});
  const writeBlob = storage.writeBlob.bind(storage);
  storage.writeBlob = (key, data) => key.includes("/history/") ? stall : writeBlob(key, data);
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, historyFlushMs: 400 });
  const sessions = new ClientSessions(supervisor, { db, storage, secret: "history-stop-secret-with-32-characters", apiKeyFor: () => "fixture-only" });
  t.after(async () => { await supervisor.close(); });
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const { id } = await sessions.create([], { model }, `agent-${index}`, {}, "default");
    await sessions.submit(id, "default", { id: "turn", method: "prompt", params: { text: "hi" } });
    ids.push(id);
  }
  for (const id of ids) await until(async () => (await sessions.stateFor(id, "default")).requests.some(record => record.id === "turn" && record.state === "completed"), "the turn");
  const started = Date.now();
  await sessions.close();
  const took = Date.now() - started;
  assert.ok(took < 5 * 400, `closing waited ${took} ms: once for all, not ${5 * 400} ms`);
});

test("a deleted agent's history is never written again, so a purge leaves nothing behind", async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "history-purge-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = fileStorage(root);
  const index = new HistoryIndex(db, storage);
  const agent = `client_${"d".repeat(40)}`;
  await db.query("insert into agents (id, tenant, header, name, type, model, expires_at, revoked, revision) values ($1, 't', '{}', 'a', 'general', 'm', null, false, 1)", [agent]);
  await index.begin(agent);
  assert.equal(await index.write(agent, undefined, { start: 0, messages: [user("q"), assistant("a")], turns: [0] }), 2);
  // Deleted, then purged; a stop's late flush (or a page's catch-up) comes after.
  await db.query("update agents set revoked = true where id = $1", [agent]);
  await index.remove(agent, db);
  await assert.rejects(index.write(agent, undefined, { start: 0, messages: [user("q"), assistant("a")], turns: [0] }), /deleted/);
  assert.equal((await db.query("select count(*)::int as count from agent_history_chunks where agent = $1", [agent])).rows[0].count, 0);
  assert.equal((await db.query("select count(*)::int as count from agent_history_index where agent = $1", [agent])).rows[0].count, 0);
  assert.deepEqual(await readdir(join(root, "sessions", agent, "history")).catch(() => []), []);
});

test("an index far behind is paged from the journal, and caught up from it at the agent's next start", { timeout: 120_000 }, async t => {
  const r = await runtime(t, body => ({ content: `${lastUser(body)} ${"x".repeat(30_000)}` }), { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const stopped = () => until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop", 30_000);
  for (let turn = 0; turn < 10; turn++) await r.prompt(agent, `q${turn}`);
  await stopped();
  // As if its stops wrote none of it: 10 turns make 300 KB unindexed.
  await until(async () => await indexedOf(r, agent) === 20, "the stopping agent to index its turns", 30_000);
  await r.db.query("delete from agent_history_chunks where agent = $1", [agent]);
  await r.db.query("update agent_history_index set indexed = 0 where agent = $1", [agent]);
  const page = (await r.call(`/v1/agents/${agent}/history?limit=4`)).json;
  assert.equal(page.total, 20);
  assert.deepEqual(page.entries.map((entry: any) => entry.index), [16, 17, 18, 19]);

  // An index that lags that far behind is caught up by the agent's next start, from its journal.
  await r.prompt(agent, "again");
  await until(async () => await indexedOf(r, agent) === 22, "the lagging index to catch up as the agent runs and stops", 30_000);
  const whole = (await r.call(`/v1/agents/${agent}/history`)).json.messages;
  const paged: any[] = [];
  for (let before: number | null | undefined; before !== null;) {
    const page = (await r.call(`/v1/agents/${agent}/history?limit=100${before !== undefined ? `&before=${before}` : ""}`)).json;
    paged.unshift(...page.entries);
    before = page.next;
  }
  const head = (message: any) => (message.content[0].text as string).slice(0, 10);
  assert.deepEqual(paged.map(entry => head(entry.message)), whole.map(head), "every page of about 4 MB, together, is the whole history");
});

test("an agent without an index row pages from its journal, and gets one at its next start, indexed from its journal", async t => {
  const r = await runtime(t, body => ({ content: `reply ${lastUser(body)}` }), { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "one");
  await until(async () => await indexedOf(r, agent) === 2, "the stopping agent to index its turn", 20_000);
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop", 20_000);
  // As if its create failed before its index row, or it predates the index (its header without the old mark).
  await r.db.query("delete from agent_history_chunks where agent = $1", [agent]);
  await r.db.query("delete from agent_history_index where agent = $1", [agent]);
  await r.db.query("update agents set header = (header::jsonb - 'history')::json where id = $1", [agent]);
  await sleep(2500);
  // Until then, unloaded, its pages come from its journal.
  assert.deepEqual((await r.call(`/v1/agents/${agent}/history?limit=2`)).json.entries.map((entry: any) => entry.index), [0, 1]);
  await r.prompt(agent, "two");
  await until(async () => await indexedOf(r, agent) === 4, "the agent to be indexed after all", 20_000);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/history?limit=1&before=2`)).json.entries.map((entry: any) => entry.index), [0, 1]);
});
