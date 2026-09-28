import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import type { Api, Model } from "@earendil-works/pi-ai";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Ownership } from "../src/ownership.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { testDatabase } from "./database.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>;

/** A node: its own ownership, supervisor and sessions over shared storage and database. */
async function node(t: Context, db: pg.Pool, storage: ReturnType<typeof memoryStorage>, name: string) {
  const root = await mkdtemp(join(tmpdir(), "purge-"));
  const ownership = new Ownership(db, { node: `http://${name}` });
  await ownership.start();
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage });
  const sessions = new ClientSessions(supervisor, { db, storage, prefix: "client-sessions/", ownership, secret: "purge-test-secret-with-32-characters!", apiKeyFor: () => "fixture-only" });
  t.after(async () => {
    await sessions.close(); await supervisor.close(); await ownership.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { sessions, supervisor };
}

/** Objects (segments, snapshots, blobs) stored for an agent's logs. */
const objectsOf = (storage: ReturnType<typeof memoryStorage>, id: string) =>
  [...storage.logs].filter(([key]) => key.includes(id)).reduce((count, [, objects]) => count + objects.size, 0);

async function execute(sessions: ClientSessions, id: string, request: string) {
  await sessions.submit(id, "default", { id: request, method: "execute", params: { code: "return 1" } });
  for (let tries = 0; sessions.sessions.get(id)?.requests.get(request)?.state !== "completed" || sessions.inFlight(); tries++) {
    assert.ok(tries < 1000, `${request} finished`);
    await sleep(5);
  }
}

test("deleting an agent purges everything it stored and leaves a tombstone that keeps its id", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  // Unfenced: the test writes a transcript itself, with no claim.
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const { sessions } = await node(t, db, storage, "a");
  const { id } = await sessions.create([], { model }, "doomed", {}, "default");
  for (let n = 0; n < 3; n++) await execute(sessions, id, `run-${n}`);
  await sessions.releaseIdle();
  // A transcript in Storage (with a blob-sized record), and tail rows still waiting for compaction.
  const transcript = storage.log<unknown>(AgentSupervisor.transcriptKey(id));
  await transcript.read();
  transcript.append({ t: "message", message: { role: "user", content: "x".repeat(100_000) } }); await transcript.flush(true);
  await transcript.close();
  const pending = storage.log<unknown>(AgentSupervisor.transcriptKey(id));
  await pending.read();
  pending.append({ t: "message", message: { role: "user", content: "later" } }); await pending.flush(true);
  assert.ok(objectsOf(storage, id) >= 2, "journal and transcript objects exist");
  await db.query("insert into schedules (id, agent, tenant, text, due_at, created_at) values ($1, $2, 'default', 'wake', $3, $3)", [randomUUID(), id, Date.now() + 60_000]);
  await db.query("insert into channel_agents (agent, channel, tenant, conversation) values ($1, 'ch_1', 'default', 'c1')", [id]);
  await db.query("insert into channel_conversations (channel, conversation, agent, generation) values ('ch_1', 'c1', $1, 0)", [id]);
  await db.query("insert into volume_watchers (volume, agent, tenant, mounts) values ('vol_x', $1, 'default', '[]')", [id]);

  assert.equal(await sessions.destroyAgent(id, "default"), true);
  await sessions.sweep();
  assert.equal(objectsOf(storage, id), 0, "no Storage objects left");
  const count = async (sql: string) => Number((await db.query(sql, [id])).rows[0].count);
  assert.equal(await count("select count(*) as count from log_records where actor = $1 or log_key like '%' || $1 || '%'"), 0);
  for (const table of ["schedules", "channel_agents", "channel_conversations", "volume_watchers"]) assert.equal(await count(`select count(*) as count from ${table} where agent = $1`), 0, table);
  const [row] = (await db.query("select header, revoked, purged_at from agents where id = $1", [id])).rows;
  assert.equal(row.revoked, true);
  assert.ok(row.purged_at > 0);
  assert.equal(row.header.purged, true);
  assert.equal("config" in row.header || "definitions" in row.header, false, "the tombstone keeps only identity");

  // The id stays taken and the agent is gone; its key makes a fresh agent.
  assert.notEqual((await sessions.create([], { model }, "doomed", {}, "default")).id, id);
  await assert.rejects(sessions.inspect(id, "default"), (error: any) => error.status === 404);
  assert.equal(await sessions.destroyAgent(id, "default"), false);
  assert.equal(await sessions.purge(), 0, "purging again finds nothing");
  assert.equal(objectsOf(storage, id), 0);
});

test("the sweep purges agents revoked before it existed and agents whose TTL expired, each once across nodes", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const a = await node(t, db, storage, "a");
  const b = await node(t, db, storage, "b");
  const revoked: string[] = [], expiring: string[] = [];
  for (let n = 0; n < 4; n++) {
    const { id } = await a.sessions.create([], { model }, `revoked-${n}`, {}, "default");
    await execute(a.sessions, id, "work");
    revoked.push(id);
  }
  for (let n = 0; n < 3; n++) {
    const { id } = await a.sessions.create([], { model }, `expiring-${n}`, {}, "default", 1_500);
    await execute(a.sessions, id, "work");
    expiring.push(id);
  }
  const { id: live } = await a.sessions.create([], { model }, "live", {}, "default");
  await execute(a.sessions, live, "work");
  // Revoked as DELETE used to leave them: the header only, all data kept.
  for (const id of revoked) await a.sessions.remove(id);
  await a.sessions.releaseIdle();
  await sleep(1_600);
  for (const id of [...revoked, ...expiring, live]) assert.ok(objectsOf(storage, id) > 0);

  let purged = 0;
  for (let round = 0; round < 10; round++) {
    const counts = await Promise.all([a.sessions.purge(2), b.sessions.purge(2)]);
    purged += counts[0] + counts[1];
    if (!counts[0] && !counts[1]) break;
  }
  assert.equal(purged, revoked.length + expiring.length, "each agent purged once");
  for (const id of [...revoked, ...expiring]) assert.equal(objectsOf(storage, id), 0, id);
  const { rows } = await db.query("select id, revoked, purged_at from agents order by id");
  for (const row of rows) {
    if (row.id === live) assert.equal(row.purged_at, null, "a live agent is untouched");
    else assert.ok(row.revoked && row.purged_at > 0, row.id);
  }
  assert.ok(objectsOf(storage, live) > 0);
  assert.equal((await a.sessions.inspect(live, "default")).requests.length, 1);
});
