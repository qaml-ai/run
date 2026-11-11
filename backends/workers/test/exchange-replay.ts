// The 500-effect replay harness (docs/design/swarm-workflows.md, "Execution: replay from the top", open question 1).
//
// A workflow step starts a fresh deterministic VM that replays the script from the top: every effect the journal
// already has is answered from it, and the first new one stops the VM (the effect is started; its ending is the event
// that runs the next step). This drives that through the real code mode exchange, in process: Pi's
// `RemoteCodemodeSandbox.start()` on the host, `isolatedSandboxRemote` (protocol 2, the caller's caps, `handle`
// results) to `serveExchange` and pi-codemode's QuickJS server with the deployed sandbox's ceilings.
//
// Two ways a step can answer journaled effects:
// - `calls`: every effect is a call through the exchange, answered from the journal (a host-side handle when the
//   body is over `resultBytes`). Step k makes k calls, so it is k exchange round trips (RPCs when deployed).
// - `table`: the host ships the guest the journal as a key -> result table in the script's prelude; a journaled
//   effect is a lookup, and only the new effect is a call. Step k makes one call.
// In both, the guest keys each effect by a hash of its canonical arguments, computed in QuickJS.
//
//   node --import ./test/sdk-deps.mjs --experimental-strip-types test/exchange-replay.ts [effects] [--json path]
import { createHash } from "node:crypto";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { RemoteCodemodeSandbox, serveCodemodeRemote, type CodemodeHostCall, type CodemodeResult } from "@earendil-works/pi-codemode/portable";
import { QuickJS } from "quickjs-wasi";
import { EXCHANGE_CEILINGS, SANDBOX_HEAP_BYTES, type ExchangeParameters } from "../codemode/exchange.ts";
import { serveExchange } from "../codemode/limits.ts";
import { isolatedSandboxRemote } from "../codemode/routing.ts";

/** Guest-side key hashes over a string, as a workflow's prelude would define them. */
export const GUEST_HASHES = {
  // FNV-1a, 32 bits: 8 hex digits.
  fnv1a32: `function keyHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}`,
  // FNV-1a, 64 bits, over each UTF-16 unit's two bytes (low first), in 16-bit limbs (no BigInt): 16 hex digits.
  fnv1a64: `function keyHash(text) {
  let a = 0x2325, b = 0x8422, c = 0x9ce4, d = 0xcbf2;
  const byte = x => {
    a ^= x;
    // h * (2^40 + 0x1b3), mod 2^64: 2^40 is two limbs and 8 bits up.
    let t0 = a * 0x1b3, t1 = b * 0x1b3 + (t0 >>> 16), t2 = c * 0x1b3 + (a << 8) + (t1 >>> 16), t3 = d * 0x1b3 + (b << 8) + (t2 >>> 16);
    a = t0 & 0xffff; b = t1 & 0xffff; c = t2 & 0xffff; d = t3 & 0xffff;
  };
  for (let i = 0; i < text.length; i++) { const u = text.charCodeAt(i); byte(u & 0xff); byte(u >>> 8); }
  return [d, c, b, a].map(x => x.toString(16).padStart(4, "0")).join("");
}`,
  // SHA-256 over UTF-8, in plain JS (QuickJS has no crypto.subtle): 64 hex digits.
  sha256: `const K256 = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
function keyHash(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) { c = 0x10000 + ((c - 0xd800) << 10) + (text.charCodeAt(++i) - 0xdc00); }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) bytes.push(0xe0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else bytes.push(0xf0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  const bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 0xff);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array(64);
  for (let o = 0; o < bytes.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = bytes[o + 4 * i] << 24 | bytes[o + 4 * i + 1] << 16 | bytes[o + 4 * i + 2] << 8 | bytes[o + 4 * i + 3];
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = (a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ a >>> 3, s1 = (b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ b >>> 10;
      w[i] = w[i - 16] + s0 + w[i - 7] + s1 | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const t1 = h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + (e & f ^ ~e & g) + K256[i] + w[i] | 0;
      const t2 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & b ^ a & c ^ b & c) | 0;
      h = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
    }
    h0 = h0 + a | 0; h1 = h1 + b | 0; h2 = h2 + c | 0; h3 = h3 + d | 0; h4 = h4 + e | 0; h5 = h5 + f | 0; h6 = h6 + g | 0; h7 = h7 + h | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map(x => (x >>> 0).toString(16).padStart(8, "0")).join("");
}`,
} as const;
export type GuestHash = keyof typeof GUEST_HASHES;

/** Canonical JSON (sorted keys), as the runner's prelude would define it. */
const CANONICAL = `function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}`;

/** Effect `i`'s arguments (0-based): an agent over one file, as a review loop makes them. Guest and host build the same. */
const ARGS = `(i) => ({ type: "reviewer", model: "fast", prompt: "Review src/delegation-" + i + ".ts for the owner model refactor.", files: ["src/delegation-" + i + ".ts"] })`;

/** The synthetic workflow: `n` keyed effects in sequence. */
function script(n: number, mode: "calls" | "table", hash: GuestHash) {
  return `${GUEST_HASHES[hash]}
${CANONICAL}
const argsOf = ${ARGS};
const journal = ${mode === "table" ? "load(\"journal\") ?? {}" : "{}"};
async function effect(kind, args) {
  const key = kind + ":" + keyHash(canonical(args));
  const row = journal[key];
  if (row) return row.result ?? row;
  return await tools.effect({ key, kind, args });
}
const seen = [];
for (let i = 0; i < ${n}; i++) {
  const result = await effect("agent", argsOf(i));
  seen.push(result.$handle ? result.sha256.slice(0, 8) : result.effect);
}
return seen.length;`;
}

/** The key the guest computes for effect `i`, computed on the host by the same code. */
function hostKeys(hash: GuestHash): (i: number) => string {
  const keyOf = new Function(`${GUEST_HASHES[hash]}\n${CANONICAL}\nconst argsOf = ${ARGS};\nreturn i => "agent:" + keyHash(canonical(argsOf(i)));`)() as (i: number) => string;
  return keyOf;
}

/** A journaled effect's result body: about `bytes` of review text. */
const body = (i: number, bytes: number) => ({ effect: i, review: `Findings for file ${i}: `.padEnd(bytes, "lorem ipsum ") });

interface VmStats { polls: number; heapBytes: number; linearBytes: number }
let current: { polls: number; vm?: QuickJS } = { polls: 0 };
let patched = false;
/** Count QuickJS's interrupt polls and keep the VM, to read its heap; the VM itself runs unchanged. */
function instrument() {
  if (patched) return;
  patched = true;
  const create = QuickJS.create.bind(QuickJS);
  QuickJS.create = (async (options: Parameters<typeof QuickJS.create>[0]) => {
    const handler = (options as { interruptHandler?: () => boolean }).interruptHandler, stats = current;
    const vm = await create({ ...(options as object), interruptHandler: () => { stats.polls++; return handler ? handler() : false; } } as never);
    stats.vm = vm;
    return vm;
  }) as typeof QuickJS.create;
}
const statsOf = (): VmStats => {
  const vm = current.vm;
  // A VM that has ended is disposed: its heap is gone.
  try { return { polls: current.polls, heapBytes: vm ? vm.getMemoryUsage().memoryUsedSize : 0, linearBytes: vm ? vm._getExports().memory.buffer.byteLength : 0 }; }
  catch { return { polls: current.polls, heapBytes: 0, linearBytes: 0 }; }
};

export interface StepResult extends VmStats {
  /** Step k replays effects 1..k-1 and stops at effect k, new. */
  step: number;
  /** From the step's start to its new effect reaching the host, in process (no RPC). */
  ms: number;
  /** Calls through the exchange: one RPC each when deployed. */
  calls: number;
  /** Result bytes that crossed into the guest. */
  crossedBytes: number;
  error?: string;
}
export interface ReplayOptions {
  effects: number; mode: "calls" | "table"; hash: GuestHash; results: "inline" | "handle";
  /** Each journaled effect's body in bytes. Default 20,000: an agent's final answer. */
  bodyBytes?: number;
  /** The steps to run (default: every one). */
  steps?: number[];
  /** The step exchange's poll budget (default: the ceiling). */
  interruptBudget?: number;
}

/**
 * Run steps of one synthetic workflow and measure each. The journal before step k holds effects 1..k-1 with the keys
 * the guest computes (computed here by the same code, and checked against the guest's on every replayed call).
 */
export async function replay(options: ReplayOptions): Promise<StepResult[]> {
  instrument();
  const wasm = await loadQuickJSWasm();
  const { effects, mode, hash, results } = options, bodyBytes = options.bodyBytes ?? 20_000;
  const parameters: ExchangeParameters = {
    protocol: 2, results,
    caps: {
      ...EXCHANGE_CEILINGS,
      // Handle results: 8 KiB crosses inline, a larger body stays on the host (the design's threshold).
      resultBytes: results === "handle" ? 8192 : EXCHANGE_CEILINGS.resultBytes,
      interruptBudget: options.interruptBudget ?? EXCHANGE_CEILINGS.interruptBudget,
    },
  };
  let crossed = 0;
  const sandbox = new RemoteCodemodeSandbox({
    remote: isolatedSandboxRemote({
      agentKey: "workflow", exchange: parameters,
      keep: (_text, call) => `wf/results/${call.id}`,
      getByName: () => ({
        execute: (request, exchange) => serveExchange(request, exchange, (served, bounded) => serveCodemodeRemote(served, async messages => {
          const reply = await bounded(messages);
          if (reply?.type === "result") crossed += reply.payload?.length ?? 0;
          return reply;
        }, { wasm, maxInterruptBudget: EXCHANGE_CEILINGS.interruptBudget, maxMemoryLimitBytes: SANDBOX_HEAP_BYTES })),
      }),
    }),
  });
  const keyOf = hostKeys(hash);
  const journal = Array.from({ length: effects }, (_, i) => ({ key: keyOf(i), value: body(i, bodyBytes) }));
  const rows = journal.map((row, i) => {
    // A table row: the result if small, else its handle, as the runner keeps it.
    const text = JSON.stringify(row.value);
    return text.length <= 8192 ? { status: "done", result: row.value }
      : { status: "done", $handle: `wf/results/${i + 1}`, bytes: text.length, sha256: createHash("sha256").update(text).digest("hex") };
  });
  const out: StepResult[] = [];
  const code = script(effects, mode, hash);
  try {
    for (const step of options.steps ?? Array.from({ length: effects }, (_, i) => i + 1)) {
      const done = step - 1;
      const table: Record<string, unknown> = {};
      if (mode === "table") for (let i = 0; i < done; i++) table[journal[i]!.key] = rows[i];
      current = { polls: 0 };
      crossed = 0;
      const controller = new AbortController(), stats: VmStats = { polls: 0, heapBytes: 0, linearBytes: 0 };
      let calls = 0, fresh: CodemodeHostCall | undefined, at = 0;
      const started = performance.now();
      const run = sandbox.start(code, {
        startedAt: 1_000, seed: 7, tools: [{ name: "effect" }], signal: controller.signal, store: mode === "table" ? { journal: table } : {},
        onCall: call => {
          calls++;
          const index = mode === "calls" ? call.id - 1 : done + call.id - 1;
          const key = (call.args as { key: string }).key;
          if (key !== journal[index]?.key) { fresh = call; controller.abort(new Error(`effect ${index + 1}'s key is ${key}, the journal's ${journal[index]?.key}`)); return; }
          if (index < done) {
            queueMicrotask(() => run.deliver(call.id, 1_000 + call.id, call.id, { ok: true, value: journal[index]!.value }));
            return;
          }
          // The step's new effect: the runner records it and starts it, and this VM stops.
          fresh = call;
          at = performance.now();
          Object.assign(stats, statsOf());
          controller.abort(new Error("step done"));
        },
      });
      const result: CodemodeResult = await run.result;
      if (!fresh || !at) {
        const error = !fresh ? (result.ok ? `ended with ${JSON.stringify(result.value)}` : `${result.error.kind}: ${result.error.message}`) : String(controller.signal.reason);
        out.push({ step, ms: performance.now() - started, calls, crossedBytes: crossed, ...statsOf(), error });
        break;
      }
      out.push({ step, ms: at - started, calls, crossedBytes: crossed, ...stats });
    }
  } finally { await sandbox.close(); }
  return out;
}

/**
 * The least poll budget step `step` runs in: what it uses of the budget in all, QuickJS's own polls and the job-queue
 * polls between promise jobs (which `polls` above does not see).
 */
export async function budgetNeeded(options: Omit<ReplayOptions, "steps" | "interruptBudget">, step: number) {
  const fits = async (budget: number) => !(await replay({ ...options, steps: [step], interruptBudget: budget }))[0]!.error;
  let low = 1, high = EXCHANGE_CEILINGS.interruptBudget;
  if (!await fits(high)) return undefined;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (await fits(middle)) high = middle; else low = middle + 1;
  }
  return low;
}

/** Hashing alone: `count` canonical keys in the guest, and what it costs in polls and time. */
export async function hashCost(hash: GuestHash, count: number) {
  instrument();
  const wasm = await loadQuickJSWasm();
  current = { polls: 0 };
  const sandbox = new RemoteCodemodeSandbox({ tools: [], remote: () => ({ execute: (request, exchange) => serveExchange(request, exchange, (served, bounded) => serveCodemodeRemote(served, bounded, { wasm, maxInterruptBudget: EXCHANGE_CEILINGS.interruptBudget, maxMemoryLimitBytes: SANDBOX_HEAP_BYTES })) }) });
  const started = performance.now();
  const result = await sandbox.execute(`${GUEST_HASHES[hash]}\n${CANONICAL}\nlet last; for (let i = 0; i < ${count}; i++) last = keyHash(canonical({ type: "reviewer", model: "fast", prompt: "Review src/delegation-" + i + ".ts for the owner model refactor.", files: ["src/delegation-" + i + ".ts"] })); return last;`);
  const ms = performance.now() - started;
  await sandbox.close();
  if (!result.ok) throw new Error(`${hash}: ${result.error.message}`);
  return { hash, count, ms, polls: current.polls, last: result.value as string };
}

/** Polls per millisecond of a non-yielding loop on this machine: what the poll budget is in CPU time here. */
export async function pollRate() {
  instrument();
  const wasm = await loadQuickJSWasm();
  current = { polls: 0 };
  const sandbox = new RemoteCodemodeSandbox({ tools: [], remote: () => ({ execute: (request, exchange) => serveExchange(request, exchange, (served, bounded) => serveCodemodeRemote(served, bounded, { wasm, maxInterruptBudget: EXCHANGE_CEILINGS.interruptBudget, maxMemoryLimitBytes: SANDBOX_HEAP_BYTES })) }) });
  const started = performance.now();
  await sandbox.execute("let x = 0; while (true) { x++ }");
  const ms = performance.now() - started;
  await sandbox.close();
  return { budget: EXCHANGE_CEILINGS.interruptBudget, ms, pollsPerMs: current.polls / ms };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const effects = Number(process.argv[2] ?? 500);
  const jsonAt = process.argv.indexOf("--json");
  const checkpoints = [...new Set([1, 10, 50, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10_000, effects].filter(step => step <= effects))];
  const report: Record<string, unknown> = { date: new Date().toISOString().slice(0, 10), node: process.version, effects, rate: await pollRate(), hashes: [] as unknown[], runs: [] as unknown[] };
  console.log("poll rate", report.rate);
  for (const hash of Object.keys(GUEST_HASHES) as GuestHash[]) {
    const cost = await hashCost(hash, effects);
    (report.hashes as unknown[]).push(cost);
    console.log("hash", cost);
  }
  const variants = [["calls", "handle", "fnv1a64"], ["calls", "inline", "fnv1a64"], ["calls", "handle", "sha256"], ["table", "handle", "fnv1a64"], ["table", "handle", "sha256"]] as const;
  for (const [mode, results, hash] of variants) {
    const steps = await replay({ effects, mode, results, hash, steps: checkpoints });
    const last = steps.at(-1)!;
    const budget = last.error ? undefined : await budgetNeeded({ effects, mode, results, hash }, last.step);
    (report.runs as unknown[]).push({ mode, results, hash, budgetNeeded: budget, steps });
    console.log(`\n${mode} / ${results} / ${hash}: step ${last.step} needs a poll budget of ${budget ?? "(did not run)"}`);
    console.table(steps.map(s => ({ step: s.step, ms: +s.ms.toFixed(1), polls: s.polls, calls: s.calls, crossedKiB: +(s.crossedBytes / 1024).toFixed(1), heapKiB: +(s.heapBytes / 1024).toFixed(0), linearMiB: +(s.linearBytes / 1048576).toFixed(1), error: s.error ?? "" })));
  }
  if (jsonAt > 0) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(process.argv[jsonAt + 1]!, JSON.stringify(report, null, 2) + "\n");
  }
}
