import assert from "node:assert/strict";
import { test } from "node:test";
import { requireEcsStopped, runMaintenanceJobs } from "../src/v1-maintenance-election.ts";

test("the replacement runner needs explicit confirmation that old ECS tasks are down", () => {
  assert.throws(() => requireEcsStopped([]), /Stop the old ECS tasks/);
  assert.throws(() => requireEcsStopped(["--ecs-stopped", "--extra"]), /Stop the old ECS tasks/);
  assert.doesNotThrow(() => requireEcsStopped(["--ecs-stopped"]));
});

test("a failed poll retries and shutdown waits for work already started", async () => {
  const stop = new AbortController();
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const failures: string[] = [];
  let polls = 0, checks = 0, closed = false;
  const run = runMaintenanceJobs([{ name: "test", intervalMs: 10, run: async () => {
    if (++polls === 1) throw new Error("transient poll failure");
    started.resolve();
    await finish.promise;
  } }], stop.signal, async () => { checks++; }, name => failures.push(name)).then(() => { closed = true; });
  await started.promise;
  stop.abort();
  assert.equal(closed, false);
  finish.resolve();
  await run;
  assert.equal(closed, true);
  assert.deepEqual([polls, checks, failures], [2, 2, ["test"]]);
});
