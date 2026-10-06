import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fc from "fast-check";
import FakeTimers from "@sinonjs/fake-timers";
import { PreconditionFailed, segmentLog, type SegmentStore } from "../shared/storage.ts";
import type { AppendLog } from "../shared/append-log.ts";
import { postgresTail } from "../src/log-tail.ts";
import type { Claim } from "../src/ownership.ts";
import type { Db } from "../src/db.ts";
import { pgliteDb, type PgliteDb } from "./pglite.ts";
import { check, turns } from "./prop-helpers.ts";

/**
 * Model-based test of `segmentLog` (shared/storage.ts) over `postgresTail` (src/log-tail.ts) on PGlite,
 * against a reference model: the log is `committed` (every record a durable flush or rewrite acknowledged)
 * followed by some prefix of `pending` (appended, not acknowledged). Every read anywhere must be exactly
 * that, and no shorter than a prefix a reader already saw:
 *
 * - I2, no acknowledged write lost: across flushes, compactions (on close, and past the tail's bound),
 *   folds into snapshots, rewrites, crashes, takeovers, lost acks and failed object writes.
 * - I7, gap-free order, and a fenced writer's records never appear after a successor's: a stale writer
 *   (its claim taken over, its process alive) keeps appending, flushing, rewriting and compacting.
 * - The current owner is never fenced: a writer whose claim is current never fails with "another owner".
 *
 * Each writer runs in a simulated process (`Proc`) with its own connection and object-store client, which
 * a crash cuts and faults act on. Coalesced (non-durable) flushes run on fake timers, fired by `Tick`.
 */

const BIG = "x".repeat(70_000);
type Rec = { id: string; pad?: string };
const ids = (records: Rec[]) => records.map(record => record.id);

const unavailable = () => Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
type Fault = "lostAck" | "unavailable" | "createFails" | "dieAfterCreate";
const isFence = (error: unknown) => error instanceof PreconditionFailed && /another owner/.test((error as Error).message);

/** An in-memory object store for one log: create-if-absent, as S3 conditional writes. */
function objectStore(objects: Map<string, string>): SegmentStore {
  return {
    async list() {
      const names = [...objects.keys()];
      return {
        segments: names.filter(name => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b),
        snapshots: names.filter(name => name.startsWith("snapshot-")).map(name => Number(name.slice(9))).sort((a, b) => a - b),
        bytes: new Map(names.map(name => [name, Buffer.byteLength(objects.get(name)!)])),
      };
    },
    async read(name) { const body = objects.get(name); if (body === undefined) throw new Error(`Missing log object ${name}`); return body; },
    async create(name, body) { if (objects.has(name)) throw new PreconditionFailed(name); objects.set(name, body); },
    async remove(names) { for (const name of names) objects.delete(name); },
  };
}

/** A writer's process: its database connection and object-store client. Dead, every call fails; a fault fires once. */
class Proc {
  dead = false;
  inflight = 0;
  fault?: Fault;
  /** While set, every call waits for it first: a scheduler orders this process's calls against another's. */
  gate?: (label: string) => Promise<void>;
  readonly db: Db;
  readonly store: SegmentStore;
  constructor(base: Db, objects: Map<string, string>) {
    const tracked = async <T>(work: () => Promise<T>, label = "") => {
      if (this.gate) await this.gate(label);
      this.inflight++;
      try { return await work(); } finally { this.inflight--; }
    };
    const statement = (query: (text: string, values?: unknown[]) => Promise<any>) => (text: string, values?: unknown[]) => tracked(async () => {
      // A dead process's connection is gone: the server rolls its transaction back.
      if (this.dead && text !== "rollback") throw unavailable();
      const insert = text.includes("insert into log_records");
      if (insert && this.fault === "unavailable") { this.fault = undefined; throw unavailable(); }
      const result = await query(text, values);
      if (insert && this.fault === "lostAck") { this.fault = undefined; throw unavailable(); }
      return result;
    }, `sql ${text.trim().split(/\s+/).slice(0, 4).join(" ")}`);
    this.db = {
      query: statement((text, values) => base.query(text, values)),
      connect: async () => {
        const client = await base.connect();
        return { query: statement((text, values) => client.query(text, values)), release: (error?: Error) => client.release(error), on() {}, off() {} };
      },
    } as unknown as Db;
    const real = objectStore(objects);
    const alive = () => { if (this.dead) throw new Error("process gone"); };
    this.store = {
      list: () => tracked(async () => { alive(); return real.list(); }, "list"),
      read: name => tracked(async () => { alive(); return real.read(name); }, `read ${name}`),
      create: (name, body) => tracked(async () => {
        alive();
        if (this.fault === "createFails") { this.fault = undefined; throw new Error("object store unavailable"); }
        await real.create(name, body);
        if (this.fault === "dieAfterCreate") { this.fault = undefined; this.dead = true; }
      }, `create ${name}`),
      remove: (names, sizes) => tracked(async () => { alive(); return real.remove(names, sizes); }, `remove ${names.join(",")}`),
    };
  }
}

interface Model {
  committed: string[];
  pending: string[];
  /** How many of `pending` some reader has seen in the log already. */
  seen: number;
  next: number;
  stale: number;
}

interface World {
  db: Db;
  objects: Map<string, string>;
  key: string;
  actor: string;
  claim: Claim;
  proc: Proc;
  writer: AppendLog<Rec>;
  stale: { proc: Proc; writer: AppendLog<Rec>; closed: boolean }[];
  procs: Proc[];
  clock: ReturnType<typeof FakeTimers.install>;
}

/** Every simulated process has finished what it started. */
async function settle(world: World) {
  for (let quiet = 0; quiet < 3;) {
    await turns(1);
    quiet = world.procs.some(proc => proc.inflight) ? 0 : quiet + 1;
  }
}

/** `actual` is the committed records then a prefix of the pending ones, no shorter than one seen before. */
function observe(model: Model, actual: string[], where: string) {
  assert.deepEqual(actual.slice(0, model.committed.length), model.committed, `${where}: every acknowledged record, in order`);
  const extra = actual.slice(model.committed.length);
  assert.deepEqual(extra, model.pending.slice(0, extra.length), `${where}: then only a prefix of the unacknowledged records`);
  assert.ok(extra.length >= model.seen, `${where}: no record a reader saw disappears (${extra.length} < ${model.seen})`);
  model.seen = extra.length;
}

/** What the log holds now is all it will ever hold of what was appended so far: the writer that appended the rest is gone. */
function settleOn(model: Model, actual: string[], where: string) {
  observe(model, actual, where);
  model.committed = actual;
  model.pending = [];
  model.seen = 0;
}

function process_(world: World) {
  const proc = new Proc(world.db, world.objects);
  world.procs.push(proc);
  return proc;
}

async function freshRead(world: World) {
  const proc = process_(world);
  return ids(await segmentLog<Rec>(proc.store, world.key, postgresTail(proc.db), undefined, { coalesceMs: 0 }).read());
}

/** A writer under the current claim in a new process: it reads the log first, as every owner does on load. */
async function open(world: World) {
  world.proc = process_(world);
  world.writer = segmentLog<Rec>(world.proc.store, world.key, postgresTail(world.proc.db), world.claim, { coalesceMs: 250 });
  return ids(await world.writer.read());
}

/** Another session (or the same one, re-acquiring) takes the actor: the epoch advances. */
async function takeover(world: World, sameSession: boolean) {
  const session = sameSession ? world.claim.session : randomUUID();
  const { rows } = await world.db.query("update actor_owners set session = $2, epoch = epoch + 1 where actor = $1 returning epoch", [world.actor, session]);
  world.claim = { actor: world.actor, session, epoch: rows[0].epoch };
}

/** The writer's process died (`dead`), or was cut off: a new owner takes over and loads the log. */
async function replace(model: Model, world: World, where: string) {
  world.proc.dead = true;
  await takeover(world, false);
  settleOn(model, await open(world), where);
}

const ownerError = (error: unknown, where: string) => {
  if (isFence(error)) assert.fail(`${where}: the current owner was fenced (${(error as Error).message})`);
};

type Command = fc.AsyncCommand<Model, World>;
/** A command: `run` against the model and the system together; `check` says when it applies. */
const command = (name: string | (() => string), run: (model: Model, world: World) => Promise<void>, check: (model: Readonly<Model>) => boolean = () => true): Command => ({
  check,
  async run(model, world) {
    await run(model, world);
    // A crash after an object write (a blob, a segment) fired somewhere in the command: the next owner takes over.
    if (world.proc.dead) await replace(model, world, `after a crash during ${String(this)}`);
  },
  toString: typeof name === "string" ? () => name : name,
});

const append = (count: number, big: boolean) => command(`append(${count}${big ? ", big" : ""})`, async (model, world) => {
  for (let index = 0; index < count; index++) {
    const id = big && index === 0 ? "BIG" : `r${model.next++}`;
    world.writer.append(id === "BIG" ? { id, pad: BIG } : { id });
    model.pending.push(id);
  }
});

const flush = (durable: boolean) => command(`flush(${durable ? "durable" : "coalesced"})`, async (model, world) => {
  try { await world.writer.flush(durable); }
  catch (error) { ownerError(error, "flush"); return; }
  if (durable) { model.committed.push(...model.pending); model.pending = []; model.seen = 0; }
});

/** Coalesced flushes' timers fire. */
const tick = command("tick", async (_model, world) => { world.clock.tick(300); await settle(world); });

const read = (fresh: boolean) => command(fresh ? "read(fresh reader)" : "read(owner)", async (model, world) => {
  let actual: string[];
  try { actual = fresh ? await freshRead(world) : ids(await world.writer.read()); }
  catch (error) { ownerError(error, "read"); throw error; }
  observe(model, actual, fresh ? "a reader" : "the owner's read");
});

const rewrite = (count: number) => command(`rewrite(${count})`, async (model, world) => {
  const records = Array.from({ length: count }, () => `s${model.next++}`);
  try {
    await world.writer.rewrite(() => records.map(id => ({ id })));
    model.committed = records; model.pending = []; model.seen = 0;
  } catch (error) {
    ownerError(error, "rewrite");
    // Not acknowledged: the log is what it was, or the snapshot if it landed after all; the buffer is discarded either way.
    const actual = await freshRead(world);
    if (actual.join() === records.join()) { model.committed = records; model.pending = []; model.seen = 0; }
    else settleOn(model, actual, "after a failed rewrite");
  }
});

/** Past the tail's bound (512 records), the writer compacts in the background. */
const bulk = command("bulk(520)", async (model, world) => {
  for (let index = 0; index < 520; index++) { const id = `b${model.next++}`; world.writer.append({ id }); model.pending.push(id); }
  try { await world.writer.flush(true); model.committed.push(...model.pending); model.pending = []; model.seen = 0; }
  catch (error) { ownerError(error, "bulk flush"); }
  await settle(world);
  if (world.proc.dead) await replace(model, world, "after a crash in a background compaction");
});

/** Unload (write and compact) and load again under the same claim; a crash mid-compaction is a takeover instead. */
const close = command("close+reopen", async (model, world) => {
  await world.writer.close();
  if (world.proc.dead) return replace(model, world, "after a crash mid-compaction");
  settleOn(model, await open(world), "reloaded after close");
});

const crash = command("crash", async (model, world) => { await replace(model, world, "after a crash"); });

/** The claim moves while the writer's process lives on (a partition, a stall): the old writer is stale. */
const takeoverCommand = (sameSession: boolean) => command(`takeover(${sameSession ? "same session, new epoch" : "new session"})`, async (model, world) => {
  world.stale.push({ proc: world.proc, writer: world.writer, closed: false });
  model.stale++;
  await takeover(world, sameSession);
  settleOn(model, await open(world), "the new owner's load");
});

type StaleOp = "flush" | "coalesced" | "rewrite" | "close" | "bulk";
/** A stale writer keeps going: whatever it writes is rejected and never shows up. */
const stale = (which: number, op: StaleOp) => command(`stale[${which}].${op}`, async (model, world) => {
  const writer = world.stale[which % world.stale.length];
  const add = (count: number) => { for (let index = 0; index < count; index++) writer.writer.append({ id: `x${model.next++}` }); };
  if (writer.closed && op !== "close") return;
  if (op === "flush" || op === "bulk") {
    add(op === "bulk" ? 520 : 1);
    // Fenced, or (a fault injected before the takeover) failed outright: never acknowledged.
    await assert.rejects(writer.writer.flush(true), "a stale writer's flush fails");
  } else if (op === "coalesced") {
    add(1);
    await writer.writer.flush(false);
    world.clock.tick(300);
    await settle(world);
  } else if (op === "rewrite") {
    await assert.rejects(writer.writer.rewrite(() => [{ id: `x${model.next++}` }]), "a stale writer's rewrite fails");
  } else {
    await writer.writer.close();
    writer.closed = true;
  }
  observe(model, await freshRead(world), `after a stale writer's ${op}`);
}, model => model.stale > 0);

type RaceOp = "flush" | "close" | "rewrite";
/**
 * The owner appends `count` records and flushes, unloads or rewrites, while another session takes the actor over, loads
 * the log and appends two records of its own: the scheduler interleaves the two processes' statements and object calls
 * (the fence-create race class, df91c1c). An acknowledged write of the old owner lands before everything of its
 * successor; nothing unacknowledged lands after it; the successor sees all that landed before it, and is never refused.
 */
const race = (scheduler: fc.Scheduler, op: RaceOp, count: number) => command(() => `race(${op}, ${count}) ${scheduler.report().map(task => task.label).join(" > ")}`, async (model, world) => {
  const old = { proc: world.proc, writer: world.writer };
  for (let index = 0; index < count; index++) { const id = `r${model.next++}`; old.writer.append({ id }); model.pending.push(id); }
  const snapshot = [`s${model.next++}`];
  const theirs = [`t${model.next++}`, `t${model.next++}`];
  const gate = (label: string) => scheduler.schedule(Promise.resolve(), label).then(() => {});
  const proc = process_(world);
  old.proc.gate = proc.gate = gate;
  const session = randomUUID();
  let claim: Claim | undefined;
  let writer: AppendLog<Rec> | undefined;
  const [mine, successor] = await scheduler.waitFor(Promise.allSettled([
    op === "flush" ? old.writer.flush(true) : op === "close" ? old.writer.close() : old.writer.rewrite(() => snapshot.map(id => ({ id }))),
    (async () => {
      const { rows } = await proc.db.query("update actor_owners set session = $2, epoch = epoch + 1 where actor = $1 returning epoch", [world.actor, session]);
      claim = { actor: world.actor, session, epoch: rows[0].epoch };
      writer = segmentLog<Rec>(proc.store, world.key, postgresTail(proc.db), claim, { coalesceMs: 250 });
      const loaded = ids(await writer.read());
      for (const id of theirs) writer.append({ id });
      await writer.flush(true);
      return loaded;
    })(),
  ]));
  // A background compaction the flush started may still be waiting on the scheduler: let it through, ungated from here on.
  old.proc.gate = proc.gate = undefined;
  await scheduler.waitIdle();
  await settle(world);
  if (successor.status === "rejected") assert.fail(`the successor failed: ${(successor.reason as Error)?.stack ?? successor.reason}`);
  const actual = await freshRead(world);
  assert.deepEqual(actual.slice(-theirs.length), theirs, "the successor's records come last");
  assert.deepEqual([...successor.value, ...theirs], actual, "the successor loaded everything that landed before it");
  const before = actual.slice(0, -theirs.length);
  const acked = mine.status === "fulfilled" && op !== "close";
  if (op === "rewrite" && before.join() === snapshot.join()) { /* the snapshot landed */ }
  else {
    assert.ok(!(acked && op === "rewrite"), "an acknowledged rewrite landed before the successor");
    observe(model, before, `before the successor (${op} ${mine.status})`);
    if (acked) assert.equal(before.length, model.committed.length + model.pending.length, "the acknowledged flush landed before the successor");
  }
  world.stale.push({ ...old, closed: op === "close" });
  model.stale++;
  world.proc = proc; world.writer = writer!; world.claim = claim!;
  model.committed = actual; model.pending = []; model.seen = 0;
});

/** The next call of a kind fails once: a lost ack (applied, then the connection dropped), an outage, an object write, a crash after an object write. */
const inject = (fault: Fault) => command(`inject(${fault})`, async (_model, world) => { world.proc.fault = fault; });

const commands = [
  fc.tuple(fc.integer({ min: 1, max: 3 }), fc.oneof({ arbitrary: fc.constant(false), weight: 9 }, { arbitrary: fc.constant(true), weight: 1 })).map(([count, big]) => append(count, big)),
  fc.boolean().map(flush),
  fc.oneof({ arbitrary: fc.constant(tick), weight: 3 }, { arbitrary: fc.constant(bulk), weight: 1 }),
  fc.boolean().map(read),
  fc.integer({ min: 0, max: 3 }).map(rewrite),
  fc.constant(close),
  fc.constant(crash),
  fc.boolean().map(takeoverCommand),
  fc.tuple(fc.nat(), fc.constantFrom<StaleOp>("flush", "coalesced", "rewrite", "close", "bulk")).map(([which, op]) => stale(which, op)),
  fc.constantFrom<Fault>("lostAck", "unavailable", "createFails", "dieAfterCreate").map(inject),
  fc.tuple(fc.scheduler(), fc.constantFrom<RaceOp>("flush", "close", "rewrite"), fc.integer({ min: 0, max: 3 })).map(([scheduler, op, count]) => race(scheduler, op, count)),
];

let database: PgliteDb;
let clock: ReturnType<typeof FakeTimers.install>;
let runs = 0;
before(async () => {
  database = await pgliteDb({ migrations: ["001_coordination.sql", "002_node_draining.sql", "003_log_records.sql"] });
  clock = FakeTimers.install({ toFake: ["setTimeout", "clearTimeout"] });
});
after(async () => { clock.uninstall(); await database.close(); });

/** A new log with one writer that has loaded it, for `work`; every process it started is cut off afterwards. */
async function withLog(work: (model: Model, world: World) => Promise<void>) {
  const db = database.db;
  const run = ++runs;
  const actor = `actor_${run}`;
  const world = { db, objects: new Map(), key: `agents/p${run}/log`, actor, stale: [], procs: [], clock } as unknown as World;
  world.claim = { actor, session: randomUUID(), epoch: 1 };
  await db.query("insert into actor_owners (actor, node, session, epoch) values ($1, 'node', $2, 1)", [actor, world.claim.session]);
  const model: Model = { committed: [], pending: [], seen: 0, next: 0, stale: 0 };
  try {
    settleOn(model, await open(world), "first load");
    await work(model, world);
  } finally {
    for (const proc of world.procs) proc.dead = true;
    clock.reset();
    await settle(world);
  }
}

test("segmentLog over postgresTail keeps every acknowledged record, in order, through crashes, takeovers and faults (I2, I7)", async t => {
  await check(t, fc.asyncProperty(fc.commands(commands, { maxCommands: 40 }), cmds => withLog(async (model, world) => {
    await fc.asyncModelRun(() => ({ model, real: world }), cmds);
    // Everything appended is acknowledged by a last durable flush, and the log is exactly the model's.
    world.proc.fault = undefined;
    try { await world.writer.flush(true); } catch (error) { ownerError(error, "final flush"); throw error; }
    assert.deepEqual(await freshRead(world), [...model.committed, ...model.pending], "the log is every acknowledged record, in order");
  })), { runs: 60 });
});

// Found by the property above (seed -117595555, path "10:6"), minimized: [inject(lostAck), rewrite(0), append(2), close+reopen].
// A rewrite whose row landed but whose answer was lost left the writer's next sequence number on the snapshot's row, so its
// next flush of two records collided there: that append failed, but its insert kept the row that did not collide, and the
// log read [r1], without r0.
test("a rewrite whose acknowledgement was lost leaves no gap, and its writer is not fenced", async () => {
  await withLog(async (model, world) => {
    world.proc.fault = "lostAck";
    await assert.rejects(world.writer.rewrite(() => []));
    await append(2, false).run(model, world);
    await world.writer.flush(true);
    assert.deepEqual(await freshRead(world), ["r0", "r1"]);
  });
});

// Found by the property after the fix above (seeds -809968565 and 1417365234), minimized: [append(1), inject(lostAck),
// flush(durable), rewrite(0)] fenced the owner (the snapshot collided with the failed batch's landed row), and
// [inject(lostAck), bulk(520), read(owner)] wrote the batch twice (the owner's read moved its position past the landed rows).
test("a failed flush whose rows landed is not written twice by a read, nor collided with by a rewrite", async () => {
  await withLog(async (model, world) => {
    world.proc.fault = "lostAck";
    await append(2, false).run(model, world);
    await assert.rejects(world.writer.flush(true));
    assert.deepEqual(ids(await world.writer.read()), ["r0", "r1"], "the batch landed");
    await world.writer.flush(true);
    assert.deepEqual(await freshRead(world), ["r0", "r1"], "and is there once");

    world.proc.fault = "lostAck";
    await append(1, false).run(model, world);
    await assert.rejects(world.writer.flush(true));
    await world.writer.rewrite(() => [{ id: "s" }]);
    await append(1, false).run(model, world);
    await world.writer.flush(true);
    assert.deepEqual(await freshRead(world), ["s", "r3"]);
  });
});

test("an append that collides with a different row at one of its sequence numbers inserts none of its rows", async () => {
  await withLog(async (_model, world) => {
    const tail = postgresTail(world.db);
    const row = (seq: number, body: string) => ({ seq, snapshot: false, body, blob: null });
    assert.equal(await tail.append(world.key, world.claim, [row(0, "a")]), true);
    assert.equal(await tail.append(world.key, world.claim, [row(0, "a"), row(1, "b")]), true, "a repeat of rows already there counts as written");
    assert.equal(await tail.append(world.key, world.claim, [row(1, "other"), row(2, "c")]), false);
    assert.deepEqual((await tail.rows(world.key)).map(found => found.body), ["a", "b"], "the row after the collision is not inserted");
  });
});
