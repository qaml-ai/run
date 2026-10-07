// The deterministic simulator (tests/sim): run generated workloads with faults against runtime nodes in this process.
//   npm run sim -- --seeds 1-200            run seeds 1 to 200
//   npm run sim -- --seed 42 --twice        run one seed twice and check both runs hash the same
//   npm run sim -- --replay sim-failures/42.json    run a saved plan again
//   npm run sim -- --minimize sim-failures/42.json  cut a failing plan down to the steps it needs (sim-failures/42.min.json)
// A failing run writes sim-failures/<seed>.json: its plan as data (replay it as is), its failures and history.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { generatePlan, type Plan } from "../tests/sim/workload.ts";
import { runPlan } from "../tests/sim/run.ts";
import { COVERAGE_GOALS } from "../tests/sim/hooks.ts";
import { minimize } from "../tests/sim/minimize.ts";

const { values } = parseArgs({ options: { seed: { type: "string" }, seeds: { type: "string" }, replay: { type: "string" }, minimize: { type: "string" }, twice: { type: "boolean" }, steps: { type: "string" } } });
if (values.minimize) {
  const plan: Plan = JSON.parse(readFileSync(values.minimize, "utf8")).plan;
  const smaller = await minimize(plan, async candidate => (await runPlan(candidate)).failures, line => process.stderr.write(`${line}\n`));
  const result = await runPlan(smaller);
  const file = values.minimize.replace(/\.json$/, ".min.json");
  writeFileSync(file, JSON.stringify(result, null, 2));
  process.stderr.write(`${JSON.stringify({ steps: smaller.steps.length, failures: result.failures, file })}\n`);
  process.exit(0);
}
const plans: Plan[] = [];
if (values.replay) plans.push(JSON.parse(readFileSync(values.replay, "utf8")).plan);
else {
  const [from, to] = (values.seeds ?? values.seed ?? "1").split("-").map(Number);
  for (let seed = from; seed <= (to ?? from); seed++) plans.push(generatePlan(String(seed), values.steps ? { steps: Number(values.steps) } : {}));
}
let failed = 0;
const reached = new Set<string>();
const started = performance.now();
for (const plan of plans) {
  const result = await runPlan(plan);
  const failures = [...result.failures];
  if (values.twice) {
    const again = await runPlan(plan);
    if (again.hash !== result.hash) failures.push(`determinism: the second run hashed ${again.hash}, the first ${result.hash}`);
  }
  for (const goal of result.reached) reached.add(goal);
  const summary = { seed: plan.seed, nodes: plan.nodes.length, steps: plan.steps.length, served: result.served, watched: result.watchedEvents, fired: result.fired, notes: result.notes, failures, hash: result.hash.slice(0, 12) };
  process.stderr.write(`${JSON.stringify(summary)}\n`);
  if (failures.length) {
    failed++;
    mkdirSync("sim-failures", { recursive: true });
    writeFileSync(`sim-failures/${plan.seed}.json`, JSON.stringify({ ...result, failures }, null, 2));
    process.stderr.write(`  replay: npm run sim -- --replay sim-failures/${plan.seed}.json\n`);
  }
}
process.stderr.write(`${JSON.stringify({ runs: plans.length, failed, seconds: Math.round((performance.now() - started) / 1000), neverReached: COVERAGE_GOALS.filter(goal => !reached.has(goal)) })}\n`);
process.exit(failed ? 1 : 0);
