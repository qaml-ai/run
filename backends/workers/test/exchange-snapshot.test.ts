import test from "node:test";
import assert from "node:assert/strict";
import { SnapshotVm, continuousWorkflow, snapshotWorkflow, type VmMessage } from "./exchange-snapshot.ts";

test("a workflow restored from a snapshot every step ends exactly as one VM that never stopped", { timeout: 60_000 }, async () => {
  for (const keep of [false, true]) {
    const { done, steps } = await snapshotWorkflow(40, [1, 40], keep);
    const continuous = await continuousWorkflow(40, keep);
    assert.equal(done?.type === "done" && done.ok, true, JSON.stringify(done));
    // Same count, and the same Math.random() and Date.now(): the seeded PRNG and the virtual clock survive restores.
    assert.deepEqual(done, continuous);
    assert.ok(steps[1]!.gzipBytes < 512 * 1024, `${steps[1]!.gzipBytes}`);
  }
});

/** Drive `code` to its end, snapshotting and restoring between every two results; answers each call with `answer`. */
async function driveWithRestores(code: string, answer: (call: Extract<VmMessage, { type: "call" }>) => unknown, options: { budget?: number } = {}) {
  const pending: VmMessage[] = [];
  const post = (message: VmMessage) => pending.push(message);
  let vm = await SnapshotVm.start({ code, tools: ["effect"], startedAt: 1_000, seed: 3, budget: options.budget }, post);
  const out: unknown[] = [];
  let seq = 0;
  while (pending.length) {
    const message = pending.shift()!;
    if (message.type === "done") return { done: message, out };
    // Every call the script has out right now, answered in reverse (results arrive in any order; seq fixes it).
    const calls = [message, ...pending.splice(0).filter(m => m.type === "call")] as Extract<VmMessage, { type: "call" }>[];
    for (const call of calls.reverse()) {
      const bytes = vm.snapshot();
      vm.dispose();
      vm = await SnapshotVm.restore(bytes, post, { budget: options.budget });
      vm.deliver({ seq: ++seq, now: 1_000 + seq, id: call.id, ok: true, payload: JSON.stringify(answer(call)) });
    }
  }
  throw new Error("the script neither called nor ended");
}

test("pending promises, Promise.all over effects, closures and the job queue survive a restore", { timeout: 30_000 }, async () => {
  const { done } = await driveWithRestores(`
    let counter = 0;
    const bump = () => ++counter;
    const results = await Promise.all([1, 2, 3].map(i => tools.effect({ key: "p" + i }).then(r => (bump(), r))));
    const after = await tools.effect({ key: "last" });
    return { results, after, counter, random: Math.floor(Math.random() * 1e9), now: Date.now() };`, call => JSON.parse(call.args!).key);
  assert.equal(done.type, "done");
  assert.equal(done.ok, true, JSON.stringify(done));
  const value = JSON.parse((done as { value: string }).value);
  assert.deepEqual(value.results, ["p1", "p2", "p3"]);
  assert.equal(value.after, "last");
  assert.equal(value.counter, 3);
  assert.equal(value.now, 1_004);
});

test("a snapshot refuses a different build, and the poll budget is a step's, not the VM's lifetime's", { timeout: 30_000 }, async () => {
  const pending: VmMessage[] = [];
  const vm = await SnapshotVm.start({ code: "await tools.effect({}); let i = 0; while (true) i++;", tools: ["effect"], startedAt: 1_000, seed: 1, budget: 50 }, m => pending.push(m));
  const bytes = vm.snapshot();
  vm.dispose();
  await assert.rejects(SnapshotVm.restore(bytes, () => {}, { heapBytes: 16 * 1024 * 1024 }), /Snapshot from another build \(.*heap 25165824\), not .*heap 16777216: replay from the journal instead/);
  const restored = await SnapshotVm.restore(bytes, m => pending.push(m), { budget: 50 });
  const call = pending.shift() as Extract<VmMessage, { type: "call" }>;
  assert.throws(() => restored.deliver({ seq: 1, now: 1_001, id: call.id, ok: true, payload: "null" }), /Promise job failed|interrupted/);
  assert.ok(restored.polls > 50 && restored.polls < 60, `${restored.polls}`);
  restored.dispose();
});
