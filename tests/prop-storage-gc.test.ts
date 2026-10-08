import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fc from "fast-check";
import FakeTimers from "@sinonjs/fake-timers";
import { memoryStorage, type Storage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { VolumeService } from "../src/volumes.ts";
import { StorageGc } from "../src/storage-gc.ts";
import type { Db } from "../src/db.ts";
import { testDatabase } from "./database.ts";
import { check } from "./prop-helpers.ts";

/**
 * GC reference safety (I10) for volumes' chunks, on the test Postgres. Rounds of volume operations (writes that store
 * content other files share, copies and moves between volumes by chunk list, removals, snapshots and their deletion,
 * forks, volume deletion, FileRef pins and their release) run at once with zero to two collections of the tenant, every
 * database statement and blob call of each ordered by `fc.scheduler()`. Time is virtual (Date advances 1 ms per call);
 * each collection's clock is skewed up to 20 ms against the writers', well inside the grace period, and rounds are
 * sometimes a grace period apart so candidates fall due.
 *
 * After every round, every chunk something refers to is stored: live volumes' files (as listed through the volume),
 * their snapshots' file maps (read from storage), and pins. References are found independently of the collector's own
 * mark. A file read that finds its chunk missing while a collection runs (deleted, then put back: H5 in the
 * correctness design) is counted, not failed.
 */

const TENANT = "acme";
const GRACE = 1_000;
const PATHS = ["/a", "/b", "/c"];
const CONTENTS = ["alpha", "beta", "gamma", "delta"];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const chunkKey = (hash: string) => `chunks/${TENANT}/${hash.slice(0, 2)}/${hash}`;

type Op =
  | { t: "write"; v: number; path: string; content: string }
  | { t: "copy"; from: number; path: string; to: number; as: string; move: boolean }
  | { t: "remove"; v: number; path: string }
  | { t: "snapshot"; v: number }
  | { t: "deleteSnapshot"; v: number; which: number }
  | { t: "fork"; v: number; fromSnapshot: boolean }
  | { t: "delete"; v: number }
  | { t: "pin"; v: number; path: string; agent: number }
  | { t: "unpin"; agent: number }
  | { t: "read"; v: number; path: string }
  | { t: "gc"; skew: number };
type Round = [ops: Op[], wait: boolean];

const seen = { rounds: 0, collections: 0, removed: 0, restored: 0, transientMisses: 0, opsFailed: 0 };

const failures: Record<string, number> = {};
let db: Db;
let clock: ReturnType<typeof FakeTimers.install>;
let runs = 0;
before(async () => {
  ({ db } = await testDatabase());
  clock = FakeTimers.install({ toFake: ["Date"], now: Date.parse("2030-01-01T00:00:00Z") });
});
after(() => clock.uninstall());

/** `db` and `storage` with each call first waiting on the round's scheduler, while one is set. */
function gated(base: Db, link: { gate?: (label: string) => Promise<void> }) {
  const wait = async (label: string) => { if (link.gate) { await link.gate(label); clock.tick(1); } };
  const label = (text: string) => text.trim().split(/\s+/).slice(0, 4).join(" ");
  const gatedDb = {
    query: async (text: string, values?: unknown[]) => { await wait(label(text)); return base.query(text, values); },
    connect: async () => {
      const client = await base.connect();
      return { query: async (text: string, values?: unknown[]) => { if (text !== "rollback") await wait(label(text)); return client.query(text, values); }, release: (error?: Error) => client.release(error), on: client.on.bind(client), off: client.off.bind(client) };
    },
  } as unknown as Db;
  const wrap = (storage: Storage & { blobs: Map<string, Uint8Array> }) => {
    const view = Object.create(storage) as typeof storage;
    for (const name of ["readBlob", "writeBlob", "removeBlob", "removeBlobs", "removeLog"] as const) {
      const original = (storage[name] as Function).bind(storage);
      (view as any)[name] = async (...args: unknown[]) => { await wait(`${name} ${String(args[0]).slice(0, 40)}`); return original(...args); };
    }
    return view;
  };
  return { db: gatedDb, wrap };
}

async function scenario(scheduler: fc.Scheduler, rounds: Round[]) {
  const run = ++runs;
  const link: { gate?: (label: string) => Promise<void> } = {};
  const { db: gatedDb, wrap } = gated(db, link);
  const raw = memoryStorage(postgresTail(gatedDb, { unfenced: true }));
  const storage = wrap(raw);
  const volumes = new VolumeService({ db: gatedDb, storage });
  const gc = new StorageGc({ db: gatedDb, storage, volumes, graceMs: GRACE });
  // Each scenario is its own tenant's world: rows from earlier scenarios are dropped first.
  for (const table of ["chunk_touches", "gc_candidates", "chunk_pins", "volume_snapshots", "volumes", "storage_gc"]) await db.query(`delete from ${table}`);
  const ids = [(await volumes.create(TENANT, { name: `v${run}a` })).id, (await volumes.create(TENANT, { name: `v${run}b` })).id];
  const snapshots = new Map<string, string[]>();
  const pick = (index: number) => ids[index % ids.length];
  const agent = (index: number) => `client_${run}_${index}`;
  try {
    for (const [ops, wait] of rounds) {
      seen.rounds++;
      if (wait) clock.tick(GRACE + 1);
      link.gate = label => scheduler.schedule(Promise.resolve(), label).then(() => {});
      const perform = async (op: Op) => {
        try {
          switch (op.t) {
            case "write": {
              const stored = await volumes.store(TENANT, Buffer.from(op.content));
              await volumes.call(pick(op.v), TENANT, "commit", { path: op.path, ...stored });
              break;
            }
            case "copy": {
              const entry = await volumes.call(pick(op.from), TENANT, "stat", { path: op.path });
              await volumes.call(pick(op.to), TENANT, "commit", { path: op.as, chunks: entry.chunks, size: entry.size });
              if (op.move) await volumes.call(pick(op.from), TENANT, "remove", { path: op.path });
              break;
            }
            case "remove": await volumes.call(pick(op.v), TENANT, "remove", { path: op.path }); break;
            case "snapshot": {
              const made = await volumes.call(pick(op.v), TENANT, "snapshot", {});
              snapshots.set(pick(op.v), [...snapshots.get(pick(op.v)) ?? [], made.id]);
              break;
            }
            case "deleteSnapshot": {
              const list = snapshots.get(pick(op.v)) ?? [];
              if (list.length) await volumes.call(pick(op.v), TENANT, "deleteSnapshot", { snapshot: list[op.which % list.length] });
              break;
            }
            case "fork": {
              const list = snapshots.get(pick(op.v)) ?? [];
              const made = await volumes.call(pick(op.v), TENANT, "fork", op.fromSnapshot && list.length ? { snapshot: list[0] } : {});
              ids.push(made.id);
              break;
            }
            case "delete": {
              // Kept to a live volume or more, so the rest of the scenario has somewhere to write.
              const id = pick(op.v);
              if (ids.length < 2) break;
              await volumes.call(id, TENANT, "delete");
              ids.splice(ids.indexOf(id), 1);
              break;
            }
            case "pin": {
              const entry = await volumes.call(pick(op.v), TENANT, "stat", { path: op.path });
              await volumes.pin(TENANT, agent(op.agent), entry.chunks);
              break;
            }
            case "unpin": await gatedDb.query("delete from chunk_pins where agent = $1", [agent(op.agent)]); break;
            case "read": {
              const entry = await volumes.call(pick(op.v), TENANT, "stat", { path: op.path });
              try { await volumes.readRange(TENANT, entry, 0, entry.size); }
              catch (error) { if (/missing or corrupt/.test((error as Error).message)) seen.transientMisses++; else throw error; }
              break;
            }
            case "gc": {
              const result = await gc.run(TENANT, Date.now() + op.skew);
              seen.collections++; seen.removed += result.removed; seen.restored += result.restored;
              break;
            }
          }
        } catch (error) {
          // A missing file, a deleted volume or snapshot: the operation does not apply now.
          if (typeof (error as { status?: number }).status !== "number") throw error;
          seen.opsFailed++;
          failures[`${op.t} ${(error as { status: number }).status}`] = (failures[`${op.t} ${(error as { status: number }).status}`] ?? 0) + 1;
        }
      };
      await scheduler.waitFor(Promise.all(ops.map(perform)));
      link.gate = undefined;
      await referencesStored(raw, volumes);
    }
  } finally {
    link.gate = undefined;
    await volumes.close();
  }
}

/** I10: every chunk a live volume's file, a live volume's snapshot or a pin refers to is stored. */
async function referencesStored(storage: Storage & { blobs: Map<string, Uint8Array> }, volumes: VolumeService) {
  const refs = new Map<string, string>();
  const { rows: live } = await db.query("select id from volumes where tenant = $1 and deleted_at is null", [TENANT]);
  for (const { id } of live) {
    const { files } = await volumes.call(id, TENANT, "list", { path: "/" });
    for (const file of files) for (const hash of file.chunks) refs.set(hash, `${id}${file.path}`);
  }
  const { rows: snaps } = await db.query("select s.id, s.volume from volume_snapshots s join volumes v on v.id = s.volume where v.tenant = $1 and v.deleted_at is null", [TENANT]);
  for (const { id, volume } of snaps) {
    const stored = await storage.readBlob(`volumes/${volume}/snapshots/${id}`);
    assert.ok(stored, `snapshot ${id} of ${volume} has its file map`);
    for (const [path, entry] of Object.entries(JSON.parse(Buffer.from(stored).toString("utf8")) as Record<string, { chunks: string[] }>)) for (const hash of entry.chunks) refs.set(hash, `${id}${path}`);
  }
  for (const { hash, agent } of (await db.query("select hash, agent from chunk_pins where tenant = $1", [TENANT])).rows) refs.set(hash, `pin of ${agent}`);
  for (const [hash, holder] of refs) {
    const content = CONTENTS.find(text => sha(text) === hash) ?? hash.slice(0, 12);
    assert.ok(storage.blobs.has(chunkKey(hash)), `I10: the chunk of "${content}" that ${holder} refers to is stored`);
  }
}

const v = fc.integer({ min: 0, max: 3 });
const path = fc.constantFrom(...PATHS);
const op: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant("write" as const), v, path, content: fc.constantFrom(...CONTENTS) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("copy" as const), from: v, path, to: v, as: path, move: fc.boolean() }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("remove" as const), v, path }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("snapshot" as const), v }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("deleteSnapshot" as const), v, which: fc.nat(3) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("fork" as const), v, fromSnapshot: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("delete" as const), v }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("pin" as const), v, path, agent: fc.nat(1) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("unpin" as const), agent: fc.nat(1) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("read" as const), v, path }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("gc" as const), skew: fc.integer({ min: -20, max: 20 }) }) },
);
// One scheduler orders every round: fast-check fails to shrink arrays of values that hold one (they are cloneable).
const round: fc.Arbitrary<Round> = fc.tuple(fc.array(op, { minLength: 1, maxLength: 5 }), fc.boolean());

test("storage GC never deletes a chunk a live volume, snapshot or pin refers to, whatever runs alongside it (I10)", async t => {
  await check(t, fc.asyncProperty(fc.scheduler(), fc.array(round, { minLength: 1, maxLength: 12 }), scenario), { runs: 100 });
  console.log(JSON.stringify({ type: "storage_gc_coverage", ...seen, failures }));
});
