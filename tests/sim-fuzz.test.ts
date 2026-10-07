import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prng } from "./sim/env.ts";
import { FAULTS, generatePlan, type Plan } from "./sim/workload.ts";
import { branch, mutate, normalize } from "./sim/mutate.ts";
import { corpusReport, failureSignature, fuzz } from "./sim/fuzz.ts";

// The coverage-guided fuzzer (npm run sim -- --fuzz): plans mutated from a corpus, kept when they cover something new.

/** What every plan a mutation makes must be: steps in order within the run, on its nodes, each request numbered once. */
function valid(plan: Plan) {
  for (let index = 1; index < plan.steps.length; index++) assert.ok(plan.steps[index - 1].at <= plan.steps[index].at);
  for (const { at, op } of plan.steps) {
    assert.ok(at >= 0 && at <= plan.durationMs, `${at}`);
    if ("node" in op) assert.ok(plan.nodes.includes(op.node), JSON.stringify(op));
    if (op.op === "partition") assert.ok(plan.nodes.includes(op.a) && op.a !== op.b && (op.b === "db" || plan.nodes.includes(op.b)), JSON.stringify(op));
  }
  const volumes = plan.steps.filter(step => step.op.op === "volume").map(step => (step.op as any).volume);
  assert.equal(new Set(volumes).size, volumes.length, `volumes made twice: ${volumes}`);
  for (const [kind, key] of [["prompt", "run"], ["fork", "fork"], ["schedule", "schedule"], ["write", "write"], ["forkVolume", "fork"]] as const) {
    const numbers = plan.steps.filter(step => step.op.op === kind).map(step => (step.op as any)[key]);
    assert.equal(new Set(numbers).size, numbers.length, `${kind} numbers repeat: ${numbers}`);
  }
}

test("mutations, splices and prefix branches make plans any run can take", () => {
  const random = prng("mutate-test");
  const plans = [generatePlan("1"), generatePlan("2", { faults: FAULTS }), generatePlan("3", { faults: ["volumes", "forks"] })];
  for (let round = 0; round < 500; round++) {
    const parent = plans[random.int(plans.length)];
    const child = round % 5 === 0 ? branch(parent, random) : mutate(parent, random, plans[random.int(plans.length)]).plan;
    valid(child);
    if (plans.length < 30) plans.push(child);
  }
  // A duplicated prompt is a new run, not a retry of the old one.
  const plan = generatePlan("4");
  valid(normalize({ ...plan, steps: [...plan.steps, ...plan.steps] }));
});

test("a failure's signature is its checker and text without the numbers, plus the first frame for an exception", () => {
  assert.equal(failureSignature("I11: fork 4 of agent-1 lacks run-9, which ended before the fork was asked for"), failureSignature("I11: fork 2 of agent-0 lacks run-12, which ended before the fork was asked for"));
  assert.equal(failureSignature("I3: run-5 (agent-0, run-5) never ended"), "I3: run-N (agent-N, run-N) never ended");
  const error = new Error("boom 42");
  error.stack = `Error: boom 42\n    at f (node:internal/x:1:1)\n    at g (file:///x/src/client-sessions.ts:10:5)`;
  assert.equal(failureSignature("run: boom 42", error), "run: boom N @ src/client-sessions.ts");
});

test("a short fuzzing run keeps the plans that cover something new, and reports what they reached", async t => {
  const dir = mkdtempSync(join(tmpdir(), "sim-fuzz-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const startedAt = Date.now();
  const lines: string[] = [];
  const summary = await fuzz({
    startedAt, until: startedAt + 15_000, corpus: join(dir, "corpus"), failures: join(dir, "failures"),
    seeds: fileURLToPath(new URL("./sim/corpus/", import.meta.url)), say: line => lines.push(line),
  });
  assert.ok(summary.runs >= 6, JSON.stringify(summary));
  assert.ok(summary.kept >= 1 && summary.features > 100, JSON.stringify(summary));
  assert.equal(readdirSync(join(dir, "corpus")).length, summary.corpus);
  const report = corpusReport(join(dir, "corpus"), join(dir, "failures"));
  assert.equal(report.features, summary.features);
  assert.deepEqual(report.failures, [], lines.join("\n"));
});
