// What one js_exec costs, and where it goes. Two views:
//  - phases: runSandbox called on this thread, each phase timed (median of warm runs,
//    and the first run of the thread, before V8 has optimized anything);
//  - end to end: executeCode through a one-worker in-process CodePool, latency and the
//    CPU the whole process (main thread and worker) spends per execution. With
//    AGENT_SANDBOX_SOCKETS set (run inside the image, as root, next to agent-launcher's
//    sandbox processes) it goes through those instead, and their CPU is counted too.
// Each for `return 1` and for a TypeScript snippet, which the main thread strips first.
// Usage: npm run bench:js-exec [-- --runs 300]
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { CodePool, executeCode, sandboxProcesses } from "../src/codemode.ts";
import { runSandbox } from "../src/quickjs-sandbox.ts";
import { prepareCodeModeUserCode, stripTypeScriptFromUserCode } from "../shared/code-mode-source.ts";
import type { ToolBridge } from "../src/protocol.ts";

const { values: args } = parseArgs({ options: { runs: { type: "string", default: "300" } } });
const runs = Number(args.runs);

const snippets = {
  "return 1": "return 1",
  typescript: [
    "interface Row { id: number; name: string }",
    "const rows: Row[] = Array.from({ length: 50 }, (_, i): Row => ({ id: i, name: `row${i}` }));",
    "function pick<T>(items: T[], n: number): T[] { return items.slice(0, n); }",
    "return pick<Row>(rows, 3).map((row: Row) => row.name).join(\",\");",
  ].join("\n"),
};
const bridge: ToolBridge = { definitions: [{ name: "echo", description: "Echoes its arguments", parameters: { type: "object" } }], call: async (_name, args) => args };
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const percentile = (values: number[], p: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))];
const round = (ms: number) => +ms.toFixed(3);

// Phases, on this thread, as code-worker.ts runs them.
const quickjs = createRequire(import.meta.url).resolve("quickjs-emscripten");
const wasm = createRequire(quickjs).resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
let started = performance.now();
const wasmModule = await WebAssembly.compile(await readFile(wasm));
const moduleCompileMs = performance.now() - started;

async function phases(code: string) {
  started = performance.now();
  const typescript = code.includes("<");
  const prepared = prepareCodeModeUserCode(typescript ? await stripTypeScriptFromUserCode(code) : code);
  const strip = performance.now() - started;
  const timings: Record<string, number> = { strip };
  let last = performance.now();
  const result = await runSandbox({
    wasmModule, cancel: new Int32Array(new SharedArrayBuffer(4)), signal: new AbortController().signal,
    code: prepared, javascriptOnly: !typescript, tools: bridge.definitions, timeoutMs: 30_000, maxOutputCharacters: 32_000,
    call: async (name, args) => JSON.stringify(await bridge.call(name, args as Record<string, unknown>, new AbortController().signal)),
    onOutput: () => {},
    mark: phase => { const now = performance.now(); timings[phase] = (timings[phase] ?? 0) + now - last; last = now; },
  });
  if (!result.output || result.output.length !== 1) throw new Error(`Unexpected result: ${JSON.stringify(result)}`);
  timings.total = Object.values(timings).reduce((sum, ms) => sum + ms, 0);
  return timings;
}

const phaseReport: Record<string, unknown> = {};
for (const [name, code] of Object.entries(snippets)) {
  const first = await phases(code);
  const warm: Record<string, number>[] = [];
  for (let i = 0; i < runs; i++) warm.push(await phases(code));
  phaseReport[name] = {
    first: Object.fromEntries(Object.entries(first).map(([phase, ms]) => [phase, round(ms)])),
    warmMedian: Object.fromEntries(Object.keys(first).map(phase => [phase, round(median(warm.map(timing => timing[phase] ?? 0)))])),
  };
}

/** Linux: CPU the sandbox processes have used, in ms. */
function sandboxCpuMs() {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).reduce((sum, pid) => {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("sandbox-server.ts")) return sum;
      const fields = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
      return sum + (Number(fields[11]) + Number(fields[12])) * 10;
    } catch { return sum; }
  }, 0);
}

// End to end, through a worker.
const isolated = sandboxProcesses();
const endToEnd: Record<string, unknown> = {};
for (const [name, code] of Object.entries(snippets)) {
  started = performance.now();
  const pool = isolated ?? new CodePool({ min: 1, max: 1 });
  await executeCode({ code, bridge, pool });
  const coldMs = performance.now() - started;
  // The second: the worker is up, but V8 has optimized little of it yet.
  started = performance.now();
  await executeCode({ code, bridge, pool });
  const secondMs = performance.now() - started;
  for (let i = 0; i < 50; i++) await executeCode({ code, bridge, pool });
  const latencies: number[] = [];
  const cpu = process.cpuUsage();
  const sandboxCpu = isolated ? sandboxCpuMs() : 0;
  for (let i = 0; i < runs; i++) {
    started = performance.now();
    await executeCode({ code, bridge, pool });
    latencies.push(performance.now() - started);
  }
  const used = process.cpuUsage(cpu);
  const sandboxUsed = isolated ? sandboxCpuMs() - sandboxCpu : 0;
  if (pool instanceof CodePool) await pool.close();
  endToEnd[name] = {
    coldMs: round(coldMs), secondMs: round(secondMs),
    p50Ms: round(median(latencies)), p90Ms: round(percentile(latencies, 0.9)),
    cpuMsPerExecution: round((used.user + used.system) / 1000 / runs + sandboxUsed / runs),
    ...(isolated ? { sandboxCpuMsPerExecution: round(sandboxUsed / runs) } : {}),
  };
}

console.log(JSON.stringify({ node: process.version, arch: process.arch, mode: isolated ? "isolated" : "in-process", runs, moduleCompileMs: round(moduleCompileMs), phases: phaseReport, endToEnd }, null, 2));
process.exit(0);
