import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { checkStorageIntegrity } from "../src/storage-integrity.ts";
import { AgentSupervisor } from "../src/supervisor.ts";
import { testDatabase } from "./database.ts";

const hash = (name: string) => createHash("sha256").update(name).digest("hex");
const ref = (name: string) => ({ type: "file", path: `/workspace/${name}`, volume: "vol_1", version: 1, size: 10, contentType: "text/plain", chunks: [hash(name)] });

test("the storage check finds chunks a live agent or volume refers to that storage no longer has, and nothing else", async () => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const append = async (key: string, records: unknown[]) => {
    const log = storage.log<unknown>(key);
    await log.read();
    for (const record of records) log.append(record);
    await log.flush(true);
    await log.close();
  };
  const store = (tenant: string, ...names: string[]) => Promise.all(names.map(name => storage.writeBlob(`chunks/${tenant}/${hash(name).slice(0, 2)}/${hash(name)}`, Buffer.from(name))));

  // acme: a volume (with a file since deleted) and a snapshot; an agent with a FileRef whose chunk is gone; a purged agent's.
  await db.query("insert into volumes (id, tenant, name, created_at) values ('vol_1', 'acme', 'w', 0), ('vol_gone', 'acme', 'x', 0)");
  await db.query("update volumes set deleted_at = 1 where id = 'vol_gone'");
  await append("volumes/vol_1/tree", [
    { t: "put", seq: 1, path: "/kept.txt", entry: { chunks: [hash("kept")] } },
    { t: "put", seq: 2, path: "/old.txt", entry: { chunks: [hash("deleted-file")] } },
    { t: "del", seq: 3, path: "/old.txt", at: 3 },
    { t: "put", seq: 4, path: "/lost.txt", entry: { chunks: [hash("lost-in-volume")] } },
  ]);
  await append("volumes/vol_gone/tree", [{ t: "put", seq: 1, path: "/a", entry: { chunks: [hash("deleted-volume")] } }]);
  await db.query("insert into volume_snapshots (id, volume, name, seq, created_at, files, bytes) values ('snap_0000000000000001', 'vol_1', 's', 1, 0, 1, 1)");
  await storage.writeBlob("volumes/vol_1/snapshots/snap_0000000000000001", Buffer.from(JSON.stringify({ "/s.txt": { chunks: [hash("in-snapshot")] } })));
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ('client_a', 'acme', '{}', 1, 'a', 'general', 'm')");
  await db.query("insert into agents (id, tenant, header, revision, name, type, model, purged_at) values ('client_gone', 'acme', '{}', 1, 'g', 'general', 'm', 1)");
  await append(AgentSupervisor.transcriptKey("client_a"), [{ t: "message", message: { role: "user", content: [ref("kept"), ref("lost-in-agent")] } }]);
  await append(AgentSupervisor.transcriptKey("client_gone"), [{ t: "message", message: { role: "user", content: [ref("purged")] } }]);
  await store("acme", "kept", "in-snapshot");
  // other: everything still stored.
  await db.query("insert into agents (id, tenant, header, revision, name, type, model) values ('client_b', 'other', '{}', 1, 'b', 'general', 'm')");
  await append(AgentSupervisor.transcriptKey("client_b"), [{ t: "message", message: { role: "user", content: [ref("fine")] } }]);
  await store("other", "fine");

  const results = await checkStorageIntegrity({ db, storage });
  assert.deepEqual(results.map(row => ({ ...row, missingSample: row.missingSample.sort((a, b) => a.hash.localeCompare(b.hash)) })), [
    { tenant: "acme", agents: 1, volumes: 1, snapshots: 1, referenced: 4, stored: 2, missing: 2, unreadable: 0,
      missingSample: [{ hash: hash("lost-in-agent"), agent: "client_a" }, { hash: hash("lost-in-volume"), volume: "vol_1" }].sort((a, b) => a.hash.localeCompare(b.hash)) },
    { tenant: "other", agents: 1, volumes: 0, snapshots: 0, referenced: 1, stored: 1, missing: 0, unreadable: 0, missingSample: [] },
  ]);
  // A Storage that cannot list reads each chunk instead, with the same answer.
  const unlisted = { ...storage, objects: undefined };
  assert.deepEqual((await checkStorageIntegrity({ db, storage: unlisted, tenant: "acme" }))[0].missing, 2);
  assert.equal((await checkStorageIntegrity({ db, storage, sample: 1 }))[0].missingSample.length, 1, "the sample is capped across tenants");
});
