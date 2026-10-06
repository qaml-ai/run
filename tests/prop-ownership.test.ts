import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import fc from "fast-check";
import FakeTimers from "@sinonjs/fake-timers";
import { LostClaim, Ownership, underClaim, type Claim } from "../src/ownership.ts";
import type { Db } from "../src/db.ts";
import { pgliteDb, type PgliteDb } from "./pglite.ts";
import { check, replayableCommands, turns } from "./prop-helpers.ts";

/**
 * Model-based test of the ownership lease (src/ownership.ts) on PGlite, with every clock virtual: the database's
 * `now()` and each node's `performance.now()` and timers. Three nodes share two actors through acquire, release,
 * fenced writes (`underClaim`), heartbeats (on their own timers), reaping and self-fencing, while the test moves time,
 * stalls a node's event loop, cuts it off from its peers or the database, crashes and restarts it, fences it, and
 * fails, loses the answer to, or delays one of its statements. Each node's local clock has its own offset and runs
 * up to 5% fast or slow.
 *
 * The abstract lease model: a node's session publishes an expiry on the database clock with each registration and
 * renewal; a claim (actor, session, epoch) is current while the actor's row names it. After every step:
 *
 * - I1: epochs per actor only grow, every acquire returns a higher epoch than any before it, and the fenced writes
 *   that commit for an actor are in epoch order, one session per epoch. Only the current claim's write commits.
 * - I6: `holds(claim)` is false no later than the expiry its session last published (on the database clock).
 * - I1/I6: while a node holds a claim, no other node holds a later one, except a node peers reaped while it still
 *   ran (a timed-out probe: H1 in the correctness design), and then only until the reaped node's published expiry.
 *   The longest such window is printed.
 * - I1 (single active executor): a node peers reaped while it ran is not `fresh`, so it makes no model or tool call,
 *   from the moment they reaped it; in particular, no two holders of one actor are both fresh.
 */

const TTL = 6_000;
const NODES = ["http://a", "http://b", "http://c"];
const ACTORS = ["agent_x", "agent_y"];
const DB_EPOCH = Date.parse("2030-01-01T00:00:00Z");

type Fault = "fail" | "lostAck" | "slow";
type FakeClock = ReturnType<ReturnType<typeof FakeTimers.withGlobal>["createClock"]>;

/** The node whose code is running, so `performance.now()` and timers resolve to its clock. */
const current = new AsyncLocalStorage<SimNode>();
const fakeTimers = new WeakMap<object, FakeClock>();
const unavailable = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

class SimNode {
  ownership!: Ownership;
  db!: Db;
  clock!: FakeClock;
  dead = false;
  stalled = false;
  /** Cut off from its peers: their probes time out, and so do its own. */
  peerCut = false;
  dbCut = false;
  fault?: { kind: Fault; ms: number };
  inflight = 0;
  /** The latest claim this node got per actor, and whether it released it since. */
  claims = new Map<string, { claim: Claim; released: boolean }>();
  /** Peers reaped this node's session while it still ran: the database time, by session. */
  reapedAlive = new Map<string, number>();
  readonly world: World;
  readonly name: string;
  readonly offset: number;
  readonly ratePermille: number;
  constructor(world: World, name: string, offset: number, ratePermille: number) { this.world = world; this.name = name; this.offset = offset; this.ratePermille = ratePermille; }
  /** Local time (ms) at global time `t`. Integer, so fake timers fire exactly when due. */
  localAt(t: number) { return this.offset + Math.floor(t * this.ratePermille / 1000); }
  /** The first global time at which local time reaches `local`. */
  globalAt(local: number) {
    let t = Math.max(0, Math.ceil((local - this.offset) * 1000 / this.ratePermille) - 1);
    while (this.localAt(t) < local) t++;
    return t;
  }
  localNow() { return this.localAt(this.world.t); }
  run<T>(work: () => T): T { return current.run(this, work); }
  get running() { return !this.dead && !this.stalled; }
  /** When this node's next timer is due, on its local clock. */
  nextDue() {
    let due: number | undefined;
    for (const timer of (this.clock as unknown as { timers?: Map<number, { callAt: number }> }).timers?.values() ?? []) due = due === undefined ? timer.callAt : Math.min(due, timer.callAt);
    return due;
  }
  /** Fire every timer due by local time now (late ones too, as after a stall). */
  catchUp() { const lag = this.localNow() - this.clock.now; if (lag > 0) this.run(() => this.clock.tick(lag)); }

  start() {
    this.clock = FakeTimers.withGlobal(globalThis).createClock(this.localNow(), 10_000);
    this.dead = false; this.stalled = false; this.peerCut = false; this.dbCut = false; this.fault = undefined;
    this.claims.clear();
    const world = this.world;
    const node = this;
    const statement = async (text: string, values: unknown[] | undefined, send: () => Promise<any>, inTransaction = false) => {
      node.inflight++;
      try {
        if (node.dead || node.dbCut) throw unavailable();
        const fault = node.fault;
        node.fault = undefined;
        if (fault?.kind === "fail") throw unavailable();
        // A slow statement: the database runs it `ms` later; every node's timers meanwhile are late.
        // (Not inside a transaction: the clock is a row, and the transaction has PGlite's one session.)
        if (fault?.kind === "slow" && !inTransaction) await world.jump(fault.ms);
        const result = await current.exit(send);
        if (/runtime_nodes/.test(text) && /^\s*(insert|update)/.test(text)) await world.published(node.name);
        if (/^\s*delete from runtime_nodes/.test(text) && result.rowCount) world.reaped(values![0] as string, values![1] as string);
        if (fault?.kind === "lostAck") throw unavailable();
        return result;
      } finally { node.inflight--; }
    };
    const db = this.db = {
      query: (text: string, values?: unknown[]) => statement(text, values, () => world.base.query(text, values)),
      connect: async () => {
        if (node.dead || node.dbCut) throw unavailable();
        const client = await current.exit(() => (world.base as any).connect());
        return { ...client, query: (text: string, values?: unknown[]) => text === "rollback" ? current.exit(() => client.query(text, values)) : statement(text, values, () => client.query(text, values), true) };
      },
    } as unknown as Db;
    this.ownership = new Ownership(db, {
      node: this.name, ttlMs: TTL,
      alive: async peer => {
        const other = world.nodes.find(candidate => candidate.name === peer);
        // A process that is gone refuses the connection; one cut off (or a prober cut off) times out.
        return !!other && !other.dead && !other.peerCut && !node.peerCut;
      },
    });
    return this.run(() => this.ownership.start()).catch(() => {});
  }
}

class World {
  t = 0;
  nodes: SimNode[] = [];
  /** The latest expiry each session published, on the database clock (ms). */
  expiries = new Map<string, number>();
  /** The highest epoch acquire returned per actor, and the epoch its row had at the last check. */
  epochs = new Map<string, number>();
  rowEpochs = new Map<string, number>();
  /** The longest time a reaped node still held a claim a peer had taken (ms). */
  dualMs = 0;
  log: string[] = [];
  readonly sim: PgliteDb;
  readonly base: Db;
  constructor(sim: PgliteDb, base: Db) { this.sim = sim; this.base = base; }
  dbNow() { return DB_EPOCH + this.t; }
  async setTime(t: number) { if (t > this.t) { this.t = t; await this.sim.setClock(this.dbNow()); } }
  /** Move time forward without running any timer: everything is late (a slow statement, or a stall). */
  jump(ms: number) { return this.setTime(this.t + ms); }
  async published(node: string) {
    const { rows } = await this.base.query("select session, expires_at from runtime_nodes where node = $1", [node]);
    for (const row of rows) {
      this.expiries.set(row.session, Math.max(this.expiries.get(row.session) ?? 0, new Date(row.expires_at).getTime()));
      // A registration whose answer was lost leaves the node unregistered under the same session; if peers reap that
      // heartbeat, the node's next registration writes it again. Peers ended the old row, which named no claims (none
      // is taken before a registration succeeds); the new one is live, so the earlier reap no longer applies.
      this.nodes.find(candidate => candidate.name === node)?.reapedAlive.delete(row.session);
    }
  }
  reaped(node: string, session: string) {
    const victim = this.nodes.find(candidate => candidate.name === node);
    if (victim && !victim.dead && victim.ownership.sessionId === session) { victim.reapedAlive.set(session, this.dbNow()); seen.reapedAlive++; }
  }
  /** Wait until no node has a statement in flight. */
  async settle() {
    for (let quiet = 0; quiet < 3;) {
      await turns(5);
      quiet = this.nodes.some(node => node.inflight) ? 0 : quiet + 1;
    }
  }
  /** Advance global time by `ms`, firing each running node's timers in time order, checking after each. */
  async advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      let next: { node: SimNode; at: number } | undefined;
      for (const node of this.nodes) {
        if (!node.running) continue;
        const due = node.nextDue();
        if (due === undefined) continue;
        const at = node.globalAt(due);
        if (at <= target && (!next || at < next.at)) next = { node, at };
      }
      if (!next) break;
      await this.setTime(next.at);
      next.node.catchUp();
      await this.settle();
      await this.check(`timers of ${next.node.name} at ${this.t}`);
    }
    await this.setTime(target);
    for (const node of this.nodes) if (node.running) node.catchUp();
    await this.settle();
  }

  async check(where: string) {
    const owners = new Map((await this.base.query("select actor, node, session, epoch from actor_owners")).rows.map(row => [row.actor as string, row]));
    for (const actor of ACTORS) {
      const epoch = owners.get(actor)?.epoch ?? 0;
      assert.ok(epoch >= (this.rowEpochs.get(actor) ?? 0), `${where}: I1: ${actor}'s epoch went back to ${epoch}`);
      this.rowEpochs.set(actor, epoch);
    }
    const holders: { node: SimNode; claim: Claim }[] = [];
    for (const node of this.nodes) {
      if (!node.running) continue;
      for (const { claim, released } of node.claims.values()) {
        if (released || !node.run(() => node.ownership.holds(claim))) continue;
        holders.push({ node, claim });
        // I6: no claim is held past the expiry its session published.
        const expiry = this.expiries.get(claim.session);
        assert.ok(expiry !== undefined && this.dbNow() < expiry, `${where}: ${node.name} holds ${claim.actor}@${claim.epoch} at ${this.dbNow() - DB_EPOCH}, its session's published expiry was ${expiry === undefined ? "never" : expiry - DB_EPOCH}`);
      }
    }
    // I1: a node peers reaped makes no effects (H1's fix: effects wait for a fresh lease).
    for (const node of this.nodes) {
      if (node.running && node.reapedAlive.has(node.ownership.sessionId)) assert.ok(!node.run(() => node.ownership.fresh()), `${where}: ${node.name} is fresh though peers reaped it`);
    }
    // I1: one holder per actor, but for H1 (bounded by the reaped node's published expiry, checked above).
    for (const a of holders) for (const b of holders) {
      if (a.claim.actor !== b.claim.actor || a.claim.session === b.claim.session || a.claim.epoch >= b.claim.epoch) continue;
      const reapedAt = a.node.reapedAlive.get(a.claim.session);
      assert.ok(reapedAt !== undefined, `${where}: ${a.node.name} holds ${a.claim.actor}@${a.claim.epoch} while ${b.node.name} holds @${b.claim.epoch}, and peers never reaped ${a.node.name}`);
      this.dualMs = Math.max(this.dualMs, this.dbNow() - reapedAt);
      seen.dual++;
    }
  }
}

type Command = fc.AsyncCommand<object, World>;
const command = (name: string, run: (world: World) => Promise<void>): Command => ({
  check: () => true, toString: () => name,
  async run(_model, world) { world.log.push(name); await run(world); await world.settle(); await world.check(name); },
});
const pick = (world: World, index: number) => world.nodes[index % world.nodes.length];

const acquire = (index: number, actor: string) => command(`acquire(${NODES[index]}, ${actor})`, async world => {
  const node = pick(world, index);
  seen.acquires++;
  if (!node.running) { seen.notRunning++; return; }
  let result: Awaited<ReturnType<Ownership["acquire"]>>;
  try { result = await node.run(() => node.ownership.acquire(actor)); }
  catch (error) { const key = (error as Error).message.slice(0, 40); seen.acquireErrors[key] = (seen.acquireErrors[key] ?? 0) + 1; return; }
  if ("owner" in result) {
    seen.owners++; assert.notEqual(result.owner, node.name, "acquire names another node as the owner, never this one"); return; }
  const before = world.epochs.get(actor) ?? 0;
  assert.ok(result.claim.epoch > before, `I1: acquire by ${node.name} returned ${actor}@${result.claim.epoch}, not above ${before}`);
  world.epochs.set(actor, result.claim.epoch);
  seen.claims++;
  if (world.nodes.some(other => other !== node && other.claims.get(actor)?.released === false)) seen.takeovers++;
  node.claims.set(actor, { claim: result.claim, released: false });
});
const release = (index: number, actor: string) => command(`release(${NODES[index]}, ${actor})`, async world => {
  const node = pick(world, index);
  const entry = node.claims.get(actor);
  if (!node.running || !entry) return;
  entry.released = true;
  await node.run(() => node.ownership.release(entry.claim)).catch(() => {});
});
/**
 * A durable write under the node's claim, fenced by `underClaim`. `checked`: as the runtime makes one, only while `holds`;
 * otherwise as a write decided before the node stalled or lost its claim, which only the fence stops.
 */
const write = (index: number, actor: string, checked: boolean) => command(`write(${NODES[index]}, ${actor}${checked ? "" : ", unchecked"})`, async world => {
  const node = pick(world, index);
  const entry = node.claims.get(actor);
  if (!node.running || !entry || (checked && (entry.released || !node.run(() => node.ownership.holds(entry.claim))))) return;
  const { claim } = entry;
  const row = (await world.base.query("select session, epoch from actor_owners where actor = $1", [actor])).rows[0];
  try {
    await node.run(() => underClaim(node.db, claim, sql => sql.query("insert into effects (actor, epoch, session) values ($1, $2, $3)", [actor, claim.epoch, claim.session])));
  } catch (error) {
    if (!(error instanceof LostClaim)) return;
    seen.fenced++;
    assert.ok(row.session !== claim.session || row.epoch !== claim.epoch, `${node.name}'s write under its current claim ${actor}@${claim.epoch} was fenced`);
    return;
  }
  seen.committed++;
  assert.ok(row?.session === claim.session && row.epoch === claim.epoch, `I1: ${node.name}'s write under ${actor}@${claim.epoch} committed, but the current claim is ${row?.session === claim.session ? "its" : "another session's"} @${row?.epoch}`);
});
const advance = (ms: number) => command(`advance(${ms})`, world => world.advance(ms));
/** The node's event loop is blocked for `ms`: its timers and code wait while the others run. */
const stall = (index: number, ms: number) => command(`stall(${NODES[index]}, ${ms})`, async world => {
  const node = pick(world, index);
  if (node.dead) return;
  node.stalled = true;
  try { await world.advance(ms); } finally { node.stalled = false; }
  // Its overdue timers (the watchdog) need not run first: a request's callback may check `holds` before them.
  await world.check(`${node.name} resumes before its timers`);
  node.catchUp();
});
const cut = (index: number, peers: boolean, db: boolean) => command(`cut(${NODES[index]}, peers ${peers}, db ${db})`, async world => {
  const node = pick(world, index);
  node.peerCut = peers; node.dbCut = db;
});
const crash = (index: number) => command(`crash(${NODES[index]})`, async world => { pick(world, index).dead = true; });
const restart = (index: number) => command(`restart(${NODES[index]})`, async world => {
  const node = pick(world, index);
  if (!node.dead) return;
  await node.start();
});
const fence = (index: number) => command(`fence(${NODES[index]})`, async world => {
  const node = pick(world, index);
  if (node.running) node.run(() => node.ownership.fence("test"));
});
const fault = (index: number, kind: Fault, ms: number) => command(`fault(${NODES[index]}, ${kind}${kind === "slow" ? ` ${ms}` : ""})`, async world => {
  const node = pick(world, index);
  if (node.running) node.fault = { kind, ms };
});

const nodeIndex = fc.integer({ min: 0, max: NODES.length - 1 });
const actor = fc.constantFrom(...ACTORS);
const weighted = <T>(entries: [fc.Arbitrary<T>, number][]) => entries.flatMap(([arbitrary, weight]) => Array.from({ length: weight }, () => arbitrary));
const commands = weighted<Command>([
  [fc.tuple(nodeIndex, actor).map(([index, name]) => acquire(index, name)), 4],
  [fc.tuple(nodeIndex, actor, fc.boolean()).map(([index, name, checked]) => write(index, name, checked)), 4],
  [fc.tuple(nodeIndex, actor).map(([index, name]) => release(index, name)), 1],
  [fc.constantFrom(300, 1_000, 2_500, TTL).map(advance), 4],
  [fc.tuple(nodeIndex, fc.constantFrom(800, 2_500, 4_000, TTL)).map(([index, ms]) => stall(index, ms)), 1],
  [fc.tuple(nodeIndex, fc.boolean(), fc.boolean()).map(([index, peers, db]) => cut(index, peers, db)), 2],
  [nodeIndex.map(crash), 1],
  [nodeIndex.map(restart), 1],
  [nodeIndex.map(fence), 1],
  [fc.tuple(nodeIndex, fc.constantFrom<Fault>("fail", "lostAck", "slow"), fc.constantFrom(500, 2_000, 4_000)).map(([index, kind, ms]) => fault(index, kind, ms)), 2],
]);

let sim: PgliteDb;
const real = { setTimeout, clearTimeout, setInterval, clearInterval, now: performance.now };
before(async () => {
  sim = await pgliteDb({ migrations: ["001_coordination.sql", "002_node_draining.sql"] });
  await sim.db.query("create table effects (id serial primary key, actor text not null, epoch bigint not null, session uuid not null)");
  // Timers and performance.now() resolve to the running node's clocks; everything else keeps the real ones.
  const fake = (name: "setTimeout" | "setInterval") => (callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const node = current.getStore();
    if (!node) return (real[name] as Function)(callback, ms, ...args);
    const timer = node.clock[name](callback, ms ?? 0, ...args) as unknown as object;
    fakeTimers.set(timer, node.clock);
    return timer;
  };
  const clear = (name: "clearTimeout" | "clearInterval") => (timer: unknown) => {
    const clock = timer && typeof timer === "object" ? fakeTimers.get(timer) : undefined;
    if (clock) clock[name](timer as any); else (real[name] as Function)(timer);
  };
  Object.assign(globalThis, { setTimeout: fake("setTimeout"), setInterval: fake("setInterval"), clearTimeout: clear("clearTimeout"), clearInterval: clear("clearInterval") });
  performance.now = () => current.getStore()?.localNow() ?? real.now.call(performance);
});
after(async () => {
  Object.assign(globalThis, { setTimeout: real.setTimeout, setInterval: real.setInterval, clearTimeout: real.clearTimeout, clearInterval: real.clearInterval });
  performance.now = real.now;
  await sim.close();
});

/** A cluster of three started nodes whose clocks have the given offsets and rates, for `work`. */
async function withCluster(clocks: { offset: number; rate: number }[], work: (world: World) => Promise<void>) {
  for (const table of ["runtime_nodes", "actor_owners", "effects"]) await sim.db.query(`delete from ${table}`);
  await sim.setClock(DB_EPOCH);
  const world = new World(sim, sim.db);
  world.nodes = NODES.map((name, index) => new SimNode(world, name, clocks[index].offset, clocks[index].rate));
  try {
    for (const node of world.nodes) await node.start();
    await world.settle();
    await work(world);
    // I1: the fenced writes that committed are in epoch order per actor, one session per epoch.
    const { rows } = await sim.db.query("select actor, epoch, session from effects order by id");
    const last = new Map<string, { epoch: number; session: string }>();
    for (const row of rows) {
      const previous = last.get(row.actor);
      if (previous) {
        assert.ok(row.epoch >= previous.epoch, `I1: ${row.actor}'s writes went back from epoch ${previous.epoch} to ${row.epoch}`);
        assert.ok(row.epoch > previous.epoch || row.session === previous.session, `I1: two sessions wrote ${row.actor} under epoch ${row.epoch}`);
      }
      last.set(row.actor, row);
    }
  } finally {
    for (const node of world.nodes) node.dead = true;
    await world.settle();
  }
}

const clocks = fc.array(fc.record({ offset: fc.integer({ min: 0, max: 1_000_000 }), rate: fc.integer({ min: 950, max: 1_050 }) }), { minLength: NODES.length, maxLength: NODES.length });
/** How often the interesting things happened, over all runs: a property that never reaches them proves nothing. */
const seen = { acquires: 0, notRunning: 0, acquireErrors: {} as Record<string, number>, owners: 0, claims: 0, takeovers: 0, committed: 0, fenced: 0, reapedAlive: 0, dual: 0, longestDualMs: 0 };

test("ownership: one holder per epoch, epochs only grow, and no claim outlives its published expiry (I1, I6)", async t => {
  await check(t, fc.asyncProperty(clocks, replayableCommands(commands, { maxCommands: 40, size: "max" }), (cl, cmds) => withCluster(cl, async world => {
    await fc.asyncModelRun(() => ({ model: {}, real: world }), cmds);
    await world.advance(2 * TTL);
    seen.longestDualMs = Math.max(seen.longestDualMs, world.dualMs);
  })), { runs: 100 });
  console.log(JSON.stringify({ type: "ownership_coverage", ...seen }));
});
