// js_exec engines side by side, through executeCode on this machine: today's QuickJS worker pool
// (in-process CodePool) against v8-exec, a process per execution (jitless as deployed, with V8's
// JIT, and pre-spawned). Run QuickJS and V8 in separate invocations: a parent holding 32 QuickJS
// workers (their WASM reservations) spawns processes several times slower.
//   npm run bench:v8-exec -- --engines quickjs; npm run bench:v8-exec -- --engines v8,v8-jit,v8-prespawn
// Build the binary first: npm run build:v8-exec.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CodePool, executeCode } from "../src/codemode.ts";
import { V8Exec } from "../src/v8-exec.ts";
import type { ToolBridge } from "../src/protocol.ts";

const { values: args } = parseArgs({ options: {
  runs: { type: "string", default: "200" },
  engines: { type: "string", default: "quickjs,v8,v8-jit,v8-prespawn" },
  cases: { type: "string", default: "" },
  concurrency: { type: "string", default: "1,8,32" },
  seconds: { type: "string", default: "5" },
  json: { type: "boolean", default: false },
  phases: { type: "string", default: "latency,memory,throughput" },
} });
const runs = Number(args.runs);

const files = new Map<string, string>();
const bridge: ToolBridge = {
  definitions: [
    { name: "echo", description: "Echoes its arguments", parameters: { type: "object" } },
    { name: "wait", description: "Answers after a while", parameters: { type: "object" } },
  ],
  call: async (name, args) => name === "wait" ? new Promise(resolve => setTimeout(resolve, Number(args.ms ?? 0), "done")) : args,
  fs: async (op, args) => {
    const path = String(args.path);
    if (op === "writeFile") { files.set(path, String(args.text ?? args.data)); return { path, bytes: files.get(path)!.length }; }
    if (op === "readFile") return { path, text: files.get(path) ?? "" };
    throw new Error(`fs.${op} is not in this bench`);
  },
};

const cases: Record<string, string> = {
  "return 1": "return 1",
  typescript: [
    "interface Row { id: number; name: string }",
    "const rows: Row[] = Array.from({ length: 50 }, (_, i): Row => ({ id: i, name: `row${i}` }));",
    "function pick<T>(items: T[], n: number): T[] { return items.slice(0, n); }",
    "return pick<Row>(rows, 3).map((row: Row) => row.name).join(\",\");",
  ].join("\n"),
  "cpu loop": "let s = 0; for (let i = 0; i < 5e6; i++) s = (s + i * i) % 1000003; return s",
  "json transform": "const rows = Array.from({ length: 20000 }, (_, i) => ({ id: i, name: 'n' + i, v: i % 97 })); const back = JSON.parse(JSON.stringify(rows)); return back.filter(r => r.v > 50).sort((a, b) => b.v - a.v).slice(0, 5).map(r => r.id)",
  "50 tool calls": "let n = 0; for (let i = 0; i < 50; i++) n += (await tools.echo({ i })).i; return n",
  "fs write+read": "await fs.writeFile('/workspace/a.txt', 'x'.repeat(50000)); const t = await fs.readFile('/workspace/a.txt'); return t.length",
};
const selectedCases = args.cases ? args.cases.split(",") : Object.keys(cases);

type Engine = { name: string; pool: CodePool | V8Exec; close(): unknown };
function engine(name: string, size = 1): Engine {
  if (name === "quickjs") { const pool = new CodePool({ min: size, max: 32 }); return { name, pool, close: () => pool.close() }; }
  const options = {
    // v8: as deployed (jitless); v8-jit: with V8's compilers; v8-prespawn: jitless, processes started ahead.
    v8: { jitless: true }, "v8-jit": { jitless: false },
    "v8-prespawn": { jitless: true, prespawn: Math.max(2, Math.min(size, 8)) },
  }[name];
  if (!options) throw new Error(`Unknown engine ${name}`);
  const pool = new V8Exec({ ...options, max: 64 });
  return { name, pool, close: () => pool.close() };
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const percentile = (values: number[], p: number) => { const s = sorted(values); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const round = (n: number, digits = 2) => +n.toFixed(digits);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Resident and (Linux) proportional set size of these pids, in MB. */
function memory(pids: number[]): { rssMb: number; pssMb?: number } {
  if (!pids.length) return { rssMb: 0 };
  if (process.platform === "linux") {
    let rss = 0, pss = 0;
    for (const pid of pids) {
      try {
        rss += Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]);
        pss += Number(/Pss:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"))![1]);
      } catch {}
    }
    return { rssMb: round(rss / 1024, 1), pssMb: round(pss / 1024, 1) };
  }
  const out = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
  return { rssMb: round(out.split("\n").filter(Boolean).reduce((sum, line) => sum + Number(line.trim()), 0) / 1024, 1) };
}

async function exec(pool: CodePool | V8Exec, code: string) {
  const result = await executeCode({ code, bridge, pool, timeoutMs: 60_000, limits: { cpuMs: 30_000 } });
  if (!result.output.length) throw new Error(`no output for ${code}`);
  return result;
}

const report: Record<string, any> = { node: process.version, platform: process.platform, arch: process.arch, runs, latency: {}, memory: {}, throughput: {} };

// Latency and CPU per execution, one at a time.
for (const name of args.phases.includes("latency") ? args.engines.split(",") : []) {
  const e = engine(name);
  report.latency[name] = {};
  for (const label of selectedCases) {
    const code = cases[label];
    let started = performance.now();
    await exec(e.pool, code);
    const firstMs = performance.now() - started;
    for (let i = 0; i < 20; i++) await exec(e.pool, code);
    const latencies: number[] = [];
    const cpu = process.cpuUsage();
    const childCpu = e.pool instanceof V8Exec ? e.pool.processCpuMs : 0;
    for (let i = 0; i < runs; i++) {
      started = performance.now();
      await exec(e.pool, code);
      latencies.push(performance.now() - started);
    }
    const used = process.cpuUsage(cpu);
    const parentCpu = (used.user + used.system) / 1000 / runs;
    const childCpuPer = e.pool instanceof V8Exec ? (e.pool.processCpuMs - childCpu) / runs : 0;
    report.latency[name][label] = {
      firstMs: round(firstMs), p50Ms: round(percentile(latencies, 0.5)), p99Ms: round(percentile(latencies, 0.99)),
      cpuMsPerExecution: round(parentCpu + childCpuPer), ...(e.pool instanceof V8Exec ? { childCpuMs: round(childCpuPer) } : {}),
    };
    if (!args.json) console.error(name, label, JSON.stringify(report.latency[name][label]));
  }
  await e.close();
}

// Memory: 32 executions at once, each waiting on a tool (the chiridion case: camel__ tools that take minutes).
for (const name of args.phases.includes("memory") ? args.engines.split(",") : []) {
  // No warm QuickJS workers before: the parent's growth is then what 32 waiting executions hold.
  const e = name === "quickjs" ? { name, pool: new CodePool({ min: 0, max: 32 }), close() { return (this.pool as CodePool).close(); } } : engine(name, 32);
  await sleep(500);
  const before = memory([process.pid]);
  let entered = 0;
  const all = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const waiting: ToolBridge = { ...bridge, call: async () => { if (++entered === 32) all.resolve(); await release.promise; return "done"; } };
  const code = "const rows = Array.from({ length: 2000 }, (_, i) => ({ i, s: 'x' + i })); const r = await tools.echo({}); return rows.length + String(r).length";
  const running = Array.from({ length: 32 }, () => executeCode({ code, bridge: waiting, pool: e.pool, timeoutMs: 60_000 }));
  await all.promise;
  await sleep(300);
  const self = memory([process.pid]);
  const children = e.pool instanceof V8Exec ? memory([...e.pool.pids]) : { rssMb: 0 };
  release.resolve();
  await Promise.all(running);
  report.memory[name] = {
    parentRssBeforeMb: before.rssMb, parentRssWaitingMb: self.rssMb,
    ...(e.pool instanceof V8Exec ? { childrenRssMb: children.rssMb, childrenPssMb: children.pssMb, perExecutionRssMb: round(children.rssMb / 32, 1), perExecutionPssMb: children.pssMb && round(children.pssMb / 32, 1) }
      : { perExecutionRssMb: round((self.rssMb - before.rssMb) / 32, 1) }),
    totalWaitingMb: round(self.rssMb + children.rssMb, 1),
  };
  if (!args.json) console.error(name, "memory", JSON.stringify(report.memory[name]));
  await e.close();
}

// Throughput: `return 1` and the JSON transform, back to back from C callers at once, for a few seconds.
for (const name of args.phases.includes("throughput") ? args.engines.split(",") : []) {
  report.throughput[name] = {};
  for (const concurrency of args.concurrency.split(",").map(Number)) {
    const e = engine(name, concurrency);
    await Promise.all(Array.from({ length: concurrency }, () => exec(e.pool, "return 1")));
    for (const label of ["return 1", "json transform"]) {
      let done = 0;
      const until = performance.now() + Number(args.seconds) * 1000;
      const cpu = process.cpuUsage();
      const childCpu = e.pool instanceof V8Exec ? e.pool.processCpuMs : 0;
      const started = performance.now();
      await Promise.all(Array.from({ length: concurrency }, async () => { while (performance.now() < until) { await exec(e.pool, cases[label]); done++; } }));
      const seconds = (performance.now() - started) / 1000;
      const used = process.cpuUsage(cpu);
      const totalCpu = (used.user + used.system) / 1000 + (e.pool instanceof V8Exec ? e.pool.processCpuMs - childCpu : 0);
      report.throughput[name][`${label} @${concurrency}`] = { perSecond: round(done / seconds, 0), cpuMsPerExecution: round(totalCpu / done) };
      if (!args.json) console.error(name, label, concurrency, JSON.stringify(report.throughput[name][`${label} @${concurrency}`]));
    }
    await e.close();
  }
}

const binary = new V8Exec().binary;
report.binary = existsSync(binary) ? { path: binary, mb: round(readFileSync(binary).length / 1024 / 1024, 1) } : undefined;
console.log(JSON.stringify(report, null, 2));
process.exit(0);
