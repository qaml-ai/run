import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MerkleStore } from "../src/store.ts";
import { memoryBlobs, nodeSql } from "../src/node.ts";
import { exportPack } from "../src/export.ts";

const te = new TextEncoder(), td = new TextDecoder();
function setup(opts: { now?: () => number; graceMs?: number } = {}) {
  const blobs = memoryBlobs();
  const store = new MerkleStore(nodeSql(), blobs, opts);
  store.createVolume("main");
  return { store, blobs };
}
const read = async (s: MerkleStore, ref: string, p: string) => { const b = await s.read(ref, p); return b && td.decode(b); };

test("root hash equals git's tree id for the same files", async () => {
  const { store } = setup();
  const files: Record<string, string> = { "README.md": "hi\n", "src/a.ts": "a\n", "src/lib/b.ts": "b\n", "src/lib/c d.ts": "c\n", "src-x": "x\n", "src.ts": "s\n" };
  for (const [p, c] of Object.entries(files)) await store.write("main", p, te.encode(c));
  const { root } = await store.checkpoint("main");
  const dir = mkdtempSync(join(tmpdir(), "mk-"));
  execFileSync("git", ["init", "-q", dir]);
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), c); }
  execFileSync("git", ["-C", dir, "add", "-A"]);
  assert.equal(execFileSync("git", ["-C", dir, "write-tree"]).toString().trim(), root);
});

test("checkpoint rewrites only the changed path; working layer reads through", async () => {
  const { store } = setup();
  for (let i = 0; i < 100; i++) await store.write("main", `d${i % 10}/f${i}.txt`, te.encode(`v1 ${i}\n`));
  const v1 = await store.checkpoint("main");
  assert.equal(v1.changed, 100);
  await store.write("main", "d3/f13.txt", te.encode("v2\n"));
  assert.equal(await read(store, "main", "d3/f13.txt"), "v2\n");
  const v2 = await store.checkpoint("main");
  assert.equal(v2.newTrees, 2); // d3 and the root, nothing else
  assert.deepEqual(store.diff(v1.root, v2.root), [{ path: "d3/f13.txt", from: store.diff(v1.root, v2.root)[0].from, to: store.stat("main", "d3/f13.txt")!.sha }]);
  store.remove("main", "d3/f13.txt");
  assert.equal(await read(store, "main", "d3/f13.txt"), null);
  assert.equal(store.list("main", "d3").size, 9);
});

test("fork is a ref; merge takes subtrees by reference and diff3s same-file edits", async () => {
  const { store } = setup();
  await store.write("main", "a/x.txt", te.encode("1\n2\n3\n4\n5\n"));
  await store.write("main", "b/y.txt", te.encode("y\n"));
  await store.checkpoint("main");
  await store.fork("main", "f1", { owner: "wf1" });
  await store.write("f1", "a/x.txt", te.encode("1\n2\n3\n4\nFIVE\n"));
  await store.write("f1", "c/new/z.txt", te.encode("z\n"));
  await store.write("main", "a/x.txt", te.encode("ONE\n2\n3\n4\n5\n"));
  await store.write("main", "b/y.txt", te.encode("y2\n"));
  const m = await store.merge("main", "f1");
  assert.ok("commit" in m && m.lineMerged === 1);
  assert.equal(await read(store, "main", "a/x.txt"), "ONE\n2\n3\n4\nFIVE\n");
  assert.equal(await read(store, "main", "c/new/z.txt"), "z\n");
  assert.equal(await read(store, "main", "b/y.txt"), "y2\n");
  // A second round from the same fork merges over the moved base, not the original one.
  await store.write("f1", "c/new/z.txt", te.encode("z2\n"));
  const m2 = await store.merge("main", "f1");
  assert.ok("commit" in m2);
  assert.equal(await read(store, "main", "c/new/z.txt"), "z2\n");
  // Overlapping edits conflict and write nothing.
  await store.fork("main", "f2");
  await store.write("f2", "b/y.txt", te.encode("theirs\n"));
  await store.write("main", "b/y.txt", te.encode("ours\n"));
  const before = store.ref("main").commit;
  await store.checkpoint("main");
  const c = await store.merge("main", "f2");
  assert.deepEqual(c, { conflicts: ["b/y.txt"] });
  assert.notEqual(store.ref("main").commit, before); // only our own checkpoint landed
  assert.equal(await read(store, "main", "b/y.txt"), "ours\n");
});

test("gc frees exactly what no ref reaches; forks and job refs hold, expired job refs do not", async () => {
  let now = 1_000_000;
  const { store, blobs } = setup({ now: () => now, graceMs: 1000 });
  for (let i = 0; i < 20; i++) await store.write("main", `f${i}`, te.encode(`base ${i}`));
  await store.checkpoint("main");
  await store.fork("main", "wf/a", { owner: "wf" });
  await store.write("wf/a", "only-in-fork", te.encode("fork data"));
  await store.checkpoint("wf/a");
  await store.fork("main", "job/1", { kind: "job", expiresAt: now + 5000 });
  await store.write("main", "f0", te.encode("base 0 v2")); // the old f0 is now held only by job/1 and history
  await store.checkpoint("main");
  now += 2000;
  let s = await store.gc();
  assert.equal(s.deletedBlobs, 0);
  store.deleteOwned("wf");
  s = await store.gc();
  assert.equal(s.deletedBlobs, 1); // "fork data"
  assert.equal([...blobs.map.keys()].filter((k) => k.startsWith("b/")).length, 21);
  now += 10_000; // job/1 past its deadline
  s = await store.gc();
  assert.equal(store.refs().some((r) => r.name === "job/1"), false);
  assert.equal(s.deletedBlobs, 0, "old f0 is still in main's history");
  assert.equal(await read(store, "main", "f0"), "base 0 v2");
});

test("gc never loses a blob a writer is re-uploading while its delete is in flight", async () => {
  let now = 1_000_000;
  const { store, blobs } = setup({ now: () => now, graceMs: 10 });
  await store.write("main", "a", te.encode("payload"));
  await store.checkpoint("main");
  store.remove("main", "a");
  await store.checkpoint("main");
  // Cut history so "payload" is unreachable, then hold its R2 delete in flight.
  (store as unknown as { historyDepth: number }).historyDepth = 1;
  now += 100;
  const release = blobs.holdDeletes();
  const collecting = store.gc();
  await new Promise((r) => setTimeout(r, 5));
  const writing = store.write("main", "b", te.encode("payload")); // same bytes: must wait for the delete, then upload
  await new Promise((r) => setTimeout(r, 5));
  release();
  await Promise.all([collecting, writing]);
  await store.checkpoint("main");
  assert.equal(await read(store, "main", "b"), "payload");
});

test("export: a git pack of the commits verifies with git fsck", async () => {
  const { store } = setup();
  await store.write("main", "src/a.ts", te.encode("a\n"));
  await store.checkpoint("main");
  await store.write("main", "src/b.ts", te.encode("b\n"));
  const { commit } = await store.checkpoint("main");
  const dir = mkdtempSync(join(tmpdir(), "mk-export-"));
  execFileSync("git", ["init", "-q", "--bare", dir]);
  const pack = await exportPack(store, commit, []);
  execFileSync("git", ["-C", dir, "index-pack", "--stdin", "--fix-thin"], { input: pack });
  execFileSync("git", ["-C", dir, "update-ref", "refs/heads/main", commit]);
  execFileSync("git", ["-C", dir, "fsck", "--strict"]);
  assert.equal(execFileSync("git", ["-C", dir, "rev-list", "--count", "main"]).toString().trim(), "3");
  assert.equal(execFileSync("git", ["-C", dir, "show", "main:src/b.ts"]).toString(), "b\n");
});
