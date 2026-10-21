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
import { effectiveMode, PiSweep, PiSweepControl, piSweepGate, type PiSweepCandidate, type PiSweepMode, type PiSweepResult } from "../src/pi-sweep.ts";
import type { AgentEngine } from "../src/pi-durable/config.ts";
import { testDatabase } from "./database.ts";
import { OTHER_OPERATOR, runtime, until } from "./runtime-server.ts";

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
  return { sessions, supervisor, ownership, close };
}

async function prompt(sessions: ClientSessions, id: string, request: string) {
  await sessions.submit(id, "default", { id: request, method: "prompt", params: { text: request } });
  await until(() => sessions.sessions.get(id)?.requests.get(request)?.state === "completed" && !sessions.inFlight(), `${request} finished`, 30_000);
}

/** A model that answers every request with a short text, and counts them. */
async function fixtureModel(t: Context) {
  const state = { calls: 0 };
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* drain request */ }
    state.calls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: `answer ${state.calls}` }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: `response-${state.calls}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
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
  return { model, state };
}

/** Agents made with history on a legacy node, then let go: what the sweep migrates. */
async function legacyAgents(t: Context, db: pg.Pool, storage: ReturnType<typeof memoryStorage>, model: Model<Api>, names: string[]) {
  const legacy = await node(t, db, storage, "legacy", "legacy");
  const ids: string[] = [];
  for (const name of names) {
    const { id } = await legacy.sessions.create([], { model }, name, {}, "default");
    await prompt(legacy.sessions, id, `hello-${name}`);
    ids.push(id);
  }
  await legacy.sessions.releaseIdle();
  await legacy.close();
  return ids;
}

const count = async (db: pg.Pool, sql: string, values: unknown[] = []) => Number((await db.query(sql, values)).rows[0].count);
const NATIVE = `select count(*) as count from pi_durable_documents where kind = '"camel.host.snapshot"'`;

/** Every table's rows but the sweep's own, as text: what a dry run must leave as it was. */
async function everything(db: pg.Pool) {
  const tables = (await db.query("select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE' and table_name <> 'pi_sweep' order by 1")).rows.map(row => row.table_name as string);
  const all: Record<string, string[]> = {};
  for (const table of tables) all[table] = (await db.query(`select t::text as row from ${table} t`)).rows.map(row => row.row as string).sort();
  return all;
}

/** A sweep over `sessions` that records each agent's outcome, never waiting for memory or pace. */
function sweeper(db: pg.Pool, sessions: ClientSessions, setting: PiSweepMode) {
  const outcomes: Record<string, number> = {};
  const sweep = new PiSweep({
    db, setting, paceMs: 0, repassMs: 60 * 60_000, pollMs: 20, backoffMs: [20, 40], busy: async () => undefined,
    sweep: async (candidate, dryRun) => {
      const result = await sessions.piSweepAgent(candidate, dryRun);
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      return result;
    },
  });
  return { sweep, outcomes, reset() { for (const key of Object.keys(outcomes)) delete outcomes[key]; } };
}

const finished = (db: pg.Pool, mode: "dry_run" | "on") => until(async () => (await db.query(`select ${mode}_finished_at from pi_sweep`)).rows[0][`${mode}_finished_at`] !== null, `the ${mode} pass`, 60_000);

test("the sweep's dry run reports and writes nothing; on, it migrates the idle agents once, and a second pass finds only those it left", { timeout: 180_000 }, async t => {
  const { model, state } = await fixtureModel(t);
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const ids = await legacyAgents(t, db, storage, model, ["idle-a", "idle-b", "waiting"]);
  await db.query(`insert into agent_inputs (id, agent, tenant, request_id, tool_call_id, kind, input, created_at, expires_at)
    values ('input-1', $1, 'default', 'r', 'c', 'confirm', '{}', $2, $3)`, [ids[2], Date.now(), Date.now() + 60_000]);
  assert.equal(await count(db, NATIVE), 0);
  const calls = state.calls;

  const pi = await node(t, db, storage, "pi", "pi-durable");
  const control = new PiSweepControl(db, "on");
  assert.equal((await control.status()).effective, "dry-run", "a new database starts in dry-run");
  assert.equal((await control.status()).remaining, 3);

  // Dry run: what each open would do; nothing written, nothing opened or held.
  const before = await everything(db);
  const { sweep, outcomes, reset } = sweeper(db, pi.sessions, "on");
  t.after(() => sweep.stop());
  sweep.start();
  await finished(db, "dry_run");
  assert.deepEqual(outcomes, { would_migrate: 2, deferred_awaiting: 1 });
  assert.deepEqual(await everything(db), before, "a dry run writes nothing but its cursor");
  assert.equal(pi.supervisor.agents.size, 0);
  assert.equal(pi.sessions.sessions.size, 0);

  // On: the idle ones migrate, and are let go again.
  reset();
  await control.set("on");
  await finished(db, "on");
  assert.deepEqual(outcomes, { migrated: 2, deferred_awaiting: 1 });
  assert.equal(await count(db, NATIVE), 2);
  assert.equal(pi.supervisor.agents.size, 0, "swept agents are stopped");
  assert.equal(pi.sessions.sessions.size, 0, "and unloaded");
  assert.equal(await count(db, "select count(*) as count from actor_owners where node is not null"), 0, "and their ownership released");
  assert.equal(state.calls, calls, "opening an agent asks no model");

  // Again from the start: migrated agents are not candidates, and nothing changes.
  reset();
  const migrated = await everything(db);
  await control.set("on", true);
  await finished(db, "on");
  await sweep.stop();
  assert.deepEqual(outcomes, { deferred_awaiting: 1 });
  assert.deepEqual((await everything(db)).pi_durable_documents, migrated.pi_durable_documents, "a second pass rewrites nothing");
  assert.equal((await control.status()).remaining, 1);

  // A migrated agent runs on Pi with its history.
  await prompt(pi.sessions, ids[0], "after-the-sweep");
  const status = await pi.supervisor.request(ids[0], "status", {}) as { engine: string; messages: number };
  assert.equal(status.engine, "pi-durable");
  assert.equal(status.messages, 4);
});

test("the sweep never takes an agent another node holds, even one taken after it was chosen", { timeout: 120_000 }, async t => {
  const { model } = await fixtureModel(t);
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const [held, free] = await legacyAgents(t, db, storage, model, ["held", "free"]);

  // Another node serves `held` (on the legacy engine, so it stays a candidate).
  const other = await node(t, db, storage, "other", "legacy");
  await prompt(other.sessions, held, "still-here");
  const pi = await node(t, db, storage, "pi", "pi-durable");

  const { sweep, outcomes } = sweeper(db, pi.sessions, "on");
  t.after(() => sweep.stop());
  await new PiSweepControl(db, "on").set("on");
  sweep.start();
  await finished(db, "on");
  await sweep.stop();
  assert.deepEqual(outcomes, { skipped_hosted: 1, migrated: 1 });

  // Chosen while free, taken by another node before the sweep opened it: its load is refused, so the node keeps it.
  const stale: PiSweepCandidate = { id: held, tenant: "default", pendingRuns: false, awaiting: false, owned: false };
  assert.deepEqual(await pi.sessions.piSweepAgent(stale, false), { outcome: "skipped_hosted" });
  assert.ok(other.sessions.sessions.has(held), "the other node still serves it");
  assert.equal(await other.ownership.owner(held), "http://other");
  assert.equal(await count(db, "select count(*) as count from pi_durable_documents where session_id = $1", [held]), 0, "and nothing of it was imported");
  await prompt(other.sessions, held, "still-mine");
  assert.equal(await count(db, `select count(*) as count from pi_durable_documents where session_id = $1 and kind = '"camel.host.snapshot"'`, [free]), 1);
});

test("turning the operator's mode off stops every node's sweep before its next agent; on again, it goes on from its cursor", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  for (let i = 0; i < 40; i++) {
    await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'default', '{}', 1, 'a', 'client', 'm')", [`client_${String(i).padStart(3, "0")}`]);
  }
  const control = new PiSweepControl(db, "on");
  await control.set("on");
  // Two nodes, each taking 30 ms an agent.
  const taken: string[][] = [[], []];
  const sweeps = taken.map(list => new PiSweep({
    db, setting: "on", paceMs: 0, repassMs: 60 * 60_000, pollMs: 20, busy: async () => undefined,
    sweep: async candidate => { list.push(candidate.id); await new Promise(resolve => setTimeout(resolve, 30)); return { outcome: "migrated" }; },
  }));
  t.after(() => Promise.all(sweeps.map(sweep => sweep.stop())));
  for (const sweep of sweeps) sweep.start();
  await until(() => taken[0].length + taken[1].length >= 10, "some agents");
  await control.set("off");
  // At most the agent each node had in hand.
  await new Promise(resolve => setTimeout(resolve, 100));
  const stoppedAt = taken[0].length + taken[1].length;
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(taken[0].length + taken[1].length, stoppedAt, "off stops every node");
  assert.ok(taken[0].length && taken[1].length, "both nodes swept");

  await control.set("on");
  await finished(db, "on");
  const all = [...taken[0], ...taken[1]].sort();
  assert.deepEqual(all, [...new Set(all)], "no agent was taken twice");
  assert.equal(all.length, 40, "and every one was taken once, across the stop");

  // The node's own stop ends a wait at once.
  const started = Date.now();
  await Promise.all(sweeps.map(sweep => sweep.stop()));
  assert.ok(Date.now() - started < 1_000);
});

test("the sweep takes no agent while the node is short of memory, its pool is waiting, it is full or leaving", { timeout: 60_000 }, async t => {
  const reading = { leaving: false, dbWaiting: 0, memoryHigh: false, full: false, maxMemoryBytes: 1000, memoryBytes: async () => 500 };
  assert.equal(await piSweepGate(reading), undefined);
  assert.equal(await piSweepGate({ ...reading, memoryBytes: async () => 1001 }), "memory");
  assert.equal(await piSweepGate({ ...reading, memoryHigh: true }), "memory_high");
  assert.equal(await piSweepGate({ ...reading, dbWaiting: 1 }), "db_waiting");
  assert.equal(await piSweepGate({ ...reading, full: true }), "node_full");
  assert.equal(await piSweepGate({ ...reading, leaving: true }), "leaving");
  assert.equal(await piSweepGate({ ...reading, maxMemoryBytes: undefined, memoryBytes: async () => 1e12 }), undefined, "unset, only AGENT_MEMORY_HIGH_BYTES counts");

  const { db } = await testDatabase();
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ('client_a', 'default', '{}', 1, 'a', 'client', 'm')");
  await new PiSweepControl(db, "on").set("on");
  let memory = 2000;
  const swept: PiSweepResult[] = [];
  const sweep = new PiSweep({
    db, setting: "on", paceMs: 0, repassMs: 60 * 60_000, pollMs: 20, backoffMs: [20, 40],
    busy: () => piSweepGate({ ...reading, memoryBytes: async () => memory }),
    sweep: async () => { swept.push({ outcome: "migrated" }); return { outcome: "migrated" }; },
  });
  t.after(() => sweep.stop());
  sweep.start();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(swept.length, 0, "past the memory limit it waits");
  assert.equal((await db.query("select on_cursor from pi_sweep")).rows[0].on_cursor, "", "without taking an agent");
  memory = 500;
  await until(() => swept.length === 1, "the agent once memory falls");
});

test("the node's setting caps the operator's mode", () => {
  assert.equal(effectiveMode("off", "on"), "off");
  assert.equal(effectiveMode("dry-run", "on"), "dry-run");
  assert.equal(effectiveMode("on", "dry-run"), "dry-run");
  assert.equal(effectiveMode("on", "off"), "off");
  assert.equal(effectiveMode("on", "on"), "on");
});

test("only the platform operator sees and sets the sweep's mode, through the API", { timeout: 120_000 }, async t => {
  const { call } = await runtime(t, () => ({ role: "assistant", content: "hi" }),
    { AGENT_BILLING_ADMINS: "alice", AGENT_PI_SWEEP: "dry-run", AGENT_PI_SWEEP_DELAY_MS: "0", AGENT_PI_SWEEP_PACE_MS: "0" });
  assert.equal((await call("/v1/operations/pi-sweep", { token: OTHER_OPERATOR })).status, 403);
  assert.equal((await call("/v1/operations/pi-sweep", { method: "PUT", body: { mode: "on" }, token: OTHER_OPERATOR })).status, 403);
  assert.equal((await call("/v1/operations/pi-sweep", { method: "PUT", body: { mode: "fast" } })).status, 400);
  // Nothing on legacy here: the node's dry run finds the end at once.
  const done = await until(async () => { const status = (await call("/v1/operations/pi-sweep")).json; return status.dryRun.finishedAt && status; }, "the dry run's pass");
  assert.equal(done.setting, "dry-run");
  assert.equal(done.remaining, 0);
  const set = await call("/v1/operations/pi-sweep", { method: "PUT", body: { mode: "on", restart: true } });
  assert.equal(set.status, 200);
  assert.equal(set.json.mode, "on");
  assert.equal(set.json.effective, "dry-run", "no more than AGENT_PI_SWEEP");
  assert.equal((await call("/v1/operations/pi-sweep", { method: "PUT", body: { mode: "off" } })).json.effective, "off");
});
