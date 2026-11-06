import test from "node:test";
import assert from "node:assert/strict";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import { serveCodemodeRemote, type CodemodeHostCall, type CodemodeOutcome } from "@earendil-works/pi-codemode/portable";
import { SessionCodemodeSandbox, endScript, waitsOnPerson } from "../codemode/sandbox.ts";
import { boundedExchange, SANDBOX_INTERRUPT_BUDGET } from "../codemode/limits.ts";

/** A durable run as Pi's code mode drives it: every call answered by `answer`, results numbered in delivery order. */
async function host(code: string, answer: (call: CodemodeHostCall) => Promise<CodemodeOutcome> | CodemodeOutcome, options: { timeoutMs?: number; seed?: number; deadlineMs?: number } = {}) {
  const wasm = await loadQuickJSWasm();
  let vms = 0;
  const sandbox = new SessionCodemodeSandbox({
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    remote: () => ({ execute: (request, exchange) => { vms++; return serveCodemodeRemote(request, boundedExchange(exchange), { wasm, maxInterruptBudget: SANDBOX_INTERRUPT_BUDGET }); } }),
  });
  const calls: CodemodeHostCall[] = [], idle: number[] = [];
  let seq = 0;
  const seed = options.seed ?? Math.floor(Math.random() * 1e9);
  const run = sandbox.start(code, {
    startedAt: 1_000, seed, tools: ["read", "approve", "delegate", "slow"].map(name => ({ name })),
    ...(options.deadlineMs ? { timeoutMs: options.deadlineMs } : {}),
    onCall: call => {
      calls.push(call);
      void Promise.resolve(answer(call)).then(outcome => { if (!run.finished) run.deliver(++seq, 1_000 + seq, call.id, outcome); });
    },
    onIdle: processed => idle.push(processed),
  });
  return { run, calls, idle, seed, vms: () => vms, close: () => sandbox.close() };
}

test("a script waiting only on a person stops its VM, and the next VM replays to where it was without making a call twice", { timeout: 20_000 }, async () => {
  let release: (() => void) | undefined, answered!: (outcome: CodemodeOutcome) => void;
  const seed = 4242;
  const h = await host("const a = await tools.read({}); console.log('after read'); const b = await tools.approve({ id: 1 }); return [a, b, await tools.read({ again: true })];", call => {
    if (call.name !== "approve") return { ok: true, value: call.args && (call.args as { again?: boolean }).again ? "r2" : "r1" };
    release = waitsOnPerson(1_000, seed, call.id);
    return new Promise<CodemodeOutcome>(resolve => { answered = resolve; });
  }, { seed });
  try {
    while (!release) await new Promise(resolve => setTimeout(resolve, 10));
    // Parked: the VM it ran on has stopped, and nothing is running.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(h.vms(), 1);
    assert.equal(h.run.finished, false);
    release();
    answered({ ok: true, value: "approved" });
    const result = await h.run.result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(result.ok && result.value, ["r1", "approved", "r2"]);
    assert.equal(h.vms(), 2, "a second VM replayed the script");
    assert.deepEqual(h.calls.map(call => [call.id, call.name]), [[1, "read"], [2, "approve"], [3, "read"]], "Pi saw each call once");
    assert.deepEqual(h.idle, [...new Set(h.idle)].sort((a, b) => a - b), "each result is acknowledged once, in order");
    assert.equal(result.output.filter(item => item.type === "text" && item.text === "after read").length, 1, "the replayed output is the script's, once");
  } finally { await h.close(); }
});

test("a sub-agent's or a person's wait is off the script's clock; any other call's is on it", { timeout: 20_000 }, async () => {
  const later = (ms: number, value: unknown) => new Promise<CodemodeOutcome>(resolve => setTimeout(() => resolve({ ok: true, value }), ms));
  const waited = await host("return await tools.delegate({})", () => later(800, "child done"), { timeoutMs: 300 });
  try {
    const result = await waited.run.result;
    assert.deepEqual(result.ok && result.value, "child done");
  } finally { await waited.close(); }
  const slow = await host("return await tools.slow({})", () => later(800, "late"), { timeoutMs: 300 });
  try {
    const result = await slow.run.result;
    assert.equal(!result.ok && result.error.kind, "timeout");
  } finally { await slow.close(); }
  // A script's own timeout_ms (Pi's deadline) counts every wait, a person's too.
  const seed = 99;
  const own = await host("return await tools.approve({})", call => { waitsOnPerson(1_000, seed, call.id); return later(800, "approved"); }, { seed, deadlineMs: 300 });
  try {
    const result = await own.run.result;
    assert.equal(!result.ok && result.error.kind, "timeout");
  } finally { await own.close(); }
});

test("an input closed without an answer ends its script there, the call unmade", { timeout: 20_000 }, async () => {
  const seed = 7;
  const h = await host("await tools.approve({}); return await tools.read({});", call => {
    if (call.name === "approve") { waitsOnPerson(1_000, seed, call.id); setTimeout(() => endScript(1_000, seed, "closed: superseded"), 100); return new Promise<CodemodeOutcome>(() => {}); }
    return { ok: true, value: "never" };
  }, { seed });
  try {
    const result = await h.run.result;
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.error.kind, "script");
    assert.match(!result.ok ? result.error.message : "", /closed: superseded/);
    assert.deepEqual(h.calls.map(call => call.name), ["approve"]);
  } finally { await h.close(); }
});

test("past 32 calls out at once, a script's calls wait their turn instead of failing", { timeout: 20_000 }, async () => {
  let out = 0, most = 0;
  const h = await host("return (await Promise.all(Array.from({ length: 40 }, (_, i) => tools.delegate({ i })))).length", async () => {
    most = Math.max(most, ++out);
    await new Promise(resolve => setTimeout(resolve, 20));
    out--;
    return { ok: true, value: null };
  });
  try {
    const result = await h.run.result;
    assert.equal(result.ok && result.value, 40, JSON.stringify(result));
    assert.ok(most <= 32, `${most} calls were out at once`);
  } finally { await h.close(); }
});
