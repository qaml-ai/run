import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { verifyGcCandidates } from "../src/gc-verify.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { testDatabase } from "./database.ts";

const hash = (name: string) => createHash("sha256").update(name).digest("hex");
const ref = (name: string) => ({ type: "file", path: `/workspace/${name}`, volume: "vol_1", version: 1, size: 10, contentType: "text/plain", chunks: [hash(name)] });
const DAY = 24 * 60 * 60_000;

test("the GC check finds due candidates an unpinned FileRef still holds, and logged hashes anything refers to", async () => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const append = async (key: string, records: unknown[]) => {
    const log = storage.log<unknown>(key);
    await log.read();
    for (const record of records) log.append(record);
    await log.flush(true);
    await log.close();
  };
  const now = Date.now();
  // A live volume with a file (another was deleted), and a snapshot of an older one.
  await db.query("insert into volumes (id, tenant, name, created_at) values ('vol_1', 'acme', 'w', 0), ('vol_gone', 'acme', 'x', 0)");
  await db.query("update volumes set deleted_at = 1 where id = 'vol_gone'");
  await append("volumes/vol_1/tree", [
    { t: "put", seq: 1, path: "/kept.txt", entry: { chunks: [hash("in-volume")] } },
    { t: "put", seq: 2, path: "/old.txt", entry: { chunks: [hash("deleted-file")] } },
    { t: "del", seq: 3, path: "/old.txt", at: 3 },
  ]);
  await append("volumes/vol_gone/tree", [{ t: "put", seq: 1, path: "/a", entry: { chunks: [hash("deleted-volume")] } }]);
  await db.query("insert into volume_snapshots (id, volume, name, seq, created_at, files, bytes) values ('snap_0000000000000001', 'vol_1', 's', 1, 0, 1, 1)");
  await storage.writeBlob("volumes/vol_1/snapshots/snap_0000000000000001", Buffer.from(JSON.stringify({ "/s.txt": { chunks: [hash("in-snapshot")] } })));
  // A live agent holding a pinned FileRef and an unpinned one (from before pins); a purged agent's refs do not count.
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ('client_a', 'acme', '{}', 1, 'a', 'general', 'm')");
  await db.query("insert into agents (id, tenant, header, revision, name, type, model, purged_at) values ('client_gone', 'acme', '{}', 1, 'g', 'general', 'm', 1)");
  await append(AgentSupervisor.transcriptKey("client_a"), [{ t: "message", message: { role: "user", content: [ref("pinned"), ref("unpinned")] } }]);
  await append(AgentSupervisor.transcriptKey("client_gone"), [{ t: "message", message: { role: "user", content: [ref("purged")] } }]);
  await db.query("insert into chunk_pins (tenant, hash, agent) values ('acme', $1, 'client_a')", [hash("pinned")]);
  const due = now - 2 * DAY, fresh = now;
  for (const [name, seen] of [["in-volume", due], ["in-snapshot", due], ["deleted-file", due], ["deleted-volume", due], ["pinned", due], ["unpinned", due], ["purged", due], ["not-yet", fresh]] as const) {
    await db.query("insert into gc_candidates (tenant, hash, first_seen) values ('acme', $1, $2)", [hash(name), seen]);
  }
  await storage.writeBlob(`chunks/acme/${hash("deleted-file").slice(0, 2)}/${hash("deleted-file")}`, Buffer.from("x"));

  const logged = new Map([["acme", [hash("deleted-file"), hash("in-volume")]]]);
  const [check] = await verifyGcCandidates({ db, storage, now, logged, sample: 10 });
  assert.equal(check.tenant, "acme");
  assert.deepEqual([check.candidates, check.due, check.dueInVolumes, check.referencedAgain, check.unreadable], [8, 7, 2, 3, 0]);
  assert.deepEqual(check.unpinnedAgentRefs, [hash("unpinned")], "the one a collection would wrongly delete");
  assert.deepEqual(check.loggedReferenced, [hash("in-volume")], "a logged hash still in a volume");
  assert.deepEqual(check.sample.sort(), [hash("deleted-file"), hash("deleted-volume"), hash("purged")].sort(), "what is safe to delete");
  assert.equal(check.missing, 2, "of the safe ones, two are already gone from storage");
});
