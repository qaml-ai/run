import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, readFile, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runPi } from "./pi-sandbox.ts";
import { localTools } from "./local-tools.ts";
import { SANDBOX_LIMITS, codeRequest } from "../src/limits.ts";
import type { ToolBridge } from "../src/protocol.ts";

// Pi execution end to end on v8-exec, this process's own (tests/v8-exec.test.ts has v8-exec's own workings).
// Needs the binary: npm run build:v8-exec.
type RunOptions = { timeoutMs?: number; signal?: AbortSignal; cpuMs?: number };
async function fixture(t: { after: (fn: () => Promise<void>) => void }, bridge?: ToolBridge) {
  const directory = await mkdtemp(join(tmpdir(), "camelai-sandbox-test-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const tools = bridge ?? await localTools(join(directory, "workspace"));
  return {
    directory,
    run: (code: string, options: RunOptions = {}) => runPi({ code, bridge: tools, ...options }),
  };
}

test("guest globals, function constructors, eval and callback prototypes cannot reach the host", async t => {
  const { run } = await fixture(t);
  const result = await run(`
    const denied = ["process", "Bun", "require", "module", "fetch", "XMLHttpRequest", "WebSocket", "Worker", "WebAssembly", "SharedArrayBuffer", "Atomics", "setTimeout", "setInterval", "__call", "__emit"];
    // fs and require throw on any use, saying what replaced them: not there to reach either.
    const globals = denied.map(name => { try { return typeof globalThis[name]; } catch { return "undefined"; } });
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
  const resultObject = result as any;
  assert.ok(resultObject.globals.every((value: string) => value === "undefined"), JSON.stringify(resultObject));
  assert.ok(resultObject.constructorProbes.every((value: string) => value === "undefined"));
  await run('tools.read = () => "hijacked";');
  await run('try { Object.prototype.guestMutation = "only here"; } catch {}');
  assert.equal(await run('return typeof ({}).guestMutation;'), "undefined");
  assert.equal((Object.prototype as any).guestMutation, undefined);
});

test("all module import schemes and direct network access are denied", async t => {
  const { run } = await fixture(t);
  const result = await run(`
    return await Promise.all(["node:fs", "node:child_process", "bun", "file:///etc/passwd", "https://example.com/module.js", "data:text/javascript,export default 1"]
      .map(async name => { try { await import(name); return "escaped"; } catch { return "denied"; } }));
  `);
  assert.deepEqual(result, Array(6).fill("denied"));
  await assert.rejects(run('return await fetch("http://127.0.0.1:8790");'), /fetch.*not defined/);
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

test("concurrent executions do not interfere", async t => {
  let delay = 0;
  const { run } = await fixture(t, {
    definitions: [{ name: "wait", description: "Resolves later", parameters: { type: "object" } }],
    call: async () => { await sleep(5 + (delay++ % 4) * 10); return null; },
  });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => run(`
    globalThis.mine = ${i};

    await tools.wait({});
    text("progress ${i}");
    await tools.wait({});
    return globalThis.mine;
  `)));
  results.forEach((result, i) => assert.equal(result, i));
});

test("CPU, stack and hostile serialization stay inside the guest's limits", { timeout: 30_000 }, async () => {
  for (const code of [
    "while (true) {}", "while (true) await Promise.resolve()",
    "return { toJSON() { while (true) {} } }",
    "throw { get message() { while (true) {} } }",
  ]) await assert.rejects(runPi({ code, cpuMs: 100, timeoutMs: 2_000 }), /CPU.*limit|exceeded/);
  await assert.rejects(runPi({ code: "function recurse() { return recurse() + 1; } return recurse();" }), /stack|recursion/i);
  await assert.rejects(runPi({ code: "return await new Promise(() => {});", timeoutMs: 500 }), /stalled|settle|exceeded/);
  assert.equal(await runPi({ code: "return 42" }), 42);
});

test("Pi caps tool calls, arguments and results, queues calls past 32 at once, and cuts output past its limits", async () => {
  const bridge: ToolBridge = {
    definitions: [{ name: "echo", description: "Echo", parameters: { type: "object" } }],
    call: async (_name, args) => args.big ? "x".repeat(SANDBOX_LIMITS.resultBytes + 1) : args,
  };
  for (const [code, pattern] of [
    ['for (let i = 0; i < 257; i++) await tools.echo({i});', /at most 256 tool calls/],
    ['await tools.echo({value: "x".repeat(150000)});', /arguments.*limit|Malformed Pi call/],
    ['await tools.echo({big: true});', /result|payload/i],
  ] as const) await assert.rejects(runPi({ code, bridge }), pattern);
  // Past 32 calls out at once, the rest wait their turn in the guest; output past its limits is left out, not fatal.
  await runPi({ code: 'await Promise.all(Array.from({length: 40}, () => tools.echo({})));', bridge });
  assert.equal(await runPi({ code: 'for (let i = 0; i < 1025; i++) text("x"); return 1;', bridge }), 1);
});

test("host tool schemas and code options cannot be overridden by scripts", async t => {
  const { run } = await fixture(t);
  await assert.rejects(run('return await tools.read({path: 12});'), /Invalid arguments/);
  await assert.rejects(run('return await tools.write({path: "x", content: "ok", extra: "no"});'), /Invalid arguments/);
  for (const [key, value] of Object.entries({ runtime: "/bin/sh", directory: "/", bridge: {}, tools: [], cpuMs: 100000, wasmBytes: 1e9 })) {
    assert.throws(() => codeRequest({ code: "return 1", [key]: value }), /Unknown codemode option/);
  }
});
