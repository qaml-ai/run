import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import type pg from "pg";
import type { Api, Model } from "@earendil-works/pi-ai";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Ownership } from "../src/ownership.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import type { AgentEngine } from "../src/pi-durable/config.ts";
import { testDatabase } from "./database.ts";
import { until } from "./runtime-server.ts";

type Context = { after(fn: () => Promise<void> | void): void };

/** A node over the shared storage and database, on `engine`. */
async function node(t: Context, db: pg.Pool, storage: ReturnType<typeof memoryStorage>, name: string, engine: AgentEngine) {
  const root = await mkdtemp(join(tmpdir(), "pi-sweep-"));
  const ownership = new Ownership(db, { node: `http://${name}` });
  await ownership.start();
  const supervisor = new AgentSupervisor(join(root, "agents"), { hosting: "inline", storage, db, engine });
  const sessions = new ClientSessions(supervisor, { db, storage, prefix: "client-sessions/", ownership, secret: "pi-sweep-test-secret-with-32-characters!", apiKeyFor: () => "fixture-only" });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await sessions.close(); await supervisor.close(); await ownership.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  t.after(close);
  return { sessions, supervisor, close };
}

async function prompt(sessions: ClientSessions, id: string, request: string) {
  await sessions.submit(id, "default", { id: request, method: "prompt", params: { text: request } });
  await until(() => sessions.sessions.get(id)?.requests.get(request)?.state === "completed" && !sessions.inFlight(), `${request} finished`, 30_000);
}

const count = async (db: pg.Pool, sql: string, values: unknown[] = []) => Number((await db.query(sql, values)).rows[0].count);

test("the Pi sweep's dry run says what each legacy agent's open would do; the sweep opens the idle ones, which migrate", { timeout: 120_000 }, async t => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain request */ }
    calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: `answer ${calls}` }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: `response-${calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const model = {
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", reasoning: false,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024,
  } as Model<Api>;
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));

  // Three agents with history on the legacy engine; one of them is then waiting on a person.
  const legacy = await node(t, db, storage, "legacy", "legacy");
  const ids: string[] = [];
  for (const name of ["idle-a", "idle-b", "waiting"]) {
    const { id } = await legacy.sessions.create([], { model }, name, {}, "default");
    await prompt(legacy.sessions, id, `hello-${name}`);
    ids.push(id);
  }
  await legacy.sessions.releaseIdle();
  await legacy.close();
  const waiting = ids[2];
  await db.query(`insert into agent_inputs (id, agent, tenant, request_id, tool_call_id, kind, input, created_at, expires_at)
    values ('input-1', $1, 'default', 'r', 'c', 'confirm', '{}', $2, $3)`, [waiting, Date.now(), Date.now() + 60_000]);
  const native = `select count(*) as count from pi_durable_documents where kind = '"camel.host.snapshot"'`;
  assert.equal(await count(db, native), 0);

  const pi = await node(t, db, storage, "pi", "pi-durable");
  const dry = await pi.sessions.piSweep({ dryRun: true, paceMs: 0 });
  assert.deepEqual(dry.outcomes, { would_migrate: 2, deferred_awaiting: 1 });
  assert.equal(dry.seen, 3);
  assert.equal(await count(db, "select count(*) as count from pi_durable_metadata"), 0, "a dry run writes no Pi storage");
  assert.equal(pi.supervisor.agents.size, 0, "a dry run opens no agent");

  const swept = await pi.sessions.piSweep({ dryRun: false, paceMs: 0 });
  assert.deepEqual(swept.outcomes, { migrated: 2, deferred_awaiting: 1 });
  assert.equal(await count(db, native), 2);
  assert.equal(pi.supervisor.agents.size, 0, "swept agents are unloaded again");
  assert.equal(pi.sessions.sessions.size, 0);
  assert.equal(await count(db, "select count(*) as count from actor_owners where node is not null"), 0, "and their ownership released");
  assert.equal(calls, 3, "opening an agent asks no model");

  // Migrated agents are not candidates again; the waiting one stays until its input settles.
  const again = await pi.sessions.piSweep({ dryRun: true, paceMs: 0 });
  assert.deepEqual(again.outcomes, { deferred_awaiting: 1 });
  // A migrated agent runs on Pi with its history.
  await prompt(pi.sessions, ids[0], "after-the-sweep");
  const status = await pi.supervisor.request(ids[0], "status", {}) as { engine: string; messages: number };
  assert.equal(status.engine, "pi-durable");
  assert.equal(status.messages, 4);
});

test("only one node sweeps at a time", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const a = await node(t, db, storage, "a", "pi-durable");
  const lock = await db.connect();
  t.after(() => lock.release());
  await lock.query("select pg_advisory_lock(hashtext('pi_sweep'))");
  assert.equal((await a.sessions.piSweep({ dryRun: true, paceMs: 0 })).skipped, "another node is sweeping");
  await lock.query("select pg_advisory_unlock(hashtext('pi_sweep'))");
  assert.equal((await a.sessions.piSweep({ dryRun: true, paceMs: 0 })).skipped, undefined);
});
