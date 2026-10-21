import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import type pg from "pg";
import { fauxAssistantMessage, type Api, type Model } from "@earendil-works/pi-ai";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { Ownership } from "../src/ownership.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { ClientSessions } from "../src/client-sessions.ts";
import { MIGRATION_MAX_BYTES } from "../src/pi-durable/migration.ts";
import { effectiveMode, PiSweep, PiSweepControl, piSweepGate, type PiSweepCandidate, type PiSweepMode, type PiSweepResult } from "../src/pi-sweep.ts";
import type { TranscriptRecord } from "../src/transcript.ts";
import { testDatabase } from "./database.ts";
import { OTHER_OPERATOR, runtime, until } from "./runtime-server.ts";

type Context = { after(fn: () => Promise<void> | void): void };

/** A node over the shared storage and database. */
async function node(t: Context, db: pg.Pool, storage: ReturnType<typeof memoryStorage>, name: string) {
  const root = await mkdtemp(join(tmpdir(), "pi-sweep-"));
  const ownership = new Ownership(db, { node: `http://${name}` });
  await ownership.start();
  const supervisor = new AgentSupervisor(join(root, "agents"), { hosting: "inline", storage, db });
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

/** A turn as the legacy engine wrote it to an agent's transcript log. */
const legacyTurn = (text: string, requestId: string, reply: string): TranscriptRecord[] => [
  { t: "turn", active: true },
  { t: "message", message: { role: "user", content: text, timestamp: 1, requestId } as never },
  { t: "message", message: fauxAssistantMessage(reply) },
  { t: "turn", active: false },
];

/**
 * Agents as the legacy engine left them: made (which starts no host), then given a transcript log of a turn, and for
 * `awaiting` ones a call still waiting on a person. What the sweep migrates.
 */
async function legacyAgents(t: Context, db: pg.Pool, storage: ReturnType<typeof memoryStorage>, model: Model<Api>, names: string[], awaiting: string[] = [], pinned: string[] = []) {
  const maker = await node(t, db, storage, "maker");
  const ids: string[] = [];
  for (const name of names) {
    const { id } = await maker.sessions.create([], { model }, name, {}, "default");
    const records = legacyTurn(`hello-${name}`, `request-${name}`, `answer-${name}`);
    // A leading system message the legacy host pinned, as it did once the prompt or tools changed with history.
    if (pinned.includes(name)) records.unshift({ t: "system", message: { role: "system", content: "You are a fixture.", timestamp: 0 } as never, leading: true });
    if (awaiting.includes(name)) records.push({ t: "message", message: fauxAssistantMessage([{ type: "toolCall", id: "call-1", name: "confirm", arguments: {} }], { stopReason: "toolUse" }) }, { t: "awaiting", calls: ["call-1"] } as TranscriptRecord);
    // Written under the agent's claim, as its legacy host wrote it.
    const acquired = await maker.ownership.acquire(id);
    assert.ok("claim" in acquired);
    const log = storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(id), acquired.claim);
    await log.rewrite(() => records);
    await log.close();
    await maker.ownership.release(acquired.claim);
    ids.push(id);
  }
  await maker.sessions.releaseIdle();
  await maker.close();
  assert.equal(await count(db, NATIVE), 0, "made agents are not on Pi yet");
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
function sweeper(db: pg.Pool, sessions: ClientSessions, setting: PiSweepMode, each?: (id: string, result: PiSweepResult) => void, node?: string) {
  const outcomes: Record<string, number> = {};
  const sweep = new PiSweep({
    db, setting, node, paceMs: 0, largePaceMs: 0, repassMs: 60 * 60_000, pollMs: 20, backoffMs: [20, 40], busy: async () => undefined,
    sweep: async (candidate, dryRun, large) => {
      const result = await sessions.piSweepAgent(candidate, dryRun, large);
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      each?.(candidate.id, result);
      return result;
    },
  });
  return { sweep, outcomes, reset() { for (const key of Object.keys(outcomes)) delete outcomes[key]; } };
}

const finished = (db: pg.Pool, mode: "dry_run" | "on") => until(async () => (await db.query(`select ${mode}_finished_at from pi_sweep`)).rows[0][`${mode}_finished_at`] !== null, `the ${mode} pass`, 60_000);

test("the sweep's dry run reports and writes nothing; on, it imports the idle agents once, and a second pass finds only those it left", { timeout: 180_000 }, async t => {
  const { model, state } = await fixtureModel(t);
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const ids = await legacyAgents(t, db, storage, model, ["idle-a", "idle-b", "waiting", "running"], ["waiting"]);
  // Runs open: the orphan sweep's to load, not this one's.
  await db.query("update agents set pending_runs = true where id = $1", [ids[3]]);

  const pi = await node(t, db, storage, "pi");
  const control = new PiSweepControl(db, "on");
  assert.equal((await control.status()).effective, "dry-run", "a new database starts in dry-run");
  assert.equal((await control.status()).remaining, 4);

  // Dry run: what each open would do; nothing written, nothing opened or held.
  const before = await everything(db);
  const results: Record<string, PiSweepResult> = {};
  const { sweep, outcomes, reset } = sweeper(db, pi.sessions, "on", (id, result) => { results[id] = result; });
  t.after(() => sweep.stop());
  sweep.start();
  await finished(db, "dry_run");
  assert.deepEqual(outcomes, { would_migrate: 3, skipped_pending_runs: 1 });
  const sized = (result: PiSweepResult) => { const { bytes, contextBytes, ...rest } = result.detail!; assert.ok((bytes as number) > 0 && (contextBytes as number) > 0); return { ...result, detail: rest }; };
  assert.deepEqual(sized(results[ids[0]]), { outcome: "would_migrate", detail: { records: 4, system: false } }, "what the import would write, and that it makes a system message from tools");
  assert.deepEqual(sized(results[ids[2]]), { outcome: "would_migrate", detail: { records: 6, system: false, from: "awaiting" } }, "with what the import would find");
  assert.deepEqual(await everything(db), before, "a dry run writes nothing but its cursor");
  assert.equal(pi.supervisor.agents.size, 0);
  assert.equal(pi.sessions.sessions.size, 0);

  // On: the idle ones are imported, and let go again.
  reset();
  await control.set("on");
  await finished(db, "on");
  assert.deepEqual(outcomes, { migrated: 3, skipped_pending_runs: 1 });
  assert.deepEqual(results[ids[2]], { outcome: "migrated", detail: { system: false, from: "awaiting" } });
  assert.equal(await count(db, NATIVE), 3);
  assert.equal(pi.supervisor.agents.size, 0, "swept agents are stopped");
  assert.equal(pi.sessions.sessions.size, 0, "and unloaded");
  assert.equal(await count(db, "select count(*) as count from actor_owners where node is not null"), 0, "and their ownership released");
  assert.equal(state.calls, 0, "opening an agent asks no model");

  // Again from the start: imported agents are not candidates, and nothing changes.
  reset();
  const migrated = await everything(db);
  await control.set("on", true);
  await finished(db, "on");
  await sweep.stop();
  assert.deepEqual(outcomes, { skipped_pending_runs: 1 });
  assert.deepEqual((await everything(db)).pi_durable_documents, migrated.pi_durable_documents, "a second pass rewrites nothing");
  assert.equal((await control.status()).remaining, 1);

  // An imported agent runs on Pi with its history.
  await prompt(pi.sessions, ids[0], "after-the-sweep");
  assert.equal((await pi.supervisor.request(ids[0], "status", {}) as { messages: number }).messages, 4);
  assert.equal(state.calls, 1);
});

test("the sweep never takes an agent another node holds, even one taken after it was chosen", { timeout: 120_000 }, async t => {
  const { model } = await fixtureModel(t);
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const [held, free] = await legacyAgents(t, db, storage, model, ["held", "free"]);

  // Another node holds `held`'s claim, as one loading or serving it does.
  const other = await node(t, db, storage, "other");
  const claimed = await other.ownership.acquire(held);
  assert.ok("claim" in claimed);
  const pi = await node(t, db, storage, "pi");

  const { sweep, outcomes } = sweeper(db, pi.sessions, "on");
  t.after(() => sweep.stop());
  await new PiSweepControl(db, "on").set("on");
  sweep.start();
  await finished(db, "on");
  await sweep.stop();
  assert.deepEqual(outcomes, { skipped_hosted: 1, migrated: 1 });

  // Chosen while free, taken by another node before the sweep opened it: its load is refused, so that node keeps it.
  const stale: PiSweepCandidate = { id: held, tenant: "default", pendingRuns: false, owned: false };
  assert.deepEqual(await pi.sessions.piSweepAgent(stale, false), { outcome: "skipped_hosted" });
  assert.ok(other.ownership.holds(claimed.claim), "the other node still holds it");
  assert.equal(await pi.ownership.owner(held), "http://other");
  assert.equal(await count(db, "select count(*) as count from pi_durable_documents where session_id = $1", [held]), 0, "and nothing of it was imported");
  assert.equal(pi.sessions.sessions.size, 0);
  assert.equal(await count(db, `select count(*) as count from pi_durable_documents where session_id = $1 and kind = '"camel.host.snapshot"'`, [free]), 1);
});

test("the sweep's start only imports: it lists tools only for a transcript without its system message, warms no tool search, and leaves no host", { timeout: 120_000 }, async t => {
  const { model, state } = await fixtureModel(t);
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const [pinned, unpinned, active, asked] = await legacyAgents(t, db, storage, model, ["pinned", "unpinned", "active", "asked"], [], ["pinned", "active", "asked"]);
  // A turn its node lost: the import takes it open, and only the next open recovers it.
  {
    const maker = await node(t, db, storage, "maker-active");
    const acquired = await maker.ownership.acquire(active);
    assert.ok("claim" in acquired);
    const log = storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(active), acquired.claim);
    for (const record of [{ t: "turn", active: true }, { t: "message", message: { role: "user", content: "lost", timestamp: 2, requestId: "lost" } }] as TranscriptRecord[]) log.append(record);
    await log.close();
    await maker.ownership.release(acquired.claim);
    await maker.close();
  }
  const pi = await node(t, db, storage, "pi");
  const sessions = pi.sessions as unknown as { toolset(...args: unknown[]): Promise<unknown>; options: { rerankers?: unknown[] } };
  const listed: string[] = [];
  const toolset = sessions.toolset.bind(pi.sessions);
  sessions.toolset = (session: unknown, next?: { warm?: boolean }) => { listed.push(`${(session as { header: { id: string } }).header.id}:${next?.warm === false ? "cold" : "warm"}`); return toolset(session, next); };
  const candidate = (id: string): PiSweepCandidate => ({ id, tenant: "default", pendingRuns: false, owned: false });

  assert.deepEqual(await pi.sessions.piSweepAgent(candidate(pinned), false), { outcome: "migrated", detail: { system: true } });
  assert.deepEqual(listed, [], "a pinned system message needs no tools");
  assert.deepEqual(await pi.sessions.piSweepAgent(candidate(unpinned), false), { outcome: "migrated", detail: { system: false } });
  assert.deepEqual(listed, [`${unpinned}:cold`], "without one, the tools are listed, but no tool search warms");
  assert.deepEqual(await pi.sessions.piSweepAgent(candidate(active), false), { outcome: "migrated", detail: { system: true, from: "active" } });
  assert.equal(pi.supervisor.agents.size, 0, "no host is left");
  assert.equal(pi.sessions.sessions.size, 0);
  assert.equal(await count(db, "select count(*) as count from pi_usage_receipts"), 0, "importing bills nothing");
  assert.equal(state.calls, 0, "and asks no model");

  // A request while the sweep's start runs waits for it, then starts the agent with its tools.
  listed.length = 0;
  // The sweep's host start is held until the request has come.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const start = pi.supervisor.start.bind(pi.supervisor);
  pi.supervisor.start = (async (...args: Parameters<typeof start>) => { await held; pi.supervisor.start = start; return start(...args); }) as typeof start;
  const sweeping = pi.sessions.piSweepAgent(candidate(asked), false);
  await until(() => (pi.sessions.sessions.get(asked) as { sweeping?: boolean } | undefined)?.sweeping, "the sweep's start");
  const prompted = prompt(pi.sessions, asked, "while-sweeping");
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  assert.equal((await sweeping).outcome, "migrated");
  await prompted;
  assert.deepEqual(listed, [`${asked}:warm`], "the request's start lists and warms as any");
  assert.ok(pi.supervisor.agents.has(asked), "and it stays for the request");

  // The lost turn is recovered by its next open, as on any session on Pi.
  const calls = state.calls;
  await prompt(pi.sessions, active, "after-the-sweep");
  assert.equal(state.calls, calls + 1);
});

test("the large pass imports a session too large to copy by reference, once the on pass is done and only when turned on", { timeout: 180_000 }, async t => {
  const { model } = await fixtureModel(t);
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const [large, small] = await legacyAgents(t, db, storage, model, ["large", "small"]);
  {
    const maker = await node(t, db, storage, "maker-large");
    const acquired = await maker.ownership.acquire(large);
    assert.ok("claim" in acquired);
    const log = storage.log<TranscriptRecord>(AgentSupervisor.transcriptKey(large), acquired.claim);
    await log.rewrite(() => [
      { t: "message", message: { role: "user", content: "x".repeat(MIGRATION_MAX_BYTES), timestamp: 1, requestId: "old" } as never },
      { t: "compaction", summary: "Earlier history", cut: 1, tokensBefore: 100, at: 2 },
    ]);
    await log.close();
    await maker.ownership.release(acquired.claim);
    await maker.close();
  }
  const pi = await node(t, db, storage, "pi");
  const control = new PiSweepControl(db, "on");
  await control.set("on");
  const { sweep, outcomes, reset } = sweeper(db, pi.sessions, "on");
  t.after(() => sweep.stop());
  sweep.start();
  await finished(db, "on");
  assert.deepEqual(outcomes, { migrated: 1, skipped_size_limit: 1 }, "the on pass leaves it");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal((await control.status()).large.finishedAt, null, "the large pass is off by default");

  reset();
  const turned = await control.set(undefined, false, "on");
  assert.equal(turned.mode, "on");
  assert.equal(turned.large.mode, "on");
  await until(async () => (await control.status()).large.finishedAt, "the large pass", 120_000);
  await sweep.stop();
  assert.deepEqual(outcomes, { migrated: 1 });
  assert.equal(await count(db, `select count(*) as count from pi_durable_documents where session_id = $1 and kind = '"camel.host.snapshot"'`, [large]), 1);
  assert.equal(await count(db, `select count(*) as count from pi_durable_documents where session_id = $1 and kind = '"camel.host.snapshot"'`, [small]), 1);
  assert.equal((await control.status()).remaining, 0, "nothing is left on legacy");
  assert.equal((await control.status()).large.leasedUntil, null, "and the lease is given back");
  assert.equal(pi.supervisor.agents.size, 0);
});

test("the large pass takes one agent at a time across nodes, and only below its own memory limit", { timeout: 60_000 }, async t => {
  const { db } = await testDatabase();
  for (let i = 0; i < 6; i++) {
    await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ($1, 'default', '{}', 1, 'a', 'client', 'm')", [`client_${i}`]);
  }
  const control = new PiSweepControl(db, "on");
  // The on pass is done: what is left is the large pass's.
  await db.query("update pi_sweep set on_finished_at = $1", [Date.now()]);
  await control.set("on", false, "on");
  let inFlight = 0, most = 0, room = false;
  const taken: string[] = [];
  const sweeps = [0, 1].map(() => new PiSweep({
    db, setting: "on", paceMs: 0, largePaceMs: 0, repassMs: 60 * 60_000, pollMs: 10, backoffMs: [10, 20],
    busy: async large => large && !room ? "memory" : undefined,
    sweep: async (candidate, _dryRun, large) => {
      assert.ok(large);
      inFlight++; most = Math.max(most, inFlight);
      taken.push(candidate.id);
      await new Promise(resolve => setTimeout(resolve, 30));
      inFlight--;
      return { outcome: "migrated" };
    },
  }));
  t.after(() => Promise.all(sweeps.map(sweep => sweep.stop())));
  for (const sweep of sweeps) sweep.start();
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(taken, [], "short of its memory, it waits");
  room = true;
  await until(async () => (await control.status()).large.finishedAt, "the large pass");
  assert.equal(most, 1, "one at a time across the fleet");
  assert.deepEqual([...taken].sort(), taken.map((_, i) => `client_${i}`), "each once");
});

test("an agent its owner holds but never started is imported by the owner's sweep, in place; other nodes leave it", { timeout: 120_000 }, async t => {
  const { model, state } = await fixtureModel(t);
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db));
  const [watched, asked] = await legacyAgents(t, db, storage, model, ["watched", "asked"], [], ["watched", "asked"]);
  const a = await node(t, db, storage, "a");
  const b = await node(t, db, storage, "b");
  // Loaded on A, as a watcher's or an upsert's load does, and never started.
  const load = (id: string) => (a.sessions as unknown as { load(id: string): Promise<unknown> }).load(id);
  await load(watched);
  await load(asked);
  assert.equal(a.supervisor.agents.size, 0);
  const control = new PiSweepControl(db, "on");
  await control.set("on");

  // B leaves both: A holds them.
  const onB = sweeper(db, b.sessions, "on", undefined, "http://b");
  t.after(() => onB.sweep.stop());
  onB.sweep.start();
  await finished(db, "on");
  await onB.sweep.stop();
  assert.deepEqual(onB.outcomes, { skipped_hosted: 2 });
  assert.equal(await count(db, NATIVE), 0);

  // A imports `watched` where it is, and keeps it loaded, not started.
  const results: Record<string, PiSweepResult> = {};
  const onA = sweeper(db, a.sessions, "on", (id, result) => { results[id] = result; }, "http://a");
  t.after(() => onA.sweep.stop());
  // A request for `asked` comes while A's sweep imports it: it waits, then runs.
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const start = a.supervisor.start.bind(a.supervisor);
  a.supervisor.start = (async (...args: Parameters<typeof start>) => { if (args[0] === asked) { await held; a.supervisor.start = start; } return start(...args); }) as typeof start;
  await control.set("on", true);
  onA.sweep.start();
  await until(() => (a.sessions.sessions.get(asked) as { sweeping?: boolean } | undefined)?.sweeping, "the sweep's start of the asked agent");
  const prompted = prompt(a.sessions, asked, "while-importing");
  await new Promise(resolve => setTimeout(resolve, 50));
  release();
  await prompted;
  await finished(db, "on");
  await onA.sweep.stop();
  assert.deepEqual(results[watched], { outcome: "migrated", detail: { system: true, loadedHere: true } });
  assert.deepEqual(results[asked], { outcome: "migrated", detail: { system: true, loadedHere: true } });
  assert.equal(await count(db, NATIVE), 2);
  assert.ok(a.sessions.sessions.has(watched), "it stays loaded for whoever holds it");
  assert.ok(!a.supervisor.agents.has(watched), "and is not started");
  assert.ok(a.supervisor.agents.has(asked), "the request's start serves it");
  assert.equal(state.calls, 1, "only the request asked the model");
  assert.equal((await control.status()).remaining, 0);
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

test("the sweep takes no agent while the node is short of memory, its pool is waiting, its turns wait for their model, it is full or leaving", { timeout: 60_000 }, async t => {
  const reading = { leaving: false, dbWaiting: 0, memoryHigh: false, full: false, maxMemoryBytes: 1000, memoryBytes: async () => 500 };
  assert.equal(await piSweepGate(reading), undefined);
  assert.equal(await piSweepGate({ ...reading, memoryBytes: async () => 1001 }), "memory");
  assert.equal(await piSweepGate({ ...reading, memoryHigh: true }), "memory_high");
  assert.equal(await piSweepGate({ ...reading, dbWaiting: 1 }), "db_waiting");
  assert.equal(await piSweepGate({ ...reading, full: true }), "node_full");
  assert.equal(await piSweepGate({ ...reading, leaving: true }), "leaving");
  assert.equal(await piSweepGate({ ...reading, firstRequestP95: 9000, maxFirstRequestMs: 8000 }), "turn_latency");
  assert.equal(await piSweepGate({ ...reading, firstRequestP95: 7000, maxFirstRequestMs: 8000 }), undefined);
  assert.equal(await piSweepGate({ ...reading, firstRequestP95: 9000, maxFirstRequestMs: 0 }), undefined, "0: no limit");
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
  const large = (await call("/v1/operations/pi-sweep", { method: "PUT", body: { large: "on" } })).json;
  assert.equal(large.large.mode, "on");
  assert.equal(large.mode, "on", "the mode as it was");
  assert.equal((await call("/v1/operations/pi-sweep", { method: "PUT", body: { large: "maybe" } })).status, 400);
  assert.equal((await call("/v1/operations/pi-sweep", { method: "PUT", body: { mode: "off" } })).json.effective, "off");
});
