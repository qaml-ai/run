// Agent hosting compared, under a camel-bots-like load: many awake agents, most idle, some busy with tool calls and
// streamed model replies from a fake model (its own process, so its work is not this one's). One hosting mode per run:
//
//   node --experimental-strip-types --disable-warning=ExperimentalWarning --expose-gc scripts/bench-hosting.ts \
//     --hosting thread [--agents 200] [--busy 20] [--turns 5] [--fault spin|grow] [--quickjs]
//
// Prints one JSON line: memory per awake agent (resident, this process and its agent processes; each agent's heap where
// it has its own), start times, turn latency and throughput, the server's event-loop delay, and with --fault, what one
// agent stuck in a loop (spin) or allocating without bound (grow) does to the rest. Inline, the fault runs on the server's
// thread, as an inline host's would: spin for --spin-ms (a real loop never ends), grow until the process dies.
// --quickjs (thread hosting) runs pi-codemode's QuickJS sandbox inside an agent's thread: cost and runaway scripts.
// Memory is Linux's VmRSS (/proc); elsewhere, this process's alone.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { AgentSupervisor, type Hosting } from "../src/supervisor.ts";
import type { ToolBridge } from "../src/protocol.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : fallback; };
const hosting = flag("hosting", "thread") as Hosting;
const agents = Number(flag("agents", "200")), busy = Number(flag("busy", "20")), turns = Number(flag("turns", "5"));
const fault = flag("fault"), spinMs = Number(flag("spin-ms", "10000"));
const heapMb = Number(flag("heap-mb", "512")), youngMb = flag("young-mb");
const gc = () => (globalThis as { gc?: () => void }).gc?.();

// The fake model: a tool call for a user's message, then a reply streamed in 30 chunks 5 ms apart after the tool's result.
const MODEL = `
const { createServer } = require("node:http");
const chunk = (delta, finish = null) => "data: " + JSON.stringify({ id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] }) + "\\n\\n";
createServer(async (req, res) => {
  let body = ""; for await (const part of req) body += part;
  const last = JSON.parse(body).messages.at(-1);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  if (last.role !== "tool") {
    res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_" + Math.random().toString(36).slice(2), type: "function", function: { name: "lookup", arguments: '{"q":"weather"}' } }] }));
    return res.end(chunk({}, "tool_calls") + "data: [DONE]\\n\\n");
  }
  res.write(chunk({ role: "assistant", content: "" }));
  for (let i = 0; i < 30; i++) { res.write(chunk({ content: "word" + i + " " })); await new Promise(r => setTimeout(r, 5)); }
  res.end(chunk({}, "stop") + "data: [DONE]\\n\\n");
}).listen(0, "127.0.0.1", function () { process.stdout.write(String(this.address().port) + "\\n"); });`;

const modelProcess = spawn(process.execPath, ["-e", MODEL], { stdio: ["ignore", "pipe", "inherit"] });
const port = await new Promise<number>(resolve => modelProcess.stdout!.once("data", data => resolve(Number(String(data).trim()))));
const model = {
  id: "fixture", name: "Fixture", api: "openai-completions", provider: "openai", baseUrl: `http://127.0.0.1:${port}/v1`,
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 1024,
} as Model<Api>;

/** Resident MB of this process and its descendants but the model's (agent processes, v8-exec). */
function residentMb() {
  if (process.platform !== "linux") return process.memoryUsage().rss / 2 ** 20;
  const parent = new Map<number, number>(), rss = new Map<number, number>();
  for (const name of readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      const status = readFileSync(`/proc/${name}/status`, "utf8");
      parent.set(Number(name), Number(/PPid:\s+(\d+)/.exec(status)?.[1]));
      rss.set(Number(name), Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024);
    } catch { /* gone */ }
  }
  const ours = (pid: number): boolean => pid === process.pid || (pid > 1 && pid !== modelProcess.pid && parent.has(pid) && ours(parent.get(pid)!));
  return [...rss].filter(([pid]) => ours(pid)).reduce((sum, [, bytes]) => sum + bytes, 0) / 2 ** 20;
}

const root = await mkdtemp(join(tmpdir(), "bench-hosting-"));
const supervisor = new AgentSupervisor(join(root, "sessions"), {
  hosting, maxAgents: agents + 10, entry: "../scripts/bench-hosting-agent.ts", threadLimits: { maxOldGenerationSizeMb: heapMb, ...(youngMb ? { maxYoungGenerationSizeMb: Number(youngMb) } : {}) },
});
const bridge = (): ToolBridge => ({
  definitions: [{ name: "lookup", description: "Looks something up", parameters: { type: "object", properties: { q: { type: "string" } } } }],
  call: async () => { await sleep(10); return { content: [{ type: "text", text: "Sunny, 18 degrees, light wind from the west." }] }; },
});
const ids = Array.from({ length: agents }, (_, i) => `agent-${i}`);
const percentile = (values: number[], p: number) => { const sorted = [...values].sort((a, b) => a - b); return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 10) / 10; };
const round = (value: number) => Math.round(value * 10) / 10;

/** A benchmark operation in an agent's host (scripts/bench-hosting-agent.ts); inline, there is none. */
function bench(id: string, request: Record<string, unknown>): Promise<any> {
  const handle = supervisor.agents.get(id);
  if (!handle || handle.kind === "inline") return Promise.reject(new Error("No agent host of its own"));
  const emitter = handle.kind === "thread" ? handle.worker : handle.child;
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const heard = (message: unknown) => {
      const reply = (typeof message === "string" ? JSON.parse(message) : message) as any;
      if (reply?.type !== "bench-result" || reply.id !== requestId) return;
      emitter.off("message", heard);
      emitter.off("exit", exited);
      if (reply.error) reject(new Error(reply.error)); else resolve(reply.result);
    };
    const exited = (code: unknown) => { emitter.off("message", heard); reject(new Error(`host exited (${code})`)); };
    emitter.on("message", heard);
    emitter.once("exit", exited);
    const message = { type: "bench", id: requestId, ...request };
    if (handle.kind === "thread") handle.worker.postMessage(JSON.stringify(message)); else handle.child.send(message);
  });
}

const prompt = async (id: string) => {
  const started = performance.now();
  const result = await supervisor.request(id, "prompt", { text: "What is the weather?" });
  if (result.error) throw new Error(`Turn failed: ${result.error}`);
  return performance.now() - started;
};

const result: Record<string, unknown> = { hosting, ...(youngMb ? { youngMb: Number(youngMb) } : {}), agents, busy, turns, node: process.version, cpus: (await import("node:os")).cpus().length };
gc();
await sleep(500);
const baseMb = residentMb();
result.baseMb = round(baseMb);

// Starts: the first 10 one at a time, the rest 16 at once.
const starts: number[] = [];
const startOne = async (id: string) => { const started = performance.now(); await supervisor.start(id, { model, apiKey: "fixture", codeMode: false }, bridge()); starts.push(performance.now() - started); };
for (const id of ids.slice(0, 10)) await startOne(id);
const sequential = [...starts];
const queue = ids.slice(10);
const startedAll = performance.now();
await Promise.all(Array.from({ length: 16 }, async () => { for (let id; (id = queue.shift());) await startOne(id); }));
result.startMs = { sequentialP50: percentile(sequential, 0.5), sequentialP95: percentile(sequential, 0.95), concurrentP50: percentile(starts.slice(10), 0.5), concurrentP95: percentile(starts.slice(10), 0.95), allSeconds: round((performance.now() - startedAll) / 1000) };

// Every agent takes one turn (an awake agent has a history), then rests.
const warm = [...ids];
await Promise.all(Array.from({ length: 16 }, async () => { for (let id; (id = warm.shift());) await prompt(id); }));
gc();
await sleep(2_000);
gc();
const idleMb = residentMb();
result.idle = { totalMb: round(idleMb), perAgentMb: round((idleMb - baseMb) / agents), serverHeapMb: round(process.memoryUsage().heapUsed / 2 ** 20) };
if (hosting !== "inline") {
  const heaps = await Promise.all(ids.slice(0, 20).map(id => bench(id, { op: "memory" })));
  (result.idle as any).agentHeapMb = round(heaps.reduce((sum, heap) => sum + heap.heapUsed, 0) / heaps.length / 2 ** 20);
  (result.idle as any).agentHeapTotalMb = round(heaps.reduce((sum, heap) => sum + heap.heapTotal, 0) / heaps.length / 2 ** 20);
}

/** `busy` agents take turns back to back for `seconds`, or `turns` each: latencies, turns per second, the loop's delay. */
async function load(options: { turns?: number; seconds?: number; during?: () => Promise<unknown> }) {
  const latencies: number[] = [], failures: string[] = [];
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  const started = performance.now();
  const until = options.seconds ? started + options.seconds * 1000 : Infinity;
  const peak = { mb: 0 };
  const sampler = setInterval(() => { peak.mb = Math.max(peak.mb, residentMb()); }, 500);
  const workers = ids.slice(0, busy).map(async id => {
    for (let i = 0; options.turns ? i < options.turns : performance.now() < until; i++) {
      try { latencies.push(await prompt(id)); } catch (error) { failures.push(String((error as Error).message).slice(0, 80)); await sleep(100); }
    }
  });
  const side = options.during?.();
  await Promise.all(workers);
  const seconds = (performance.now() - started) / 1000;
  clearInterval(sampler);
  delay.disable();
  return {
    turns: latencies.length, failed: failures.length, ...(failures.length ? { failures: [...new Set(failures)].slice(0, 3) } : {}),
    turnsPerSecond: round(latencies.length / seconds), latencyP50Ms: percentile(latencies, 0.5), latencyP95Ms: percentile(latencies, 0.95), latencyMaxMs: round(Math.max(...latencies)),
    loopDelayP50Ms: round(delay.percentile(50) / 1e6), loopDelayP99Ms: round(delay.percentile(99) / 1e6), loopDelayMaxMs: round(delay.max / 1e6),
    peakMb: round(peak.mb), side: (await side) as any,
  };
}

result.load = await load({ turns });

if (fault) {
  // The busy agents keep taking turns for --fault-seconds (45: the watchdog's 30 s and some); 2 s in, an idle agent misbehaves.
  const victim = ids[agents - 1];
  result.fault = await load({ seconds: Number(flag("fault-seconds", "45")), during: async () => {
    await sleep(2_000);
    const started = performance.now();
    if (hosting === "inline") {
      if (fault === "spin") { const end = performance.now() + spinMs; while (performance.now() < end); return { ms: round(performance.now() - started), outcome: `server thread blocked ${spinMs} ms (a real loop never ends; no watchdog can stop it)` }; }
      const kept: unknown[] = [];
      for (;;) kept.push(Array.from({ length: 100_000 }, (_, i) => ({ i })));
    }
    if (hosting === "process" && fault === "grow") {
      // An agent process has V8's default heap limit, which is most of the machine's memory: give it a minute.
      const outcome = await Promise.race([bench(victim, { op: fault }).then(() => "returned", error => String(error.message).slice(0, 100)), sleep(60_000).then(() => "still growing after 60 s")]);
      return { ms: round(performance.now() - started), outcome, victimHosted: supervisor.agents.has(victim) };
    }
    const outcome = await bench(victim, { op: fault }).then(() => "returned", error => String(error.message).slice(0, 100));
    return { ms: round(performance.now() - started), outcome, victimHosted: supervisor.agents.has(victim) };
  } });
  if (!supervisor.agents.has(victim)) {
    const started = performance.now();
    await startOne(victim);
    await prompt(victim);
    (result.fault as any).victimBackMs = round(performance.now() - started);
  }
}

if (args.includes("--quickjs") && hosting === "thread") {
  const id = ids[agents - 2];
  const quick: Record<string, unknown> = {};
  for (const inline of [false, true]) {
    const name = inline ? "inlineSandbox" : "workerSandbox";
    const times: number[] = [];
    for (let i = 0; i < 30; i++) times.push((await bench(id, { op: "quickjs", inline, code: "const r = await tools.echo({ n: 1 }); return r.n + 1;" })).ms);
    gc();
    const before = residentMb();
    // 20 executions at once, each waiting on nothing but computing a little.
    await Promise.all(Array.from({ length: 20 }, () => bench(id, { op: "quickjs", inline, code: "let s = 0; for (let i = 0; i < 1e5; i++) s += i; return s;" })));
    const runaway = await load({ seconds: 6, during: async () => {
      // A script that never ends, with a 3 s deadline; meanwhile the agent's own host should answer.
      const running = bench(id, { op: "quickjs", inline, code: "while (true) {}", timeoutMs: 3_000 });
      await sleep(500);
      const asked = performance.now();
      const status = await Promise.race([supervisor.request(id, "status").then(() => round(performance.now() - asked)), sleep(5_000).then(() => "no answer in 5 s")]);
      const ended = await running;
      return { script: ended.ok ? "finished" : ended.error, scriptMs: round(ended.ms), agentStatusMs: status };
    } });
    const bomb = await bench(id, { op: "quickjs", inline, code: "const a = []; for (;;) a.push(new Array(1e5).fill(1));", timeoutMs: 20_000, memoryLimitBytes: 64 * 2 ** 20 });
    quick[name] = {
      executeP50Ms: percentile(times, 0.5), executeP95Ms: percentile(times, 0.95), firstMs: round(times[0]), twentyAtOnceMb: round(residentMb() - before),
      runaway: { ...runaway.side, otherTurnsP95Ms: runaway.latencyP95Ms, failedTurns: runaway.failed, loopDelayMaxMs: runaway.loopDelayMaxMs },
      memoryBomb64Mb: { outcome: bomb.ok ? "finished" : bomb.error, ms: round(bomb.ms) },
    };
  }
  // No memoryLimitBytes: the VM's wasm memory is not the agent thread's V8 heap, so the thread's limit does not bound it.
  const before = residentMb();
  const peak = { mb: before };
  const sampler = setInterval(() => { peak.mb = Math.max(peak.mb, residentMb()); }, 200);
  const unbounded = await bench(id, { op: "quickjs", code: "const a = []; for (;;) a.push(new Array(1e5).fill(1));", timeoutMs: 8_000 });
  clearInterval(sampler);
  quick.unboundedBomb = { outcome: unbounded.ok ? "finished" : unbounded.error, ms: round(unbounded.ms), peakGrowthMb: round(peak.mb - before), agentStillHosted: supervisor.agents.has(id) };
  result.quickjs = quick;
}

console.log(JSON.stringify(result));
await supervisor.close();
modelProcess.kill();
await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
process.exit(0);
