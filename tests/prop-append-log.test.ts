import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { fileAppendLog, type AppendLog } from "../shared/append-log.ts";
import { check } from "./prop-helpers.ts";

/**
 * Model-based test of `fileAppendLog` (shared/append-log.ts), the single-host log: a JSONL file. The model is the
 * acknowledged records (a durable flush or a rewrite resolved) then some prefix of the rest. A crash keeps every
 * acknowledged byte and an arbitrary prefix of what was written after (a torn final record included); a new
 * writer then loads the log and carries on. Every read must be the acknowledged records then a prefix of the
 * others: a torn record is dropped, never a record acknowledged before or after it (I2, I7).
 */

type Rec = { id: string };

interface Model { committed: string[]; pending: string[]; next: number }
interface World { path: string; writer: AppendLog<Rec>; /** File bytes known durable: a crash keeps at least these. */ durable: number }

const ids = (records: Rec[]) => records.map(record => record.id);
const size = (path: string) => stat(path).then(found => found.size, () => 0);

function observe(model: Model, actual: string[], where: string) {
  assert.deepEqual(actual.slice(0, model.committed.length), model.committed, `${where}: every acknowledged record, in order`);
  const extra = actual.slice(model.committed.length);
  assert.deepEqual(extra, model.pending.slice(0, extra.length), `${where}: then a prefix of the others`);
}

type Command = fc.AsyncCommand<Model, World>;
const command = (name: string, run: (model: Model, world: World) => Promise<void>): Command => ({ check: () => true, run, toString: () => name });

const append = (count: number) => command(`append(${count})`, async (model, world) => {
  for (let index = 0; index < count; index++) { const id = `r${model.next++}`; world.writer.append({ id }); model.pending.push(id); }
});
const flush = (durable: boolean) => command(`flush(${durable ? "durable" : "written"})`, async (model, world) => {
  await world.writer.flush(durable);
  if (durable) { model.committed.push(...model.pending); model.pending = []; world.durable = await size(world.path); }
});
const rewrite = (count: number) => command(`rewrite(${count})`, async (model, world) => {
  const records = Array.from({ length: count }, () => `s${model.next++}`);
  await world.writer.rewrite(() => records.map(id => ({ id })));
  model.committed = records; model.pending = []; world.durable = await size(world.path);
});
const read = command("read", async (model, world) => observe(model, ids(await world.writer.read()), "read"));
/** The process dies: the file keeps what was durable and `keep` (0..1) of the bytes written after, cut anywhere. */
const crash = (keep: number) => command(`crash(keep ${keep.toFixed(2)})`, async (model, world) => {
  const length = await size(world.path);
  const kept = world.durable + Math.floor((length - world.durable) * keep);
  if (kept < length) await truncate(world.path, kept);
  world.writer = fileAppendLog<Rec>(world.path);
  const actual = ids(await world.writer.read());
  observe(model, actual, "the next process's load");
  model.committed = actual; model.pending = [];
  world.durable = kept;
});

const commands = [
  fc.integer({ min: 1, max: 3 }).map(append),
  fc.boolean().map(flush),
  fc.integer({ min: 0, max: 2 }).map(rewrite),
  fc.constant(read),
  // Not fc.double: it is biased to 0, 1 and denormals, so a crash would almost never cut inside a record.
  fc.integer({ min: 0, max: 1000 }).map(permille => crash(permille / 1000)),
];

let root: string;
let runs = 0;
before(async () => { root = await mkdtemp(join(tmpdir(), "prop-append-log-")); });
after(() => rm(root, { recursive: true, force: true }));

test("fileAppendLog keeps every acknowledged record, in order, across crashes that tear the last write (I2, I7)", async t => {
  await check(t, fc.asyncProperty(fc.commands(commands, { maxCommands: 30 }), async cmds => {
    const path = join(root, `log-${++runs}.jsonl`);
    const world: World = { path, writer: fileAppendLog<Rec>(path), durable: 0 };
    const model: Model = { committed: [], pending: [], next: 0 };
    try {
      await fc.asyncModelRun(() => ({ model, real: world }), cmds);
      await world.writer.flush(true);
      assert.deepEqual(ids(await fileAppendLog<Rec>(path).read()), [...model.committed, ...model.pending], "the log is every acknowledged record, in order");
    } finally { await world.writer.close(); }
  }), { runs: 100 });
});
