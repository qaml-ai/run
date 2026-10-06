// js_exec and file parsing cost, as production runs them: js_exec `return 1` latency through executeCode,
// file parsing latency (inspect an image's header, scale a large image down), and the memory the
// container's processes hold idle and with executions waiting on a tool. Run it in the image, under
// agent-launcher, so the confined processes are as in production:
//   docker run --rm --init -v "$PWD/scripts/bench-codemode.ts:/app/scripts/bench-codemode.ts:ro" agent-runtime \
//     node --experimental-strip-types --disable-warning=ExperimentalWarning --expose-gc scripts/bench-codemode.ts [concurrency]
// (or npm run bench:codemode, here, without the launcher).
// On Linux, memory is the VmRSS of every process the container can see; elsewhere, this process's.
import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { executeCode } from "../src/codemode.ts";
import { fitImage, inspect } from "../src/inspect.ts";
import type { ToolBridge } from "../src/protocol.ts";

const concurrency = Number(process.argv[2] ?? 16);
const release = Promise.withResolvers<void>();
let entered = 0;
const bridge: ToolBridge = {
  definitions: [{ name: "hold", description: "Waits until the benchmark releases it", parameters: { type: "object" } }],
  call: async () => { entered++; await release.promise; return 1; },
};
const run = (code: string) => executeCode({ code, bridge });

/** MB resident, in all and by program (the last file its command line names, or its first word). */
function rssMb() {
  if (process.platform !== "linux") return { total: process.memoryUsage().rss / 2 ** 20, by: {} };
  const by: Record<string, number> = {};
  for (const pid of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const kb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
      const words = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      const name = (words.filter(word => /[/.]/.test(word) && !word.startsWith("-")).at(-1) ?? words[0]).split("/").at(-1)!;
      by[name] = +((by[name] ?? 0) + kb / 1024).toFixed(1);
    } catch {}
  }
  return { total: Object.values(by).reduce((a, b) => a + b, 0), by };
}
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return +sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))].toFixed(2); };
async function time(runs: number, fn: () => Promise<unknown>) {
  const took: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    took.push(performance.now() - start);
  }
  return { p50Ms: percentile(took, 0.5), p90Ms: percentile(took, 0.9) };
}

for (let i = 0; i < 20; i++) await run("return 1");
const execute = await time(200, () => run("return 1"));
const small = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3366aa" } }).png().toBuffer();
const large = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#3366aa" } }).png().toBuffer();
const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 10 10]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n");
for (let i = 0; i < 3; i++) await inspect(small);
const header = await time(30, () => inspect(small));
const pages = await time(30, () => inspect(pdf, true));
const fit = await time(20, async () => { const fitted = await fitImage(large); if ("omitted" in fitted) throw new Error(fitted.omitted); });

(globalThis as { gc?: () => void }).gc?.();
await sleep(1000);
const idle = rssMb();
const held = Array.from({ length: concurrency }, () => run("return await tools.hold({})"));
while (entered < concurrency) await sleep(10);
await sleep(300);
const busy = rssMb();
release.resolve();
await Promise.all(held);

console.log(JSON.stringify({
  sandbox: process.env.AGENT_SANDBOX_DIR ? "isolated" : "in-process",
  execute, inspectImage: header, inspectPdf: pages, fitImage: fit,
  concurrency, idleRssMb: +idle.total.toFixed(1), busyRssMb: +busy.total.toFixed(1), rssPerExecutionMb: +((busy.total - idle.total) / concurrency).toFixed(2),
  idleByProgram: idle.by,
}));
process.exit(0);
