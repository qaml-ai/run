import { test } from "node:test";
import assert from "node:assert/strict";
import { FAULTS, generatePlan } from "./sim/workload.ts";
import { runPlan } from "./sim/run.ts";

// Keep replay and recovery workloads separate from the seed sweep so each file
// stays below the runner's per-file timeout when other suites share the CPU.
test("a plan replays exactly: the same seed, the same trace", async () => {
  const plan = generatePlan("21", { faults: FAULTS });
  const first = await runPlan(plan), second = await runPlan(plan);
  assert.equal(second.hash, first.hash);
  assert.ok(plan.steps.some(step => step.op.op === "crash") || plan.steps.some(step => step.op.op === "partition"));
});

test("pauses of one to ten heartbeats and isolations (peers reap the node on a timed-out probe): one executor per agent holds", async () => {
  for (const seed of ["p1", "p2", "p3"]) {
    const plan = generatePlan(seed, { faults: ["pause", "partition"] });
    const result = await runPlan(plan);
    assert.deepEqual(result.failures, [], `npm run sim -- --replay of generatePlan("${seed}", { faults: ["pause", "partition"] })`);
  }
});

test("agent forks, schedules and volumes under faults: writes read back everywhere (I2), forks hold what they should (I11), schedules fire once (I13)", async () => {
  for (const seed of ["o1", "o2"]) {
    const result = await runPlan(generatePlan(seed, { faults: ["forks", "schedules", "volumes", "crash", "pause", "database"] }));
    assert.deepEqual(result.failures, []);
  }
});
