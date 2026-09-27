import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { boundaries, chunksOf } from "../src/history-pages.ts";
import { Transcript, type TranscriptRecord } from "../src/transcript.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { AgentRuntime, memoryJournalStore } from "../clients/typescript.ts";
import { lastUser, OPERATOR, OTHER_OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }) as AgentMessage;
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 }) as unknown as AgentMessage;
const memoryLog = (records: TranscriptRecord[]): AppendLog<TranscriptRecord> => ({
  read: async () => records, append: record => { records.push(record); }, flush: async () => {}, rewrite: async () => {}, appendedSinceRewrite: 0, close: async () => {},
});

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

test("the newest page has the running turn; an agent never indexed is indexed at its first page; purging removes its chunks", async t => {
  const r = await runtime(t, body => {
    if (body.messages.at(-1).role === "tool") return { content: "finished", delayMs: lastUser(body) === "slow" ? 1500 : 0 };
    return lastUser(body) === "slow" ? toolCall("js_exec", { code: "return 2" }) : { content: `reply ${lastUser(body)}` };
  }, { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "first");
  await r.prompt(agent, "second");
  // Undo the index of the stopped agent, as for one from before the index: its first page indexes it from the log.
  await until(async () => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed === 4, "the stopping agent to index its turns", 20_000);
  await r.db.query("delete from agent_history_chunks where agent = $1", [agent]);
  await r.db.query("delete from agent_history_index where agent = $1", [agent]);
  const rebuilt = await r.call(`/v1/agents/${agent}/history?limit=2`);
  assert.deepEqual(rebuilt.json.entries.map((entry: any) => entry.index), [2, 3]);
  assert.equal(rebuilt.json.next, 2);
  assert.equal((await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0].indexed, 4);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/history?before=2&limit=2`)).json.entries.map((entry: any) => entry.message.role), ["user", "assistant"]);
  // An index behind what the agent's runs reported (its stop could not write the last chunks) catches up the same way.
  await r.db.query("delete from agent_history_chunks where agent = $1", [agent]);
  await r.db.query("update agent_history_index set indexed = 0 where agent = $1", [agent]);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/history?limit=2`)).json.entries.map((entry: any) => entry.index), [2, 3]);
  assert.equal((await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0].indexed, 4);

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
