// The Merkle store under local workerd (Miniflare) with Miniflare's on-disk R2, at the three shared bench sizes
// (proto/artifacts-volumes bench: 200 files/1 MB, 5k/50 MB, 50k/500 MB, the same generated source-like text and paths).
// Requests go over real local HTTP; "do" columns are the Durable Object's own time (x-do-ms), "wall" the client's.
// BENCH_SIZES=small,medium,large (default all). Prints a JSON blob and markdown tables.
import { createRequire } from "node:module";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { materialize, type MaterializeStats } from "../src/materialize.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");
const req = createRequire(join(repo, "backends/workers/package.json"));

const SIZES: Record<string, { files: number; bytesPerFile: number }> = {
  small: { files: 200, bytesPerFile: 5_000 },
  medium: { files: 5_000, bytesPerFile: 10_000 },
  large: { files: 50_000, bytesPerFile: 10_000 },
};
const sizes = (process.env.BENCH_SIZES ?? "small,medium,large").split(",");
const work = await mkdtemp(join(process.env.BENCH_DIR ?? tmpdir(), "merkle-bench-"));

// ---- the shared generator (copied from proto/artifacts-volumes bench/bench.ts) -----------------------------------
const WORDS = "const let function return import export async await class interface type string number boolean void null undefined if else for while switch case break continue throw try catch finally new this super extends implements public private static readonly".split(" ");
function content(seed: number, bytes: number) {
  let x = seed * 2654435761 >>> 0;
  const next = () => (x = (x * 1664525 + 1013904223) >>> 0);
  let out = `// file ${seed}\n`;
  while (out.length < bytes) {
    const line: string[] = [];
    for (let n = 2 + next() % 9; n > 0; n--) line.push(WORDS[next() % WORDS.length]);
    out += `${"  ".repeat(next() % 4)}${line.join(" ")}${next() % 3 ? ";" : " {"}\n`;
  }
  return out;
}
const pathOf = (i: number) => `src/m${Math.floor(i / 2500)}/d${Math.floor(i / 50)}/f${i}.ts`;

// ---- harness ---------------------------------------------------------------------------------------------------------
// wrangler dev --local: workerd + Miniflare's on-disk R2 and Durable Object SQLite.
const port = 18700 + Math.floor(Math.random() * 200);
const wrangler = spawn(process.execPath, [join(repo, "backends/workers/node_modules/wrangler/bin/wrangler.js"), "dev", "--local", "-c", join(here, "../wrangler.jsonc"), "--port", String(port), "--ip", "127.0.0.1", "--persist-to", join(work, "state"), "--show-interactive-dev-session=false"], { env: { ...process.env, WRANGLER_LOG_PATH: join(work, "logs"), WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; wrangler.stdout.on("data", (d) => (log += d)); wrangler.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  try { await fetch(`${base}/l/probe/stats`); break; } catch { if (i > 120) { console.error(log); throw new Error("wrangler dev did not start"); } await new Promise((r) => setTimeout(r, 500)); }
}
console.error(`wrangler dev at ${base}; work dir ${work}`);

type T = { wall: number; do: number };
async function call(lineage: string, method: string, path: string, body?: Uint8Array | string): Promise<{ json: any; t: T; bytes: number }> {
  const t0 = performance.now();
  const res = await fetch(`${base}/l/${lineage}${path}`, { method, body });
  const buf = new Uint8Array(await res.arrayBuffer());
  const wall = performance.now() - t0;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${new TextDecoder().decode(buf).slice(0, 300)}`);
  const type = res.headers.get("content-type") ?? "";
  return { json: type.includes("json") ? JSON.parse(new TextDecoder().decode(buf)) : buf, t: { wall, do: Number(res.headers.get("x-do-ms")) }, bytes: buf.length };
}
const med = (xs: T[]): T => {
  const m = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  return { wall: +m(xs.map((x) => x.wall)).toFixed(1), do: +m(xs.map((x) => x.do)).toFixed(1) };
};
const r = (t: T) => ({ wall: +t.wall.toFixed(1), do: +t.do.toFixed(1) });
function frame(files: { path: string; text: string }[]) {
  const parts: Buffer[] = [];
  for (const f of files) {
    const p = Buffer.from(f.path), b = Buffer.from(f.text), h = Buffer.alloc(2), s = Buffer.alloc(4);
    h.writeUInt16BE(p.length); s.writeUInt32BE(b.length); parts.push(h, p, s, b);
  }
  return new Uint8Array(Buffer.concat(parts));
}
const enc = encodeURIComponent;
const edit = (i: number, round: number) => content(i, 1) + `// edit ${round}\n` + content(i * 7 + round, 2_000);

const results: Record<string, any> = {};
for (const size of sizes) {
  const { files, bytesPerFile } = SIZES[size];
  const L = `${size}-${Date.now()}`;
  const out: any = (results[size] = {});
  console.error(`== ${size}: ${files} files`);
  await call(L, "POST", "/volumes/main");

  // import
  let t0 = performance.now();
  for (let i = 0; i < files; i += 2000) {
    const batch = [];
    for (let j = i; j < Math.min(files, i + 2000); j++) batch.push({ path: pathOf(j), text: content(j, bytesPerFile) });
    await call(L, "POST", `/refs/main/import`, frame(batch));
  }
  out.importWall = Math.round(performance.now() - t0);
  out.importCheckpoint = r((await call(L, "POST", "/refs/main/checkpoint")).t);
  out.storeAfterImport = (await call(L, "GET", "/stats")).json;

  // single-file write and read
  const writes: T[] = [], readsDirty: T[] = [], readsCommitted: T[] = [];
  for (let k = 0; k < 20; k++) writes.push((await call(L, "PUT", `/refs/main/files/${pathOf(k * 7 % files)}`, edit(k * 7 % files, 0))).t);
  for (let k = 0; k < 20; k++) readsDirty.push((await call(L, "GET", `/refs/main/files/${pathOf(k * 7 % files)}`)).t);
  for (let k = 0; k < 20; k++) readsCommitted.push((await call(L, "GET", `/refs/main/files/${pathOf((k * 13 + 3) % files)}`)).t);
  out.write = med(writes); out.readDirty = med(readsDirty); out.readCommitted = med(readsCommitted);
  await call(L, "POST", "/refs/main/checkpoint");

  // checkpoint after 1 and after 100 edits
  const cp1: T[] = [], cp100: T[] = [];
  const newTrees: number[] = [], split: string[] = [];
  for (let round = 1; round <= 5; round++) {
    await call(L, "PUT", `/refs/main/files/${pathOf((round * 31) % files)}`, edit((round * 31) % files, round));
    const c = await call(L, "POST", "/refs/main/checkpoint"); cp1.push(c.t); newTrees.push(c.json.newTrees); split.push(`${c.json.syncMs}+${c.json.mirrorMs}`);
  }
  out.checkpoint1 = { ...med(cp1), newTrees: newTrees[2], syncPlusMirrorMs: split };
  const nt100: number[] = [], split100: string[] = [];
  for (let round = 1; round <= 3; round++) {
    const batch = Array.from({ length: Math.min(100, files) }, (_, k) => { const i = (k * Math.floor(files / 100) + round) % files; return { path: pathOf(i), text: edit(i, 10 + round) }; });
    await call(L, "POST", "/refs/main/import", frame(batch));
    const c = await call(L, "POST", "/refs/main/checkpoint"); cp100.push(c.t); nt100.push(c.json.newTrees); split100.push(`${c.json.syncMs}+${c.json.mirrorMs}`);
  }
  out.checkpoint100 = { ...med(cp100), newTrees: nt100[1], syncPlusMirrorMs: split100 };

  // fork
  const forks: T[] = [];
  for (let k = 0; k < 10; k++) forks.push((await call(L, "POST", `/refs/main/fork?name=${enc(`tmp/${k}`)}&owner=tmp`)).t);
  out.fork = med(forks);
  await call(L, "DELETE", "/owners/tmp");

  // merge: 3 disjoint files per side, plus one file both sides edited in different hunks (diff3)
  const merges: T[] = [];
  for (let round = 0; round < 3; round++) {
    const f = `wf/m${round}`;
    await call(L, "POST", `/refs/main/fork?name=${enc(f)}&owner=wfm`);
    const shared = pathOf((round * 97 + 5) % files);
    const sharedText = new TextDecoder().decode((await call(L, "GET", `/refs/main/files/${shared}`)).json as Uint8Array);
    const lines = sharedText.split("\n");
    for (let k = 0; k < 3; k++) {
      const a = (round * 1000 + k * 17 + 1) % files, b = (round * 1000 + k * 17 + 2 + Math.floor(files / 2)) % files;
      await call(L, "PUT", `/refs/${enc(f)}/files/${pathOf(a)}`, edit(a, 100 + round));
      await call(L, "PUT", `/refs/main/files/${pathOf(b)}`, edit(b, 200 + round));
    }
    await call(L, "PUT", `/refs/${enc(f)}/files/${shared}`, ["THEIRS", ...lines.slice(1)].join("\n"));
    await call(L, "PUT", `/refs/main/files/${shared}`, [...lines.slice(0, -2), "OURS", ""].join("\n"));
    await call(L, "POST", `/refs/${enc(f)}/checkpoint`); await call(L, "POST", "/refs/main/checkpoint");
    const m = await call(L, "POST", `/refs/main/merge?from=${enc(f)}`);
    if (!m.json.commit || m.json.lineMerged !== 1) throw new Error(`merge: ${JSON.stringify(m.json)}`);
    merges.push(m.t);
  }
  out.merge = med(merges);
  await call(L, "DELETE", "/owners/wfm");

  // materialize: cold, warm after a 3-file change (same dir), warm cache + fresh dir
  const mat = async (root: string, dir: string, cache: string) => materialize({ endpoint: base, lineage: L, root, dir: join(work, dir), cache: join(work, cache) });
  const root1 = (await call(L, "GET", "/refs/main")).json.root;
  const io0 = (await call(L, "GET", "/stats")).json.io;
  out.materializeCold = await mat(root1, `${size}-dirA`, `${size}-cas`);
  const io1 = (await call(L, "GET", "/stats")).json.io;
  out.materializeCold.r2Gets = io1.gets - io0.gets;
  for (let k = 0; k < 3; k++) { const i = (k * 1237 + 11) % files; await call(L, "PUT", `/refs/main/files/${pathOf(i)}`, edit(i, 300)); }
  const root2 = (await call(L, "POST", "/refs/main/checkpoint")).json.root;
  out.materializeWarm = await mat(root2, `${size}-dirA`, `${size}-cas`);
  out.materializeWarmFreshDir = await mat(root2, `${size}-dirB`, `${size}-cas`);
  // Check the result against git: the directory's tree id must be the root.
  const check = join(work, `${size}-dirA`);
  execFileSync("git", ["init", "-q", check]);
  execFileSync("git", ["-C", check, "add", "-A", "--", ".", ":!.merkle-root"]);
  out.materializeVerified = execFileSync("git", ["-C", check, "write-tree"]).toString().trim() === root2;
  await rm(join(work, `${size}-dirA`), { recursive: true, force: true }); await rm(join(work, `${size}-dirB`), { recursive: true, force: true });
  await rm(join(work, `${size}-cas`), { recursive: true, force: true });

  // GC: mark over a store with no garbage; then 10 workflow forks x 100 unique new files, dropped, collected
  out.gcNoGarbage = (await call(L, "POST", "/gc?graceMs=0")).json;
  for (let k = 0; k < 10; k++) {
    const f = `wf/g${k}`;
    await call(L, "POST", `/refs/main/fork?name=${enc(f)}&owner=wfg`);
    await call(L, "POST", `/refs/${enc(f)}/import`, frame(Array.from({ length: 100 }, (_, j) => ({ path: `gen/${k}/f${j}.ts`, text: content(1e6 + k * 100 + j, bytesPerFile) }))));
    await call(L, "POST", `/refs/${enc(f)}/checkpoint`);
  }
  await call(L, "DELETE", "/owners/wfg");
  const gc = await call(L, "POST", "/gc?graceMs=0");
  out.gcGarbage = { ...gc.json, wall: Math.round(gc.t.wall) };
  out.storeEnd = (await call(L, "GET", "/stats")).json;
  console.error(JSON.stringify(out));
}

console.log(JSON.stringify(results, null, 2));
const row = (label: string, f: (o: any) => string) => `| ${label} | ${sizes.map((s) => f(results[s])).join(" | ")} |`;
const t = (x: T) => `${x.do} / ${x.wall}`;
const ms = (m: MaterializeStats & { r2Gets?: number }) => `${m.ms} ms, ${m.requests} req, ${(m.bytesFetched / 1e6).toFixed(2)} MB (${m.treesFetched} trees + ${m.blobsFetched} blobs), ${m.written} written`;
console.log([
  `| (do ms / wall ms unless noted) | ${sizes.join(" | ")} |`, `|---|${sizes.map(() => "---:").join("|")}|`,
  row("import (wall, batches of 2k files)", (o) => `${o.importWall} ms`),
  row("first checkpoint of the whole tree", (o) => t(o.importCheckpoint)),
  row("write one file", (o) => t(o.write)), row("read a dirty file", (o) => t(o.readDirty)), row("read a committed file", (o) => t(o.readCommitted)),
  row("checkpoint after 1 edit", (o) => `${t(o.checkpoint1)} (${o.checkpoint1.newTrees} new trees; sync+mirror ${o.checkpoint1.syncPlusMirrorMs[2]})`),
  row("checkpoint after 100 edits", (o) => `${t(o.checkpoint100)} (${o.checkpoint100.newTrees} new trees; sync+mirror ${o.checkpoint100.syncPlusMirrorMs[1]})`),
  row("fork", (o) => t(o.fork)), row("merge (3+3 files, 1 diff3)", (o) => t(o.merge)),
  row("materialize cold", (o) => ms(o.materializeCold)), row("materialize warm, 3-file change", (o) => ms(o.materializeWarm)),
  row("materialize warm cache, fresh dir", (o) => ms(o.materializeWarmFreshDir)), row("materialized tree == root (git write-tree)", (o) => String(o.materializeVerified)),
  row("gc mark, no garbage", (o) => `${o.gcNoGarbage.markMs} ms mark (${o.gcNoGarbage.liveTrees} trees, ${o.gcNoGarbage.liveBlobs} blobs)`),
  row("gc, 10 dropped forks x 100 files", (o) => `${o.gcGarbage.markMs} mark + ${o.gcGarbage.sweepMs} sweep ms; ${o.gcGarbage.deletedBlobs} blobs / ${o.gcGarbage.deletedTrees} trees / ${(o.gcGarbage.deletedBytes / 1e6).toFixed(1)} MB`),
  row("trees in SQLite (all versions)", (o) => `${o.storeEnd.trees} / ${(o.storeEnd.treeBytes / 1e6).toFixed(2)} MB`),
].join("\n"));
wrangler.kill();
