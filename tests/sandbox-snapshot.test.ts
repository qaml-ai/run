import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { CodePool, executeCode } from "../src/codemode.ts";
import { prepareSandbox, runSandbox } from "../src/quickjs-sandbox.ts";
import { SANDBOX_LIMITS } from "../src/limits.ts";
import type { ToolBridge } from "../src/protocol.ts";

// Every execution starts from one snapshot of an initialized QuickJS (quickjs-sandbox.ts)
// and writes it back when it ends. These run the sandbox on this thread to look at its memory.
const quickjs = createRequire(import.meta.url).resolve("quickjs-emscripten");
const wasmModule = await WebAssembly.compile(await readFile(createRequire(quickjs).resolve("@jitl/quickjs-wasmfile-release-sync/wasm")));

function sandbox(code: string, options: { call?: (name: string, args: unknown) => Promise<string>; cancel?: Int32Array; signal?: AbortSignal; timeoutMs?: number; javascriptOnly?: boolean; tools?: string[]; mark?: (phase: string) => void } = {}) {
  return runSandbox({
    wasmModule, code, cancel: options.cancel ?? new Int32Array(new SharedArrayBuffer(4)), signal: options.signal ?? new AbortController().signal,
    javascriptOnly: options.javascriptOnly, timeoutMs: options.timeoutMs ?? 10_000, maxOutputCharacters: 32_000,
    tools: options.tools ?? ["probe"],
    call: options.call ?? (async () => "null"), onOutput: () => {}, mark: options.mark,
  });
}
const outcome = (promise: Promise<unknown>) => promise.then(value => JSON.stringify(value), (error: Error) => `error: ${error.message}`);

test("every execution, however it ends, leaves the memory exactly as the snapshot: nothing of the guest remains", { timeout: 60_000 }, async () => {
  const image = await prepareSandbox(wasmModule);
  const snapshot = new Uint8Array(image.memory.buffer).slice();
  const marker = "guest-secret-5f3a9c";
  const unchanged = (label: string) => {
    const now = new Uint8Array(image.memory.buffer);
    assert.ok(Buffer.from(now.buffer, 0, snapshot.length).equals(snapshot), `${label}: the snapshot's range is restored`);
    assert.ok(now.subarray(snapshot.length).every(byte => byte === 0), `${label}: memory the guest grew is zeroed`);
  };
  const cancelled = new Int32Array(new SharedArrayBuffer(4));
  Atomics.store(cancelled, 0, 1);
  const abort = new AbortController();
  const executions: [string, () => Promise<unknown>, RegExp][] = [
    ["returns", () => sandbox(`const kept = "${marker}".repeat(1000); globalThis.leak = kept; return kept.length;`), /\["19000"\]/],
    ["mutates built-ins", () => sandbox(`Object.prototype.polluted = "${marker}"; Array.prototype.push = () => 0; JSON.parse = () => "${marker}"; Math.random = () => 4; return 1;`), /"1"/],
    ["throws", () => sandbox(`throw new Error("${marker}");`), new RegExp(`error: ${marker}`)],
    ["does not compile as JavaScript", () => sandbox(`const secret: string = "${marker}"; return secret;`, { javascriptOnly: true }), /"typescript":true/],
    ["spins until cancelled", () => sandbox(`globalThis.leak = "${marker}"; while (true) {}`, { cancel: cancelled }), /limit exceeded/],
    ["spins until its deadline", () => sandbox(`globalThis.leak = "${marker}"; while (true) {}`, { timeoutMs: 100 }), /limit exceeded/],
    ["recurses", () => sandbox(`const secret = "${marker}"; function recurse() { return recurse() + 1; } return recurse();`), /stack overflow/],
    ["exhausts memory", () => sandbox(`const keep = ["${marker}"]; try { for (;;) keep.push("${marker}".repeat(65536)); } catch {} return keep.length;`), /"\d+"/],
    ["leaves a tool call unawaited", () => sandbox(`tools.probe({ secret: "${marker}" }); return 1;`, { call: async () => { await sleep(50); return JSON.stringify("${marker}"); } }), /Unawaited tool calls/],
    ["is aborted waiting on a tool", () => sandbox(`await tools.probe({ secret: "${marker}" });`, { signal: abort.signal, call: () => { setTimeout(() => abort.abort(), 20); return new Promise(() => {}); } }), /limit exceeded/],
  ];
  for (const [label, execute, expected] of executions) {
    assert.match(await outcome(execute()), expected, label);
    unchanged(label);
    assert.equal(Buffer.from(image.memory.buffer).indexOf(marker), -1, `${label}: the guest's data is gone`);
  }
  assert.ok(image.memory.buffer.byteLength > snapshot.length, "One execution grew the memory");
  // A tool result that arrives after its execution ended touches nothing.
  await sleep(100);
  unchanged("late tool result");
  assert.equal(await prepareSandbox(wasmModule), image, "Guest failures keep the image");
  assert.deepEqual(await sandbox("return [typeof leak, ({}).polluted, [].push(1), JSON.parse('2'), Math.random() < 1];"), { output: ['["undefined",null,1,2,true]'], truncated: false });
});

test("a failure outside the guest's own errors drops the image, and the next execution builds a new one", async () => {
  const image = await prepareSandbox(wasmModule);
  await assert.rejects(sandbox("return 1", { mark: phase => { if (phase === "compile") throw new Error("host fault"); } }), /host fault/);
  const rebuilt = await prepareSandbox(wasmModule);
  assert.notEqual(rebuilt, image);
  assert.deepEqual((await sandbox("return 2")).output, ["2"]);
  assert.equal(await prepareSandbox(wasmModule), rebuilt);
});

test("each execution on a worker gets its own Math.random seed, its tenant's tools only, and the current clock", async t => {
  const pool = new CodePool({ min: 1, max: 1 });
  t.after(() => pool.close());
  const bridge = (name: string): ToolBridge => ({ definitions: [{ name, description: `Only ${name}'s tenant has this`, parameters: { type: "object" } }], call: async () => name });
  const run = async (code: string, tenant = "alpha") => JSON.parse((await executeCode({ code, bridge: bridge(tenant), pool })).output[0]);
  const draws: number[][] = [];
  for (let i = 0; i < 6; i++) draws.push(await run("return Array.from({ length: 4 }, () => Math.random());"));
  assert.equal(new Set(draws.flat()).size, draws.length * 4, "No two executions draw the same numbers");
  assert.ok(draws.flat().every(value => value >= 0 && value < 1));

  assert.deepEqual(await run(`globalThis.stash = await tools.alpha({}); Object.prototype.owner = "alpha"; return Object.keys(tools);`, "alpha"), ["alpha", "search", "describe", "namespaces"]);
  assert.deepEqual(await run(`return [Object.keys(tools), (await tools.search("")).map(tool => tool.name), await tools.describe("alpha"), typeof stash, ({}).owner ?? null, await tools.beta({})];`, "beta"),
    [["beta", "search", "describe", "namespaces"], ["beta"], null, "undefined", null, "beta"]);
  assert.equal(pool.slots.size, 1, "Both tenants ran on the same worker");

  const first = await run("return Date.now();");
  await sleep(30);
  assert.ok(await run("return Date.now();") >= first + 25, "The clock is not frozen in the snapshot");
});

test("limits hold from the snapshot: heap, stack depth and CPU", { timeout: 30_000 }, async () => {
  const heap = await sandbox(`const keep = []; try { for (;;) keep.push(new Uint8Array(1024 * 1024)); } catch { return keep.length; }`);
  assert.ok(Number(heap.output![0]) < SANDBOX_LIMITS.wasmBytes / (1024 * 1024), heap.output![0]);
  assert.match(await outcome(sandbox("function recurse(n) { return recurse(n + 1) + 1; } return recurse(0);")), /stack overflow/);
  const started = performance.now();
  assert.match(await outcome(sandbox("while (true) {}", { timeoutMs: 60_000 })), /CPU or wall-clock limit/);
  assert.ok(performance.now() - started < SANDBOX_LIMITS.cpuMs + 1_000);
});
