import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLongPlan, generatePlan, type Plan } from "./sim/workload.ts";
import { normalize } from "./sim/mutate.ts";
import { runPlan } from "./sim/run.ts";

// The simulator's longer fixed plans (sim-workload.test.ts has the generated ones), in a file of their own so each
// file ends well within a test file's time on a loaded CI runner: retries, clock faults and a failover; an object store
// that misbehaves; a month's end of billing, reconciliation and purges.

test("retries with the prompt's key, clock jumps and drift, database errors and a failover: the checkers find nothing", async () => {
  const plan: Plan = {
    seed: "faults-2", nodes: ["a", "b"], leaseTtlMs: 3_000, durationMs: 30_000, skews: { a: 0, b: 2_000 }, modelDelayMs: [50, 2_000], buggify: false,
    drifts: { a: { wall: 0.01, monotonic: 0.001 }, b: { wall: -0.01, monotonic: -0.001 } },
    dbErrors: { rate: 0.02, codes: ["40001", "40P01", "57014", "ECONNRESET"] },
    steps: [
      { at: 0, op: { op: "create", agent: 0, node: "a" } },
      { at: 1_000, op: { op: "prompt", agent: 0, run: 0, node: "a" } },
      // Sent again at once to the other node (the first not yet answered), and again much later.
      { at: 1_010, op: { op: "retry", agent: 0, run: 0, node: "b" } },
      { at: 2_000, op: { op: "prompt", agent: 0, run: 1, node: "b", key: "requestId" } },
      { at: 2_005, op: { op: "retry", agent: 0, run: 1, node: "a" } },
      { at: 4_000, op: { op: "clockJump", node: "b", ms: 9_000 } },
      // Both nodes, with clocks 11 s apart: one forwards to the agent's owner.
      { at: 5_000, op: { op: "prompt", agent: 0, run: 2, node: "b" } },
      { at: 5_100, op: { op: "prompt", agent: 0, run: 5, node: "a" } },
      { at: 8_000, op: { op: "failover", ms: 2_000 } },
      { at: 9_000, op: { op: "prompt", agent: 0, run: 3, node: "a" } },
      { at: 12_000, op: { op: "clockJump", node: "a", ms: -8_000 } },
      { at: 14_000, op: { op: "retry", agent: 0, run: 0, node: "a" } },
      { at: 15_000, op: { op: "prompt", agent: 0, run: 4, node: "b" } },
    ],
  };
  const result = await runPlan(plan);
  assert.deepEqual(result.failures, []);
  assert.ok(result.reached.includes("a request sent again with its id got the first one's record"), result.reached.join(", "));
  assert.ok(result.history.filter(event => event.op.op === "retry").every(event => event.status === undefined || event.status < 300 || event.status >= 500), JSON.stringify(result.history.filter(event => event.op.op === "retry")));
});

test("an object store that is slow, refuses requests, throttles and loses answers: what runs said is kept (I15), writes read back (I2)", async () => {
  const plan: Plan = {
    ...generatePlan("storage-faults", { faults: ["volumes", "forks", "crash"] }),
    storageFaults: { rate: 0.2, kinds: ["slow", "error", "throttle", "lost"], slowMs: [50, 500] },
  };
  const result = await runPlan(plan);
  assert.deepEqual(result.failures, []);
  assert.ok(result.served > 0);
});

test("a long plan across a month's end: charged once a day (I16), reconciled on schedule and metered exactly (I17), deleted and expired agents and a deleted volume purged (I18)", async () => {
  const long = generateLongPlan("long-test", { hours: 3 });
  const faults = new Set(["crash", "restart", "partition", "heal", "databaseDown", "databaseUp", "deleteAgent", "deleteVolume", "create", "volume"]);
  const plan: Plan = {
    ...long, startAt: "2030-01-31T23:00:00Z", buggify: false, nodes: ["a", "b"], skews: { a: 0, b: 0 },
    env: { ...long.env, AGENT_GC_GRACE_MS: "1800000", AGENT_GC_INTERVAL_MS: "1800000" },
    steps: [
      { at: 0, op: { op: "create", agent: 0, node: "a" } },
      { at: 10, op: { op: "create", agent: 1, node: "b" } },
      { at: 20, op: { op: "create", agent: 2, node: "a", ttlSeconds: 1_800 } },
      { at: 100, op: { op: "volume", volume: 0, node: "a" } },
      { at: 110, op: { op: "volume", volume: 1, node: "b" } },
      ...long.steps.filter(step => !faults.has(step.op.op)).map(step => {
        const op = { ...step.op } as any;
        if ("node" in op) op.node = op.node === "c" ? "a" : op.node;
        if ("agent" in op) op.agent %= 3;
        if ("volume" in op) op.volume %= 2;
        return { at: step.at, op };
      }),
      { at: 600_000, op: { op: "deleteAgent", agent: 1, node: "a" } },
      { at: 900_000, op: { op: "deleteVolume", volume: 1, node: "b" } },
    ].sort((a, b) => a.at - b.at),
  };
  const result = await runPlan(normalize(plan));
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.notes, []);
  const charged = result.logs.filter(log => log.line.includes('"storage_charged"')).map(log => JSON.parse(log.line).day);
  assert.deepEqual([...new Set(charged)], ["2030-01-31", "2030-02-01"]);
});
