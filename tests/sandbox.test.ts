import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, readFile, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { executeCode, presentResult } from "../src/codemode.ts";
import { localTools } from "./local-tools.ts";
import { SANDBOX_LIMITS, codeRequest } from "../src/limits.ts";
import type { ToolBridge } from "../src/protocol.ts";

// js_exec end to end on v8-exec, this process's own (tests/v8-exec.test.ts has v8-exec's own workings).
// Needs the binary: npm run build:v8-exec.
type RunOptions = { timeoutMs?: number; maxOutputCharacters?: number; signal?: AbortSignal; onEvent?: (event: unknown) => void };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, bridge?: ToolBridge) {
  const directory = await mkdtemp(join(tmpdir(), "camelai-sandbox-test-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const tools = bridge ?? await localTools(join(directory, "workspace"));
  return {
    directory,
    run: (code: string, options: RunOptions = {}) => executeCode({ code, bridge: tools, ...options }),
  };
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
  await assert.rejects(run('return await tools.notRegistered({});'), /tools\.notRegistered is not a tool/);
  await assert.rejects(run('return await tools.read({path: "x".repeat(150000)});'), /size limit/);
  for (const [key, value] of Object.entries({ runtime: "/bin/sh", directory: "/", bridge: {}, tools: [], cpuMs: 100000, wasmBytes: 1e9 })) {
    assert.throws(() => codeRequest({ code: "return 1", [key]: value }), /Unknown codemode option/);
  }
});

test("bulk arrays and strings cannot grow beyond the memory limits", async t => {
  const { run } = await fixture(t);
  // ArrayBuffers are refused past 128 MB (catchable); a heap past its 128 MB ends the execution.
  const buffers = JSON.parse((await run('const a = []; try { for (let i = 0; i < 256; i++) a.push(new Uint8Array(1 << 20)); } catch (error) { return { count: a.length, error: String(error) }; }')).output[0]);
  assert.ok(buffers.count < 128 && /RangeError/.test(buffers.error), JSON.stringify(buffers));
  await assert.rejects(run('const a = []; for (;;) a.push(new Array(1 << 16).fill(Math.random()));'), /Codemode memory limit exceeded/);
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
  assert.deepEqual(await run('return "x".repeat(1000000);', { maxOutputCharacters: 5 }).then(({ cpuMs: _cpuMs, ...result }) => result), { output: ["xxxxx"], truncated: true, returned: { index: 0, json: false, truncated: true } });
  const result = await run('for(let i=0;i<10000;i++) text("x");', { maxOutputCharacters: 128000 });
  assert.equal(result.output.length, SANDBOX_LIMITS.outputEvents);
  assert.equal(result.truncated, true);
});

test("a tool name code gets wrong says which tool it may have meant", async t => {
  const bridge: ToolBridge = {
    definitions: ["camel__list_commits", "camel__read", "helpdesk__read"].map(name => ({ name, description: name, parameters: { type: "object" } })),
    call: async name => ({ called: name }),
  };
  const { run } = await fixture(t, bridge);
  // The server prefix left off: the one tool it can be.
  await assert.rejects(run("return await tools.list_commits({});"), /tools\.list_commits is not a tool\. Did you mean tools\.camel__list_commits\?/);
  // More than one server has it: each is named.
  await assert.rejects(run("return await tools.read({});"), /Did you mean tools\.camel__read or tools\.helpdesk__read\?/);
  await assert.rejects(run("return await tools.nothing_like_it({});"), /tools\.nothing_like_it is not a tool\. tools\.search/);
  // What code may look up without calling still works: the tools object itself, its names, and real tools.
  assert.deepEqual(JSON.parse((await run("return { keys: Object.keys(tools).length, then: typeof tools.then, json: JSON.stringify(tools) !== undefined, fn: typeof tools.camel__read };")).output.at(-1)!),
    { keys: 6, then: "undefined", json: true, fn: "function" });
  assert.equal((await run("const t = tools; return (await t.camel__read({})).called;")).output.at(-1), "camel__read");
});

test("the model reads what code returned as it is, after what it logged, with cuts marked", async t => {
  const { run } = await fixture(t);
  const read = async (code: string, maxOutputCharacters?: number) => presentResult(await run(code, { maxOutputCharacters }), maxOutputCharacters);
  assert.equal(await read('return { total: 2, apps: ["a", "b"] };'), '{"total":2,"apps":["a","b"]}', "a returned value is its JSON, not a string inside an envelope");
  assert.equal(await read('return "done";'), "done", "a string is its own text");
  assert.equal(await read('console.log("step", { n: 1 }); return [1];'), 'Logged:\nstep\n{"n":1}\n\nReturned:\n[1]');
  assert.equal(await read('console.log("only");'), "only");
  assert.equal(await read("const x = 1;"), "No output: nothing was returned or logged.");
  assert.equal(await read('return { a: "z".repeat(40) };', 20), '{"a":"zzzzzzzzzzzzzz\n\n[Output cut at 20 characters, so the returned JSON is incomplete. Return only what you need (counts, chosen fields, a summary), or write the data to a file and read it in parts.]');
  assert.match(await read('text("y".repeat(30)); return 1;', 20), /^Logged:\ny{20}\n\nReturned:\n\(cut\)\n\n\[Output cut at 20 characters, leaving no room for the return value\./);
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
    "AggregateError", "Array", "ArrayBuffer", "AsyncDisposableStack", "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date",
    "DisposableStack", "Error", "EvalError", "FinalizationRegistry", "Float16Array", "Float32Array", "Float64Array", "Function", "Infinity",
    "Int16Array", "Int32Array", "Int8Array", "Intl", "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object", "Promise", "Proxy",
    "RangeError", "ReferenceError", "Reflect", "RegExp", "Set", "String", "SuppressedError", "Symbol", "SyntaxError", "Temporal", "TypeError",
    "URIError", "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "console", "decodeURI",
    "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape", "eval", "fs", "globalThis", "isFinite", "isNaN", "parseFloat",
    "parseInt", "text", "tools", "undefined", "unescape",
  ]);
  assert.ok(Object.values(value.probes).every(type => type === "undefined"), JSON.stringify(value.probes));
  assert.ok(value.imports.every((outcome: string) => /imports are disabled/.test(outcome)), JSON.stringify(value.imports));
  assert.ok(!value.reachable.includes("sandbox-test-canary"));
});

test("concurrent executions do not interfere", async t => {
  let delay = 0;
  const { run } = await fixture(t, {
    definitions: [{ name: "wait", description: "Resolves later", parameters: { type: "object" } }],
    call: async () => { await sleep(5 + (delay++ % 4) * 10); return null; },
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => run(`
    globalThis.mine = ${i};
    Object.prototype.owner = ${i};
    await tools.wait({});
    text("progress ${i}");
    await tools.wait({});
    return [globalThis.mine, ({}).owner];
  `)));
  results.forEach((result, i) => assert.deepEqual(result.output, [`progress ${i}`, JSON.stringify([i, i])]));
});
