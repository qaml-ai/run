import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, readFile, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { CodePool, executeCode } from "../src/codemode.ts";
import { localTools } from "../src/local-tools.ts";
import { SANDBOX_LIMITS, codeRequest } from "../src/limits.ts";
import type { ToolBridge } from "../src/protocol.ts";

type RunOptions = { timeoutMs?: number; maxOutputCharacters?: number; signal?: AbortSignal; onEvent?: (event: unknown) => void };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, bridge?: ToolBridge, pool?: CodePool) {
  const directory = await mkdtemp(join(tmpdir(), "camelai-sandbox-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (pool) t.after(() => pool.close());
  const tools = bridge ?? await localTools(join(directory, "workspace"));
  return {
    directory,
    run: (code: string, options: RunOptions = {}) => executeCode({ code, bridge: tools, pool, ...options }),
  };
}

const threads = (pool: CodePool) => [...pool.slots].map(slot => slot.worker.threadId).sort();
async function until(condition: () => boolean, timeoutMs = 5_000) {
  for (let i = 0; i < timeoutMs / 25 && !condition(); i++) await sleep(25);
  assert.ok(condition(), "Condition not reached");
}
/**
 * Aborts a guest once it is inside one long native call (parsing a 300,000-digit BigInt,
 * then printing it: seconds, with no interrupt checks), so only terminating its worker stops it.
 * Aborting on the guest's own signal, not on a timer, keeps a slow host from cancelling it
 * cooperatively before it gets there.
 */
function stuck(run: (code: string, options?: RunOptions) => Promise<unknown>) {
  const controller = new AbortController();
  let aborted = 0;
  const result = run('const digits = "9".repeat(300000); text("parsing"); return BigInt(digits).toString().length;', {
    signal: controller.signal, timeoutMs: 60_000,
    onEvent: () => { aborted = performance.now(); controller.abort(); },
  });
  return assert.rejects(result, /aborted/).then(() => performance.now() - aborted);
}
/** Holds a worker's termination until released, like a thread slow to reach a point where it can be stopped. */
function holdTermination(worker: Worker) {
  const terminate = worker.terminate.bind(worker);
  const held = Promise.withResolvers<void>();
  worker.terminate = () => held.promise.then(terminate);
  return () => held.resolve();
}
function blocking() {
  let calls = 0;
  const release = Promise.withResolvers<void>();
  const bridge: ToolBridge = {
    definitions: [{ name: "hang", description: "Blocks until released or aborted", parameters: { type: "object" } }],
    call: (_name, _args, signal) => new Promise((resolve, reject) => {
      calls++;
      void release.promise.then(() => resolve("released"));
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
  };
  return { bridge, entered: (count: number) => until(() => calls >= count), release: () => release.resolve() };
}

test("guest globals, function constructors, eval and callback prototypes cannot reach the host", async t => {
  const { run } = await fixture(t);
  const result = await run(`
    const denied = ["process", "Bun", "require", "module", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "WebAssembly", "SharedArrayBuffer", "Atomics", "setTimeout", "setInterval", "__call", "__emit"];
    const globals = denied.map(name => typeof globalThis[name]);
    const constructorProbes = [
      Function("return typeof process")(),
      ({}).constructor.constructor("return typeof process")(),
      console.log.constructor("return typeof process")(),
      text.constructor("return typeof process")(),
      await tools.read.constructor("return typeof process")(),
      eval("typeof process"),
      (await tools.ls({})).constructor.constructor("return typeof process")(),
    ];
    return {globals, constructorProbes};
  `);
  const resultObject = JSON.parse(result.output[0]);
  assert.ok(resultObject.globals.every((value: string) => value === "undefined"), JSON.stringify(resultObject));
  assert.ok(resultObject.constructorProbes.every((value: string) => value === "undefined"));
  await assert.rejects(run('tools.read = () => "hijacked";'), /read.only|not writable|read-only/i);
  await run('Object.prototype.guestMutation = "only here";');
  assert.deepEqual((await run('return typeof ({}).guestMutation;')).output, ["undefined"]);
  assert.equal((Object.prototype as any).guestMutation, undefined);
});

test("all module import schemes and direct network access are denied", async t => {
  const { run } = await fixture(t);
  const result = await run(`
    return await Promise.all(["node:fs", "node:child_process", "bun", "file:///etc/passwd", "https://example.com/module.js", "data:text/javascript,export default 1"]
      .map(async name => { try { await import(name); return "escaped"; } catch { return "denied"; } }));
  `);
  assert.deepEqual(JSON.parse(result.output[0]), Array(6).fill("denied"));
  await assert.rejects(run('return await fetch("http://127.0.0.1:8790");'), /fetch.*not defined/);
});

test("host policy validates schemas and rejects execution policy overrides", async t => {
  const { run } = await fixture(t);
  await assert.rejects(run('return await tools.read({path: 12});'), /Invalid arguments/);
  await assert.rejects(run('return await tools.write({path: "x", content: "ok", extra: "no"});'), /Invalid arguments/);
  await assert.rejects(run('return await tools.notRegistered({});'), /not a function/);
  await assert.rejects(run('return await tools.read({path: "x".repeat(150000)});'), /size limit/);
  for (const [key, value] of Object.entries({ runtime: "/bin/sh", directory: "/", bridge: {}, tools: [], cpuMs: 100000, wasmBytes: 1e9 })) {
    assert.throws(() => codeRequest({ code: "return 1", [key]: value }), /Unknown codemode option/);
  }
});

test("bulk arrays and strings cannot grow beyond the fixed WASM memory", async t => {
  const { run } = await fixture(t);
  for (const allocation of ['new Uint8Array(1024 * 1024)', '"x".repeat(1024 * 1024)']) {
    const result = await run(`
      const allocations = [];
      try { for (let i = 0; i < 128; i++) allocations.push(${allocation}); }
      catch (error) { return {count: allocations.length, stopped: true}; }
      return {count: allocations.length, stopped: false};
    `);
    const value = JSON.parse(result.output[0]);
    assert.equal(value.stopped, true);
    assert.ok(value.count < SANDBOX_LIMITS.wasmBytes / (1024 * 1024), JSON.stringify(value));
  }
  assert.deepEqual((await run("return 42;")).output, ["42"]);
});

test("CPU, stack, hostile serialization and abandoned promises are bounded", { timeout: 20_000 }, async t => {
  const { run } = await fixture(t);
  await assert.rejects(run("while (true) {}", { timeoutMs: 10_000 }), /CPU.*limit/);
  await assert.rejects(run("while (true) await Promise.resolve();", { timeoutMs: 5000 }), /CPU.*limit|timed out/);
  await assert.rejects(run("function recurse() { return recurse() + 1; } return recurse();"), /stack|recursion/i);
  await assert.rejects(run("return { toJSON() { while (true) {} } };", { timeoutMs: 500 }), /timed out/);
  await assert.rejects(run('throw { get message() { while (true) {} } };', { timeoutMs: 500 }), /timed out/);
  await assert.rejects(run("return await new Promise(() => {});", { timeoutMs: 500 }), /timed out/);
  assert.deepEqual((await run("return 42;")).output, ["42"]);
});

test("output floods are bounded by both characters and event count", async t => {
  const { run } = await fixture(t);
  assert.deepEqual(await run('return "x".repeat(1000000);', { maxOutputCharacters: 5 }), { output: ["xxxxx"], truncated: true });
  const result = await run('for(let i=0;i<10000;i++) text("x");', { maxOutputCharacters: 128000 });
  assert.equal(result.output.length, SANDBOX_LIMITS.outputEvents);
  assert.equal(result.truncated, true);
});

test("tool call count, concurrency and result transfer quotas hold outside the guest", async t => {
  let calls = 0;
  let inflight = 0;
  let peak = 0;
  const { run } = await fixture(t, {
    definitions: [{ name: "echo", description: "Test capability", parameters: { type: "object" } }],
    async call(_name, args) {
      calls++;
      peak = Math.max(peak, ++inflight);
      try {
        if (args.delay) await new Promise(resolve => setTimeout(resolve, 50));
        if (args.big) return "x".repeat(SANDBOX_LIMITS.resultBytes + 1);
        if (args.large) return "x".repeat(SANDBOX_LIMITS.resultBytes - 16);
        return args;
      } finally { inflight--; }
    },
  });
  await assert.rejects(run('for(let i=0;i<257;i++) await tools.echo({i});'), /tool call limit/);
  assert.equal(calls, SANDBOX_LIMITS.toolCalls);
  const result = await run('return (await Promise.allSettled(Array.from({length:40}, () => tools.echo({delay:true})))).map(r => r.status);');
  const statuses = JSON.parse(result.output[0]);
  assert.equal(statuses.filter((s: string) => s === "fulfilled").length, SANDBOX_LIMITS.concurrentTools);
  assert.equal(peak, SANDBOX_LIMITS.concurrentTools);
  await assert.rejects(run('return await tools.echo({big:true});'), /Tool result exceeds JSON size limit/);
  await assert.rejects(run('for(let i=0;i<9;i++) await tools.echo({large:true});'), /transfer limit exceeded/);
  const before = calls;
  await assert.rejects(run('tools.echo({}); return 1;'), /Unawaited tool calls/);
  assert.equal(calls, before, "An unawaited call must not dispatch after sandbox disposal");
});

test("workspace capabilities reject traversal, live/dangling symlinks and hard links", async t => {
  const { directory, run } = await fixture(t);
  const outside = join(directory, "secret.txt");
  await writeFile(outside, "unchanged");
  await symlink(outside, join(directory, "workspace", "link"));
  await symlink(join(directory, "created-outside.txt"), join(directory, "workspace", "dangling"));
  await link(outside, join(directory, "workspace", "hardlink"));
  for (const path of ["../secret.txt", "link", "dangling", "hardlink"]) {
    await assert.rejects(run(`return await tools.write({path:${JSON.stringify(path)}, content:"escaped"});`), /escapes|linked/);
  }
  assert.equal(await readFile(outside, "utf8"), "unchanged");
  await assert.rejects(readFile(join(directory, "created-outside.txt")), /ENOENT/);
});

test("the guest reaches only ECMAScript built-ins and the codemode helpers: no process, require, Node modules or environment", async t => {
  process.env.SANDBOX_TEST_CANARY = "sandbox-test-canary-must-not-leak";
  t.after(() => { delete process.env.SANDBOX_TEST_CANARY; });
  const { run } = await fixture(t);
  const result = await run(`
    const globals = Object.getOwnPropertyNames(globalThis).sort();
    const probes = {
      process: typeof process, require: typeof require, module: typeof module, Buffer: typeof Buffer,
      globalProcess: typeof globalThis.process, std: typeof std, os: typeof os, env: typeof env,
    };
    const imports = await Promise.all(["node:process", "node:fs", "node:worker_threads", "process", "fs", "module"]
      .map(async name => { try { await import(name); return "escaped"; } catch (error) { return String(error.message); } }));
    return { globals, probes, imports, reachable: JSON.stringify(globals.map(name => { try { return String(globalThis[name]); } catch { return ""; } })) };
  `);
  const value = JSON.parse(result.output[0]);
  assert.deepEqual(value.globals, [
    "AggregateError", "Array", "ArrayBuffer", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date", "Error",
    "EvalError", "FinalizationRegistry", "Float16Array", "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array",
    "Int8Array", "InternalError", "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy", "RangeError",
    "ReferenceError", "Reflect", "RegExp", "Set", "String", "Symbol", "SyntaxError", "TypeError", "URIError", "Uint16Array", "Uint32Array",
    "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "console", "decodeURI", "decodeURIComponent", "encodeURI",
    "encodeURIComponent", "escape", "eval", "globalThis", "isFinite", "isNaN", "parseFloat", "parseInt", "text", "tools", "undefined", "unescape",
  ]);
  assert.ok(Object.values(value.probes).every(type => type === "undefined"), JSON.stringify(value.probes));
  assert.ok(value.imports.every((outcome: string) => /imports are disabled/.test(outcome)), JSON.stringify(value.imports));
  assert.ok(!value.reachable.includes("sandbox-test-canary"));
});

test("a worker keeps no guest state between executions", async t => {
  const pool = new CodePool({ min: 1, max: 1 });
  const { run } = await fixture(t, undefined, pool);
  await run("return 0");
  const [worker] = threads(pool);
  await run(`globalThis.leak = "secret"; Object.prototype.polluted = 1; Array.prototype.push = () => 0; JSON.parse = () => "hijacked"; var declared = 1;`);
  const result = await run(`return [typeof leak, typeof declared, ({}).polluted, [].push(1), JSON.parse("2")];`);
  assert.deepEqual(JSON.parse(result.output[0]), ["undefined", "undefined", null, 1, 2]);
  assert.deepEqual(threads(pool), [worker], "Both ran on the same worker");
  // Memory is fresh too: exhausting it leaves nothing behind for the next guest.
  await run('const keep = []; try { for (;;) keep.push(new Uint8Array(1024 * 1024)); } catch {}');
  assert.deepEqual((await run('const keep = []; for (let i = 0; i < 12; i++) keep.push(new Uint8Array(1024 * 1024)); return keep.length;')).output, ["12"]);
  assert.deepEqual(threads(pool), [worker]);
});

test("concurrent executions do not interfere", async t => {
  let delay = 0;
  const pool = new CodePool({ min: 1, max: 3 });
  const { run } = await fixture(t, {
    definitions: [{ name: "wait", description: "Resolves later", parameters: { type: "object" } }],
    call: async () => { await sleep(5 + (delay++ % 4) * 10); return null; },
  }, pool);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => run(`
    globalThis.mine = ${i};
    Object.prototype.owner = ${i};
    await tools.wait({});
    text("progress ${i}");
    await tools.wait({});
    return [globalThis.mine, ({}).owner];
  `)));
  results.forEach((result, i) => assert.deepEqual(result.output, [`progress ${i}`, JSON.stringify([i, i])]));
  assert.ok(pool.slots.size <= 3);
});

test("timeouts and aborts cancel the guest, and the worker is reused once it unwinds", async t => {
  const pool = new CodePool({ min: 1, max: 1 });
  const hang = blocking();
  const { run } = await fixture(t, hang.bridge, pool);
  await run("return 0");
  const [worker] = threads(pool);
  const timedOut = assert.rejects(run("await tools.hang({});", { timeoutMs: 500 }), /timed out after 500ms/);
  await hang.entered(1);
  await timedOut;
  const controller = new AbortController();
  const aborted = assert.rejects(run("await tools.hang({});", { signal: controller.signal }), /aborted/);
  await hang.entered(2);
  controller.abort();
  await aborted;
  const spinning = new AbortController();
  const spun = assert.rejects(run("while (true) {}", { signal: spinning.signal, timeoutMs: 60_000 }), /aborted/);
  await sleep(200);
  spinning.abort();
  await spun;
  await assert.rejects(run("return await new Promise(() => {});", { timeoutMs: 300 }), /timed out/);
  assert.match(String(await run("while (true) {}", { timeoutMs: 60_000 }).catch(error => error)), /CPU or wall-clock limit/, "A CPU-bound guest dies at the CPU limit, well before its deadline");
  assert.deepEqual((await run("return 42;")).output, ["42"]);
  assert.deepEqual(threads(pool), [worker], "Every cancellation was cooperative");
});

test("a guest stuck where the interrupt handler cannot reach is terminated with its worker, whose slot is refilled without waiting for it to exit", async t => {
  const pool = new CodePool({ min: 1, max: 2 });
  const { run } = await fixture(t, undefined, pool);
  await run("return 0");
  const [slot] = pool.slots;
  const release = holdTermination(slot.worker);
  try {
    assert.ok(await stuck(run) < 1_000, "The caller does not wait for the worker to be terminated");
    await until(() => pool.dying.has(slot.worker) && pool.slots.size === 1 && !pool.slots.has(slot));
    assert.deepEqual((await run("return 42;")).output, ["42"], "The replacement serves while the old thread is still exiting");
  } finally { release(); }
  await until(() => pool.dying.size === 0);
  assert.equal(pool.slots.size, 1);
});

test("while too many terminated workers are still exiting, no new ones start and executions wait with a clear error", async t => {
  const pool = new CodePool({ min: 1, max: 4, maxDying: 2 });
  const { run } = await fixture(t, undefined, pool);
  const logged = t.mock.method(console, "error", () => {});
  const releases: (() => void)[] = [];
  try {
    for (let i = 0; i < 2; i++) {
      await run("return 0");
      const [slot] = pool.slots;
      releases.push(holdTermination(slot.worker));
      await stuck(run);
      await until(() => pool.dying.has(slot.worker));
    }
    assert.equal(pool.slots.size, 0, "No worker starts while two terminated ones are still exiting");
    assert.ok(logged.mock.calls.some(call => String(call.arguments[0]).includes("codemode_workers_dying")));
    await assert.rejects(run("return 1;", { timeoutMs: 300 }), /timed out after 300ms waiting for a sandbox worker \(2 terminated workers still exiting\)/);
    const queued = run("return 2;", { timeoutMs: 10_000 });
    releases[0]();
    assert.deepEqual((await queued).output, ["2"], "One exiting frees room for a new worker");
  } finally { releases.forEach(release => release()); }
  await until(() => pool.dying.size === 0);
});

test("a worker that dies mid-execution fails the execution and is replaced", async t => {
  const pool = new CodePool({ min: 1, max: 1 });
  const hang = blocking();
  const { run } = await fixture(t, hang.bridge, pool);
  const running = assert.rejects(run("await tools.hang({});"), /worker exited/);
  await hang.entered(1);
  const [slot] = pool.slots;
  await slot.worker.terminate();
  await running;
  await until(() => pool.slots.size === 1 && !pool.slots.has(slot));
  assert.deepEqual((await run("return 1;")).output, ["1"]);
});

test("executions queue for a free worker and fail clearly past their own timeout; idle extra workers are reaped", async t => {
  const pool = new CodePool({ min: 1, max: 2, idleMs: 100 });
  const hang = blocking();
  const { run } = await fixture(t, hang.bridge, pool);
  const held = [run("return await tools.hang({});"), run("return await tools.hang({});")];
  await until(() => [...pool.slots].filter(slot => slot.state === "busy").length === 2);
  assert.equal(pool.slots.size, 2, "Grew on demand up to the maximum");
  await assert.rejects(run("return 1;", { timeoutMs: 200 }), /timed out after 200ms waiting for a sandbox worker \(all 2 busy\)/);
  const queued = run("return 2;", { timeoutMs: 10_000 });
  await sleep(100);
  hang.release();
  assert.deepEqual((await Promise.all(held)).map(result => result.output), [["released"], ["released"]]);
  assert.deepEqual((await queued).output, ["2"]);
  await until(() => pool.slots.size === 1);
});
