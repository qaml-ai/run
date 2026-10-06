// v8-exec (prototype): the limits that tests/sandbox.test.ts and tests/codemode-limits.test.ts check
// against the QuickJS pool's internals (worker threads, the dying set), checked here for a process
// per execution. Needs the binary: cd sandbox/v8-exec && cargo build --release.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { executeCode } from "../src/codemode.ts";
import { SANDBOX_BOOTSTRAP } from "../src/sandbox-bootstrap.ts";
import { V8Exec, v8ExecBinary } from "../src/v8-exec.ts";
import type { ToolBridge } from "../src/protocol.ts";

const skip = !existsSync(v8ExecBinary()) && "v8-exec is not built";
const none: ToolBridge = { definitions: [], call: async () => null };
function hanging() {
  let calls = 0;
  const bridge: ToolBridge = {
    definitions: [{ name: "hang", description: "Never answers", parameters: { type: "object" } }],
    call: (_name, _args, signal) => { calls++; return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))); },
  };
  return { bridge, entered: async (count: number) => { for (let i = 0; i < 200 && calls < count; i++) await sleep(25); assert.ok(calls >= count); } };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the binary's bootstrap is src/sandbox-bootstrap.ts's", { skip }, () => {
  const compiled = readFileSync(new URL("../sandbox/v8-exec/src/bootstrap.js", import.meta.url), "utf8");
  assert.ok(compiled.endsWith(SANDBOX_BOOTSTRAP), "run scripts/gen-v8-bootstrap.ts");
});

test("built-ins V8 cannot interrupt are killed just past the CPU budget", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec();
  t.after(() => pool.close());
  for (const code of ["return new Array(1e9).fill(0).length", "return /(a+)+$/.test('a'.repeat(40) + '!')", "while (true) {}"]) {
    const started = performance.now();
    await assert.rejects(executeCode({ code, bridge: none, pool, timeoutMs: 60_000, limits: { cpuMs: 500 } }), /CPU limit exceeded: the execution kept its thread busy for over 500 ms/);
    const took = performance.now() - started;
    assert.ok(took >= 500 && took < 1_500, `${code}: ${Math.round(took)} ms`);
  }
});

test("memory: the heap is capped (the execution ends), ArrayBuffers are capped (a catchable RangeError)", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec();
  t.after(() => pool.close());
  await assert.rejects(executeCode({ code: "const a = []; for (;;) a.push({ x: Math.random(), y: [1, 2, 3] })", bridge: none, pool }), /Codemode memory limit exceeded/);
  const result = await executeCode({ code: "const a = []; try { for (;;) a.push(new Uint8Array(1 << 20)); } catch (error) { return [a.length, String(error)]; }", bridge: none, pool });
  const [count, error] = JSON.parse(result.output[0]);
  assert.ok(count < 128, String(count));
  assert.match(error, /RangeError: Array buffer allocation failed/);
});

test("a cancelled or timed-out execution's process is killed at once", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec();
  t.after(() => pool.close());
  const hang = hanging();
  const controller = new AbortController();
  const running = executeCode({ code: "await tools.hang({})", bridge: hang.bridge, pool, signal: controller.signal });
  await hang.entered(1);
  const [pid] = pool.pids;
  controller.abort();
  await assert.rejects(running, /aborted/);
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(25);
  assert.equal(alive(pid), false);
  const spinning = new AbortController();
  const spun = executeCode({ code: "while (true) {}", bridge: none, pool, signal: spinning.signal, timeoutMs: 60_000 });
  await sleep(200);
  const aborted = performance.now();
  spinning.abort();
  await assert.rejects(spun, /aborted/);
  assert.ok(performance.now() - aborted < 100);
  await assert.rejects(executeCode({ code: "await tools.hang({})", bridge: hang.bridge, pool, timeoutMs: 300 }), /timed out after 300ms while tools\.hang was still running/);
  assert.equal(pool.running, 0);
});

test("a process that dies mid-execution fails it clearly, and the next one runs", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec();
  t.after(() => pool.close());
  const hang = hanging();
  const running = executeCode({ code: "await tools.hang({})", bridge: hang.bridge, pool });
  await hang.entered(1);
  process.kill([...pool.pids][0], "SIGKILL");
  await assert.rejects(running, /Codemode sandbox process exited \(SIGKILL\)/);
  assert.deepEqual((await executeCode({ code: "return 1", bridge: none, pool })).output, ["1"]);
});

test("past `max` processes, executions wait for one and fail clearly past their timeout", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec({ max: 2 });
  t.after(() => pool.close());
  const hang = hanging();
  const held = [1, 2].map(() => executeCode({ code: "await tools.hang({})", bridge: hang.bridge, pool, timeoutMs: 3_000 }).catch(error => error));
  await hang.entered(2);
  await assert.rejects(executeCode({ code: "return 1", bridge: none, pool, timeoutMs: 300 }), /timed out after 300ms waiting for a sandbox worker/);
  const queued = executeCode({ code: "return 2", bridge: none, pool, timeoutMs: 10_000 });
  await Promise.all(held);
  assert.deepEqual((await queued).output, ["2"]);
});

test("pre-spawned processes are each used once", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec({ prespawn: 2 });
  t.after(() => pool.close());
  for (let i = 0; i < 5; i++) {
    const result = await executeCode({ code: "globalThis.n = (globalThis.n ?? 0) + 1; return n", bridge: none, pool });
    assert.deepEqual(result.output, ["1"], "Nothing carries over");
  }
});
