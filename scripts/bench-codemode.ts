// js_exec cost through the full executeCode path: latency of `return 1`, and
// the resident memory each concurrent execution holds (this process, any child
// processes, and the sandbox processes when agent-launcher runs them).
// Usage: npm run bench:codemode [-- concurrency]
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { executeCode, sandboxProcesses } from "../src/codemode.ts";
import type { ToolBridge } from "../src/protocol.ts";

const concurrency = Number(process.argv[2] ?? 16);
const release = Promise.withResolvers<void>();
let entered = 0;
const bridge: ToolBridge = {
  definitions: [{ name: "hold", description: "Waits until the benchmark releases it", parameters: { type: "object" } }],
  call: async () => { entered++; await release.promise; return 1; },
};
const run = (code: string) => executeCode({ code, bridge });

function descendants(pid: number): number[] {
  let children: number[] = [];
  try { children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number); }
  catch { return []; }
  return children.flatMap(child => [child, ...descendants(child)]);
}
/** Linux only: sandbox processes run under the launcher, not this process. */
function sandboxRssBytes(): number {
  if (!sandboxProcesses()) return 0;
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).reduce((sum, pid) => {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("sandbox-server.ts")) return sum;
      return sum + Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))![1]) * 1024;
    } catch { return sum; }
  }, 0);
}
function rssMb() {
  const pids = descendants(process.pid);
  const children = pids.length ? execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" }).trim().split("\n").reduce((sum, kb) => sum + Number(kb), 0) * 1024 : 0;
  return (process.memoryUsage().rss + children + sandboxRssBytes()) / 2 ** 20;
}
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

for (let i = 0; i < 20; i++) await run("return 1");
const latencies: number[] = [];
for (let i = 0; i < 200; i++) {
  const start = performance.now();
  await run("return 1");
  latencies.push(performance.now() - start);
}
latencies.sort((a, b) => a - b);

global.gc?.();
await sleep(500);
const idle = rssMb();
const held = Array.from({ length: concurrency }, () => run("return await tools.hold({})"));
while (entered < concurrency) await sleep(10);
await sleep(200);
const busy = rssMb();
release.resolve();
await Promise.all(held);

console.log(JSON.stringify({
  mode: sandboxProcesses() ? "isolated" : "in-process",
  p50Ms: +percentile(latencies, 0.5).toFixed(2),
  p90Ms: +percentile(latencies, 0.9).toFixed(2),
  concurrency,
  idleRssMb: +idle.toFixed(1),
  busyRssMb: +busy.toFixed(1),
  rssPerExecutionMb: +((busy - idle) / concurrency).toFixed(2),
  executionsIn2Gb: Math.floor((2048 - idle) / ((busy - idle) / concurrency)),
}));
process.exit(0);
