// The job-side materializer: put root R of a lineage into a directory, fetching only objects the host's
// content-addressed cache lacks. It walks the new root against the root the directory holds now (`.merkle-root`),
// descending only into subtrees whose hashes differ, so a warm directory after a small change costs the changed trees
// on the changed paths plus the changed blobs. Every object is verified against its id before it is used.
// Runs on the job host (or in the runtime's guest): plain Node, no git.
import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type Entry = { mode: string; name: string; sha: string };
export type MaterializeStats = { ms: number; requests: number; bytesFetched: number; treesFetched: number; blobsFetched: number; cacheHits: number; written: number; removed: number; treesWalked: number };

export async function materialize(opts: { endpoint: string; lineage: string; root: string; dir: string; cache: string; batch?: number; concurrency?: number }): Promise<MaterializeStats> {
  const t0 = performance.now();
  const stats: MaterializeStats = { ms: 0, requests: 0, bytesFetched: 0, treesFetched: 0, blobsFetched: 0, cacheHits: 0, written: 0, removed: 0, treesWalked: 0 };
  const batch = opts.batch ?? 512, concurrency = opts.concurrency ?? 8;
  const casPath = (sha: string) => join(opts.cache, sha.slice(0, 2), sha.slice(2));
  const stamp = join(opts.dir, ".merkle-root");
  const previous = existsSync(stamp) ? (await readFile(stamp, "utf8")).trim() : null;
  await mkdir(opts.dir, { recursive: true });
  if (previous === opts.root) { stats.ms = Math.round(performance.now() - t0); return stats; }

  /** Make sure these objects are in the CAS: fetch the missing ones in batches, verify, store. */
  const ensure = async (shas: string[]) => {
    const missing = [...new Set(shas)].filter((s) => !existsSync(casPath(s)));
    stats.cacheHits += new Set(shas).size - missing.length;
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += batch) chunks.push(missing.slice(i, i + batch));
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (next < chunks.length) {
        const chunk = chunks[next++];
        const res = await fetch(`${opts.endpoint}/l/${opts.lineage}/objects`, { method: "POST", body: Buffer.concat(chunk.map((s) => Buffer.from(s, "hex"))) });
        if (!res.ok) throw new Error(`objects: ${res.status} ${await res.text()}`);
        const body = Buffer.from(await res.arrayBuffer());
        stats.requests++; stats.bytesFetched += body.length;
        const writes: Promise<void>[] = [];
        for (let i = 0; i < body.length;) {
          const sha = body.subarray(i, i + 20).toString("hex"), type = body[i + 20], size = body.readUInt32BE(i + 21);
          const bytes = body.subarray(i + 25, i + 25 + size); i += 25 + size;
          if (type === 0) throw new Error(`object ${sha} missing on the server`);
          const t = type === 1 ? "tree" : "blob";
          if (createHash("sha1").update(`${t} ${size}\0`).update(bytes).digest("hex") !== sha) throw new Error(`object ${sha} does not match its id`);
          type === 1 ? stats.treesFetched++ : stats.blobsFetched++;
          const p = casPath(sha);
          writes.push(mkdir(dirname(p), { recursive: true }).then(() => writeFile(`${p}.${process.pid}.tmp`, bytes)).then(() => rename(`${p}.${process.pid}.tmp`, p)));
        }
        await Promise.all(writes);
      }
    }));
  };
  const tree = async (sha: string): Promise<Map<string, Entry>> => {
    const b = await readFile(casPath(sha));
    const out = new Map<string, Entry>();
    for (let i = 0; i < b.length;) {
      const sp = b.indexOf(0x20, i), nul = b.indexOf(0, sp);
      const e = { mode: b.subarray(i, sp).toString(), name: b.subarray(sp + 1, nul).toString(), sha: b.subarray(nul + 1, nul + 21).toString("hex") };
      out.set(e.name, e); i = nul + 21;
    }
    return out;
  };
  const isTree = (e?: Entry) => e?.mode === "40000" || e?.mode === "040000";

  // Breadth-first over pairs (new tree, old tree), fetching each level's new trees in one batch.
  let level: { path: string; next: string; prev: string | null }[] = [{ path: "", next: opts.root, prev: previous }];
  const toWrite: { path: string; e: Entry }[] = [], toRemove: string[] = [];
  while (level.length) {
    await ensure(level.map((l) => l.next));
    const following: typeof level = [];
    for (const l of level) {
      stats.treesWalked++;
      const now = await tree(l.next), was = l.prev ? await tree(l.prev) : new Map<string, Entry>();
      for (const [name, e] of was) if (!now.has(name)) toRemove.push(join(l.path, name));
      for (const [name, e] of now) {
        const old = was.get(name), p = l.path ? `${l.path}/${name}` : name;
        if (old && old.sha === e.sha && old.mode === e.mode) continue;
        if (isTree(e)) {
          if (old && !isTree(old)) toRemove.push(p);
          following.push({ path: p, next: e.sha, prev: isTree(old) ? old!.sha : null });
        } else {
          if (old && isTree(old)) toRemove.push(p);
          toWrite.push({ path: p, e });
        }
      }
    }
    level = following;
  }
  await Promise.all(toRemove.map((p) => rm(join(opts.dir, p), { recursive: true, force: true })));
  stats.removed = toRemove.length;
  await ensure(toWrite.map((w) => w.e.sha));
  const dirs = new Set(toWrite.map((w) => dirname(join(opts.dir, w.path))));
  for (const d of [...dirs].sort()) await mkdir(d, { recursive: true });
  let next = 0;
  await Promise.all(Array.from({ length: 32 }, async () => {
    while (next < toWrite.length) {
      const { path, e } = toWrite[next++];
      const target = join(opts.dir, path);
      if (e.mode === "120000") { await rm(target, { force: true }); await symlink(await readFile(casPath(e.sha), "utf8"), target); continue; }
      // A copy, never a hard link: a job writing a file in place must not change the host's cache. On a filesystem
      // with reflinks (btrfs, xfs) FICLONE makes this copy free.
      await copyFile(casPath(e.sha), target, constants.COPYFILE_FICLONE);
      if (e.mode === "100755") await chmod(target, 0o755);
      stats.written++;
    }
  }));
  await writeFile(stamp, opts.root);
  stats.ms = Math.round(performance.now() - t0);
  return stats;
}
