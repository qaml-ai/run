import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { createContext, runInContext, constants } from "node:vm";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { num, obj } from "@earendil-works/pi-schema";
import { type CodemodeHostCall, type CodemodeOutcome, type CodemodeRun } from "@earendil-works/pi-codemode";
import { PiV8Sandbox } from "../src/codemode-pi-launcher.ts";
import type { Guest } from "../src/v8-exec.ts";
import { frames } from "../src/sandbox-wire.ts";
import { V8Exec, v8ExecBinary } from "../src/v8-exec.ts";

const { PRELUDE_SOURCE } = await import(new URL("./runtime/prelude-source.js", import.meta.resolve("@earendil-works/pi-codemode/portable")).href) as { PRELUDE_SOURCE: string };
const preludeSha256 = createHash("sha256").update(PRELUDE_SOURCE).digest("hex");

const skip = !existsSync(v8ExecBinary()) && "v8-exec is not built (npm run build:v8-exec)";
const tools = [{ name: "test.echo", jsName: "echo", description: "Echo a value" }];
const defaults = { startedAt: 1700000000000, seed: 7, tools, timeoutMs: 10_000 };
const success = (value: unknown): CodemodeOutcome => ({ ok: true, value });
type Delivery = { seq: number; now: number; id: number; outcome: CodemodeOutcome };

for (const [name, code] of [
  ["sequential", 'const a = await tools.echo("雪\\0"); return await tools.echo({ a, nil: null });'],
  ["parallel", 'return await Promise.all([tools.echo("a"), tools.echo("b")]);'],
  ["race", 'return await Promise.race([tools.echo("a"), tools.echo("b")]);'],
]) {
  test(`Pi start: ${name} records and replays deliveries in reverse arrival order`, { skip }, async t => {
    const pool = new V8Exec();
    const sandbox = new PiV8Sandbox({ pool });
    t.after(async () => { await sandbox.close(); pool.close(); });
    const deliveries: Delivery[] = [];
    async function run(replay: boolean) {
      const calls: CodemodeHostCall[] = [], idle: number[][] = [];
      const sent = new Set<number>();
      let fingerprint = "";
      let execution: CodemodeRun;
      execution = sandbox.start(code, { ...defaults,
        onStarted: value => { fingerprint = value; },
        onCall: call => { assert.ok(fingerprint); calls.push(call); },
        onIdle: (seq, issued) => {
          idle.push([seq, issued]);
          if (!replay) {
            for (const call of calls) if (!deliveries.some(delivery => delivery.id === call.id)) {
              deliveries.push({ seq: deliveries.length + 1, now: defaults.startedAt + 100, id: call.id, outcome: success(call.args) });
            }
          }
          // Send the last available result first; it must not run until earlier seq arrives.
          for (const delivery of [...deliveries].reverse()) if (!sent.has(delivery.seq) && calls.some(call => call.id === delivery.id)) {
            sent.add(delivery.seq);
            execution.deliver(delivery.seq, delivery.now, delivery.id, delivery.outcome);
          }
        },
      });
      const result = await execution.result;
      assert.equal(result.ok, true, JSON.stringify(result));
      return { calls, idle, fingerprint, result: { ...result, calls: result.calls.map(call => ({ ...call, durationMs: 0 })) } };
    }
    const first = await run(false);
    assert.deepEqual(await run(true), first);
    assert.deepEqual(first.calls.map(call => call.id), [1, 2]);
    assert.deepEqual(first.idle[0], [0, 1 + Number(name !== "sequential")]);
    assert.ok(first.result.during);
  });
}

test("Pi start: virtual Date, Intl, random and globals survive a clock rollback", { skip }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  const code = `
    const read = () => [Date.now(), +new Date(), Date(), new Date().getTimezoneOffset(),
      Intl.DateTimeFormat().format(), new Intl.DateTimeFormat().formatToParts(), performance.now(), Math.random(),
      typeof WeakRef, typeof FinalizationRegistry, new Date.constructor('return Date.now()')(),
      +new Date.prototype.constructor(), new Date(0).toISOString()];
    const before = read();
    await tools.echo(null);
    const middle = read();
    await tools.echo(null);
    return [before, middle, read()];`;
  async function run() {
    let execution: CodemodeRun;
    execution = sandbox.start(code, { ...defaults, onCall: call => {
      execution.deliver(call.id, defaults.startedAt + (call.id === 1 ? 500 : -500), call.id, success(null));
    } });
    const result = await execution.result;
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.ok ? result.value as any[] : [];
  }
  const first = await run();
  assert.deepEqual(await run(), first);
  assert.deepEqual(first.map(row => row.slice(0, 2)), [[defaults.startedAt, defaults.startedAt], [defaults.startedAt + 500, defaults.startedAt + 500], [defaults.startedAt + 500, defaults.startedAt + 500]]);
  for (const row of first) assert.deepEqual([row[3], row[8], row[9]], [0, "undefined", "undefined"]);
  assert.deepEqual(first.map(row => row[6]), [0, 500, 500]);
});

test("Pi start: spread globals, store writes, output, null and TypeScript", { skip }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  let execution: CodemodeRun;
  const calls: CodemodeHostCall[] = [];
  execution = sandbox.start(`
    const old: { n: number } = load('old');
    enum Kind { First, Second }
    store('old', undefined); store('new', { n: old.n + Kind.Second });
    text(null); console.log('雪\\0', null);
    image('data:image/png;base64,iVBORw0KGgo=');
    return [await helper.join('a', null, '雪\\0'), ALL_TOOLS, await tools.echo(null)];`, {
    ...defaults, globals: [{ name: "helper.join", spread: true }], store: { old: { n: 1 } },
    onCall: call => { calls.push(call); execution.deliver(call.id, defaults.startedAt, call.id, success(call.args)); },
  });
  const result = await execution.result;
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value, [["a", null, "雪\0"], [{ name: "echo", description: "Echo a value" }], null]);
  assert.deepEqual(result.storeWrites, { set: { new: { n: 2 } }, delete: ["old"] });
  assert.deepEqual(result.output, [
    { type: "text", text: "null" }, { type: "text", text: "雪\0 null", console: true },
    { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
  ]);
  assert.deepEqual(calls.map(call => call.target), ["global", "tool"]);
});

test("Pi start: structured tool errors, script errors, syntax errors, exit and stalled promises", { skip }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  let execution: CodemodeRun;
  execution = sandbox.start(`try { await tools.echo(null); } catch (error) { return [error.message, error.code, error.data, error.name]; }`, {
    ...defaults, onCall: call => execution.deliver(1, defaults.startedAt, call.id, { ok: false, message: "denied", properties: { code: 403, data: null, name: "forged" } }),
  });
  const result = await execution.result;
  assert.ok(result.ok);
  assert.deepEqual(result.value, ["denied", 403, null, "Error"]);
  for (const [code, pattern] of [['throw new TypeError("broken")', /broken/], ["const = ;", /SyntaxError/], ["await new Promise(() => {})", /never settle/]] as const) {
    const result = await sandbox.start(code, { ...defaults, onCall() {} }).result;
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.kind, "script"); assert.match(result.error.message, pattern); }
  }
  const exited = await sandbox.start("text('done'); exit(); throw Error('unreachable');", { ...defaults, onCall() {} }).result;
  assert.equal(exited.ok, true);
  assert.deepEqual(exited.output, [{ type: "text", text: "done" }]);
});

test("Pi start: fingerprint refusal runs no user code; JIT and limits have distinct fingerprints", { skip }, async t => {
  const fingerprints: string[] = [];
  for (const jitless of [true, false]) {
    const pool = new V8Exec({ jitless });
    const sandbox = new PiV8Sandbox({ pool });
    t.after(async () => { await sandbox.close(); pool.close(); });
    await sandbox.start("return 1", { ...defaults, onCall() {}, onStarted: value => fingerprints.push(value) }).result;
  }
  assert.notEqual(fingerprints[0], fingerprints[1]);
  const sandbox = new PiV8Sandbox({ expectedFingerprint: "wrong" });
  t.after(() => sandbox.close());
  let calls = 0;
  const result = await sandbox.start("text('ran'); await tools.echo(1)", { ...defaults, onCall: () => { calls++; } }).result;
  assert.equal(result.ok, false);
  assert.equal(calls, 0);
  assert.deepEqual(result.output, []);
  if (!result.ok) assert.match(result.error.message, /fingerprint mismatch/);
});

test("Pi start: CPU, heap and wall limits still terminate the child", { skip, timeout: 60_000 }, async () => {
  for (const [code, options, pattern] of [
    ["while (true) {}", { cpuMs: 100 }, /CPU limit/],
    ["while (true) await null", { cpuMs: 100 }, /CPU limit/],
    ["return /(a+)+$/.test('a'.repeat(40) + '!')", { cpuMs: 100 }, /CPU limit/],
    ["const a = []; for (;;) a.push({ x: Math.random(), y: [1, 2, 3] })", { cpuMs: 30_000 }, /memory limit/],
    ["await tools.echo(1)", { timeoutMs: 100 }, /exceeded/],
  ] as const) {
    const pool = new V8Exec();
    const sandbox = new PiV8Sandbox({ pool, ...options });
    try {
      const result = await sandbox.start(code, { ...defaults, timeoutMs: 40_000, onCall() {} }).result;
      assert.equal(result.ok, false, code);
      if (!result.ok) assert.match(result.error.message, pattern);
    } finally { await sandbox.close(); pool.close(); }
    assert.equal(pool.running, 0);
  }
});

test("Pi start: output past its limits is left out with a note, and the script still completes", { skip, timeout: 60_000 }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  // A 200 KB PNG as base64, as Pi's image() takes it: the signature, then filler.
  const image = `data:image/png;base64,iVBORw0KGgoA${"A".repeat(200 * 1024)}`;
  const run = (code: string) => sandbox.start(code, { ...defaults, onCall() {} }).result;
  const lines = await run("for (let i = 0; i < 1100; i++) console.log(`line ${i}`); return 'done'");
  assert.equal(lines.ok, true, JSON.stringify(lines).slice(0, 300));
  assert.equal(lines.output.length, 1025);
  assert.match((lines.output.at(-1) as { text: string }).text, /Output stops here: a script prints at most 1,024 times/);
  const long = await run("text('x'.repeat(130 * 1024)); text('after'); return 1");
  assert.equal(long.ok, true);
  const [cut, note] = long.output as { text: string }[];
  assert.equal(long.output.length, 2);
  assert.equal(cut.text.length, 128_000);
  assert.match(note.text, /Output stops here/);
  const images = await run(`for (let i = 0; i < 3; i++) image(${JSON.stringify(image)}); text("shown"); return 1`);
  assert.equal(images.ok, true);
  assert.deepEqual(images.output.map(item => item.type), ["image", "image", "image", "text"]);
  const many = await run(`for (let i = 0; i < 50; i++) image(${JSON.stringify(image)}); return 1`);
  assert.equal(many.ok, true);
  assert.equal(many.output.filter(item => item.type === "image").length, 16);
  assert.match((many.output.at(-1) as { text: string }).text, /Images past 16/);
});

test("Pi start: one message too large for a frame is cut or noted, and a return value too large fails the script, saying so", { skip, timeout: 60_000 }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  const run = (code: string) => sandbox.start(code, { ...defaults, onCall() {} }).result;
  const huge = await run("console.log('x'.repeat(2_500_000)); return 1");
  assert.equal(huge.ok, true, JSON.stringify(huge).slice(0, 300));
  assert.equal((huge.output[0] as { text: string }).text.length, 128_000);
  const image = await run(`image("data:image/png;base64,iVBORw0KGgoA" + "A".repeat(2_200_000)); return 1`);
  assert.equal(image.ok, true, JSON.stringify(image).slice(0, 300));
  assert.match((image.output[0] as { text: string }).text, /image of \d+ base64 characters was left out/);
  const returned = await run("return 'y'.repeat(3_000_000)");
  assert.equal(returned.ok, false);
  if (!returned.ok) { assert.equal(returned.error.kind, "script"); assert.match(returned.error.message, /return value is too large to return/); }
});

test("Pi start: half an emoji in output, a return value or a call's arguments does not break the bridge", { skip }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  let seq = 0;
  const run: CodemodeRun = sandbox.start('const half = "hi \\ud83d"; text(half); console.log(half); const echoed = await tools.echo(half); return [half, echoed];', { ...defaults,
    onCall: call => { run.deliver(++seq, defaults.startedAt + 1, call.id, success(call.args)); } });
  const result = await run.result;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.output.map(item => (item as { text: string }).text), ["hi \ufffd", "hi \ufffd"]);
});

test("Pi start: a script reaching for fs, require, an import or js_exec's tool finders is told what replaced them", { skip }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  const run = (code: string) => sandbox.start(code, { ...defaults, onCall() {} }).result;
  const caught = await run("try { await fs.readFile('/bot/bot.ts', 'utf8'); } catch (error) { return error.message; }");
  assert.equal(caught.ok, true);
  if (caught.ok) assert.match(String(caught.value), /^fs is not defined in codemode: files are the agent's file tools, called as await tools\.read/);
  for (const [finder, global] of [["search", "searchTools"], ["describe", "describeTool"], ["namespaces", "describeNamespace"]]) {
    const result = await run(`try { await tools.${finder}("x"); } catch (error) { return error.message; }`);
    assert.equal(result.ok, true);
    if (result.ok) assert.match(String(result.value), new RegExp(`^tools\\.${finder} is not in codemode: call ${global}\\(`));
  }
  for (const code of ["return require('fs')", "import { readFileSync } from 'fs';\nreturn 1;"]) {
    const result = await run(code);
    assert.equal(result.ok, false, code);
    if (!result.ok) assert.match(result.error.message, /tools\.read\(\{ path \}\)/, code);
  }
});

test("Pi start: a script may declare tools or console of its own, as in js_exec", { skip }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  for (const [code, value] of [
    ["const tools = ALL_TOOLS.length; return tools;", 1],
    ["let console = { log() {} }; console.log('quiet'); return 1;", 1],
    ["'use strict'; const tools = 2; return tools;", 2],
  ] as const) {
    const result = await sandbox.start(code, { ...defaults, onCall() {} }).result;
    assert.equal(result.ok, true, `${code}: ${JSON.stringify(result)}`);
    if (result.ok) assert.deepEqual(result.value, value, code);
  }
});

/** Runs `code` with a delegate and an echo tool, answering each call after `delayMs(name)`; resolves with its result. */
function answering(sandbox: PiV8Sandbox, code: string, delayMs: (name: string) => number) {
  let seq = 0;
  const run: CodemodeRun = sandbox.start(code, { ...defaults, tools: [...tools, { name: "delegate", jsName: "delegate", description: "Delegate" }],
    onCall: call => { setTimeout(() => run.deliver(++seq, defaults.startedAt + 1, call.id, success(call.args)), delayMs(call.name)); } });
  return run.result;
}

test("Pi start: time waiting on delegate is not on the script's clock, and the script holds no code slot meanwhile", { skip, timeout: 60_000 }, async t => {
  // One slot for everything: a second script runs while the first waits on its delegate.
  let holders = 0, most = 0, waiters: (() => void)[] = [];
  const acquireSlot = async () => {
    while (holders >= 1) await new Promise<void>(resolve => waiters.push(resolve));
    most = Math.max(most, ++holders);
    return () => { holders--; waiters.shift()?.(); };
  };
  const ended: string[] = [];
  const first = new PiV8Sandbox({ timeoutMs: 300, acquireSlot, awaits: ["delegate"] }), second = new PiV8Sandbox({ timeoutMs: 300, acquireSlot, awaits: ["delegate"] });
  t.after(async () => { await first.close(); await second.close(); });
  const waiting = answering(first, "return await tools.delegate({ task: 'x' })", () => 800).then(result => { ended.push("first"); return result; });
  await new Promise(resolve => setTimeout(resolve, 100));
  const other = await answering(second, "return await tools.echo(1)", () => 0);
  ended.push("second");
  const result = await waiting;
  assert.equal(other.ok, true, JSON.stringify(other));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(ended, ["second", "first"]);
  assert.equal(most, 1);
  assert.equal(holders, 0);
  // Any other tool's wait is on the clock.
  const slow = await answering(first, "return await tools.echo(1)", () => 800);
  assert.equal(slow.ok, false);
  if (!slow.ok) assert.match(slow.error.message, /exceeded 300 ms/);
});

/** A code slot gate as the node's: `limit` at once per tenant. */
function slots(limit: number) {
  const held = new Map<string, number>(), waiters: (() => void)[] = [];
  const acquire = (tenant: string) => async () => {
    while ((held.get(tenant) ?? 0) >= limit) await new Promise<void>(resolve => waiters.push(resolve));
    held.set(tenant, (held.get(tenant) ?? 0) + 1);
    return () => { held.set(tenant, held.get(tenant)! - 1); for (const wake of waiters.splice(0)) wake(); };
  };
  return { acquire, held };
}

test("Pi start: a script waiting on delegate leaves the pool's processes to others, and its clock starts only with a process", { skip, timeout: 60_000 }, async t => {
  // One process for running scripts: the waiting one is parked outside it, so another runs within its own 500 ms.
  const pool = new V8Exec({ max: 1 });
  const gate = slots(4);
  const waiting = new PiV8Sandbox({ pool, timeoutMs: 500, acquireSlot: gate.acquire("a"), awaits: ["delegate"], tenant: "a" });
  const other = new PiV8Sandbox({ pool, timeoutMs: 500, acquireSlot: gate.acquire("b"), awaits: ["delegate"], tenant: "b" });
  t.after(async () => { await waiting.close(); await other.close(); pool.close(); });
  const parked = answering(waiting, "return await tools.delegate({ task: 'x' })", () => 3_000);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(pool.parked, 1);
  const quick = await answering(other, "return 1", () => 0);
  assert.equal(quick.ok, true, JSON.stringify(quick));
  assert.equal((await parked).ok, true);
  assert.deepEqual({ running: pool.running, parked: pool.parked }, { running: 0, parked: 0 });
});

test("Pi start: past its share of parked processes, a tenant's waiting script keeps its slot and process, and others still run", { skip, timeout: 60_000 }, async t => {
  const pool = new V8Exec({ max: 2, parkedPerTenant: 1 });
  const gate = slots(1);
  const sandbox = (tenant: string) => new PiV8Sandbox({ pool, timeoutMs: 500, acquireSlot: gate.acquire(tenant), awaits: ["delegate"], tenant });
  const [a1, a2, b] = [sandbox("a"), sandbox("a"), sandbox("b")];
  t.after(async () => { await a1.close(); await a2.close(); await b.close(); pool.close(); });
  const first = answering(a1, "return await tools.delegate({})", () => 2_000);
  await new Promise(resolve => setTimeout(resolve, 300));
  const second = answering(a2, "return await tools.delegate({})", () => 2_000);
  await new Promise(resolve => setTimeout(resolve, 300));
  // a's first is parked; its second, past a's share, keeps a's one slot and a process; b runs beside them.
  assert.deepEqual({ parked: pool.parked, running: pool.running, a: gate.held.get("a") }, { parked: 1, running: 1, a: 1 });
  assert.equal((await answering(b, "return 1", () => 0)).ok, true);
  assert.deepEqual([(await first).ok, (await second).ok], [true, true]);
});

test("Pi start: a waiting script refused a parked place gives back its slot, so its children run; its wait counts and says why", { skip, timeout: 60_000 }, async t => {
  // No parked places, one code slot: the parent's child needs that slot to run at all.
  const pool = new V8Exec({ parkedMax: 0 });
  const gate = slots(1);
  const parent = new PiV8Sandbox({ pool, timeoutMs: 5_000, acquireSlot: gate.acquire("a"), awaits: ["delegate"], tenant: "a" });
  const child = new PiV8Sandbox({ pool, timeoutMs: 5_000, acquireSlot: gate.acquire("a"), awaits: ["delegate"], tenant: "a" });
  t.after(async () => { await parent.close(); await child.close(); pool.close(); });
  let seq = 0;
  const run: CodemodeRun = parent.start("return await tools.delegate({})", { ...defaults, tools: [...tools, { name: "delegate", jsName: "delegate", description: "Delegate" }],
    onCall: call => { void answering(child, "return 'child done'", () => 0).then(result => run.deliver(++seq, defaults.startedAt + 1, call.id, success(result.ok ? result.value : null))); } });
  const result = await run.result;
  assert.equal(result.ok, true, JSON.stringify(result));
  if (result.ok) assert.equal(result.value, "child done");
  assert.equal(pool.parked, 0);
  // Its wait is on its clock: past its deadline it ends, saying the node had no room for it.
  const slow = new PiV8Sandbox({ pool, timeoutMs: 300, acquireSlot: gate.acquire("a"), awaits: ["delegate"], tenant: "a" });
  t.after(() => slow.close());
  const timedOut = await answering(slow, "return await tools.delegate({})", () => 800);
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.match(timedOut.error.message, /no room to set a waiting script aside/);
});

test("Pi start: a script holding more memory than a parked place allows waits with its process, its clock running", { skip: skip || (process.platform !== "linux" && "reads /proc"), timeout: 60_000 }, async t => {
  const pool = new V8Exec({ parkedMaxRssMb: 1 });
  const sandbox = new PiV8Sandbox({ pool, timeoutMs: 5_000, awaits: ["delegate"], tenant: "a" });
  t.after(async () => { await sandbox.close(); pool.close(); });
  const waiting = answering(sandbox, "return await tools.delegate({})", () => 500);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual({ parked: pool.parked, running: pool.running }, { parked: 0, running: 1 });
  assert.equal((await waiting).ok, true);
});

test("Pi start: a script waiting on a delegate and on other calls holds its slot and its clock runs", { skip, timeout: 60_000 }, async t => {
  const gate = slots(4);
  const sandbox = new PiV8Sandbox({ timeoutMs: 300, acquireSlot: gate.acquire("a"), awaits: ["delegate"], tenant: "a" });
  t.after(() => sandbox.close());
  const result = await answering(sandbox, "const d = tools.delegate({}); for (let i = 0; i < 5; i++) await tools.echo(i); return await d;", name => name === "delegate" ? 2_000 : 100);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /exceeded 300 ms/);
});

test("Pi start: a script awaits any number of calls at once, 32 out at a time, and the 257th call says the limit", { skip, timeout: 60_000 }, async t => {
  const sandbox = new PiV8Sandbox();
  t.after(() => sandbox.close());
  const many = await answering(sandbox, "return (await Promise.all(Array.from({ length: 100 }, (_, i) => tools.delegate({ i })))).length", () => 5);
  assert.equal(many.ok, true, JSON.stringify(many).slice(0, 300));
  if (many.ok) assert.equal(many.value, 100);
  const over = await answering(sandbox, "return (await Promise.all(Array.from({ length: 257 }, (_, i) => tools.echo(i)))).length", () => 1);
  assert.equal(over.ok, false);
  if (!over.ok) assert.match(over.error.message, /at most 256 tool calls/);
});

// No executable is needed to test the trusted host's validation and shutdown behavior.
function fakePool() {
  let receive!: (message: unknown) => void, close!: (reason: string) => void;
  const sent: any[] = [];
  let ended = 0;
  const guest: Guest = { dispatched: true, send: message => { sent.push(message); }, listen: (message, closed) => { receive = message; close = closed; }, end: () => { ended++; close("closed"); } };
  const pool = { open: () => guest } as V8Exec;
  return { pool, sent, receive: (message: unknown) => receive(message), ended: () => ended };
}

test("Pi launcher sends Pi's exact prelude and SHA-256", async () => {
  const fake = fakePool();
  const sandbox = new PiV8Sandbox({ pool: fake.pool });
  const controller = new AbortController();
  const run = sandbox.start("return 1", { ...defaults, signal: controller.signal, onCall() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.sent[0].method, "pi-start-v1");
  assert.equal(fake.sent[0].params.prelude, PRELUDE_SOURCE);
  assert.equal(fake.sent[0].params.preludeSha256, preludeSha256);
  controller.abort();
  await run.result;
  await sandbox.close();
});

test("Pi launcher rejects malformed frames and never acknowledges a rejected fingerprint", async () => {
  for (const message of [null, { type: "done", ok: true, writes: "[]", during: { seq: 2, issued: 0 } }, { type: "bogus" }, { type: "call", id: 0 }, { type: "idle", seq: 0, issued: 42 }, { type: "output", item: { type: "text", text: 3 } }]) {
    const fake = fakePool();
    const sandbox = new PiV8Sandbox({ pool: fake.pool });
    const run = sandbox.start("return 1", { ...defaults, onCall() {} });
    await new Promise(resolve => setImmediate(resolve));
    fake.receive({ type: "started", fingerprint: "test" });
    fake.receive(message);
    assert.equal((await run.result).ok, false);
    assert.equal(fake.ended(), 1);
    await sandbox.close();
  }
  const fake = fakePool();
  const sandbox = new PiV8Sandbox({ pool: fake.pool });
  const run = sandbox.start("return 1", { ...defaults, onCall() {}, onStarted() { throw new Error("replay mismatch"); } });
  await new Promise(resolve => setImmediate(resolve));
  fake.receive({ type: "started", fingerprint: "test" });
  assert.equal((await run.result).ok, false);
  assert.equal(fake.sent.some(message => message.method === "pi-run-v1"), false);
  await sandbox.close();
});

test("Pi launcher balances slot admission when cancelled while waiting", async () => {
  const fake = fakePool();
  let acquired!: () => void;
  let released = 0;
  const sandbox = new PiV8Sandbox({ pool: fake.pool, acquireSlot: async () => { await new Promise<void>(resolve => { acquired = resolve; }); return () => { released++; }; } });
  const controller = new AbortController();
  const run = sandbox.start("return 1", { ...defaults, signal: controller.signal, onCall() {} });
  controller.abort();
  await run.result;
  acquired();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, 1);
  assert.deepEqual(fake.sent, []);
  await sandbox.close();
});

test("Pi native wire rejects duplicate, missing and malformed delivery metadata", { skip }, async () => {
  for (const params of [
    [{ type: "result", id: 1, ok: true, payload: "null", seq: 2, now: 1 }, { type: "result", id: 1, ok: true, payload: "null", seq: 2, now: 1 }],
    { type: "result", id: 1, ok: true, payload: "null" },
    { type: "result", id: 1, ok: true, payload: "bad-json", seq: 1, now: 1 },
    { type: "result", id: 1, ok: true, payload: "null", seq: 0, now: 1 },
    { type: "result", id: 99, ok: true, payload: "null", seq: 1, now: 1 },
  ]) {
    const child = spawn(v8ExecBinary(), ["--jitless", "--max-data-mb", "512"], { env: {}, stdio: ["pipe", "pipe", "ignore"] });
    const messages: any[] = [];
    const write = frames(child.stdout as Socket, (message: any) => {
      messages.push(message);
      if (message.type === "started") write({ type: "request", id: "pi", method: "pi-run-v1" });
      if (message.type === "idle") for (const reply of Array.isArray(params) ? params : [params]) write({ type: "request", id: "pi", method: "pi-result-v1", params: reply });
    }, undefined, child.stdin as Socket);
    write({ type: "request", id: "pi", method: "pi-start-v1", params: { prelude: PRELUDE_SOURCE, preludeSha256, code: "await tools.echo(null)", tools, globals: [], store: {}, deterministic: { startedAt: 0, seed: 1 }, cpuMs: 1000 } });
    await new Promise(resolve => child.once("close", resolve));
    assert.equal(messages.at(-1)?.type, "crash", JSON.stringify(messages));
    assert.match(messages.at(-1).message, /Malformed|Invalid/);
  }
});

test("Pi execute convenience API uses the V8 launcher, and tells the CPU the script used", { skip }, async t => {
  const ends: { ms: number; cpuMs?: number }[] = [];
  const sandbox = new PiV8Sandbox({ tools: [{ name: "echo", execute: args => args }], onEnd: end => ends.push(end) });
  t.after(() => sandbox.close());
  const result = await sandbox.execute("let x = 0; for (let i = 0; i < 3e7; i++) x += i; return await tools.echo(null)");
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value, null);
  assert.equal(ends.length, 1);
  assert.ok(Number.isSafeInteger(ends[0].cpuMs) && ends[0].cpuMs! > 0 && ends[0].cpuMs! <= ends[0].ms + 5, JSON.stringify(ends));
  // A failed script's end names its error.
  await sandbox.execute("const x = ;");
  await sandbox.execute("return null.x");
  assert.deepEqual(ends.slice(1).map(end => (end as { errorName?: string }).errorName), ["SyntaxError", "TypeError"]);
});

test("Pi start keeps Linux seccomp with and without the JIT", { skip: skip || (process.platform !== "linux" && "seccomp requires Linux") }, async () => {
  for (const [jitless, hook] of [[true, "--test-forbidden-syscall"], [false, "--test-forbidden-syscall"], [true, "--test-exec-memory"]] as const) {
    const pool = new V8Exec({ jitless });
    pool.args.push(hook);
    const sandbox = new PiV8Sandbox({ pool });
    try {
      const result = await sandbox.start("return 1", { ...defaults, onCall() {} }).result;
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.error.message, /SIGSYS/);
    } finally { await sandbox.close(); pool.close(); }
    assert.equal(pool.running, 0);
  }
});

test("Pi aborts and reaps processes queued at capacity", { skip }, async () => {
  const pool = new V8Exec({ max: 1 });
  const sandbox = new PiV8Sandbox({ pool });
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const first = sandbox.start("await tools.echo(1)", { ...defaults, onCall: entered });
  // A first run that fails before its call fails the test instead of waiting forever.
  await Promise.race([waiting, first.result.then(result => assert.fail(JSON.stringify(result)))]);
  const controller = new AbortController();
  const second = sandbox.start("return 1", { ...defaults, signal: controller.signal, onCall() {} });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal((await second.result).ok, false);
  assert.equal(pool.running, 1);
  await sandbox.close();
  assert.equal((await first.result).ok, false);
  assert.equal(pool.running, 0);
  pool.close();
});

test("Pi guest bootstrap smoke test (Node vm only, not native isolation)", async () => {
  const messages: any[] = [];
  const context = createContext(constants.DONT_CONTEXTIFY);
  context.send = (json: string) => messages.push(JSON.parse(json));
  runInContext("delete globalThis.console", context);
  const bootstrap = PRELUDE_SOURCE;
  const glue = readFileSync(new URL("../sandbox/v8-exec/src/pi-glue.js", import.meta.url), "utf8");
  context.data = JSON.stringify({ tools, globals: [], store: {}, deterministic: { startedAt: defaults.startedAt, seed: 7 } });
  runInContext(`globalThis.api = (${glue})(send, (${bootstrap}), data)`, context);
  runInContext(`api[1](async () => { text(Date.now()); return [Date.now(), +new Date(), Intl.DateTimeFormat().format(), typeof WeakRef, await tools.echo(null)]; })`, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages[0].item.text, String(defaults.startedAt));
  assert.deepEqual(messages[1], { type: "call", id: 1, target: "tool", name: "test.echo", args: "null" });
  context.delivery = JSON.stringify({ type: "result", id: 1, seq: 1, now: defaults.startedAt + 1, ok: true, payload: '"雪\\u0000"' });
  runInContext("api[0](delivery)", context);
  await new Promise(resolve => setImmediate(resolve));
  const done = messages.at(-1);
  assert.equal(done.type, "done");
  assert.equal(done.ok, true);
  assert.deepEqual(JSON.parse(done.value).slice(-2), ["undefined", "雪\0"]);
});

test("Pi durable code mode on V8 resumes a script after the Harness reopens, without repeating finished calls", { skip }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-codemode-v8-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runs: number[] = [];
  let blocked!: () => void;
  const reachedSecond = new Promise<void>(resolve => { blocked = resolve; });
  let hold = true;
  const step = defineTool({
    name: "step", description: "One step", parameters: obj({ n: num() }), replay: "safe",
    execute: async (args, _api, context) => {
      runs.push(args.n);
      // The first process is closed while the second call runs.
      if (args.n === 2 && hold) {
        blocked();
        await new Promise((_, reject) => context.abortSignal?.addEventListener("abort", () => reject(new Error("closed"))));
      }
      return { output: [{ type: "text", text: `s${args.n}` }] };
    },
  });
  let seen = "";
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code: "const a = await tools.step({ n: 1 }); const b = await tools.step({ n: 2 }); text([a, b, await tools.step({ n: 3 })]);" }), { stopReason: "toolUse" }),
    request => { seen = JSON.stringify(request.messages.at(-1)); return fauxAssistantMessage("finished"); },
  ]);
  const pool = new V8Exec();
  t.after(() => pool.close());
  async function open() {
    const sandbox = new PiV8Sandbox({ pool });
    const registry = createRegistry();
    registry.install(defineExtension({ name: "steps", tools: [step] }));
    registry.install(createCodemodeExtension({ sandbox, models: false }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), { models, registry }, BACKGROUND_CONTEXT);
    const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: faux.provider.name, modelId: faux.getModel().id } } });
    return { harness, root, sandbox };
  }
  const first = await open();
  await first.root.submit({ type: "input", content: "go", requestId: "go" }, BACKGROUND_CONTEXT);
  await reachedSecond;
  await first.harness.close(BACKGROUND_CONTEXT);
  await first.sandbox.close();
  hold = false;
  const second = await open();
  second.harness.resume();
  const submission = await second.root.submit({ type: "input", content: "go", requestId: "go" }, BACKGROUND_CONTEXT);
  const settled = await submission.wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, "done", JSON.stringify(settled));
  // The model sees the script's output: the results of all three calls.
  assert.match(seen, /s1.*s2.*s3/);
  // Call 1 finished before the close and is not run again; call 2 was cut off and is replay-safe.
  assert.deepEqual(runs, [1, 2, 2, 3]);
  await second.harness.close(BACKGROUND_CONTEXT);
  await second.sandbox.close();
});
