import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { VolumeService } from "../src/volumes.ts";
import { StorageGc } from "../src/storage-gc.ts";
import { testDatabase } from "./database.ts";
import { runtime, until } from "./runtime-server.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const key = (text: string, tenant = "acme") => `chunks/${tenant}/${hash(text).slice(0, 2)}/${hash(text)}`;

async function setup(t: Context) {
  const { db } = await testDatabase();
  const metered = new Map<string, number>();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }), (name, bytes) => metered.set(name, (metered.get(name) ?? 0) + bytes));
  const volumes = new VolumeService({ db, storage });
  t.after(() => volumes.close());
  // No grace: a chunk unreferenced in two runs in a row goes.
  const gc = new StorageGc({ db, storage, volumes, graceMs: 0 });
  const write = async (id: string, path: string, content: string) => volumes.call(id, "acme", "commit", { path, ...await volumes.store("acme", Buffer.from(content)) });
  const collect = async () => { await gc.run("acme"); return gc.run("acme"); };
  return { db, storage, volumes, gc, write, collect, metered };
}

test("a deleted file's chunks stop being stored and metered; chunks a file still holds stay", async t => {
  const { storage, volumes, write, collect, metered } = await setup(t);
  const { id } = await volumes.create("acme", { name: "v" });
  await write(id, "/a.txt", "alpha");
  await write(id, "/b.txt", "beta");
  await volumes.call(id, "acme", "remove", { path: "/a.txt" });
  const result = await collect();
  assert.equal(result.removed, 1);
  assert.equal(storage.blobs.has(key("alpha")), false);
  assert.equal(storage.blobs.has(key("beta")), true);
  assert.equal(metered.get(key("alpha")), 0, "no longer counted as stored");
  const entry = await volumes.call(id, "acme", "stat", { path: "/b.txt" });
  assert.equal((await volumes.readRange("acme", entry, 0, entry.size)).toString(), "beta");
});

test("a chunk a FileRef pins stays after its file is deleted, until the agent holding the pin is purged", async t => {
  const { db, storage, volumes, write, collect } = await setup(t);
  const { id } = await volumes.create("acme", { name: "v" });
  const entry = await write(id, "/upload.pdf", "gamma");
  await volumes.pin("acme", "client_holder", entry.chunks);
  await volumes.call(id, "acme", "remove", { path: "/upload.pdf" });
  await collect();
  assert.equal(storage.blobs.has(key("gamma")), true, "the transcript still refers to it");
  await db.query("delete from chunk_pins where agent = 'client_holder'");
  await collect();
  assert.equal(storage.blobs.has(key("gamma")), false);
});

test("a deleted volume's chunks go once no fork or snapshot holds them, and its own objects go too", async t => {
  const { storage, volumes, write, collect } = await setup(t);
  const source = await volumes.create("acme", { name: "source" });
  await write(source.id, "/shared.txt", "delta");
  const fork = await volumes.call(source.id, "acme", "fork", {});
  const snapshotted = await volumes.create("acme", { name: "snapshotted" });
  await write(snapshotted.id, "/s.txt", "epsilon");
  const snapshot = await volumes.call(snapshotted.id, "acme", "snapshot", {});
  await volumes.call(snapshotted.id, "acme", "remove", { path: "/s.txt" });

  await volumes.call(source.id, "acme", "delete");
  await collect();
  assert.equal(storage.blobs.has(key("delta")), true, "the fork shares it");
  assert.equal(storage.blobs.has(key("epsilon")), true, "the snapshot holds it");
  assert.equal([...storage.logs.keys()].some(name => name.startsWith(`volumes/${source.id}/`)), false, "the deleted volume's tree is gone");

  await volumes.call(fork.id, "acme", "delete");
  await volumes.call(snapshotted.id, "acme", "deleteSnapshot", { snapshot: snapshot.id });
  assert.equal([...storage.blobs.keys()].some(name => name.includes(snapshot.id)), false, "a deleted snapshot's file map goes at once");
  await collect();
  assert.equal(storage.blobs.has(key("delta")), false);
  assert.equal(storage.blobs.has(key("epsilon")), false);
});

test("a chunk written again between two collections stays; one written as it is deleted is put back; one stored before collection existed is never touched", async t => {
  const { gc, storage, volumes, write, collect } = await setup(t);
  const { id } = await volumes.create("acme", { name: "v" });
  await write(id, "/z.txt", "zeta");
  await volumes.call(id, "acme", "remove", { path: "/z.txt" });
  await gc.run("acme");
  await write(id, "/again.txt", "zeta");
  await gc.run("acme");
  assert.equal(storage.blobs.has(key("zeta")), true, "written again: it is a file's once more");

  // A writer that stores the same bytes as the collector deletes them: its write finds the chunk there, so it is put back.
  await write(id, "/eta.txt", "eta");
  await volumes.call(id, "acme", "remove", { path: "/eta.txt" });
  await gc.run("acme");
  const remove = storage.removeBlob.bind(storage);
  storage.removeBlob = async name => { await remove(name); if (name === key("eta")) await volumes.store("acme", Buffer.from("eta")).then(() => {}, () => {}); };
  const racing = await gc.run("acme");
  storage.removeBlob = remove;
  assert.equal(racing.restored, 1);
  assert.equal(storage.blobs.has(key("eta")), true);

  await storage.writeBlob(key("legacy"), Buffer.from("legacy"));
  await collect();
  assert.equal(storage.blobs.has(key("legacy")), true, "only chunks written since collection began are collected");
});

test("on a runtime, an attachment's chunks are pinned to its agent, and collected once the agent and its workspace are deleted", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_PURGE_INTERVAL_MS: "1000", AGENT_GC_GRACE_MS: "0", AGENT_GC_INTERVAL_MS: "0", AGENT_GC_POLL_MS: "200" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "read this", files: [{ name: "note.txt", data: Buffer.from("attached words").toString("base64") }] } });
  assert.equal(accepted.status, 202, accepted.text);
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json.state === "completed", "the turn");
  const pinned = await r.db.query("select hash from chunk_pins where agent = $1", [agent]);
  assert.deepEqual(pinned.rows.map(row => row.hash), [hash("attached words")], "the message's FileRef pins its chunk");

  assert.equal((await r.call(`/v1/agents/${agent}`, { method: "DELETE" })).status, 200);
  await until(async () => (await r.db.query("select count(*)::int as count from chunk_touches where hash = $1", [hash("attached words")])).rows[0].count === 0, "the chunk to be collected", 30_000);
  assert.equal((await r.db.query("select count(*)::int as count from chunk_pins where agent = $1", [agent])).rows[0].count, 0);
});
