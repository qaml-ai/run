import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { WorkflowSandbox } from "../codemode/workflow-protocol.ts";
import { canonicalJson, fnv1a64, gunzip, gzip, QUICKJS_WASI_VERSION, QUICKJS_WASM_SHA256, serveWorkflowStep, WORKFLOW_HEAP_BYTES } from "../codemode/workflow-vm.ts";
import { SANDBOX_HEAP_BYTES } from "../codemode/exchange.ts";
import { WorkflowRunner } from "../src/workflow-runner.ts";
import { harness, PI_QUICKJS, storage, WASM, WASM_BYTES, World } from "./workflow-harness.ts";

const REVIEW = `
phase("plan");
const plan = await agent("plan the work");
log("planned", plan.answer);
phase("review");
const reviews = await parallel(["a.ts", "b.ts", "c.ts"], file => agent("review " + file, { key: "review:" + file }));
await sleep(60);
const deploy = await agent("fail to deploy");
const fix = await agent("fix", { type: "fixer" });
log("fixed");
return { plan: plan.answer, reviews: reviews.map(r => r.answer), deploy, fix: fix.answer, t: now(), r: random(), d: Date.now(), m: Math.random() };`;

async function drive(code: string, options: Parameters<typeof harness>[0] = {}) {
  const h = harness(options);
  h.init({ code });
  await h.wake();
  await h.run();
  return h;
}

test("the pinned QuickJS build is the installed one, and host and guest compute the same keys", async () => {
  assert.equal(createHash("sha256").update(WASM_BYTES).digest("hex"), QUICKJS_WASM_SHA256, "update QUICKJS_WASM_SHA256 with quickjs-wasi");
  assert.equal(PI_QUICKJS("quickjs-wasi/package.json").version, QUICKJS_WASI_VERSION, "the quickjs-wasi pi-codemode bundles");
  assert.equal(WORKFLOW_HEAP_BYTES, SANDBOX_HEAP_BYTES, "a workflow VM takes one of the sandbox's heap slots");
  const h = await drive(`return await agent("a prompt", { type: "reviewer", files: ["x", { b: 1, a: [2, undefined] }] });`);
  assert.equal(h.runner.items().items[0]!.key, `agent:${fnv1a64(canonicalJson({ prompt: "a prompt", type: "reviewer", files: ["x", { b: 1, a: [2, undefined] }] }))}`);
  const reference = (text: string) => {
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < text.length; i++) for (const byte of [text.charCodeAt(i) & 0xff, text.charCodeAt(i) >>> 8]) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
    return hash.toString(16).padStart(16, "0");
  };
  for (const text of ["", "a", "héllo €𝄞", canonicalJson({ z: 1, a: [null, "x"] })]) assert.equal(fnv1a64(text), reference(text));
});

test("a workflow runs its effects, with phases, logs, parallel keys, a timer, a failure as null and its clock", { timeout: 30_000 }, async () => {
  const h = await drive(REVIEW);
  const summary = h.runner.get();
  assert.equal(summary.status, "completed", JSON.stringify(summary));
  const result = summary.result as Record<string, unknown>;
  assert.deepEqual(result.reviews, ["re: review a.ts", "re: review b.ts", "re: review c.ts"]);
  assert.equal(result.deploy, null, "a failed effect gives the script null");
  assert.equal(result.fix, "re: fix");
  assert.equal(result.t, 65_000, "the clock is the step's: the timer fired 60 s after it was set");
  assert.equal(result.d, result.t, "Date.now() is the step's clock too");
  const items = h.runner.items().items;
  assert.deepEqual(items.map(item => [item.kind, item.phase, item.status]), [
    ["agent", "plan", "done"], ["agent", "review", "done"], ["agent", "review", "done"], ["agent", "review", "done"],
    ["sleep", "review", "done"], ["agent", "review", "failed"], ["agent", "review", "done"],
  ]);
  assert.equal(items[5]!.reason, "could not fail to deploy");
  assert.deepEqual(h.runner.logs().map(row => [row.phase, row.text]), [["plan", "planned re: plan the work"], ["review", "fixed"]]);
  assert.equal(h.alarmAt, null, "a finished workflow keeps no alarm");
});

test("a run restored every step ends exactly as one replayed every step, and as one with another build's snapshots", { timeout: 60_000 }, async () => {
  const restored = await drive(REVIEW);
  const replayed = await drive(REVIEW, { snapshotCap: 0 });
  let restores = 0;
  const foreign = await drive(REVIEW, {
    // Every third restore claims another build: the sandbox refuses it and the runner replays.
    rewrite: async request => {
      if (!request.restore || ++restores % 3) return request;
      const raw = await gunzip(request.restore);
      const length = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true);
      const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + length)));
      header.fingerprint = header.fingerprint.replace(/driver \d+/, "driver 0");
      const head = new TextEncoder().encode(JSON.stringify(header)), image = raw.subarray(4 + length);
      const out = new Uint8Array(4 + head.byteLength + image.byteLength);
      new DataView(out.buffer).setUint32(0, head.byteLength, true);
      out.set(head, 4);
      out.set(image, 4 + head.byteLength);
      return { ...request, restore: await gzip(out) };
    },
  });
  const replays = (h: typeof restored) => h.store.db.prepare("SELECT COUNT(*) AS n FROM workflow_steps WHERE replayed = 1").get() as { n: number };
  assert.equal(replays(restored).n, 0, "every step restored");
  assert.ok(replays(replayed).n >= 5, "every later step replayed");
  assert.ok(replayed.runner.events().some(event => event.type === "snapshot_dropped"));
  assert.ok(foreign.runner.events().some(event => event.type === "snapshot_refused" && /cannot restore into/.test(event.data.message)), JSON.stringify(foreign.runner.events()));
  for (const other of [replayed, foreign]) assert.deepEqual(other.snapshot(), restored.snapshot());
});

test("a crash at every step boundary leaves the same workflow, each effect journaled once and started at most twice", { timeout: 600_000 }, async t => {
  const baseline = await drive(REVIEW);
  assert.equal(baseline.crashes, 0);
  // A crash while an ending lands loses it until the alarm's sweep finds it 5 minutes later: the same workflow, at
  // later times. Everything but the times must match.
  const timeless = (shot: ReturnType<typeof baseline.snapshot>) => {
    const { t: _t, d: _d, ...result } = shot.summary.result as Record<string, unknown>;
    return { ...shot, summary: { ...shot.summary, result }, items: shot.items.map(({ issuedAt: _i, endedAt: _e, ...item }) => item) };
  };
  const expected = timeless(baseline.snapshot());
  const where = new Set<string>();
  for (let crashAt = 1; crashAt <= baseline.ops; crashAt++) {
    const run = await drive(REVIEW, { crashAt });
    // Most points kill the process. A failed start, and a failure inside one of the alarm's concerns, is handled instead
    // (recorded, and tried again by a later advance or alarm).
    assert.ok(run.crashed, `crash ${crashAt} fired`);
    assert.ok(run.crashes <= 1, `crash ${crashAt} (${run.crashed})`);
    where.add(run.crashed!);
    assert.deepEqual(timeless(run.snapshot()), expected, `crash ${crashAt} (${run.crashed})`);
    assert.deepEqual([...run.world.starts.keys()].sort(), [...baseline.world.starts.keys()].sort());
    assert.ok([...run.world.starts.values()].every(count => count <= 2));
  }
  assert.deepEqual([...where].sort(), ["executor start", "sandbox after", "sandbox before", "transaction begin", "transaction commit"]);
  t.diagnostic(`${baseline.ops} crash points over ${baseline.runner.get().step} steps`);
});

test("faults end the workflow failed: keys inside parallel, key conflicts, a stalled script, the step budget; a newer journal only pauses it", { timeout: 60_000 }, async () => {
  const unkeyed = await drive(`return await parallel([1, 2], i => agent("review " + i));`);
  assert.deepEqual([unkeyed.runner.get().status, unkeyed.runner.get().pauseReason, unkeyed.runner.get().fault?.code], ["failed", undefined, "key_required"]);
  assert.match(unkeyed.runner.get().fault!.message, /inside parallel\(\) needs an explicit key/);
  assert.equal(unkeyed.runner.items().items.length, 0, "a faulted step journals nothing");
  assert.equal((await drive(`await agent("one", { key: "k" }); return await agent("two", { key: "k" });`)).runner.get().fault?.code, "key_conflict");
  assert.equal((await drive(`await new Promise(() => {});`)).runner.get().fault?.code, "stalled");
  const thrown = (await drive(`await agent("x"); throw new Error("boom");`)).runner.get();
  assert.equal(thrown.status, "failed");
  assert.match(thrown.error!, /boom/);
  assert.equal((await drive(`await agent("x"); let i = 0; while (true) i++;`)).runner.get().fault?.code, "step_budget");

  const h = harness();
  h.init({ code: `await agent("a"); return await agent("b");` });
  await h.wake();
  h.store.db.exec("UPDATE workflow_effects SET version = 3");
  await h.next();
  // A newer runner's rows: not a fault (this node is behind); it pauses and tries again by itself.
  assert.deepEqual([h.runner.get().status, h.runner.get().pauseReason, h.runner.get().fault], ["paused", "journal_version", undefined]);
  assert.ok(h.alarmAt !== null, "armed to try again");
  h.store.db.exec("UPDATE workflow_effects SET version = 2");
  await h.next(); // the alarm: it goes on by itself
  await h.run();
  assert.deepEqual([h.runner.get().status, h.runner.get().result], ["completed", { answer: "re: b", attempt: 1 }]);
});

test("protocol 3 mismatches fail clearly", async () => {
  await assert.rejects(serveWorkflowStep({ protocol: 4 } as never, WASM), /protocol 4 is not 3, the one this sandbox speaks/);
  const old = { step: async () => { throw new TypeError("stub.step is not a function"); } } as unknown as WorkflowSandbox;
  const runner = new WorkflowRunner(storage(), old, new World());
  runner.init({ code: "return 1", seed: 1, startedAt: 1 });
  await assert.rejects(runner.wake(), /does not speak workflow step protocol 3/);
});

test("500 effects end to end, one step per effect", { timeout: 300_000 }, async t => {
  const started = performance.now();
  const h = await drive(`let count = 0; for (let i = 0; i < 500; i++) { const r = await agent("review src/delegation-" + i + ".ts"); if (r.answer) count++; } return count;`);
  const ms = performance.now() - started;
  assert.equal(h.runner.get().status, "completed");
  assert.equal(h.runner.get().result, 500);
  const steps = h.store.db.prepare("SELECT ms, snapshot_bytes, polls, replayed FROM workflow_steps ORDER BY step").all() as { ms: number; snapshot_bytes: number; polls: number; replayed: number }[];
  assert.equal(steps.length, 501);
  assert.ok(steps.every(step => step.replayed === 0));
  const last = steps.at(-2)!;
  const perStep = steps.reduce((sum, step) => sum + step.ms, 0) / steps.length;
  t.diagnostic(`500 effects: ${Math.round(ms)} ms in all, ${perStep.toFixed(1)} ms a step in the runner, last snapshot ${last.snapshot_bytes} bytes, ${Math.max(...steps.map(step => step.polls))} polls at most`);
  assert.ok(last.snapshot_bytes < 512 * 1024, `${last.snapshot_bytes}`);
});

test("a syntax error is a script_error naming the line and column, before a workflow starts and if one runs", { timeout: 30_000 }, async () => {
  const { checkWorkflowScript } = await import("../codemode/workflow-vm.ts");
  assert.deepEqual(await checkWorkflowScript(`const a = 1;\nconst b = "x" "y";`, WASM), { ok: false, message: "SyntaxError at line 2, column 15: expecting ';'", line: 2, column: 15 });
  assert.deepEqual(await checkWorkflowScript(`await agent(;`, WASM), { ok: false, message: "SyntaxError at line 1, column 13: unexpected token in expression: ';'", line: 1, column: 13 });
  assert.deepEqual(await checkWorkflowScript(`return await agent("ok");`, WASM), { ok: true });
  // A script that reaches a step anyway (started before the check) faults as a script error, not a VM crash; a
  // workflow's args line before it does not move the line.
  const h = await drive(`const args = Object.freeze(null);\nlog("x");\nlog("y" "z");`);
  assert.deepEqual([h.runner.get().status, h.runner.get().fault?.code, h.runner.get().fault?.message], ["failed", "script_error", "SyntaxError at line 2, column 9: Unexpected string"]);
});

test("the guest has TextEncoder, TextDecoder and Unicode-safe base64, deterministic across snapshots", { timeout: 30_000 }, async () => {
  const code = `
    const text = "héllo, 世界 🐪";
    const bytes = new TextEncoder().encode(text);
    const before = { length: bytes.length, base64: toBase64(text), fromBytes: toBase64(bytes) };
    await agent("wait", { key: "w" }); // the VM is snapshotted and restored here
    const after = new TextDecoder().decode(bytes);
    return { ...before, after, back: fromBase64(before.base64), raw: Array.from(fromBase64("AAEC/w==", { as: "bytes" })), urlSafe: fromBase64(toBase64("??>>").replace(/\\+/g, "-").replace(/\\//g, "_")), lone: toBase64("\\ud800"), encoding: new TextDecoder("utf8").encoding };`;
  const restored = await drive(code);
  const replayed = await drive(code, { snapshotCap: 0 });
  const expected = Buffer.from("héllo, 世界 🐪", "utf8");
  assert.deepEqual(restored.runner.get().result, {
    length: expected.length, base64: expected.toString("base64"), fromBytes: expected.toString("base64"),
    after: "héllo, 世界 🐪", back: "héllo, 世界 🐪", raw: [0, 1, 2, 255], urlSafe: "??>>", lone: Buffer.from("�").toString("base64"), encoding: "utf-8",
  });
  assert.deepEqual(replayed.runner.get().result, restored.runner.get().result);
  const bad = await drive(`try { fromBase64("!!!"); } catch (error) { return String(error); }`);
  assert.match(String(bad.runner.get().result), /not base64/);
});

test("the script check only compiles: a script that closes its wrapper does not run or hang it; fromBase64 keeps every s", { timeout: 30_000 }, async () => {
  const { checkWorkflowScript } = await import("../codemode/workflow-vm.ts");
  const started = Date.now();
  assert.deepEqual(await checkWorkflowScript(`})(); for (;;) {} ;(async () => {`, WASM), { ok: true }, "valid syntax, and never executed");
  assert.deepEqual(await checkWorkflowScript(`})(); globalThis.ran = 1; while (true) {} ;(async () => {`, WASM), { ok: true });
  assert.ok(Date.now() - started < 5_000, "the check returned at once");
  const h = await drive(`return { sw: fromBase64("sw=="), round: fromBase64(toBase64("ss saas \\u{1F42A}s")), spaced: fromBase64("c3 Nz\\nc3M=") };`);
  assert.deepEqual(h.runner.get().result, { sw: Buffer.from("sw==", "base64").toString(), round: "ss saas \u{1F42A}s", spaced: "sssss" });
});
