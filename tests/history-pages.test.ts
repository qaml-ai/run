import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { boundaries, chunksOf, HistoryIndex } from "../src/history-pages.ts";
import { fileStorage } from "../shared/storage.ts";
import { testDatabase } from "./database.ts";
import { Transcript, type TranscriptRecord } from "../src/transcript.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { AgentRuntime, memoryJournalStore } from "../clients/typescript.ts";
import { lastUser, OPERATOR, OTHER_OPERATOR, runtime, sleep, toolCall, until } from "./runtime-server.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }) as unknown as AgentMessage;
const memoryLog = (records: TranscriptRecord[]): AppendLog<TranscriptRecord> => ({
  read: async () => records, append: record => { records.push(record); }, flush: async () => {}, rewrite: async () => {}, appendedSinceRewrite: 0, close: async () => {},
});

const indexedOf = async (r: { db: any }, agent: string) => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed as number | undefined;

test("a transcript keeps what the history index lacks, retractions included, and chunks it at turn starts", async () => {
  const log = memoryLog([
    { t: "turn", active: true }, { t: "message", message: user("a") }, { t: "message", message: assistant("A") }, { t: "turn", active: false },
    { t: "turn", active: true }, { t: "message", message: user("b") }, { t: "message", message: assistant("error") }, { t: "retract" }, { t: "message", message: assistant("B") }, { t: "turn", active: false },
    // A resumed run starts without a user message: no turn begins there.
    { t: "turn", active: true }, { t: "message", message: user("c") }, { t: "turn", active: false }, { t: "turn", active: true }, { t: "message", message: assistant("C") }, { t: "turn", active: false },
  ]);
  const transcript = new Transcript(log, 2);
  await transcript.load();
  const backlog = transcript.backlog!;
  assert.equal(backlog.from, 2);
  assert.deepEqual(backlog.messages.map(message => (message as any).content[0].text), ["b", "B", "c", "C"]);
  assert.deepEqual(boundaries(backlog.from, backlog.messages, backlog.turns), [2, 4]);
  assert.deepEqual(chunksOf(backlog).map(chunk => [chunk.start, chunk.messages.length, chunk.turns]), [[2, 4, [2, 4]]]);
  transcript.indexed(4);
  assert.deepEqual([backlog.from, backlog.messages.length, backlog.turns], [4, 2, [4, 5]]);

  // Chunks end at the latest turn start that keeps them under the bound; one turn larger than it is split between messages.
  const big = "x".repeat(400_000);
  const sized = new Transcript(memoryLog([
    { t: "turn", active: true }, { t: "message", message: user(big) }, { t: "message", message: assistant(big) }, { t: "turn", active: false },
    { t: "turn", active: true }, { t: "message", message: user(big) }, { t: "message", message: assistant(big) }, { t: "message", message: assistant(big) }, { t: "message", message: assistant(big) }, { t: "turn", active: false },
  ]), 0);
  await sized.load();
  assert.deepEqual(chunksOf(sized.backlog!).map(chunk => [chunk.start, chunk.messages.length, chunk.turns]), [[0, 2, [0]], [2, 2, [2]], [4, 2, []]]);
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

  // The agent indexes its settled turns as it stops; then pages come from chunks alone, and the log is not read.
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop", 20_000);
  await until(async () => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed === 16, "the stopping agent to index its turns");
  await rm(join(r.root, "sessions", agent, "transcript.jsonl"));
  await check();

  // The SDK pages the same way, with the agent's own token.
  const client = await new AgentRuntime({ url: r.base, apiKey: OPERATOR, journalStore: memoryJournalStore() }).connectAgent(session, { tools: {} });
  t.after(() => client.close());
  const newest = await client.historyPage({ limit: 3 });
  assert.deepEqual(newest.entries.map(entry => entry.index), [12, 13, 14, 15]);
  assert.deepEqual((await client.historyPage({ before: newest.next!, limit: 3 })).entries.map(entry => entry.index), [8, 9, 10, 11]);

  // Another tenant's token gets no page.
  assert.equal((await r.call(`/v1/agents/${agent}/history?limit=3`, { token: OTHER_OPERATOR })).status, 404);
});

test("the newest page has the running turn; an agent without an index gets pages from its log and is never indexed; purging removes its chunks", async t => {
  const r = await runtime(t, body => {
    if (body.messages.at(-1).role === "tool") return { content: "finished", delayMs: lastUser(body) === "slow" ? 1500 : 0 };
    return lastUser(body) === "slow" ? toolCall("js_exec", { code: "return 2" }) : { content: `reply ${lastUser(body)}` };
  }, { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "first");
  await r.prompt(agent, "second");
  // Undo the index of the stopped agent, as for one from before the index: its pages come from its log, and it stays unindexed.
  await until(async () => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed === 4, "the stopping agent to index its turns", 20_000);
  await r.db.query("delete from agent_history_chunks where agent = $1", [agent]);
  await r.db.query("delete from agent_history_index where agent = $1", [agent]);
  const rebuilt = await r.call(`/v1/agents/${agent}/history?limit=2`);
  assert.deepEqual(rebuilt.json.entries.map((entry: any) => entry.index), [2, 3]);
  assert.equal(rebuilt.json.next, 2);
  assert.equal(await indexedOf(r, agent), undefined);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/history?before=2&limit=2`)).json.entries.map((entry: any) => entry.message.role), ["user", "assistant"]);
  // An index behind what the agent's runs reported (its stop could not write the last chunks) reads the rest from the log;
  // the agent's next start indexes it.
  await r.db.query("insert into agent_history_index (agent, indexed) values ($1, 0)", [agent]);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/history?limit=2`)).json.entries.map((entry: any) => entry.index), [2, 3]);
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

test("a transcript's backlog past its bound leaves what it holds to the log, and keeps the rest", async () => {
  const records: TranscriptRecord[] = [];
  for (let turn = 0; turn < 12; turn++) records.push({ t: "turn", active: true }, { t: "message", message: user(`q${turn}`) }, { t: "message", message: assistant("x".repeat(1_000_000)) }, { t: "turn", active: false });
  const transcript = new Transcript(memoryLog(records), 0);
  await transcript.load();
  const backlog = transcript.backlog!;
  assert.equal(backlog.from, 0, "the index still has to reach back to where it ends");
  assert.ok(backlog.kept > 0 && backlog.kept < 24 && backlog.bytes <= 8_000_000, "memory holds only what came after");
  assert.equal(backlog.kept + backlog.messages.length, 24);
  transcript.indexed(backlog.kept + 1);
  assert.deepEqual([backlog.from, backlog.kept, backlog.kept + backlog.messages.length], [backlog.kept, backlog.kept, 24]);
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

test("more unindexed history than a backlog holds is still paged, and indexed from the log rather than given up", { timeout: 120_000 }, async t => {
  const r = await runtime(t, body => ({ content: `${lastUser(body)} ${"x".repeat(950_000)}` }), { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const stopped = () => until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop", 30_000);
  await stopped();
  // As for an agent from before the index (no row, and a header without the mark), once its session has unloaded:
  // its process keeps no backlog, and 10 turns make 9.5 MB unindexed.
  await r.db.query("delete from agent_history_index where agent = $1", [agent]);
  await r.db.query("update agents set header = (header::jsonb - 'history')::json where id = $1", [agent]);
  await sleep(2500);
  for (let turn = 0; turn < 10; turn++) await r.prompt(agent, `q${turn}`);
  await stopped();
  const page = (await r.call(`/v1/agents/${agent}/history?limit=4`)).json;
  assert.equal(page.total, 20);
  assert.deepEqual(page.entries.map((entry: any) => entry.index), [16, 17, 18, 19]);
  assert.equal(await indexedOf(r, agent), undefined);

  // An index that lags that far behind is caught up by the agent's next start, from its log.
  await r.db.query("insert into agent_history_index (agent, indexed) values ($1, 0)", [agent]);
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

test("an agent made with a history index whose index row was never written gets it at its next start", async t => {
  const r = await runtime(t, body => ({ content: `reply ${lastUser(body)}` }), { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await until(async () => !(await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).running, "the idle agent to stop", 20_000);
  // As if its create wrote the agent but failed before its index row.
  await r.db.query("delete from agent_history_index where agent = $1", [agent]);
  await r.prompt(agent, "one");
  await until(async () => await indexedOf(r, agent) === 2, "the agent to be indexed after all", 20_000);
});
