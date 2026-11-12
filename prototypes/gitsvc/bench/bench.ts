// gitsvc bench, run ON the service host (a sprite). Same generated trees as proto/artifacts-volumes `bench/bench.ts`
// (200 files/1 MB, 5k/50 MB, 50k/500 MB, seeded source-like text) so the numbers line up.
//
// Two servers on the same disk: `repl` with the replication gate to S3 (MinIO on the host when S3_ENDPOINT is set),
// `plain` without, so the gate's cost is visible. Every client is the git CLI or the prototype core, over HTTP on
// loopback; bench/client.ts runs the client half from another sprite.
//
// Env: BENCH_SIZES (default small,medium,large), PORT (repl server port, default 8080), SERVE_MINUTES (keep the repl
// server up afterwards for bench/client.ts), GITSVC_KEY, S3_*.
import { mkdir, mkdtemp, rm, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { startServer } from "../src/server.ts";
import { mintToken } from "../src/token.ts";
import { git } from "../src/gitexec.ts";
import { Replicator } from "../src/replicate.ts";
import { GitsvcStore } from "../src/core/store.ts";
import { VolumeCore, type Sql } from "../src/core/volume.ts";
import { tarEntry, tarEnd } from "./tar.ts";
import { SIZES, content, pathOf, generate } from "./trees.ts";

const KEY = process.env.GITSVC_KEY ?? "bench-key";
const sizes = (process.env.BENCH_SIZES ?? "small,medium,large").split(",");
const root = await mkdtemp(join(process.env.BENCH_DIR ?? tmpdir(), "gitsvc-bench-"));
await mkdir(join(root, "repl"), { recursive: true }); await mkdir(join(root, "plain"), { recursive: true });

let replicator: Replicator | undefined;
if (process.env.S3_ENDPOINT) {
  const options = { endpoint: process.env.S3_ENDPOINT, bucket: process.env.S3_BUCKET ?? "gitsvc", accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! };
  replicator = new Replicator(options);
  await replicator.s3.send(new CreateBucketCommand({ Bucket: options.bucket })).catch((e) => { if (!/BucketAlready/.test(e.name)) throw e; });
}
const repl = await startServer({ root: join(root, "repl"), key: KEY, replicator, port: Number(process.env.PORT ?? 8080), host: "0.0.0.0" });
const plain = await startServer({ root: join(root, "plain"), key: KEY });
console.error(`replication: ${replicator ? process.env.S3_ENDPOINT : "off"}; work dir ${root}`);

const results: Record<string, Record<string, number | string>> = {};
const tok = (repo: string, scope: "read" | "write" | "admin") => mintToken(KEY, { repo, scope, exp: Date.now() / 1000 + 3600 });
const auth = (t: string) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Bearer ${t}` });
const ident = ["-c", "user.email=bench@example.com", "-c", "user.name=bench"];
async function timed(fn: () => Promise<unknown>) { const t = performance.now(); await fn(); return Math.round(performance.now() - t); }
async function median(n: number, fn: () => Promise<unknown>) { const s: number[] = []; for (let i = 0; i < n; i++) s.push(await timed(fn)); return s.sort((a, b) => a - b)[Math.floor(n / 2)]; }
async function api(base: string, repo: string, path: string, body?: unknown) {
  const response = await fetch(`${base}/api/repos${path}`, { method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body), headers: { authorization: `Bearer ${tok(repo, "admin")}`, "content-type": "application/json" } });
  if (!response.ok && response.status !== 409) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}
const b64 = (s: string) => Buffer.from(s).toString("base64");
async function du(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) total += entry.isDirectory() ? await du(join(dir, entry.name)) : (await stat(join(dir, entry.name))).size;
  return total;
}
async function tarSync(from: string, paths: string[], to: string) {
  const { readFile } = await import("node:fs/promises");
  const child = spawn("tar", ["-x", "-f", "-", "-C", to, "--no-same-owner", "--no-same-permissions"], { stdio: ["pipe", "ignore", "inherit"] });
  for (const path of paths) for (const block of tarEntry(path, await readFile(join(from, path)))) if (block.byteLength && !child.stdin.write(block)) await new Promise((r) => child.stdin.once("drain", r));
  child.stdin.end(tarEnd());
  await new Promise<void>((resolve, reject) => child.on("close", (code) => (code ? reject(new Error(`tar ${code}`)) : resolve())));
}
function sqlite(): Sql {
  const db = new DatabaseSync(":memory:");
  return { exec: (q, ...p) => { const s = db.prepare(q); return /^\s*SELECT/i.test(q) ? (s.all(...(p as never[])) as never) : (s.run(...(p as never[])), []); } };
}
/** A VolumeCore seeded from the service's own tree listing (one GET: the index a volume object would keep). */
async function seededCore(base: string, repo: string): Promise<{ core: VolumeCore; seedMs: number; seedBytes: number }> {
  const core = new VolumeCore(sqlite(), new GitsvcStore({ base, repo, key: KEY }));
  core.init({ repo, remote: `${base}/${repo}.git`, branch: "main" });
  const sql = (core as unknown as { sql: Sql }).sql;
  const t = performance.now();
  const listing = Buffer.from(await (await api(base, repo, `/${repo}/tree/refs/heads/main`)).arrayBuffer());
  const head = ((await (await api(base, repo, `/${repo}/refs`)).json()) as Record<string, string>)["refs/heads/main"];
  for (const entry of listing.toString().split("\0").filter(Boolean)) {
    const [meta, path] = entry.split("\t"); const [, type, sha, size] = meta.split(/\s+/);
    if (type === "blob") sql.exec(`INSERT INTO tree (path, sha, size) VALUES (?, ?, ?)`, path, sha, Number(size));
    else sql.exec(`INSERT INTO dirs (path, sha) VALUES (?, ?)`, path, sha);
  }
  sql.exec(`INSERT INTO dirs (path, sha) VALUES ('', ?)`, await git(["--git-dir", join(root, "repl", `${repo}.git`), "rev-parse", `${head}^{tree}`]));
  sql.exec(`INSERT INTO meta (key, value) VALUES ('head', ?)`, head);
  return { core, seedMs: Math.round(performance.now() - t), seedBytes: listing.byteLength };
}

for (const size of sizes) {
  const { files, bytesPerFile } = SIZES[size];
  const repo = `bench-${size}`;
  const work = join(root, size), source = join(work, "source");
  await mkdir(source, { recursive: true });
  const row: Record<string, number | string> = { files };
  results[size] = row;
  console.error(`\n== ${size}: ${files} files x ${bytesPerFile} B`);
  await api(repl.url, repo, "", { name: repo }); await api(plain.url, repo, "", { name: repo });
  await generate(source, files, bytesPerFile);
  await git(["-C", source, "init", "-q", "-b", "main"]);
  await git(["-C", source, "add", "-A"]);
  await git(["-C", source, ...ident, "commit", "-qm", "import"]);
  row.tree_mb = +((await du(source) - await du(join(source, ".git"))) / 1e6).toFixed(1);
  // Import: one push of the whole tree (no per-push cap on our own server), with and without the gate.
  row.import_push_plain_ms = await timed(() => git(["-C", source, "push", "-q", `${plain.url}/${repo}.git`, "main"], { env: auth(tok(repo, "write")) }));
  row.import_push_repl_ms = await timed(() => git(["-C", source, "push", "-q", `${repl.url}/${repo}.git`, "main"], { env: auth(tok(repo, "write")) }));
  row.pack_mb = +((await du(join(root, "repl", `${repo}.git`, "objects/pack"))) / 1e6).toFixed(1);
  const remote = `${repl.url}/${repo}.git`, readEnv = auth(tok(repo, "read"));
  const paths = Array.from({ length: files }, (_, i) => pathOf(i));

  // (a) today's shape, lower bound: tar stream over a local pipe.
  const tarTo = join(work, "tar"); await mkdir(tarTo);
  row.a_tar_ms = await timed(() => tarSync(source, paths, tarTo));
  await rm(tarTo, { recursive: true, force: true });
  // (b) cold host: full clone (v2), shallow clone, blobless partial clone (metadata only, then full checkout).
  row.b_clone_full_ms = await timed(() => git(["-c", "protocol.version=2", "clone", "-q", remote, join(work, "clone")], { env: readEnv }));
  row.b_clone_depth1_ms = await timed(() => git(["clone", "-q", "--depth", "1", remote, join(work, "shallow")], { env: readEnv }));
  await rm(join(work, "shallow"), { recursive: true, force: true });
  row.b_clone_blobless_nocheckout_ms = await timed(() => git(["clone", "-q", "--filter=blob:none", "--no-checkout", remote, join(work, "blobless")], { env: readEnv }));
  row.b_blobless_checkout_ms = await timed(() => git(["-C", join(work, "blobless"), "checkout", "-q", "main"], { env: readEnv }));
  await rm(join(work, "blobless"), { recursive: true, force: true });
  // Host mirror: the bare repo a job host keeps per volume.
  const mirror = join(work, "mirror.git");
  row.mirror_cold_ms = await timed(() => git(["clone", "-q", "--mirror", remote, mirror], { env: readEnv }));

  // A 3-file change lands (server-side commit API), then the warm paths.
  const head0 = ((await (await api(repl.url, repo, `/${repo}/refs`)).json()) as Record<string, string>)["refs/heads/main"];
  await api(repl.url, repo, `/${repo}/commit`, { branch: "main", parent: head0, message: "3 files", files: Object.fromEntries([0, 1, 2].map((i) => [pathOf(i), b64(content(i + 100_000, bytesPerFile))])) });
  // (c) a job dir from last time: fetch + reset (moves the delta only).
  row.c_fetch_reset_ms = await timed(async () => { await git(["-C", join(work, "clone"), "fetch", "-q", "origin", "main"], { env: readEnv }); await git(["-C", join(work, "clone"), "reset", "-q", "--hard", "FETCH_HEAD"]); });
  // (d) a NEW job dir on a warm host: fetch into the mirror, then a local clone sharing its objects + checkout.
  row.d_mirror_fetch_ms = await timed(() => git(["-C", mirror, "fetch", "-q", "origin"], { env: readEnv }));
  row.d_job_from_mirror_ms = await timed(() => git(["clone", "-q", "--shared", "--branch", "main", mirror, join(work, "job")]));
  // (d') same, but a worktree of the mirror (no second .git at all).
  row.d_worktree_from_mirror_ms = await timed(() => git(["-C", mirror, "worktree", "add", "-q", "--detach", join(work, "job2"), "main"]));
  await rm(join(work, "job"), { recursive: true, force: true }); await rm(join(work, "job2"), { recursive: true, force: true });
  await git(["-C", mirror, "worktree", "prune"]);

  // Commit latency, one changed file, medians of 5: git CLI push (plain / gated), the prototype core's thin pack
  // (gated), the server-side commit API (gated).
  const clone = join(work, "clone");
  let n = 0;
  const cliPush = (url: string) => async () => {
    await writeFile(join(clone, pathOf(3)), content(200_000 + n++, bytesPerFile));
    await git(["-C", clone, ...ident, "commit", "-qam", "one"]);
    await git(["-C", clone, "push", "-q", `${url}/${repo}.git`, "HEAD:refs/heads/cli"], { env: auth(tok(repo, "write")) });
  };
  row.push_1file_cli_plain_ms = await median(5, cliPush(plain.url));
  row.push_1file_cli_repl_ms = await median(5, cliPush(repl.url));
  const { core, seedMs, seedBytes } = await seededCore(repl.url, repo);
  row.seed_index_ms = seedMs; row.seed_index_kb = Math.round(seedBytes / 1024);
  row.commit_1file_core_ms = await median(5, async () => { core.write(pathOf(9), new TextEncoder().encode(content(300_000 + n++, bytesPerFile))); await core.commit("core one"); });
  row.commit_1file_api_ms = await median(5, async () => {
    const head = ((await (await api(repl.url, repo, `/${repo}/refs`)).json()) as Record<string, string>)["refs/heads/main"];
    const r = await api(repl.url, repo, `/${repo}/commit`, { branch: "main", parent: head, message: "api one", files: { [pathOf(10)]: b64(content(400_000 + n++, bytesPerFile)) } });
    if (r.status !== 200) throw new Error("commit api");
  });
  row.commit_100files_api_ms = await timed(async () => {
    const head = ((await (await api(repl.url, repo, `/${repo}/refs`)).json()) as Record<string, string>)["refs/heads/main"];
    await api(repl.url, repo, `/${repo}/commit`, { branch: "main", parent: head, message: "api 100", files: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [pathOf(100 + i), b64(content(500_000 + i, bytesPerFile))])) });
  });
  row.blob_read_ms = await median(10, async () => { const s = (core as unknown as { sql: Sql }).sql; s.exec(`DELETE FROM blobs`); if (!(await core.read(pathOf(7)))) throw new Error("miss"); });

  // Fork = create a branch (CAS from nothing); merge = merge-ort server-side, 3 disjoint files per side plus
  // disjoint hunks of one shared file.
  const head = ((await (await api(repl.url, repo, `/${repo}/refs`)).json()) as Record<string, string>)["refs/heads/main"];
  let f = 0;
  row.fork_ms = await median(5, () => api(repl.url, repo, `/${repo}/refs`, { ref: `refs/heads/fork/f${f++}`, old: null, new: head }));
  const shared = pathOf(40);
  const lines = content(40, bytesPerFile).split("\n");
  const edit = (at: number, tag: string) => { const copy = [...lines]; copy[at] = `// ${tag}`; return copy.join("\n"); };
  await api(repl.url, repo, `/${repo}/commit`, { branch: "fork/f0", parent: head, message: "fork", files: { ...Object.fromEntries([20, 21, 22].map((i) => [pathOf(i), b64(content(i + 7, bytesPerFile))])), [shared]: b64(edit(lines.length - 3, "theirs")) } });
  await api(repl.url, repo, `/${repo}/commit`, { branch: "main", parent: head, message: "main", files: { ...Object.fromEntries([30, 31, 32].map((i) => [pathOf(i), b64(content(i + 9, bytesPerFile))])), [shared]: b64(edit(2, "ours")) } });
  let merged: { merged?: boolean } = {};
  row.merge_ms = await timed(async () => { merged = await (await api(repl.url, repo, `/${repo}/merge`, { into: "main", from: "fork/f0" })).json() as { merged: boolean }; });
  if (!merged.merged) throw new Error(`merge failed: ${JSON.stringify(merged)}`);
  // A conflicting merge: refused, nothing written.
  const h2 = ((await (await api(repl.url, repo, `/${repo}/refs`)).json()) as Record<string, string>)["refs/heads/main"];
  await api(repl.url, repo, `/${repo}/refs`, { ref: "refs/heads/fork/c", old: null, new: h2 });
  await api(repl.url, repo, `/${repo}/commit`, { branch: "fork/c", parent: h2, message: "c", files: { [shared]: b64("theirs\n") } });
  await api(repl.url, repo, `/${repo}/commit`, { branch: "main", parent: h2, message: "m", files: { [shared]: b64("ours\n") } });
  row.merge_conflict_ms = await timed(async () => { const r = await api(repl.url, repo, `/${repo}/merge`, { into: "main", from: "fork/c" }); if (r.status !== 409) throw new Error("expected conflict"); });

  // GC + bucket sweep, then restore from the bucket into a fresh directory (the RTO of one repo).
  const packsBefore = (await readdir(join(root, "repl", `${repo}.git`, "objects/pack"))).filter((x) => x.endsWith(".pack")).length;
  row.packs_before_gc = packsBefore;
  const gc = await (await api(repl.url, repo, `/${repo}/gc`, { graceMs: 0 })).json() as { ms: number; swept: number };
  row.gc_ms = gc.ms; row.gc_swept_objects = gc.swept;
  row.pack_after_gc_mb = +((await du(join(root, "repl", `${repo}.git`, "objects/pack"))) / 1e6).toFixed(1);
  if (replicator) {
    let restored = { packs: 0, bytes: 0, refs: 0 };
    row.restore_ms = await timed(async () => { restored = await replicator!.restore(repo, join(work, "restored.git")); });
    row.restore_mb = +(restored.bytes / 1e6).toFixed(1);
    row.restore_fsck_ms = await timed(() => git(["--git-dir", join(work, "restored.git"), "fsck", "--connectivity-only", "--no-progress"]));
    const want = await git(["--git-dir", join(root, "repl", `${repo}.git`), "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
    const got = await git(["--git-dir", join(work, "restored.git"), "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
    row.restore_refs_match = want === got ? "yes" : "NO";
  }
  console.error(JSON.stringify(row));
  // Keep the repl repo for bench/client.ts; drop the work dir.
  await rm(work, { recursive: true, force: true });
}

const keys = [...new Set(Object.values(results).flatMap((r) => Object.keys(r)))];
console.log(`\nreplication: ${replicator ? "MinIO on the same host" : "off"}\n`);
console.log(`| metric | ${sizes.join(" | ")} |\n|---|${sizes.map(() => "---:").join("|")}|`);
for (const key of keys) console.log(`| ${key} | ${sizes.map((s) => String(results[s]?.[key] ?? "")).join(" | ")} |`);
console.log(`\n${JSON.stringify(results)}`);
await plain.close();
const serve = Number(process.env.SERVE_MINUTES ?? 0);
if (serve > 0) {
  console.log(`SERVING on :${repl.port} for ${serve} min (repos: ${sizes.map((s) => `bench-${s}`).join(", ")}); touch ${root}/stop to end`);
  const until = Date.now() + serve * 60_000;
  while (Date.now() < until && !(await stat(join(root, "stop")).then(() => true, () => false))) await new Promise((r) => setTimeout(r, 2000));
}
await repl.close();
await rm(root, { recursive: true, force: true }).catch(() => {});
