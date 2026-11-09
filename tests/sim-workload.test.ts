import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePlan } from "./sim/workload.ts";
import { runPlan } from "./sim/run.ts";

// Generated workloads in the simulator (npm run sim runs many more): clients making agents, prompting and watching them
// across nodes while the run's faults happen (crashes and restarts, deploys, partitions, database outages, aborts,
// BUGGIFY, clock skew), then recovery; then the checkers: every accepted run ends once (I3), one executor per agent
// outside faults (I1), watchers' event ids are never reused (I8), nothing runs after an abort (I9), no assertion
// violated, no real I/O.

for (const seed of ["1", "2", "3", "4", "5", "6"]) {
  test(`seed ${seed}: the checkers find nothing`, async () => {
    const result = await runPlan(generatePlan(seed));
    assert.deepEqual(result.failures, [], `npm run sim -- --seed ${seed}`);
    assert.ok(result.served > 0);
  });
}
