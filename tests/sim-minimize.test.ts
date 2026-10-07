import { test } from "node:test";
import assert from "node:assert/strict";
import { minimize } from "./sim/minimize.ts";
import { generatePlan } from "./sim/workload.ts";

test("minimizing keeps only the steps a failure needs", async () => {
  const plan = generatePlan("5", { steps: 60 });
  // A stand-in for a run: it "fails" while the plan still crashes node a and prompts agent 0 after that.
  const needed = (steps: typeof plan.steps) => {
    const crash = steps.findIndex(step => step.op.op === "crash" && step.op.node === "a");
    return crash >= 0 && steps.slice(crash).some(step => step.op.op === "prompt" && step.op.agent === 0);
  };
  const withCrash = { ...plan, steps: [...plan.steps, { at: 1, op: { op: "crash" as const, node: "a" } }, { at: 2, op: { op: "prompt" as const, agent: 0, run: 999, node: "b" } }].sort((x, y) => x.at - y.at) };
  let runs = 0;
  const smaller = await minimize(withCrash, async candidate => { runs++; return needed(candidate.steps) ? ["I3: never ended"] : ["I1: something else"]; });
  assert.ok(needed(smaller.steps));
  assert.equal(smaller.steps.length, 2, JSON.stringify(smaller.steps));
  assert.ok(runs < 200, `${runs} runs`);
});
