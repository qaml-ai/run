/**
 * Memory per resident agent: the Node runtime (src/, AGENT_HOSTING=inline as in production) against the Workers backend
 * (backends/workers) on local workerd, or on celld (./celld). Same API calls, same deterministic fake
 * model, same local Postgres. See backends/workers/docs/memory-benchmark.md for method and results.
 *
 *   node --experimental-strip-types benchmarks/agent-memory/run.ts --backend=node|workers|celld --agents=100 \
 *     [--turns=3] [--concurrency=50] [--idle-wait=150] [--code=0] [--node-idle-ms=90000] [--out=results.json]
 *
 * Needs AGENT_TEST_DATABASE_URL (local Postgres). Samples every process on the machine once a second from /proc and
 * groups them (server, workerd, wrangler, celld, v8-exec, postgres), so run it on a machine of its own.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { OPERATOR, toolCall } from "../../tests/contract/http.ts";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")) as [string, string][]);
const backend = args.backend ?? "node";
const N = Number(args.agents ?? 10), TURNS = Number(args.turns ?? 3), C = Number(args.concurrency ?? 50);
const IDLE_WAIT_S = Number(args["idle-wait"] ?? 150);
// --code=0: no code turn (every turn a plain answer), to separate the code sandbox's share.
const CODE = args.code !== "0";
const out = args.out ?? `agent-memory-${backend}-${N}.json`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---- process sampling ----------------------------------------------------------------------------------------------
const PAGE = 4096, HZ = 100;
type Group = "server" | "workerd" | "workerd-proxy" | "wrangler" | "esbuild" | "celld" | "v8-exec" | "postgres" | "harness";
function classify(pid: string): Group | undefined {
  let cmd: string;
  try { cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " "); } catch { return; }
  if (Number(pid) === process.pid) return "harness";
  // Wrangler runs two workerd processes: the Worker (entry socket on port 0) and its dev proxy (entry on the fixture's
  // port). The proxy is local tooling, not part of the runtime, and is reported apart.
  if (/\bworkerd\b/.test(cmd)) return /--socket-addr=entry=127\.0\.0\.1:0\b/.test(cmd) ? "workerd" : "workerd-proxy";
  if (/\bcelld\b/.test(cmd.split(" ")[0] ?? "")) return "celld";
  if (/src\/server\.ts/.test(cmd)) return "server";
  if (/agent-child\.ts/.test(cmd)) return "server";
  if (/v8-exec/.test(cmd)) return "v8-exec";
  if (/wrangler/.test(cmd)) return "wrangler";
  if (/esbuild/.test(cmd)) return "esbuild";
  if (/^postgres/.test(cmd) || /postgresql\/.*\/bin\/postgres/.test(cmd)) return "postgres";
}
type Sample = { t: number; rss: Partial<Record<Group, number>>; hwm: Partial<Record<Group, number>>; cpu: Partial<Record<Group, number>>; pss?: number; phase: string; n?: number };
const samples: Sample[] = [];
let phase = "start";
function sample(): Sample {
  const s: Sample = { t: Date.now(), rss: {}, hwm: {}, cpu: {}, phase };
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const g = classify(pid);
    if (!g) continue;
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const kb = (k: string) => Number(status.match(new RegExp(`${k}:\\s+(\\d+)`))?.[1] ?? 0);
      // Postgres shares its buffers between backends: RssAnon + RssFile of each counts shared pages many times.
      // Count it by Pss (smaps_rollup) instead; the other groups are single processes or unshared.
      let rss = kb("VmRSS");
      if (g === "postgres") {
        try { rss = Number(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8").match(/Pss:\s+(\d+)/)?.[1] ?? rss); } catch {}
      }
      s.rss[g] = (s.rss[g] ?? 0) + rss / 1024;
      s.hwm[g] = Math.max(s.hwm[g] ?? 0, kb("VmHWM") / 1024);
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
      s.cpu[g] = (s.cpu[g] ?? 0) + (Number(stat[11]) + Number(stat[12])) / HZ;
    } catch { /* exited */ }
  }
  return s;
}
/** Each runtime process (pid, MB, command) at one moment: the workerd group is Wrangler's two processes, for instance. */
function processes() {
  const rows: { pid: number; group: string; mb: number; cmd: string }[] = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    const g = classify(pid);
    if (!g || g === "postgres" || g === "harness") continue;
    try {
      const mb = Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)?.[1] ?? 0) / 1024;
      rows.push({ pid: Number(pid), group: g, mb: Math.round(mb), cmd: readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").slice(0, 160) });
    } catch {}
  }
  return rows;
}
const runtimeOf = (s: Sample) => (s.rss.server ?? 0) + (s.rss.workerd ?? 0) + (s.rss.celld ?? 0) + (s.rss["v8-exec"] ?? 0);
const timer = setInterval(() => samples.push(sample()), 1000);
const mark = async (name: string) => { phase = name; samples.push(sample()); console.log(`[${new Date().toISOString()}] ${name} runtime=${runtimeOf(samples.at(-1)!).toFixed(1)}MB`); };
const steady = async (name: string, seconds = 5) => {
  phase = name; await sleep(seconds * 1000);
  const xs = samples.filter(s => s.phase === name).map(runtimeOf).sort((a, b) => a - b);
  return xs[Math.floor(xs.length / 2)] ?? runtimeOf(sample());
};

// ---- fake model: identical replies on every backend ------------------------------------------------------------------
const text = (m: any) => typeof m?.content === "string" ? m.content : (m?.content ?? []).map((p: any) => p.text ?? "").join("");
const codeResults: { ok: number; failed: number; sample?: string } = { ok: 0, failed: 0 };
const respond = (body: any) => {
  const messages = body.messages ?? [];
  const lastUser = messages.findLastIndex((m: any) => m.role === "user");
  const prompt = text(messages[lastUser]);
  const usage = { prompt_tokens: 10, completion_tokens: 5, cost: 0 };
  const tool = messages.slice(lastUser + 1).find((m: any) => m.role === "tool");
  if (tool) {
    // The script sums 0..999: count the tool results that carry its answer, so a failing sandbox cannot pass as a turn.
    if (text(tool).includes("499500")) codeResults.ok++; else { codeResults.failed++; codeResults.sample ??= text(tool).slice(0, 300); }
    return { role: "assistant", content: "Code ran.", usage };
  }
  if (prompt.startsWith("code:")) return { ...toolCall("codemode", { code: "let s = 0; for (let i = 0; i < 1000; i++) s += i; return s;" }), usage };
  return { role: "assistant", content: `Echo: ${prompt} ` + "lorem ipsum ".repeat(40), usage };
};

// ---- backends -------------------------------------------------------------------------------------------------------
type Api = { call(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: any; text: string }>; close(): Promise<void>; logs?: () => string[] };
let api: Api | undefined;
const tenants = { tenants: { alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), apiKeys: { openrouter: "fixture-model-key" }, maxAgents: 100_000 } } };
const cleanups: Array<() => Promise<void> | void> = [];
const t = { after: (fn: () => Promise<void> | void) => { cleanups.push(fn); } };
const nodeEnv = {
  AGENT_HOSTING: "inline", AGENT_MAX_AGENTS: "100000", AGENT_MAX_AGENTS_PER_TENANT: "100000",
  // Production is 300000; long enough here that every agent stays hosted through the resident sample.
  AGENT_IDLE_MS: String(Number(args["node-idle-ms"] ?? 90_000)),
};
async function start(): Promise<Api> {
  if (backend === "node") {
    const { createNodeFixture } = await import("../../tests/contract/fixtures/node.ts");
    const r = await createNodeFixture(t as any, { respond, env: nodeEnv, tenants });
    return { call: (p, i) => r.call(p, i), close: async () => {}, logs: () => r.logs };
  }
  if (backend === "workers") {
    const { createWorkerdFixture } = await import("./workers.ts");
    return createWorkerdFixture(t, { respond, tenants, operator: OPERATOR });
  }
  if (backend === "celld") {
    const { createCelldFixture } = await import("./workers.ts");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CELLD_"))) as Record<string, string>;
    return createCelldFixture(t, { respond, tenants, operator: OPERATOR, env });
  }
  throw new Error(`Unknown backend ${backend}`);
}

async function pool<T>(items: T[], width: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0; const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) { try { await fn(items[i], i); } catch (e) { errors.push(e); } }
  }));
  return errors;
}

async function turn(api: Api, agent: string, prompt: string) {
  const sent = await api.call(`/v1/agents/${agent}/prompt`, { body: { text: prompt } });
  if (sent.status !== 202) throw new Error(`prompt ${sent.status} ${sent.text.slice(0, 200)}`);
  const deadline = Date.now() + 300_000;
  for (;;) {
    const r = await api.call(`/v1/agents/${agent}/requests/${sent.json.id}`);
    if (r.json?.state === "completed") {
      if (r.json.status !== "completed") throw new Error(`turn ${r.json.status}: ${JSON.stringify(r.json.outcome ?? r.json).slice(0, 300)}`);
      return;
    }
    if (Date.now() > deadline) throw new Error("turn timed out");
    await sleep(200);
  }
}

const result: any = { backend, agents: N, turns: TURNS, concurrency: C, code: CODE, startedAt: new Date().toISOString() };
try {
  await mark("pre-start");
  result.preStartMB = runtimeOf(samples.at(-1)!);
  const startedAt = Date.now();
  api = await start();
  result.startupMs = Date.now() - startedAt;
  // A warm-up agent and turn, so lazily loaded modules count as baseline, not as the first agent's cost.
  const warm = (await api.call("/v1/agents", { body: { name: "warmup" } })).json.id;
  await turn(api, warm, "hello"); await turn(api, warm, "code: warm");
  result.baselineMB = await steady("baseline", 10);
  result.baselineDetail = samples.at(-1)!.rss;

  const ids: string[] = [];
  const createErrors = await pool(Array.from({ length: N }, (_, i) => i), 20, async i => {
    let r = await api.call("/v1/agents", { body: { name: `bench-${i}` } });
    // A create under load can answer 503 CONFIGURATION_PENDING (saved, not yet applied): the documented answer is a retry.
    for (let a = 0; a < 5 && r.status === 503; a++) { await sleep(500); r = await api.call("/v1/agents", { body: { name: `bench-${i}` } }); }
    if (r.status !== 201 && r.status !== 200) throw new Error(`create ${r.status} ${r.text.slice(0, 200)}`);
    ids.push(r.json.id);
  });
  if (createErrors.length) console.error("create errors", createErrors.length, String(createErrors[0]));
  result.created = ids.length;
  result.createdMB = await steady("created", 5);

  // K turns per agent, C agents at once. Turn 2 of 3 runs code (a codemode tool call, then a closing answer).
  phase = "turns";
  const t0 = Date.now(); const cpu0 = sample().cpu;
  const prompts = Array.from({ length: TURNS }, (_, k) => k === 1 && CODE ? `code: turn ${k}` : `turn ${k} of the benchmark`);
  const turnErrors: unknown[] = [];
  for (let k = 0; k < TURNS; k++) {
    phase = `turns-${k}`;
    turnErrors.push(...await pool(ids, C, async id => turn(api, id, prompts[k])));
    console.log(`turn ${k} done (${turnErrors.length} errors so far)`);
  }
  const cpu1 = sample().cpu;
  result.codeResults = codeResults;
  result.turnErrors = turnErrors.length; if (turnErrors.length) result.firstTurnError = String(turnErrors[0]).slice(0, 500);
  result.turnsWallMs = Date.now() - t0;
  const okTurns = ids.length * TURNS - turnErrors.length;
  const cpuGroups = ["server", "workerd", "celld", "v8-exec", "postgres"] as const;
  result.cpuSecondsPerTurn = Object.fromEntries(cpuGroups.map(g => [g, ((cpu1[g] ?? 0) - (cpu0[g] ?? 0)) / Math.max(1, okTurns)]));
  const turnSamples = samples.filter(s => s.phase.startsWith("turns"));
  result.peakMB = Math.max(...turnSamples.map(runtimeOf));
  result.peakPostgresMB = Math.max(...turnSamples.map(s => s.rss.postgres ?? 0));

  // Resident: every agent touched in the last seconds. Read each agent's state (GET /v1/agents/:id/state, answered by
  // the agent itself: it loads an unloaded Node agent and wakes an evicted Durable Object), then sample. workerd frees
  // an object after a short inactivity ("Actor freed due to inactivity"), so residentPeakMB, the highest sample while
  // the reads run and just after, is the figure with every agent in memory at once.
  phase = "resident";
  await pool(ids, 50, async id => { await api.call(`/v1/agents/${id}/state`); });
  result.residentMB = await steady("resident", 5);
  result.residentPeakMB = Math.max(...samples.filter(s => s.phase === "resident").map(runtimeOf));
  result.peakMBPerAgent = (result.residentPeakMB - result.baselineMB) / Math.max(1, ids.length);
  result.residentDetail = samples.at(-1)!.rss;
  result.residentProcesses = processes();
  result.marginalMBPerAgent = (result.residentMB - result.baselineMB) / Math.max(1, ids.length);

  // Idle: no requests; Node unloads after AGENT_IDLE_MS, workerd/celld evict idle objects on their own schedule.
  phase = "idle";
  for (let s = 0; s < IDLE_WAIT_S; s += 10) { await sleep(10_000); }
  result.idleMB = await steady("idle-end", 10);
  result.idleDetail = samples.at(-1)!.rss;
  result.postgresIdleMB = samples.at(-1)!.rss.postgres ?? 0;
  // Waking every agent once more after idle shows whether the residue was a cache or a leak.
  await api.close();
} catch (error) {
  result.error = String((error as Error)?.stack ?? error);
  console.error(error);
  try { console.error((api?.logs?.() ?? []).filter(l => !/lease attempt|ship loop|fleet_sample|Environment Variable/.test(l)).slice(-150).join("\n")); } catch {}
} finally {
  clearInterval(timer);
  for (const fn of cleanups.reverse()) { try { await fn(); } catch (e) { console.error("cleanup", e); } }
  result.samples = samples.map(s => ({ t: s.t, phase: s.phase, rss: s.rss, cpu: s.cpu }));
  writeFileSync(out, JSON.stringify(result, null, 1));
  const { samples: _s, ...summary } = result;
  console.log(JSON.stringify(summary, null, 1));
  process.exit(0);
}
