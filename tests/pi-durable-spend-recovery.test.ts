import { NativeTranscript } from "../src/pi-durable/transcript.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { EntryId } from "@earendil-works/pi-durable";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { memoryStorage } from "../shared/storage.ts";
import { ClientSessions, MAX_RESUMES } from "../src/client-sessions.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Ownership } from "../src/ownership.ts";
import { getModel } from "../src/pi-catalog.ts";
import { LEGACY_CONVERSATION_ID } from "../src/pi-durable/migration.ts";
import { openPiStorage } from "../src/pi-durable/storage.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { Transcript, type TranscriptRecord } from "../src/transcript.ts";
import { testDatabase } from "./database.ts";

const database = testDatabase();
const model = { ...getModel("openai", "gpt-5.5-pro")!, baseUrl: "http://127.0.0.1:9/v1" };
const response = {
  role: "assistant" as const, api: "openai-completions" as const, provider: "openai", model: "gpt-5.5-pro",
  content: [{ type: "text" as const, text: "native committed response" }], stopReason: "stop" as const, timestamp: 1,
  usage: { input: 5000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 5000,
    // The stored model/provider cost must not override the platform catalog's $0.15 price.
    cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 } },
};

async function fixture(t: TestContext, engine: "legacy" | "pi-durable" = "pi-durable") {
  const { db } = await database;
  const directory = await mkdtemp(join(tmpdir(), "pi-spend-recovery-"));
  const tail = postgresTail(db, { unfenced: true });
  let loseSpendAck = false;
  const storage = memoryStorage({ ...tail, async append(...args: Parameters<typeof tail.append>) {
    const written = await tail.append(...args);
    if (written && loseSpendAck && args[0].endsWith("/transcript") && args[3]?.length) {
      loseSpendAck = false;
      throw new Error("fixture lost commit acknowledgement");
    }
    return written;
  } });
  const ownership = new Ownership(db, { node: `http://pi-spend-${randomUUID()}` });
  await ownership.start();
  const nodes: { sessions: ClientSessions; supervisor: AgentSupervisor }[] = [];
  function open() {
    const supervisor = new AgentSupervisor(directory, { storage, db, hosting: "inline", engine });
    const sessions = new ClientSessions(supervisor, { db, storage, prefix: "client-sessions/", ownership,
      secret: "pi-spend-recovery-test-secret-32-characters", apiKeyFor: () => ({ key: "fixture", platform: true }), catalogPriced: async () => true });
    const node = { sessions, supervisor };
    nodes.push(node);
    return node;
  }
  const first = open();
  const { id } = await first.sessions.create([], { model, codeMode: false, fileTools: false }, randomUUID(), {}, "default", undefined, undefined, undefined, undefined, { spendLimit: 10 });
  await first.sessions.sessions.get(id)?.starting;
  assert.equal(first.supervisor.agents.has(id), true);
  await first.sessions.close();
  await first.supervisor.close();
  // Simulate the two stores after a crash: the native response committed, its public projection did not.
  const log = storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id));
  const transcript = new Transcript(log);
  await transcript.load();
  await transcript.setActive(true);
  await transcript.push({ role: "user", content: "interrupted request", requestId: "interrupted", timestamp: 1 } as any);
  await log.close();
  if (engine === "pi-durable") {
    const native = await openPiStorage({ sessionId: id, directory: join(directory, id), db });
    // Exercise recovery from the older compatibility adapter, before a native
    // host snapshot and atomic usage receipts existed.
    await (await NativeTranscript.open(native))?.disable();
    const entryId = await native.mintId<EntryId>();
    await native.commit([{ type: "entry", value: { id: entryId, conversationId: LEGACY_CONVERSATION_ID, kind: "pi.assistant", model: [response] as any } }], context);
    await native.close(context);
  }
  async function request(changes: Partial<RequestRecord>) {
    const journal = storage.log(`client-sessions/${id}.journal`);
    await journal.read();
    journal.append({ t: "request", record: { id: "interrupted", method: "prompt", fingerprint: "fixture", state: "running", began: 1, startedAt: 1, ...changes } });
    await journal.flush(true);
    await journal.close();
  }
  const spent = async () => Number((await db.query("select spent from agent_spend_limits where agent = $1", [id])).rows[0].spent);
  const projected = async () => {
    const log = storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id));
    try { return (await log.read()).filter(record => record.t === "message" && record.message.role === "assistant"); }
    finally { await log.close(); }
  };
  t.after(async () => {
    for (const node of nodes.reverse()) { await node.sessions.close(); await node.supervisor.close(); }
    await ownership.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { id, db, open, request, spent, projected, loseAck: () => { loseSpendAck = true; } };
}

for (const reason of ["aborted", "past resumes"] as const) test(`stopped ${reason} turn recovers native response spend once before session load`, async t => {
  const f = await fixture(t);
  await f.request(reason === "aborted" ? { abortedAt: 2 } : { resumes: MAX_RESUMES });
  const node = f.open();
  const view = await node.sessions.inspect(f.id, "default");
  assert.deepEqual(view.spendLimit, { usd: 10, spent: 0.15 }, "the pre-start pricing and in-memory spend both include the recovered response");
  assert.equal(await f.spent(), 0.15);
  assert.equal((await f.projected()).length, 1);
  assert.equal(node.supervisor.agents.has(f.id), false, "settling the abandoned turn never starts a model host");
  await (node.sessions as any).closeTurn(node.sessions.sessions.get(f.id));
  assert.equal(await f.spent(), 0.15, "a repeated stopped-turn close cannot bill the recovered entry again");
  await node.sessions.close();
  const reopened = f.open();
  assert.deepEqual((await reopened.sessions.inspect(f.id, "default")).spendLimit, { usd: 10, spent: 0.15 });
  assert.equal((await f.projected()).length, 1);
});

test("a failed recovered-spend transaction projects and charges neither, then retry projects and charges once", async t => {
  const f = await fixture(t);
  await f.request({ abortedAt: 2 });
  const trigger = `reject_pi_spend_${randomUUID().replaceAll("-", "")}`;
  await f.db.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin raise exception 'fixture spend transaction rejected'; end $$`);
  await f.db.query(`create trigger ${trigger} before update on agent_spend_limits for each row when (old.agent = '${f.id}') execute function ${trigger}()`);
  try {
    const node = f.open();
    await assert.rejects(node.sessions.inspect(f.id, "default"), /fixture spend transaction rejected/);
    assert.equal(await f.spent(), 0);
    assert.equal((await f.projected()).length, 0, "a spend failure rolls back the same transcript insert");
    await f.db.query(`drop trigger ${trigger} on agent_spend_limits`);
    assert.deepEqual((await node.sessions.inspect(f.id, "default")).spendLimit, { usd: 10, spent: 0.15 });
    assert.equal(await f.spent(), 0.15);
    assert.equal((await f.projected()).length, 1);
    await (node.sessions as any).closeTurn(node.sessions.sessions.get(f.id));
    assert.equal(await f.spent(), 0.15);
  } finally {
    await f.db.query(`drop trigger if exists ${trigger} on agent_spend_limits`);
    await f.db.query(`drop function ${trigger}()`);
  }
});

test("a resumed run whose host fails to start closes and charges its native tail exactly once", async t => {
  const f = await fixture(t);
  await f.request({ resumes: 0 });
  const node = f.open();
  node.supervisor.start = async () => { throw new Error("fixture host unavailable"); };
  await node.sessions.inspect(f.id, "default");
  await node.sessions.sessions.get(f.id)!.runs;
  const view = await node.sessions.inspect(f.id, "default");
  assert.equal(view.requests.find(request => request.id === "interrupted")?.state, "completed");
  assert.deepEqual(view.spendLimit, { usd: 10, spent: 0.15 });
  assert.equal(await f.spent(), 0.15);
  assert.equal((await f.projected()).length, 1);
});

test("a lost recovery commit acknowledgement never charges its native response twice", async t => {
  const f = await fixture(t);
  await f.request({ abortedAt: 2 });
  const node = f.open();
  f.loseAck();
  await assert.rejects(node.sessions.inspect(f.id, "default"), /fixture lost commit acknowledgement/);
  assert.equal(await f.spent(), 0.15, "the commit was durable before its acknowledgement was lost");
  assert.equal((await f.projected()).length, 1);
  assert.deepEqual((await node.sessions.inspect(f.id, "default")).spendLimit, { usd: 10, spent: 0.15 });
  assert.equal(await f.spent(), 0.15);
  assert.equal((await f.projected()).length, 1);
});

test("closing a deferred legacy turn with an empty Pi namespace never resolves model credentials", async t => {
  const f = await fixture(t, "legacy");
  await f.request({ abortedAt: 2 });
  const empty = await openPiStorage({ sessionId: f.id, directory: "unused", db: f.db });
  await empty.close(context);
  const node = f.open();
  assert.equal(await node.supervisor.hasDurableHistory(f.id), false);
  node.sessions.options.apiKeyFor = () => { throw new Error("credentials unavailable and unnecessary for synthetic repair"); };
  assert.deepEqual((await node.sessions.inspect(f.id, "default")).spendLimit, { usd: 10, spent: 0 });
  assert.equal(node.supervisor.agents.has(f.id), false);
});

test("host init recovery refreshes cached spend even when the recovered native response has no live event", async t => {
  const f = await fixture(t);
  // No abandoned request forces closeTurn: the host itself performs reconciliation when it starts.
  const node = f.open();
  await node.sessions.inspect(f.id, "default");
  const session = node.sessions.sessions.get(f.id)!;
  assert.equal(session.spend?.spent, 0);
  await (node.sessions as any).ensureStarted(session);
  assert.equal(await f.spent(), 0.15);
  assert.equal(session.spend?.spent, 0.15, "the next run's spend gate sees the committed recovery cost");
  assert.equal((await f.projected()).length, 1);
});
