import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { RequestRecord } from "../shared/client-protocol.ts";
import { memoryStorage } from "../shared/storage.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Ownership } from "../src/ownership.ts";
import { getModel } from "../src/pi-catalog.ts";
import { openPiStorage, purgePiStorage } from "../src/pi-durable/storage.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { Transcript, type TranscriptRecord } from "../src/transcript.ts";
import { testDatabase } from "./database.ts";

const database = testDatabase();
const model = { ...getModel("openai", "gpt-5.5-pro")!, baseUrl: "http://127.0.0.1:9/v1" };

async function fixture(t: TestContext) {
  const { db } = await database;
  const directory = await mkdtemp(join(tmpdir(), "pi-spend-recovery-"));
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const ownership = new Ownership(db, { node: `http://pi-spend-${randomUUID()}` });
  await ownership.start();
  const nodes: { sessions: ClientSessions; supervisor: AgentSupervisor }[] = [];
  function open() {
    const supervisor = new AgentSupervisor(directory, { storage, db, hosting: "inline" });
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
  // A session the legacy engine kept, its turn left open: its log, and no Pi storage.
  await purgePiStorage(db, id);
  const log = storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id));
  const transcript = new Transcript(log);
  await transcript.load();
  await transcript.setActive(true);
  await transcript.push({ role: "user", content: "interrupted request", requestId: "interrupted", timestamp: 1 } as any);
  await log.close();
  async function request(changes: Partial<RequestRecord>) {
    const journal = storage.log(`client-sessions/${id}.journal`);
    await journal.read();
    journal.append({ t: "request", record: { id: "interrupted", method: "prompt", fingerprint: "fixture", state: "running", began: 1, startedAt: 1, ...changes } });
    await journal.flush(true);
    await journal.close();
  }
  t.after(async () => {
    for (const node of nodes.reverse()) { await node.sessions.close(); await node.supervisor.close(); }
    await ownership.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { id, db, open, request };
}

test("closing a deferred legacy turn with an empty Pi namespace never resolves model credentials", async t => {
  const f = await fixture(t);
  await f.request({ abortedAt: 2 });
  const empty = await openPiStorage({ sessionId: f.id, directory: "unused", db: f.db });
  await empty.close(context);
  const node = f.open();
  assert.equal(await node.supervisor.hasDurableHistory(f.id), false);
  node.sessions.options.apiKeyFor = () => { throw new Error("credentials unavailable and unnecessary for synthetic repair"); };
  assert.deepEqual((await node.sessions.inspect(f.id, "default")).spendLimit, { usd: 10, spent: 0 });
  assert.equal(node.supervisor.agents.has(f.id), false);
});

test("starting an agent whose history is only in the legacy format fails with 409 AGENT_NOT_MIGRATED, and writes nothing", async t => {
  const f = await fixture(t);
  const node = f.open();
  await node.sessions.inspect(f.id, "default");
  const session = node.sessions.sessions.get(f.id)!;
  await assert.rejects((node.sessions as any).ensureStarted(session), (error: any) => error.status === 409 && error.code === "AGENT_NOT_MIGRATED" && /legacy format/.test(error.message));
  assert.equal(node.supervisor.agents.has(f.id), false);
  assert.equal(await node.supervisor.hasDurableHistory(f.id), false, "no Pi storage was made for it");
});
