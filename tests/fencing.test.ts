import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import type { Api, Model } from "@earendil-works/pi-ai";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { LostClaim, Ownership, underClaim } from "../src/ownership.ts";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { VolumeService } from "../src/volumes.ts";
import { Scheduler } from "../src/scheduler.ts";
import { testDatabase } from "./database.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const model = { id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: "http://127.0.0.1:9/v1", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1024 } as Model<Api>;

/**
 * A peer taking `actor` over, begun on its own connection but not committed: it holds
 * the ownership row until `commit`. A write fenced by the old claim must wait for it
 * and then change nothing; an unfenced one goes through meanwhile.
 */
async function takeover(t: Context, url: string, actor: string) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  t.after(() => client.end().catch(() => {}));
  await client.query("begin");
  await client.query("update actor_owners set node = 'http://peer', session = gen_random_uuid(), epoch = epoch + 1 where actor = $1", [actor]);
  return { commit: () => client.query("commit") };
}

/** Start `write`, let it run into the takeover, then commit the takeover: the write must not land. */
async function racing(t: Context, url: string, actor: string, write: () => Promise<unknown>) {
  const peer = await takeover(t, url, actor);
  let settled = false;
  const outcome = write().then(value => ({ value }), (error: unknown) => ({ error })).finally(() => { settled = true; });
  await sleep(200);
  const waited = !settled;
  await peer.commit();
  return { waited, ...await outcome };
}

test("a write under a claim waits for a takeover in flight, then changes nothing", async t => {
  const { db, url } = await testDatabase();
  const ownership = new Ownership(db, { node: "http://a" });
  await ownership.start();
  t.after(() => ownership.close().catch(() => {}));
  const taken = await ownership.acquire("client_raced");
  assert.ok("claim" in taken);
  await db.query("create table owned (actor text, value int)");
  const result = await racing(t, url, "client_raced", () => underClaim(db, taken.claim, sql => sql.query("insert into owned values ('client_raced', 1)")));
  assert.equal(result.waited, true, "the write waited for the takeover");
  assert.ok("error" in result && result.error instanceof LostClaim);
  assert.equal((await db.query("select count(*) as count from owned")).rows[0].count, 0);
});

test("a stale owner's header write loses to a takeover in flight, and the header stays as the takeover found it", { timeout: 60_000 }, async t => {
  const { db, url } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "fencing-"));
  const ownership = new Ownership(db, { node: "http://a" });
  await ownership.start();
  const storage = memoryStorage(postgresTail(db));
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage });
  const sessions = new ClientSessions(supervisor, { db, storage, prefix: "client-sessions/", ownership, secret: "fencing-test-secret-with-32-characters", apiKey: "fixture-only" });
  t.after(async () => {
    await sessions.close(); await supervisor.close(); await ownership.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const { id } = await sessions.create([], { model }, "raced");
  // The revocation is a header write, the first write deleting makes.
  const result = await racing(t, url, id, () => sessions.destroyAgent(id, "default"));
  assert.equal(result.waited, true);
  assert.ok("error" in result, "the stale owner's write failed");
  const [row] = (await db.query("select revoked, revision from agents where id = $1", [id])).rows;
  assert.equal(row.revoked, false, "the header is as the takeover found it");
});

async function volumeNode(t: Context, db: pg.Pool) {
  const ownership = new Ownership(db, { node: "http://a" });
  await ownership.start();
  const volumes = new VolumeService({ db, storage: memoryStorage(postgresTail(db)), ownership });
  t.after(async () => { await volumes.close(); await ownership.close(); });
  const volume = await volumes.create("acme");
  await volumes.handle(volume.id, "acme", "commit", { path: "/a.txt", ...await volumes.store("acme", Buffer.from("a")) });
  return { volumes, id: volume.id };
}

test("a stale owner's volume snapshot, snapshot delete and volume delete lose to a takeover in flight", async t => {
  const { db, url } = await testDatabase();
  {
    const { volumes, id } = await volumeNode(t, db);
    const result = await racing(t, url, id, () => volumes.handle(id, "acme", "snapshot", { name: "stale" }));
    assert.equal(result.waited, true);
    assert.ok("error" in result && result.error instanceof LostClaim);
    assert.equal((await db.query("select count(*) as count from volume_snapshots where volume = $1", [id])).rows[0].count, 0);
  }
  {
    const { volumes, id } = await volumeNode(t, db);
    const snapshot = await volumes.handle(id, "acme", "snapshot", {});
    const result = await racing(t, url, id, () => volumes.handle(id, "acme", "deleteSnapshot", { snapshot: snapshot.id }));
    assert.ok("error" in result && result.error instanceof LostClaim);
    assert.equal((await db.query("select count(*) as count from volume_snapshots where id = $1", [snapshot.id])).rows[0].count, 1);
  }
  {
    const { volumes, id } = await volumeNode(t, db);
    const rows = Number((await db.query("select count(*) as count from log_records where actor = $1", [id])).rows[0].count);
    const result = await racing(t, url, id, () => volumes.handle(id, "acme", "delete"));
    assert.ok("error" in result && result.error instanceof LostClaim);
    const [volume] = (await db.query("select deleted_at from volumes where id = $1", [id])).rows;
    assert.equal(volume.deleted_at, null, "the volume is not deleted");
    assert.equal(Number((await db.query("select count(*) as count from log_records where actor = $1", [id])).rows[0].count), rows, "nor its tail");
  }
});

test("a stale owner's volume watches and schedules for its agent lose to a takeover in flight", async t => {
  const { db, url } = await testDatabase();
  const ownership = new Ownership(db, { node: "http://a" });
  await ownership.start();
  t.after(() => ownership.close().catch(() => {}));
  const taken = await ownership.acquire("client_watcher");
  assert.ok("claim" in taken);
  const volumes = new VolumeService({ db, storage: memoryStorage(postgresTail(db)), ownership });
  t.after(() => volumes.close());
  const volume = await volumes.create("acme");
  const mounts = [{ volumeId: volume.id, path: "/data", mode: "rw" as const, notify: true }];
  const watched = await racing(t, url, "client_watcher", () => volumes.watch("client_watcher", "acme", [], mounts, taken.claim));
  assert.equal(watched.waited, true);
  assert.ok("error" in watched && watched.error instanceof LostClaim);
  assert.equal((await db.query("select count(*) as count from volume_watchers")).rows[0].count, 0);

  const scheduler = new Scheduler({ db, node: "http://a", deliver: async () => {} });
  const scheduled = await racing(t, url, "client_watcher", () => scheduler.create({ agent: "client_watcher", tenant: "acme", text: "wake", dueAt: Date.now() + 60_000 }, taken.claim));
  assert.ok("error" in scheduled && scheduled.error instanceof LostClaim);
  assert.equal((await db.query("select count(*) as count from schedules")).rows[0].count, 0);
  // Schedules the API made, from any node, are removed by the agent's owner only while it is the owner.
  const made = await scheduler.create({ agent: "client_watcher", tenant: "acme", text: "wake", dueAt: Date.now() + 60_000 });
  await assert.rejects(scheduler.remove("client_watcher", made.id, taken.claim), LostClaim);
  assert.equal(await scheduler.remove("client_watcher", made.id), true);
});

test("two creates of one agent at once on one node leave one claim, still current, and an agent that works", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  const root = await mkdtemp(join(tmpdir(), "fencing-"));
  const ownership = new Ownership(db, { node: "http://a" });
  await ownership.start();
  const storage = memoryStorage(postgresTail(db));
  const volumes = new VolumeService({ db, storage, ownership });
  const supervisor = new AgentSupervisor(join(root, "agents"), { runtime: process.env.AGENT_RUNTIME, hosting: process.env.AGENT_HOSTING as Hosting | undefined, storage });
  const sessions = new ClientSessions(supervisor, { db, storage, prefix: "client-sessions/", ownership, volumes, secret: "fencing-test-secret-with-32-characters", apiKey: "fixture-only" });
  t.after(async () => {
    await sessions.close(); await supervisor.close(); await volumes.close(); await ownership.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  // Both find no agent, and before the fix both took the claim: the second's new epoch fenced the first's writes.
  const [first, second] = await Promise.all([sessions.create([], { model }, "twin"), sessions.create([], { model }, "twin")]);
  assert.equal(first.id, second.id);
  const session = sessions.sessions.get(first.id)!;
  assert.ok(session.claim && ownership.holds(session.claim));
  const [row] = (await db.query("select epoch from actor_owners where actor = $1", [first.id])).rows;
  assert.equal(Number(row.epoch), session.claim.epoch, "the agent's claim is the current one");
  await sessions.submit(first.id, "default", { id: "after-twins", method: "execute", params: { code: "return 1" } });
  for (let tries = 0; sessions.sessions.get(first.id)?.requests.get("after-twins")?.state !== "completed"; tries++) {
    assert.ok(tries < 1000, "the agent ran a request");
    await sleep(5);
  }
});
