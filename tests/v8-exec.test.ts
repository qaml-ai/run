// v8-exec: js_exec on V8, a process per execution (src/v8-exec.ts, sandbox/v8-exec). Its own
// workings (processes killed, pre-spawned, waiting past `max`), and Intl, the seccomp allowlist and
// jitless; tests/sandbox.test.ts and tests/codemode-limits.test.ts run js_exec end to end on it. Needs the binary (npm run build:v8-exec); the seccomp
// tests need Linux (tests/image-isolation.ts runs them in the image as well).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { executeCode, FS_CALLS, HOST_CALLS } from "../src/codemode.ts";
import { frames } from "../src/sandbox-wire.ts";
import { V8Exec, v8ExecBinary } from "../src/v8-exec.ts";
import type { ToolBridge } from "../src/protocol.ts";

const skip = !existsSync(v8ExecBinary()) && "v8-exec is not built (npm run build:v8-exec)";
const linux = skip || (process.platform !== "linux" && "seccomp is Linux's");
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
const run = (pool: V8Exec, code: string, bridge = none) => executeCode({ code, bridge, pool }).then(result => JSON.parse(result.output.at(-1)!));

test("the bootstrap calls the host by the names the runtime answers", () => {
  const bootstrap = readFileSync(new URL("../sandbox/v8-exec/src/bootstrap.js", import.meta.url), "utf8");
  const hostCalls = [...bootstrap.matchAll(/call\("(tools\.\w+)"/g)].map(match => match[1]);
  assert.deepEqual(hostCalls.sort(), Object.values(HOST_CALLS).sort());
  assert.match(bootstrap, /call\("fs\." \+ name/);
  const fsCalls = [...bootstrap.matchAll(/fsCall\("(\w+)"/g)].map(match => `fs.${match[1]}`);
  assert.deepEqual([...new Set(fsCalls)].sort(), [...FS_CALLS].sort());
});

for (const jitless of [true, false]) {
  test(`${jitless ? "jitless" : "with the JIT"}: code, TypeScript, tools, fs and Intl run`, { skip, timeout: 30_000 }, async t => {
    const pool = new V8Exec({ jitless });
    t.after(() => pool.close());
    const files = new Map<string, string>();
    const bridge: ToolBridge = {
      definitions: [{ name: "echo", description: "Echoes", parameters: { type: "object" } }],
      call: async (_name, args) => args,
      fs: async (op, args) => op === "writeFile" ? (files.set(String(args.path), String(args.text)), { path: args.path }) : { path: args.path, text: files.get(String(args.path)) },
    };
    assert.deepEqual(await run(pool, [
      "enum Color { Red, Green }",
      "const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);",
      "const echoed = await Promise.all([1, 2, 3].map(i => tools.echo({ i })));",
      "await fs.writeFile('/workspace/a.txt', 'hello');",
      "return { sum: sum(echoed.map(e => e.i)), green: Color.Green, file: await fs.readFile('/workspace/a.txt') };",
    ].join("\n"), bridge), { sum: 6, green: 1, file: "hello" });
    // ICU is compiled in: formatting, dates, collation and case mapping in other locales, in UTC by default.
    assert.deepEqual(await run(pool, `return [
      new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(1234.5),
      (1234567.891).toLocaleString(),
      new Date(0).toLocaleString("en-US"),
      new Intl.DateTimeFormat("ja-JP", { dateStyle: "full", timeZone: "Asia/Tokyo" }).format(new Date(0)),
      ["z", "ä", "a"].sort(new Intl.Collator("de").compare),
      "I".toLocaleLowerCase("tr"),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      new Intl.PluralRules("en", { type: "ordinal" }).select(2),
    ]`), ["1.234,50 €", "1,234,567.891", "1/1/1970, 12:00:00 AM", "1970年1月1日木曜日", ["a", "ä", "z"], "ı", "UTC", "two"]);
  });
}

test("TypeScript that makes a backtracking parser take hours strips in linear time", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec();
  t.after(() => pool.close());
  const started = performance.now();
  await assert.rejects(executeCode({ code: `1<2; x = ${"a ? (b): c => ".repeat(30)}d`, bridge: none, pool }), /is not defined/);
  assert.ok(performance.now() - started < 2_000, `${Math.round(performance.now() - started)} ms`);
});

test("built-ins V8 cannot interrupt are killed just past the CPU budget", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec();
  t.after(() => pool.close());
  for (const code of ["return /(a+)+$/.test('a'.repeat(40) + '!')", "while (true) {}"]) {
    const started = performance.now();
    await assert.rejects(executeCode({ code, bridge: none, pool, timeoutMs: 60_000, limits: { cpuMs: 500 } }), /CPU limit exceeded: the execution kept its thread busy for over 500 ms/);
    const took = performance.now() - started;
    assert.ok(took >= 500 && took < 1_500, `${code}: ${Math.round(took)} ms`);
  }
});

test("memory: the heap is capped (the execution ends), ArrayBuffers are capped (a catchable RangeError)", { skip, timeout: 30_000 }, async t => {
  const pool = new V8Exec();
  t.after(() => pool.close());
  // CPU to spare: on a slow machine, filling the heap takes longer than the default 2 s budget.
  await assert.rejects(executeCode({ code: "const a = []; for (;;) a.push({ x: Math.random(), y: [1, 2, 3] })", bridge: none, pool, limits: { cpuMs: 30_000 } }), /Codemode memory limit exceeded/);
  // One allocation past all the heap there is: V8 would abort; the process answers as at the limit.
  await assert.rejects(executeCode({ code: "return new Array(1e9).fill(0).length", bridge: none, pool, limits: { cpuMs: 30_000 } }), /Codemode memory limit exceeded/);
  const [count, error] = await run(pool, "const a = []; try { for (;;) a.push(new Uint8Array(1 << 20)); } catch (error) { return [a.length, String(error)]; }");
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
  await assert.rejects(running, /Codemode sandbox process exited \(SIGKILL/);
  assert.deepEqual((await executeCode({ code: "return 1", bridge: none, pool })).output, ["1"]);
});

test("a binary that cannot be started fails the execution clearly", { skip, timeout: 30_000 }, async () => {
  const pool = new V8Exec({ binary: "/nonexistent/v8-exec" });
  await assert.rejects(executeCode({ code: "return 1", bridge: none, pool }), /Codemode sandbox process could not start \(ENOENT\)/);
  assert.equal(pool.running, 0);
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
  for (let i = 0; i < 5; i++) assert.equal(await run(pool, "globalThis.n = (globalThis.n ?? 0) + 1; return n"), 1, "Nothing carries over");
});

/** Runs the binary with a test hook and a `return 1` execution; resolves with how it ended. */
function hooked(...args: string[]) {
  const child = spawn(v8ExecBinary(), ["--jitless", "--max-data-mb", "512", ...args], { stdio: ["pipe", "pipe", "ignore"] });
  const replies: unknown[] = [];
  const write = frames(child.stdout as Socket, message => replies.push(message), undefined, child.stdin as Socket);
  write({ type: "request", id: "x", method: "execute", params: { code: "return 1", tools: [], timeoutMs: 10_000, maxOutputCharacters: 100, cpuMs: 1_000 } });
  return new Promise<{ signal: string | null; replies: unknown[] }>(resolve => child.once("close", (_code, signal) => resolve({ signal, replies })));
}

test("seccomp: a system call outside the allowlist, or executable memory under --jitless, kills the process", { skip: linux, timeout: 30_000 }, async () => {
  assert.deepEqual(await hooked("--test-forbidden-syscall"), { signal: "SIGSYS", replies: [] });
  assert.deepEqual(await hooked("--test-exec-memory"), { signal: "SIGSYS", replies: [] });
  // Without the hooks, the same process runs.
  const ran = await hooked();
  assert.equal(ran.signal, null);
  assert.deepEqual((ran.replies.at(-1) as { result: { output: string[] } }).result.output, ["1"]);
});

test("seccomp: the parent reports a process the filter killed as such", { skip: linux, timeout: 30_000 }, async t => {
  const pool = new V8Exec();
  (pool.args as string[]).push("--test-forbidden-syscall");
  t.after(() => pool.close());
  await assert.rejects(executeCode({ code: "return 1", bridge: none, pool }), /Codemode sandbox process exited \(SIGSYS: a system call outside its seccomp allowlist\)/);
});
