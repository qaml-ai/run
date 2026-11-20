// Disk-fork benchmark for camelRun computers.
//
//   node --experimental-strip-types scripts/bench/computer-fork/bench.ts \
//     --provider boat|boat-saved|boat-live|exe|cloudflare|sprites|fresh|worktrees [--rounds 1,5,10] [--skip-probe] [--skip-fresh]
//
// fork scenario (default): prepare one source workspace (clone qaml-ai/run, npm ci
// root + backends/workers), make it forkable, then for each N fork it N times in
// parallel and run a build + test in every fork. One extra fork and one fresh
// machine get the disk probe (mounts, I/O, git, npm ci warm/cold, typecheck).
// Every machine the run creates is deleted at the end and the provider listing
// is recorded as cleanup proof. Results land in results/<provider>-<time>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boat, cloudflare, exe, sprites, type Machine, type Provider, type Result } from "./providers.ts";
import { build, check, io, mounts, parse, prepare, realwork } from "./workload.ts";

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(" ").split("--").filter(Boolean).map(a => { const [k, ...v] = a.trim().split(/\s+/); return [k, v.join(" ") || "1"]; }));
const which = String(args.provider ?? "boat");
const rounds = String(args.rounds ?? "1,5,10").split(",").map(Number).filter(n => n > 0);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const prefix = `cfork-${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`;
const out: any = { provider: which, prefix, startedAt: new Date().toISOString(), rounds: [], errors: [] as string[] };
const resultsFile = join(here, "results", `${which}-${stamp}.json`);
const save = () => { mkdirSync(dirname(resultsFile), { recursive: true }); writeFileSync(resultsFile, JSON.stringify(out, null, 2)); };
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; };
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), max: Math.max(...xs) });

function provider(): Provider {
  if (which === "boat" || which === "fresh" || which === "worktrees") return boat("stop");
  if (which === "boat-saved") return boat("saved");
  if (which === "boat-live") return boat("live");
  if (which === "exe") return exe();
  if (which === "sprites") return sprites();
  if (which === "cloudflare") {
    const token = process.env.CF_BENCH_TOKEN ?? readFileSync(String(args.tokenFile), "utf8").trim();
    return cloudflare(String(args.url ?? "https://cfork-bench.miguel-85b.workers.dev"), token);
  }
  throw new Error(`unknown provider ${which}`);
}
const p = provider();
const created: Machine[] = [];
const handles: unknown[] = [];

async function timed<T>(f: () => Promise<T>) { const t = Date.now(); const v = await f(); return [v, Date.now() - t] as const; }
async function must(m: Machine, cmd: string, what: string, timeoutSec = 900): Promise<Result> {
  const r = await p.exec(m, cmd, timeoutSec);
  if (r.code !== 0) throw new Error(`${what} on ${m.name} exit ${r.code}: ${(r.stdout + r.stderr).slice(-800)}`);
  return r;
}
/** Poll a trivial command until the machine answers; returns ms. */
async function firstCommand(m: Machine, t0: number) {
  for (let i = 0; ; i++) {
    try { const r = await p.exec(m, "true", 30); if (r.code === 0) return Date.now() - t0; } catch (e) { if (i > 120) throw e; }
    await sleep(250);
  }
}
/** Run a long step detached and poll for it, so no single API call or HTTP request has to outlive it. */
async function detached(m: Machine, cmd: string, what: string, timeoutSec = 3600): Promise<Result> {
  const id = Math.random().toString(36).slice(2, 8);
  const b64 = Buffer.from(cmd).toString("base64");
  await must(m, `echo ${b64} | base64 -d > /tmp/job-${id}.sh; nohup bash -c 'bash /tmp/job-${id}.sh > /tmp/job-${id}.out 2>&1; echo $? > /tmp/job-${id}.rc' >/dev/null 2>&1 &`, `${what} start`, 60);
  for (const until = Date.now() + timeoutSec * 1000; Date.now() < until; await sleep(5000)) {
    const r = await p.exec(m, `cat /tmp/job-${id}.rc 2>/dev/null && tail -c 20000 /tmp/job-${id}.out`, 60).catch(() => null);
    if (r && r.code === 0 && r.stdout.trim()) { const [rc, ...rest] = r.stdout.split("\n"); const res = { code: Number(rc), stdout: rest.join("\n"), stderr: "" }; if (res.code) throw new Error(`${what} exit ${res.code}: ${res.stdout.slice(-800)}`); return res; }
  }
  throw new Error(`${what} timed out`);
}
async function create(name: string) { const m = await p.create(name); created.push(m); return m; }

async function probe(m: Machine, label: string) {
  log(`probe ${label}: mounts, io, realwork`);
  const mnt = await p.exec(m, mounts(p.ws), 120);
  const ior = await p.exec(m, io(p.ws), 900);
  const rw = await p.exec(m, realwork(p.ws), 900);
  return { mounts: mnt.stdout.slice(-4000), io: parse(ior.stdout), ioRaw: (ior.stdout + ior.stderr).slice(-2000), realwork: parse(rw.stdout), realworkRaw: rw.stdout.slice(-1500) };
}

async function forkScenario() {
  // 1. Source workspace
  log(`create source ${prefix}-src`);
  let [src, ms] = await timed(() => create(`${prefix}-src`));
  out.source = { createMs: ms, firstCommandMs: await firstCommand(src, Date.now() - ms) };
  const prep = await must(src, prepare(p.ws), "prepare", 1800);
  out.source.prepare = parse(prep.stdout);
  log("source prepared", out.source.prepare);
  const b = await p.exec(src, build(p.ws, "source"), 900);
  out.source.build = parse(b.stdout);
  await p.exec(src, `cd ${p.ws}/run && git checkout -q main && rm -f FORK_ID`, 60);
  save();

  // 2. Make it forkable
  let handle: unknown;
  [handle, ms] = await timed(() => p.prepareFork(src, `${prefix}-base`));
  handles.push(handle);
  out.snapshot = { ms, handle };
  log(`prepareFork ${ms} ms`);
  save();

  // 3. Rounds of N parallel forks
  for (const n of rounds) {
    log(`round N=${n}`);
    const t0 = Date.now();
    const forks = await Promise.all(Array.from({ length: n }, async (_, i) => {
      const name = `${prefix}-n${n}-${i}`;
      const s = Date.now();
      try {
        const m = await p.fork(handle, name); created.push(m);
        const callMs = Date.now() - s;
        const firstMs = await firstCommand(m, s);
        return { m, callMs, firstMs };
      } catch (e) { out.errors.push(`fork ${name}: ${(e as Error).message}`); return null; }
    }));
    const ok = forks.filter(f => f !== null) as { m: Machine; callMs: number; firstMs: number }[];
    const allFirstMs = Date.now() - t0;
    const builds = await Promise.all(ok.map(async (f, i) => {
      const r = await p.exec(f.m, build(p.ws, String(i)), 900);
      return { exit: r.code, ...parse(r.stdout) };
    }));
    const allBuiltMs = Date.now() - t0;
    const checks = await Promise.all(ok.map(async (f, i) => ({ i, ...parse((await p.exec(f.m, check(p.ws), 60)).stdout) })));
    const independent = checks.every(c => c.fork_id === String(c.i) && c.branch === `fork-${c.i}` && c.node_modules === "yes");
    out.rounds.push({
      n, ok: ok.length, callMs: stats(ok.map(f => f.callMs)), firstCommandMs: stats(ok.map(f => f.firstMs)),
      allFirstCommandMs: allFirstMs, allBuiltMs, buildMs: stats(builds.map(b => Number(b.build_ms))), builds, checks, independent,
    });
    log(`N=${n}: first p50 ${pct(ok.map(f => f.firstMs), 50)} p95 ${pct(ok.map(f => f.firstMs), 95)} all ${allFirstMs}; build p50 ${pct(builds.map(b => Number(b.build_ms)), 50)}; independent ${independent}`);
    save();
    // keep the first fork of the first round for the persistence test
    await Promise.all(ok.slice(n === rounds[0] ? 1 : 0).map(f => p.destroy(f.m).then(() => { created.splice(created.indexOf(f.m), 1); })));
  }

  // 4. Persistence across stop/wake on a fork that holds its own changes
  const keep = rounds.length ? created.find(m => m.name === `${prefix}-n${rounds[0]}-0`) : undefined;
  if (keep && p.stopWake) {
    try {
      const before = parse((await p.exec(keep, check(p.ws), 60)).stdout);
      const sw = await p.stopWake(keep);
      const after = parse((await p.exec(keep, check(p.ws), 60)).stdout);
      out.persistence = { ...sw, before, after, kept: before.fork_id === after.fork_id && after.node_modules === "yes" };
      log("persistence", out.persistence);
    } catch (e) { out.errors.push(`persistence: ${(e as Error).message}`); }
    save();
  }

  // 5. Source unaffected by the forks' writes
  try {
    if (which === "boat") { await fetchResume(src); }
    out.sourceAfter = parse((await p.exec(src, check(p.ws), 120)).stdout);
    out.sourceUnaffected = out.sourceAfter.fork_id === "none" && out.sourceAfter.branch === "main";
  } catch (e) { out.errors.push(`source check: ${(e as Error).message}`); }
  save();

  // 6. Disk probe: a fresh fork against a fresh machine
  if (!args["skip-probe"]) {
    try {
      const s = Date.now(); const pf = await p.fork(handle, `${prefix}-probe`); created.push(pf); await firstCommand(pf, s);
      out.probeFork = await probe(pf, "fork");
      if (which.startsWith("boat")) {
        // Boat restores lazily through FUSE; probe again once it reports the disk fully hydrated.
        const t = Date.now(); while (!(await boatHydrated(pf)) && Date.now() - t < 900_000) await sleep(5000);
        out.probeForkHydrated = { waitedMs: Date.now() - t, ...(await probe(pf, "fork after hydration")) };
      }
    } catch (e) { out.errors.push(`probe fork: ${(e as Error).message}`); }
    save();
  }
  if (!args["skip-fresh"]) {
    try {
      const fresh = await create(`${prefix}-fresh`); await firstCommand(fresh, Date.now());
      out.freshPrepare = parse((await must(fresh, prepare(p.ws), "fresh prepare", 1800)).stdout);
      out.probeFresh = await probe(fresh, "fresh");
    } catch (e) { out.errors.push(`probe fresh: ${(e as Error).message}`); }
    save();
  }
}

async function boatHydrated(m: Machine) {
  const key = readFileSync(`${process.env.HOME}/.config/boat/key`, "utf8").trim();
  const r = await fetch(`https://boat.dev/api/v1/sandboxes/${m.id}`, { headers: { Authorization: `Bearer ${key}` } }).then(r => r.json()) as any;
  return r?.sandbox?.hydrated === true;
}

async function fetchResume(src: Machine) {
  // Boat stop-mode sources are stopped; resume to inspect them.
  const key = readFileSync(`${process.env.HOME}/.config/boat/key`, "utf8").trim();
  await fetch(`https://boat.dev/api/v1/sandboxes/${src.id}/resume`, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ ttlSeconds: 1800 }) });
  await firstCommand(src, Date.now());
}

/** Baseline: N fresh machines each clone + install from scratch, then build. */
async function freshScenario() {
  for (const n of rounds) {
    log(`fresh N=${n}`);
    const t0 = Date.now();
    const rs = await Promise.all(Array.from({ length: n }, async (_, i) => {
      try {
        const s = Date.now(); const m = await create(`${prefix}-fresh${n}-${i}`); const firstMs = await firstCommand(m, s);
        const pr = parse((await must(m, prepare(p.ws), "prepare", 1800)).stdout); const readyMs = Date.now() - s;
        const b = parse((await p.exec(m, build(p.ws, String(i)), 900)).stdout);
        return { firstMs, readyMs, ...pr, build_ms: Number(b.build_ms), m };
      } catch (e) { out.errors.push(`fresh ${i}: ${(e as Error).message}`); return null; }
    }));
    const ok = rs.filter(Boolean) as any[];
    out.rounds.push({ n, ok: ok.length, firstCommandMs: stats(ok.map(r => r.firstMs)), readyToBuildMs: stats(ok.map(r => r.readyMs)), allReadyMs: Date.now() - t0,
      buildMs: stats(ok.map(r => r.build_ms)), detail: ok.map(({ m, ...r }) => r) });
    save();
    await Promise.all(ok.map(r => p.destroy(r.m).then(() => created.splice(created.indexOf(r.m), 1))));
  }
}

/** Baseline: one machine, N git worktrees building at once. */
async function worktreeScenario() {
  const m = await create(`${prefix}-wt`); await firstCommand(m, Date.now());
  out.source = { prepare: parse((await must(m, prepare(p.ws), "prepare", 1800)).stdout) };
  out.source.build = parse((await p.exec(m, build(p.ws, "solo"), 900)).stdout);
  await p.exec(m, `cd ${p.ws}/run && git checkout -q main && rm -f FORK_ID`, 60);
  for (const n of rounds) {
    log(`worktrees N=${n}`);
    // Each worktree needs its own node_modules: npm ci from the warm npm cache.
    const setup = `set -e; ms(){ echo $(( $(date +%s%N) / 1000000 )); }; cd ${p.ws}/run; t0=$(ms)
for i in $(seq 0 $((${n}-1))); do git worktree add -q -b wt${n}-$i ../wt${n}-$i main; done; t1=$(ms)
for i in $(seq 0 $((${n}-1))); do (cd ../wt${n}-$i && npm ci --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null 2>&1 && cd backends/workers && npm ci --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null 2>&1) & done; wait; t2=$(ms)
echo "worktree_add_ms=$((t1-t0)) parallel_install_ms=$((t2-t1)) disk_kb=$(du -sk ${p.ws} | cut -f1)"`;
    const s = parse((await detached(m, setup, "worktree setup")).stdout);
    const t0 = Date.now();
    out.rounds.push({ n, setup: s }); save();
    // Builds run detached too: ten at once on one machine can outlive an HTTP request.
    const builds = await Promise.all(Array.from({ length: n }, async (_, i) => ({ exit: 0, ...parse((await detached(m, build(p.ws, `${n}-${i}`, `wt${n}-${i}`), `build ${i}`).catch(e => ({ stdout: `error=${String(e.message).replace(/\s+/g, "_").slice(0, 80)}` } as Result))).stdout) })));
    const allBuiltMs = Date.now() - t0;
    // Port contention: every worktree's dev server wants the same port.
    const ports = parse((await p.exec(m, `ok=0; fail=0; for i in $(seq 1 ${n}); do (node -e 'require("http").createServer(()=>{}).listen(8787,()=>setTimeout(()=>process.exit(0),1500)).on("error",()=>process.exit(1))' && echo up || echo clash) > /tmp/port$i & done; wait; echo "port_8787_bound=$(grep -l up /tmp/port* | wc -l) port_8787_clash=$(grep -l clash /tmp/port* | wc -l)"`, 60)).stdout);
    const load = parse((await p.exec(m, `echo "load1=$(cut -d' ' -f1 /proc/loadavg) nproc=$(nproc)"`, 30)).stdout);
    out.rounds.pop(); out.rounds.push({ n, setup: s, allBuiltMs, buildMs: stats(builds.map(b => Number(b.build_ms))), builds, ports, load });
    log(`worktrees N=${n}: build p50 ${pct(builds.map(b => Number(b.build_ms)), 50)} all ${allBuiltMs}`, s, ports);
    await p.exec(m, `cd ${p.ws}/run && for i in $(seq 0 $((${n}-1))); do git worktree remove --force ../wt${n}-$i; done`, 300);
    save();
  }
}

/** Sprites has no fork: checkpoint the source, scribble, restore, and time it. */
async function spritesScenario() {
  const [src, ms] = await timed(() => create(`${prefix}-src`));
  out.source = { createMs: ms, firstCommandMs: await firstCommand(src, Date.now() - ms) };
  out.source.prepare = parse((await must(src, prepare(p.ws), "prepare", 1800)).stdout);
  out.source.build = parse((await p.exec(src, build(p.ws, "source"), 900)).stdout);
  await p.exec(src, `cd ${p.ws}/run && git checkout -q main && rm -f FORK_ID`, 60);
  const [cp, cpMs] = await timed(() => p.prepareFork(src, "base"));
  out.snapshot = { ms: cpMs, handle: cp };
  await p.exec(src, `cd ${p.ws}/run && echo scribble > FORK_ID && rm -rf node_modules/typescript`, 120);
  const version = String((cp as any).create.match(/v\d+/)?.[0] ?? (cp as any).list.match(/"(v\d+)"/)?.[1] ?? "v1");
  const t0 = Date.now();
  const r = await run2("sprite", ["-o", "camelai", "restore", "-s", src.name, version]);
  out.restore = { version, callMs: Date.now() - t0, output: (r.stdout + r.stderr).slice(-500) };
  out.restore.firstCommandMs = await firstCommand(src, t0);
  out.restore.after = parse((await p.exec(src, check(p.ws), 60)).stdout);
  out.restore.build = parse((await p.exec(src, build(p.ws, "restored"), 900)).stdout);
  out.probeRestored = await probe(src, "restored");
  save();
}
async function run2(cmd: string, a: string[]) {
  const { execFile } = await import("node:child_process");
  return new Promise<Result>(res => execFile(cmd, a, { timeout: 600000 }, (e, so, se) => res({ code: e ? 1 : 0, stdout: String(so), stderr: String(se) })));
}

try {
  if (which === "fresh") await freshScenario();
  else if (which === "worktrees") await worktreeScenario();
  else if (which === "sprites") await spritesScenario();
  else await forkScenario();
} catch (e) {
  out.errors.push(`fatal: ${(e as Error).stack ?? e}`); log("FATAL", e);
} finally {
  log(`cleanup ${created.length} machines`);
  for (const m of created.splice(0)) { try { await p.destroy(m); } catch (e) { out.errors.push(`destroy ${m.name}: ${(e as Error).message}`); } }
  for (const h of handles) { try { await p.cleanupHandle?.(h); } catch {} }
  await sleep(3000);
  out.leftovers = await p.leftovers(prefix).catch(e => [`listing failed: ${e.message}`]);
  out.finishedAt = new Date().toISOString();
  save();
  log("leftovers", out.leftovers, "->", resultsFile);
}
