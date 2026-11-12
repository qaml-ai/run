import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { Client } from "pg";
import type { Api, Model } from "@earendil-works/pi-ai";
import { memoryStorage } from "../shared/storage.ts";
import { INBOX_CHANNEL } from "../src/inputs.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Ownership } from "../src/ownership.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { Triggers } from "../src/triggers.ts";
import { HookAdmission, handleHook } from "../src/core/trigger-ingress.ts";
import { transaction } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

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

/** A second connection, listening on the inbox channel as a node's inbox watchers do. */
async function listening(url: string) {
  const client = new Client({ connectionString: url });
  await client.connect();
  const heard: string[] = [];
  client.on("notification", message => { if (message.channel === INBOX_CHANNEL) heard.push(message.payload ?? ""); });
  await client.query(`listen "${INBOX_CHANNEL}"`);
  return { heard, close: () => client.end() };
}

/** Objects (segments, snapshots, blobs) stored for an agent's logs. */
const objectsOf = (storage: ReturnType<typeof memoryStorage>, id: string) =>
  [...storage.logs].filter(([key]) => key.includes(id)).reduce((count, [, objects]) => count + objects.size, 0);

async function execute(sessions: ClientSessions, id: string, request: string) {
  await sessions.submit(id, "default", { id: request, method: "execute", params: { code: "return 1" } });
  await until(() => sessions.sessions.get(id)?.requests.get(request)?.state === "completed" && !sessions.inFlight(), `${request} finished`, 30_000);
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
  // An email thread it answered, and one of another agent on the same channel, which stays.
  await db.query("insert into channel_conversations (channel, conversation, agent, generation) values ('ch_1', 'c2', 'client_other', 0)");
  for (const conversation of ["c1", "c2"]) {
    await db.query("insert into email_threads (conversation, channel, reply_to, subject, refs, last_message, updated_at) values ($1, 'ch_1', 'person@example.com', 'Private subject', '[]', 'm@x', 1)", [conversation]);
    await db.query("insert into email_messages (channel, message_id, conversation, created_at) values ('ch_1', $1, $2, 1)", [`${conversation}@x`, conversation]);
  }

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
  assert.deepEqual(row.header, { version: 3, id, revoked: true, purged: true }, "the tombstone keeps only the id");
  const tombstone = (await db.query("select tenant, name, model, expires_at from agents where id = $1", [id])).rows[0];
  assert.deepEqual(tombstone, { tenant: "", name: id, model: "", expires_at: null }, "no tenant, name or model on the row");
  assert.deepEqual((await db.query("select conversation from email_threads")).rows, [{ conversation: "c2" }], "its email thread goes, another agent's stays");
  assert.deepEqual((await db.query("select conversation from email_messages")).rows, [{ conversation: "c2" }]);

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

test("purging an agent forgets its dreaming job and disables its triggers, whose hooks then answer 202 and run nothing", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const { sessions } = await node(t, db, storage, "a");
  const { id } = await sessions.create([], { model }, "dreamer", {}, "default");
  const { id: other } = await sessions.create([], { model }, "other", {}, "default");
  for (const [agent, volume] of [[id, "vol_doomed"], [other, "vol_other"]]) {
    await db.query("insert into agent_dreaming (agent, tenant, volume, config, since, due_at) values ($1, 'default', $2, '{}', 0, 0)", [agent, volume]);
    await db.query("insert into agent_dreaming_runs (id, agent, tenant, created_at, result) values ($1, $2, 'default', 0, '{}')", [`run-${agent}`, agent]);
  }
  const submitted: string[] = [];
  const triggers = new Triggers({ db, transaction: work => transaction(db, work), keys: { seal: (_c, text) => ({ text }), unseal: (_c, value) => value.text },
    fresh: { precheck: async () => {}, definition: async () => "d", upsert: async () => id }, upload: async () => ({ path: "x" }), submit: async agent => { submitted.push(agent); return {}; } });
  const hook = await triggers.create("default", id, { name: "Stripe", prompt: "Handle it", budget: { usd: 1 } }, "https://hooks.test");
  const kept = await triggers.create("default", other, { name: "Other", prompt: "Handle it", budget: { usd: 1 } }, "https://hooks.test");
  const post = (url: string) => handleHook(new Request(url, { method: "POST", body: "{}" }), "127.0.0.1", async () => triggers, new HookAdmission());

  assert.equal(await sessions.destroyAgent(id, "default"), true);
  await sessions.sweep();
  assert.equal(Number((await db.query("select count(*) as count from agent_dreaming where agent = $1", [id])).rows[0].count), 0, "its dreaming job goes");
  assert.equal(Number((await db.query("select count(*) as count from agent_dreaming_runs where agent = $1", [id])).rows[0].count), 0, "with its runs");
  assert.equal(Number((await db.query("select count(*) as count from agent_dreaming where agent = $1", [other])).rows[0].count), 1, "another agent's stays");
  const rows = (await db.query("select id, disabled_at from agent_triggers order by id")).rows;
  assert.equal(rows.length, 2, "the trigger rows stay");
  assert.ok(Number(rows.find(row => row.id === hook.id).disabled_at) > 0, "the purged agent's trigger is disabled");
  assert.equal(rows.find(row => row.id === kept.id).disabled_at, null, "another agent's is not");

  // Its hook answers as accepted, records nothing and runs nothing; the live agent's still does.
  assert.deepEqual(await post(hook.url), { code: 202, body: { status: "disabled", verified: false, deduped: false } });
  assert.equal(Number((await db.query("select count(*) as count from trigger_deliveries where trigger_id = $1", [hook.id])).rows[0].count), 0);
  assert.equal(((await post(kept.url)).body as { status: string }).status, "queued");
  await triggers.scan();
  assert.deepEqual([...new Set(submitted)], [other]);
});

test("purging an agent tells its tenant's inbox when the agent had an item waiting, and says nothing when it did not", { timeout: 60_000 }, async t => {
  const { db, url } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const { sessions } = await node(t, db, storage, "a");
  const listened = await listening(url);
  try {
    const { id } = await sessions.create([], { model }, "asker", {}, "default");
    // A question it left waiting, as Inputs.create writes one (the purge reads the state, never the item itself).
    const input = `inp_${"a".repeat(32)}`;
    await db.query(`insert into agent_inputs (id, agent, tenant, request_id, tool_call_id, kind, input, created_at, expires_at)
      values ($1, $2, 'default', 'r1', 'call_1', 'question', '{"message":"Which region?"}', $3, $4)`, [input, id, Date.now(), Date.now() + 60_000]);

    assert.equal(await sessions.destroyAgent(id, "default"), true);
    await sessions.sweep();
    await until(() => listened.heard.length === 1, "the purge's notification");
    assert.deepEqual(listened.heard, ["default"], "the item's tenant hears that its queue changed");
    assert.equal((await db.query("select count(*) as count from agent_inputs where agent = $1", [id])).rows[0].count, 0, "the rows go with the purge");

    // An agent with nothing waiting changes no one's inbox: its purge is quiet.
    const quiet = await sessions.create([], { model }, "quiet", {}, "default");
    assert.equal(await sessions.destroyAgent(quiet.id, "default"), true);
    await sessions.sweep();
    await sleep(200);
    assert.deepEqual(listened.heard, ["default"]);
  } finally {
    await listened.close();
  }
});
