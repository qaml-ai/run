// How long a Node parent takes to spawn a v8-exec process (to its answer for `return 1`), as the
// parent grows: fresh, holding a big JS heap, and after 32 QuickJS workers came and went.
//   node --experimental-strip-types scripts/bench-spawn-cost.ts
import { readFileSync } from "node:fs";
import { CodePool, executeCode } from "../src/codemode.ts";
import { V8Exec } from "../src/v8-exec.ts";

const bridge = { definitions: [], call: async () => null };
const pool = new V8Exec({ max: 64 });
const vm = () => process.platform === "linux" ? /VmSize:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))![1] + " kB virtual, " + readFileSync("/proc/self/maps", "utf8").split("\n").length + " mappings" : "";
async function measure(label: string) {
  const times: number[] = [];
  for (let i = 0; i < 100; i++) {
    const started = performance.now();
    await executeCode({ code: "return 1", bridge, pool });
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, p50Ms: +times[50].toFixed(2), p90Ms: +times[90].toFixed(2), rssMb: Math.round(process.memoryUsage().rss / 2 ** 20), vm: vm() }));
}
await measure("fresh parent");
const keep: number[][] = [];
for (let i = 0; i < 400; i++) keep.push(new Array(250_000).fill(i));
await measure("parent holding ~800 MB of JS heap");
keep.length = 0;
const quickjs = new CodePool({ min: 32, max: 32 });
await Promise.all(Array.from({ length: 32 }, () => executeCode({ code: "return 1", bridge, pool: quickjs })));
await measure("parent with 32 QuickJS workers running");
await quickjs.close();
await measure("after the 32 workers exited");
pool.close();
process.exit(0);
