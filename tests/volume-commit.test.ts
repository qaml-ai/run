import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryStorage } from "../shared/storage.ts";
import { HttpError } from "../src/http.ts";
import { commitContents, VolumeService } from "../src/volumes.ts";
import { postgresTail } from "../src/log-tail.ts";
import { testDatabase } from "./database.ts";

type Context = { after(fn: () => Promise<void> | void): void };

async function service(t: Context) {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const volumes = new VolumeService({ db, storage });
  t.after(() => volumes.close());
  // A single-file write, as every node (an old one too) makes it.
  const write = async (id: string, path: string, content: string, ifMatch?: number) =>
    volumes.call(id, "acme", "commit", { path, ...await volumes.store("acme", Buffer.from(content)), ...(ifMatch !== undefined ? { ifMatch } : {}) });
  const read = async (id: string, path: string) => {
    const entry = await volumes.call(id, "acme", "stat", { path });
    return (await volumes.readRange("acme", entry, 0, entry.size)).toString("utf8");
  };
  const exists = async (id: string, path: string) => volumes.call(id, "acme", "stat", { path }).then(() => true, () => false);
  const commit = (id: string, body: unknown) => commitContents(volumes, "acme", id, body);
  return { volumes, write, read, exists, commit };
}

test("a commit writes and removes every file together, or writes nothing and names the conflicts", async t => {
  const { volumes, read, exists, commit } = await service(t);
  const { id } = await volumes.create("acme", { name: "base" });
  const first = await commit(id, { files: [
    { path: "/src/a.ts", version: 0, text: "a1" },
    { path: "/src/b.ts", version: 0, data: Buffer.from("b1").toString("base64"), contentType: "text/plain" },
    { path: "/old.txt", version: 0, text: "old" },
  ] });
  assert.deepEqual(first.files.map((file: any) => file.path), ["/src/a.ts", "/src/b.ts", "/old.txt"]);
  assert.equal(first.seq, 3);
  assert.equal(first.files[1].contentType, "text/plain");
  // A removed file's path becomes a directory in the same commit.
  const second = await commit(id, { files: [{ path: "/old.txt", version: 3, delete: true }, { path: "/old.txt/inside.txt", version: 0, text: "inside" }] });
  assert.deepEqual(second.removed, ["/old.txt"]);
  assert.equal(await read(id, "/old.txt/inside.txt"), "inside");

  const before = (await volumes.call(id, "acme", "info")).seq;
  const conflict = await commit(id, { files: [
    { path: "/src/a.ts", version: 1, text: "a2" },
    { path: "/src/b.ts", version: 1, text: "b2" },
    { path: "/src/c.ts", version: 7, text: "c" },
    { path: "/src/new.ts", version: 0, text: "new" },
  ], snapshot: { name: "never" } });
  assert.deepEqual(conflict.conflicts, [{ path: "/src/b.ts", headVersion: 2 }, { path: "/src/c.ts", headVersion: 0 }]);
  assert.equal(await read(id, "/src/a.ts"), "a1");
  assert.equal(await exists(id, "/src/new.ts"), false);
  assert.equal((await volumes.call(id, "acme", "info")).seq, before);
  assert.deepEqual(await volumes.call(id, "acme", "snapshots"), []);

  await assert.rejects(commit(id, { files: [{ path: "/x", version: 0, text: "x", delete: true }] }), /exactly one of/);
  await assert.rejects(commit(id, { files: [{ path: "/x", version: 0, text: "x" }, { path: "/x/", version: 0, text: "y" }] }), /given twice/);
  await assert.rejects(commit(id, { files: [{ path: "/d", version: 0, text: "x" }, { path: "/d/e", version: 0, text: "y" }] }), (error: any) => error.status === 409);
  assert.equal(await exists(id, "/d"), false);
});

test("a snapshot on success holds exactly the commit", async t => {
  const { volumes, write, commit } = await service(t);
  const { id } = await volumes.create("acme");
  const a = await write(id, "/a.txt", "a1");
  const done = await commit(id, { files: [{ path: "/a.txt", version: a.version, text: "a2" }, { path: "/b.txt", version: 0, text: "b" }], snapshot: { name: "release 1", pinned: true, labels: { release: "1" } } });
  assert.equal(done.snapshot.seq, done.seq);
  assert.equal(done.snapshot.files, 2);
  assert.equal(done.snapshot.pinned, true);
  assert.deepEqual(done.snapshot.labels, { release: "1" });
  await write(id, "/a.txt", "after");
  const listed = await volumes.call(id, "acme", "list", { snapshot: done.snapshot.id });
  assert.deepEqual(listed.files.map((file: any) => [file.path, file.version]), [["/a.txt", done.files[0].version], ["/b.txt", done.files[1].version]]);
  await assert.rejects(commit(id, { files: [{ path: "/z.txt", version: 0, text: "z" }], snapshot: { name: "" } }), (error: any) => error.status === 400);
  await assert.rejects(volumes.call(id, "acme", "stat", { path: "/z.txt" }), /does not exist/);
  // A snapshot that fails after the files are committed is reported beside the commit, not as its failure.
  const writeBlob = volumes.storage.writeBlob.bind(volumes.storage);
  volumes.storage.writeBlob = async (key, data) => {
    if (key.includes("/snapshots/")) throw new Error("storage is down");
    return writeBlob(key, data);
  };
  const landed = await commit(id, { files: [{ path: "/y.txt", version: 0, text: "y" }], snapshot: { name: "lost" } });
  volumes.storage.writeBlob = writeBlob;
  assert.equal(landed.snapshot, null);
  assert.match(landed.snapshotError, /files are committed, but the snapshot failed: storage is down/);
  assert.equal(landed.files[0].path, "/y.txt");
  assert.equal((await volumes.call(id, "acme", "stat", { path: "/y.txt" })).version, landed.seq);
});

test("concurrent commits: the same file has one winner, different files all land, and plain writes interleave", async t => {
  const { volumes, write, read, exists, commit } = await service(t);
  const { id } = await volumes.create("acme");
  const seed = await write(id, "/race.txt", "0", 0);
  const same = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    commit(id, { files: [{ path: "/race.txt", version: seed.version, text: `writer ${i}` }, { path: `/side-${i}.txt`, version: 0, text: "side" }] })));
  const winners = same.flatMap((result, i) => result.conflicts ? [] : [i]);
  assert.equal(winners.length, 1);
  assert.equal(await read(id, "/race.txt"), `writer ${winners[0]}`);
  for (let i = 0; i < 6; i++) assert.equal(await exists(id, `/side-${i}.txt`), i === winners[0]);
  const different = await Promise.all(Array.from({ length: 6 }, (_, i) => commit(id, { files: [{ path: `/many/${i}.txt`, version: 0, text: String(i) }] })));
  assert.equal(new Set(different.map(result => result.files[0].version)).size, 6);
  // A single-file write (what an old node makes) and commits on one file at one version: exactly one wins.
  const mixed = await write(id, "/mixed.txt", "0", 0);
  const outcomes = await Promise.all(Array.from({ length: 8 }, (_, i) => i % 2
    ? write(id, "/mixed.txt", `write ${i}`, mixed.version).then(() => "won", (error: any) => error.status === 412 ? "lost" : error)
    : commit(id, { files: [{ path: "/mixed.txt", version: mixed.version, text: `commit ${i}` }] }).then(result => result.conflicts ? "lost" : "won")));
  assert.equal(outcomes.filter(outcome => outcome === "won").length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter(outcome => outcome === "lost").length, 7, JSON.stringify(outcomes));
});

test("a fork's changes land on its base from the fork, sharing their chunks", async t => {
  const { volumes, write, read, commit } = await service(t);
  const { id } = await volumes.create("acme", { name: "base" });
  const b = await write(id, "/b.txt", "b1");
  const fork = await volumes.call(id, "acme", "fork", {});
  await write(fork.id, "/b.txt", "b from fork", b.version);
  await write(fork.id, "/fresh.txt", "fresh", 0);
  const landed = await commit(id, { files: [{ path: "/b.txt", version: b.version, from: { volume: fork.id } }, { path: "/fresh.txt", version: 0, from: { volume: fork.id } }] });
  assert.equal(landed.files.length, 2);
  await volumes.call(fork.id, "acme", "delete");
  assert.equal(await read(id, "/b.txt"), "b from fork");
  assert.equal(await read(id, "/fresh.txt"), "fresh");
  await assert.rejects(commit(id, { files: [{ path: "/c.txt", version: 0, from: { volume: id, path: "/b.txt", version: 1 } }] }), (error: any) => error.status === 412);
});

test("a commit refused by a node that predates it writes nothing and asks for a retry", async t => {
  const { volumes, exists, commit } = await service(t);
  const { id } = await volumes.create("acme");
  const call = volumes.call.bind(volumes);
  // Mid-rollout the volume's owner may be an old node, which answers an operation it lacks with a 400.
  volumes.call = async (volume: string, tenant: string, op: string, args?: Record<string, unknown>) => {
    if (op === "commitFiles") throw new HttpError(400, `Unknown volume operation ${op}`);
    return call(volume, tenant, op, args);
  };
  await assert.rejects(commit(id, { files: [{ path: "/a.txt", version: 0, text: "a" }] }), (error: any) => error.status === 503);
  volumes.call = call;
  assert.equal(await exists(id, "/a.txt"), false);
  assert.equal((await commit(id, { files: [{ path: "/a.txt", version: 0, text: "a" }] })).files.length, 1);
});
