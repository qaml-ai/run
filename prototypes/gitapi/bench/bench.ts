// Bench of the git API at the shared sizes (same generator and paths as prototypes/artifacts-volumes/bench):
// small 200 files / 1 MB, medium 5k / 50 MB, large 50k / 500 MB.
//   GITAPI_URL=http://127.0.0.1:8795 (node server, CPU per request from /_cpu) or :8794 (wrangler dev: wall only).
// Prints JSON per size to stdout.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const base = process.env.GITAPI_URL ?? "http://127.0.0.1:8795";
const sizes = (process.env.BENCH_SIZES ?? "small,medium,large").split(",");
const BATCH = Number(process.env.BATCH ?? 2500);
const SIZES: Record<string, { files: number; bytesPerFile: number }> = { small: { files: 200, bytesPerFile: 5_000 }, medium: { files: 5_000, bytesPerFile: 10_000 }, large: { files: 50_000, bytesPerFile: 10_000 } };
const WORDS = "const let function return import export async await class interface type string number boolean void null undefined if else for while switch case break continue throw try catch finally new this super extends implements public private static readonly".split(" ");
function content(seed: number, bytes: number) { let x = seed * 2654435761 >>> 0; const next = () => (x = (x * 1664525 + 1013904223) >>> 0); let out = `// file ${seed}\n`; while (out.length < bytes) { const line: string[] = []; for (let n = 2 + next() % 9; n > 0; n--) line.push(WORDS[next() % WORDS.length]); out += `${"  ".repeat(next() % 4)}${line.join(" ")}${next() % 3 ? ";" : " {"}\n`; } return out; }
const pathOf = (i: number) => `src/m${Math.floor(i / 2500)}/d${Math.floor(i / 50)}/f${i}.ts`;

const git = async (cwd: string, args: string[]) => (await run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, maxBuffer: 64 << 20 })).stdout.trim();
const cpuOf = async (key: string): Promise<number | null> => { try { const r = await fetch(`${base}/_cpu`); if (!r.ok) return null; const j = (await r.json()) as Record<string, number>; return j[key] ?? null; } catch { return null; } };
type Sample = { wall: number; server: number; cpu: number | null };
const round = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
function summary(samples: Sample[]) { return { wall_ms: round(med(samples.map((s) => s.wall))), server_ms: round(med(samples.map((s) => s.server))), cpu_ms: samples[0].cpu === null ? null : round(med(samples.map((s) => s.cpu!))) }; }

async function call(repo: string, method: string, path: string, body?: unknown, cpuKey?: string): Promise<{ json: any; s: Sample }> {
  const t = performance.now();
  const r = await fetch(`${base}/repos/${repo}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  const wall = performance.now() - t;
  if (!r.ok && r.status !== 409) throw new Error(`${method} ${path} ${r.status}: ${text.slice(0, 300)}`);
  const cpu = cpuKey ? await cpuOf(cpuKey) : null;
  return { json: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, s: { wall, server: Number(r.headers.get("x-server-ms") ?? 0), cpu } };
}
async function gitTimed(cwd: string, args: string[]): Promise<Sample> {
  const t = performance.now();
  await git(cwd, args);
  return { wall: performance.now() - t, server: 0, cpu: await cpuOf("POST /git-upload-pack") };
}

const root = await mkdtemp(join(tmpdir(), "gitapi-bench-"));
const results: Record<string, unknown> = { base };
for (const size of sizes) {
  const { files, bytesPerFile } = SIZES[size];
  const repo = `bench-${size}-${Date.now().toString(36)}`;
  const remote = `${base}/git/${repo}.git`;
  const out: Record<string, unknown> = { files, raw_mb: Math.round((files * bytesPerFile) / 1e6) };
  results[size] = out;
  console.error(`== ${size} (${repo})`);

  // Import through the commit API, BATCH files per commit (a Worker request body is ≤100 MB; the object holds one
  // batch in memory).
  let importWall = 0, importServer = 0, importCpu = 0, commits = 0;
  for (let i = 0; i < files; i += BATCH) {
    const map: Record<string, { content: string }> = {};
    for (let j = i; j < Math.min(files, i + BATCH); j++) map[pathOf(j)] = { content: content(j, bytesPerFile) };
    const r = await call(repo, "POST", "/commits", { branch: "main", message: `import ${i}`, files: map }, "POST /commits");
    importWall += r.s.wall; importServer += r.s.server; importCpu += r.s.cpu ?? 0; commits++;
  }
  out.import = { commits, wall_ms: Math.round(importWall), server_ms: Math.round(importServer), cpu_ms: Math.round(importCpu) };
  out.stats_after_import = (await call(repo, "GET", "/stats")).json;

  // Clone: cold builds the pack from segment ranges (and caches it); warm streams the cached pack.
  const work = join(root, size);
  await git(root, ["init", "-q", work]);
  const cold = await gitTimed(root, ["clone", "-q", remote, join(work, "c1")]);
  await new Promise((r) => setTimeout(r, 500)); // the cache put finishes in waitUntil
  const warm = await gitTimed(root, ["clone", "-q", remote, join(work, "c2")]);
  const shallowCold = await gitTimed(root, ["clone", "-q", "--depth", "1", remote, join(work, "s1")]);
  await new Promise((r) => setTimeout(r, 500));
  const shallowWarm = await gitTimed(root, ["clone", "-q", "--depth", "1", remote, join(work, "s2")]);
  const packBytes = (await call(repo, "GET", "/stats")).json.clonePackBytes;
  out.clone = { full_cold: summary([cold]), full_warm: summary([warm]), depth1_cold: summary([shallowCold]), depth1_warm: summary([shallowWarm]), cached_pack_bytes_total: packBytes };

  // Commit latency: one file, then 100 files, into the imported tree.
  const one: Sample[] = [], hundred: Sample[] = [];
  for (let k = 0; k < 10; k++) one.push((await call(repo, "POST", "/commits", { branch: "main", message: `one ${k}`, files: { [pathOf(k * 7 % files)]: { content: content(1e6 + k, bytesPerFile) } } }, "POST /commits")).s);
  for (let k = 0; k < 5; k++) {
    const map: Record<string, { content: string }> = {};
    for (let j = 0; j < 100; j++) map[pathOf((k * 100 + j * 13) % files)] = { content: content(2e6 + k * 100 + j, bytesPerFile) };
    hundred.push((await call(repo, "POST", "/commits", { branch: "main", message: `hundred ${k}`, files: map }, "POST /commits")).s);
  }
  out.commit_1_file = summary(one);
  out.commit_100_files = summary(hundred);

  // Fetch: the 15 commits above (~510 changed files) into c1; then one 3-file commit into c2's next fetch.
  const fetchMany = await gitTimed(join(work, "c1"), ["fetch", "-q", "origin"]);
  await git(join(work, "c2"), ["fetch", "-q", "origin"]);
  await call(repo, "POST", "/commits", { branch: "main", message: "three", files: { [pathOf(1)]: { content: "x\n" }, [pathOf(2)]: { content: "y\n" }, [pathOf(3)]: { content: "z\n" } } });
  const fetch3 = await gitTimed(join(work, "c2"), ["fetch", "-q", "origin"]);
  const fetch3b = await gitTimed(join(work, "c1"), ["fetch", "-q", "origin"]);
  out.fetch = { after_15_commits_510_files: summary([fetchMany]), three_files: summary([fetch3]), three_files_again_other_clone: summary([fetch3b]) };
  await git(join(work, "c1"), ["fsck", "--connectivity-only"]);

  // Reads.
  const reads: Sample[] = [];
  for (let k = 0; k < 20; k++) {
    const t = performance.now();
    const r = await fetch(`${base}/repos/${repo}/files/${pathOf((k * 97) % files)}?ref=main`);
    await r.arrayBuffer();
    reads.push({ wall: performance.now() - t, server: Number(r.headers.get("x-server-ms")), cpu: await cpuOf(`GET /files/${pathOf((k * 97) % files)}`) });
  }
  out.read_file = summary(reads);
  const treeR = await call(repo, "GET", "/tree?recursive=1", undefined, "GET /tree");
  out.read_tree_recursive = { ...summary([treeR.s]), entries: treeR.json.entries.length };
  const logR = await call(repo, "GET", "/log?limit=50", undefined, "GET /log");
  out.log_50 = summary([logR.s]);
  const firstCommit = logR.json.at(-1).sha;
  const diffR = await call(repo, "GET", `/diff?from=${firstCommit}&to=main`, undefined, "GET /diff");
  out.diff_all_history = { ...summary([diffR.s]), changes: diffR.json.changes.length };

  // Worktree (the agent file-tool layer): a write is a SQLite row; a checkpoint commits the dirty rows.
  const wtWrites: Sample[] = [], wtReads: Sample[] = [];
  for (let k = 0; k < 50; k++) {
    const path = pathOf((k * 31) % files), t = performance.now();
    const r = await fetch(`${base}/repos/${repo}/worktree/${path}?branch=main`, { method: "PUT", body: content(4e6 + k, bytesPerFile) });
    await r.arrayBuffer();
    wtWrites.push({ wall: performance.now() - t, server: Number(r.headers.get("x-server-ms")), cpu: await cpuOf(`PUT /worktree/${path}`) });
    const t2 = performance.now();
    const g = await fetch(`${base}/repos/${repo}/worktree/${path}?branch=main`);
    await g.arrayBuffer();
    wtReads.push({ wall: performance.now() - t2, server: Number(g.headers.get("x-server-ms")), cpu: await cpuOf(`GET /worktree/${path}`) });
  }
  out.worktree_write = summary(wtWrites);
  out.worktree_read_dirty = summary(wtReads);
  out.worktree_checkpoint_50_files = summary([(await call(repo, "POST", "/worktree?branch=main&message=cp", undefined, "POST /worktree")).s]);

 Branch create is one row. Merge A: disjoint files on each side (tree-level). Merge B: the same
  // file edited in disjoint hunks (diff3, reads three blobs from R2). Merge C: fast-forward.
  const branches: Sample[] = [];
  for (let k = 0; k < 10; k++) branches.push((await call(repo, "POST", "/branches", { name: `b/${k}`, from: "main", ttlSeconds: 3600 }, "POST /branches")).s);
  out.branch_create = summary(branches);
  const mergesA: Sample[] = [], mergesB: Sample[] = [], mergesFF: Sample[] = [];
  for (let k = 0; k < 3; k++) {
    await call(repo, "POST", "/commits", { branch: `b/${k}`, message: "fork", files: { [pathOf(10 + k)]: { content: "fork\n" }, [pathOf(20 + k)]: { content: "fork\n" }, [pathOf(30 + k)]: { content: "fork\n" } } });
    await call(repo, "POST", "/commits", { branch: "main", message: "main", files: { [pathOf(40 + k)]: { content: "main\n" }, [pathOf(50 + k)]: { content: "main\n" }, [pathOf(60 + k)]: { content: "main\n" } } });
    const r = await call(repo, "POST", "/merges", { into: "main", from: `b/${k}`, deleteSource: true }, "POST /merges");
    if (r.json.status !== "merged") throw new Error(JSON.stringify(r.json));
    mergesA.push(r.s);
  }
  for (let k = 3; k < 6; k++) {
    await call(repo, "POST", "/branches", { name: `h/${k}`, from: "main" });
    const p = pathOf(100 + k), lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    await call(repo, "POST", "/commits", { branch: "main", message: "base", files: { [p]: { content: lines.join("\n") + "\n" } } });
    await call(repo, "POST", "/merges", { into: `h/${k}`, from: "main" });
    const fork = [...lines]; fork[2] = "fork"; const mine = [...lines]; mine[35] = "main";
    await call(repo, "POST", "/commits", { branch: `h/${k}`, message: "f", files: { [p]: { content: fork.join("\n") + "\n" } } });
    await call(repo, "POST", "/commits", { branch: "main", message: "m", files: { [p]: { content: mine.join("\n") + "\n" } } });
    const r = await call(repo, "POST", "/merges", { into: "main", from: `h/${k}`, deleteSource: true }, "POST /merges");
    if (r.json.status !== "merged") throw new Error(JSON.stringify(r.json));
    mergesB.push(r.s);
  }
  for (let k = 6; k < 9; k++) {
    await call(repo, "POST", "/commits", { branch: `b/${k}`, message: "ff", files: { [pathOf(70 + k)]: { content: "ff\n" } } });
    await call(repo, "POST", "/merges", { into: `b/${k}`, from: "main" }); // bring b/k up to main, then ff main
    const r = await call(repo, "POST", "/merges", { into: "main", from: `b/${k}`, deleteSource: true }, "POST /merges");
    mergesFF.push(r.s);
  }
  out.merge_disjoint_files = summary(mergesA);
  out.merge_same_file_diff3 = summary(mergesB);
  out.merge_fast_forward = summary(mergesFF);

  // Ephemeral lifecycle: branch with a 2 s TTL, 10 checkpoints of 5 files, expiry, GC reclaims its bytes.
  const life = performance.now();
  await call(repo, "POST", "/branches", { name: "attempt/x", from: "main", ttlSeconds: 2 });
  for (let k = 0; k < 10; k++) {
    const map: Record<string, { content: string }> = {};
    for (let j = 0; j < 5; j++) map[`scratch/${k}-${j}.txt`] = { content: content(3e6 + k * 5 + j, bytesPerFile) };
    await call(repo, "POST", "/commits", { branch: "attempt/x", message: `cp ${k}`, files: map });
  }
  const worked = performance.now() - life;
  const statsBefore = (await call(repo, "GET", "/stats")).json;
  for (let tries = 0; tries < 30; tries++) { await new Promise((r) => setTimeout(r, 500)); if (!(await call(repo, "GET", "/refs")).json.some((r: { name: string }) => r.name === "attempt/x")) break; }
  const expiredAfter = performance.now() - life;
  const gcR = await call(repo, "POST", "/gc", { graceMs: 0 }, "POST /gc");
  const statsAfter = (await call(repo, "GET", "/stats")).json;
  out.ephemeral = { work_ms: Math.round(worked), expired_after_ms: Math.round(expiredAfter), gc: { ...summary([gcR.s]), ...gcR.json }, segments_before: statsBefore.segments, segments_after: statsAfter.segments, segment_mb_before: +(statsBefore.segmentBytes / 1e6).toFixed(2), segment_mb_after: +(statsAfter.segmentBytes / 1e6).toFixed(2) };
  out.stats_end = statsAfter;
  console.log(JSON.stringify({ [size]: out }, null, 1));
  if (!process.env.KEEP) await call(repo, "DELETE", "");
  await rm(work, { recursive: true, force: true });
}
console.error(JSON.stringify(results));
await rm(root, { recursive: true, force: true });
