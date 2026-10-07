// The deterministic simulator (tests/sim): run generated workloads with faults against runtime nodes in this process.
//   npm run sim -- --seeds 1-200            run seeds 1 to 200 (ranges and lists: 1-10,500,900-949)
//   npm run sim -- --seeds 1-200 --jobs 4   the same, in 4 processes
//   npm run sim -- --seed 42 --twice        run one seed twice and check both runs hash the same
//   npm run sim -- --replay sim-failures/42.json    run a saved plan again
//   npm run sim -- --minimize sim-failures/42.json  cut a failing plan down to the steps it needs (sim-failures/42.min.json)
//   npm run sim -- --postgres --seeds 1-20  the nightly mode: a real Postgres server (AGENT_TEST_DATABASE_URL) on the
//                                            machine's clock, for what PGlite's one session cannot show; not deterministic
// A failing run writes <out>/<seed>.json (--out, default sim-failures): its plan as data (replay it as is), its failures,
// history and logs; with --minimize-failures it is also cut down to <seed>.min.json.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generatePlan, type Plan } from "../tests/sim/workload.ts";
import { runPlan } from "../tests/sim/run.ts";
import { COVERAGE_GOALS } from "../tests/sim/hooks.ts";
import { minimize } from "../tests/sim/minimize.ts";

const { values } = parseArgs({
  options: {
    seed: { type: "string" }, seeds: { type: "string" }, replay: { type: "string" }, minimize: { type: "string" }, twice: { type: "boolean" },
    steps: { type: "string" }, jobs: { type: "string" }, out: { type: "string" }, "minimize-failures": { type: "boolean" }, postgres: { type: "boolean" },
  },
});
const out = values.out ?? "sim-failures";
// Read by Sim.create, here and in --jobs' processes.
if (values.postgres) process.env.SIM_DATABASE = "postgres";
const say = (line: string) => process.stderr.write(`${line}\n`);

/** Cut a failing plan down and save it beside the original as <seed>.min.json. */
async function minimizeFile(file: string) {
  const plan: Plan = JSON.parse(readFileSync(file, "utf8")).plan;
  const smaller = await minimize(plan, async candidate => (await runPlan(candidate)).failures, line => say(`  ${line}`));
  const result = await runPlan(smaller);
  const target = file.replace(/\.json$/, ".min.json");
  writeFileSync(target, JSON.stringify(result, null, 2));
  say(JSON.stringify({ minimized: file, steps: smaller.steps.length, failures: result.failures, file: target }));
}

if (values.minimize) {
  await minimizeFile(values.minimize);
  process.exit(0);
}

/** "1-10,500,900-949" as seeds. */
const seeds = (spec: string) => spec.split(",").flatMap(part => {
  const [from, to] = part.split("-").map(Number);
  return Array.from({ length: (to ?? from) - from + 1 }, (_, index) => String(from + index));
});

const jobs = Number(values.jobs ?? 1);
if (jobs > 1 && !values.replay) {
  // Each job runs its share of the seeds as a process of its own; this one adds up what they say.
  const all = seeds(values.seeds ?? values.seed ?? "1");
  const shares = Array.from({ length: jobs }, (_, job) => all.filter((_, index) => index % jobs === job)).filter(share => share.length);
  const skip = new Set(["--jobs", "--seeds", "--seed"]);
  const passed = process.argv.slice(2).filter((arg, index, args) => !skip.has(arg.split("=")[0]) && !skip.has(args[index - 1]));
  const started = performance.now();
  const results = await Promise.all(shares.map(share => new Promise<{ code: number; summary?: { failed: number; neverReached: string[] } }>(resolve => {
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...passed, "--seeds", share.join(",")], { stdio: ["ignore", "ignore", "pipe"] });
    let text = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { process.stderr.write(chunk); text += chunk; });
    child.on("close", code => {
      let summary;
      try { summary = JSON.parse(text.trim().split("\n").at(-1)!); } catch { /* it died before its summary */ }
      resolve({ code: code ?? 1, summary });
    });
  })));
  const never = results.map(result => new Set(result.summary?.neverReached ?? COVERAGE_GOALS)).reduce((a, b) => new Set([...a].filter(goal => b.has(goal))));
  const failed = results.reduce((sum, result) => sum + (result.summary?.failed ?? 1), 0);
  say(JSON.stringify({ runs: all.length, failed, seconds: Math.round((performance.now() - started) / 1000), neverReached: [...never] }));
  process.exit(results.some(result => result.code !== 0) ? 1 : 0);
}

const plans: Plan[] = [];
if (values.replay) plans.push(JSON.parse(readFileSync(values.replay, "utf8")).plan);
else for (const seed of seeds(values.seeds ?? values.seed ?? "1")) plans.push(generatePlan(seed, values.steps ? { steps: Number(values.steps) } : {}));
let failed = 0;
const reached = new Set<string>();
const started = performance.now();
for (const plan of plans) {
  const result = await runPlan(plan);
  const failures = [...result.failures];
  if (values.twice && !values.postgres) {
    const again = await runPlan(plan);
    if (again.hash !== result.hash) failures.push(`determinism: the second run hashed ${again.hash}, the first ${result.hash}`);
  }
  for (const goal of result.reached) reached.add(goal);
  say(JSON.stringify({ seed: plan.seed, nodes: plan.nodes.length, steps: plan.steps.length, served: result.served, watched: result.watchedEvents, fired: result.fired, notes: result.notes, failures, hash: result.hash.slice(0, 12) }));
  if (failures.length) {
    failed++;
    mkdirSync(out, { recursive: true });
    const file = `${out}/${plan.seed}.json`;
    writeFileSync(file, JSON.stringify({ ...result, failures }, null, 2));
    say(`  FAILED seed ${plan.seed}: ${failures[0]}`);
    say(`  rerun:  npm run sim -- --seed ${plan.seed}${values.twice ? " --twice" : ""}`);
    say(`  replay: npm run sim -- --replay ${file}   minimize: npm run sim -- --minimize ${file}`);
    if (values["minimize-failures"]) await minimizeFile(file);
  }
}
say(JSON.stringify({ runs: plans.length, failed, seconds: Math.round((performance.now() - started) / 1000), neverReached: COVERAGE_GOALS.filter(goal => !reached.has(goal)) }));
process.exit(failed ? 1 : 0);
