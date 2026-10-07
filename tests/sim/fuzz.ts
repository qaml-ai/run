import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Coverage, hash } from "./coverage.ts";
import { prng } from "./env.ts";
import { minimize } from "./minimize.ts";
import { branch, mutate } from "./mutate.ts";
import { runPlan, type RunResult } from "./run.ts";
import { generatePlan, type Plan } from "./workload.ts";

/** A plan the corpus keeps: what it covered, when it was found and how it was made. */
export type Entry = { plan: Plan; features: number[]; goals: string[]; found: number; worker: number; how: string[]; adds: number; behaviours?: number };

export type FuzzOptions = {
  /** When the whole fuzzing run began (epoch ms), and when it stops starting runs. */
  startedAt: number;
  until: number;
  /** Where kept plans go (shared by every worker, which picks up the others' as it goes), and failures. */
  corpus: string;
  failures: string;
  /** Committed plans to begin from when the corpus is empty. */
  seeds?: string;
  worker?: number;
  /** Random plans only, no corpus to draw on: the baseline the fuzzer is measured against (it still keeps what is new, to compare). */
  random?: boolean;
  /** Cut each new failure down to the steps it needs. */
  minimizeFailures?: boolean;
  /** Coverage already started in this process (V8 keeps one count per process): it is shared, not started again. */
  coverage?: Coverage;
  say?: (line: string) => void;
};

/**
 * A failure's kind, for deduplication: its checker and its text with the numbers and ids taken out (`I11: fork N of
 * agent-N lacks run-N, ...`); for an exception, its message and the first frame in the runtime's or simulator's code.
 */
export function failureSignature(failure: string, error?: Error) {
  const [, checker = "", rest = failure] = /^(I\d+:)?([\s\S]*)$/.exec(failure) ?? [];
  const text = (checker + rest.replace(/client_[0-9a-f]+|vol_[0-9a-f]+/g, "X").replace(/\d+/g, "N")).slice(0, 160);
  if (!error) return text;
  const frame = error.stack?.split("\n").find(line => /\/(src|shared|tests\/sim)\//.test(line))?.trim().replace(/:\d+:\d+\)?$/, "").replace(/^at .*\((.*)$/, "$1") ?? "";
  return `${text} @ ${frame.split("/").slice(-2).join("/")}`;
}

/** Features of a run beyond its blocks: each coverage goal it reached, and how often each assertion was passed (coarsely). */
function assertionFeatures(result: RunResult) {
  const features = new Set<number>();
  for (const goal of result.reached) features.add(hash(`goal:${goal}`));
  // A path an ownership race took (an acquire that took nothing, a renewal that found its heartbeat gone): seen at all.
  for (const outcome of Object.keys(result.ownership ?? {})) features.add(hash(`ownership:${outcome}`));
  for (const [message, { hits, held }] of Object.entries(result.checked)) {
    features.add(hash(`assert:${message}:${hits === 1 ? 1 : hits < 8 ? 2 : 3}`));
    if (held) features.add(hash(`held:${message}`));
  }
  return features;
}

const read = <T>(file: string): T | undefined => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };

/**
 * One fuzzing worker: run plans until `until`, keeping each that covers something no kept plan did (a block, a block
 * run more often, an assertion passed more often, a goal reached). Its next plans are mostly mutations of kept ones
 * (see mutate.ts), some prefix branches, and now and then a fresh random one. Workers share the corpus directory and
 * pick up each other's plans as they go. Each new kind of failure is saved once (by `failureSignature`, claimed by file
 * so two workers never both do it) and minimized.
 */
export async function fuzz(options: FuzzOptions) {
  const say = options.say ?? (line => process.stderr.write(`${line}\n`));
  const worker = options.worker ?? 0;
  mkdirSync(options.corpus, { recursive: true });
  mkdirSync(options.failures, { recursive: true });
  const random = prng(`fuzz:${options.startedAt}:${worker}`);
  const coverage = options.coverage ?? new Coverage();
  if (!options.coverage) await coverage.start();
  const seen = new Set<number>();
  const goals = new Set<string>();
  const corpus: { name: string; entry: Entry }[] = [];
  const known = new Set<string>();
  const sync = () => {
    for (const name of readdirSync(options.corpus).filter(name => name.endsWith(".json") && !known.has(name))) {
      const entry = read<Entry>(join(options.corpus, name));
      if (!entry) continue;
      known.add(name);
      for (const feature of entry.features) seen.add(feature);
      for (const goal of entry.goals) goals.add(goal);
      corpus.push({ name, entry });
    }
  };
  sync();
  let runs = 0, kept = 0, failed = 0;
  const elapsed = () => Date.now() - options.startedAt;

  const evaluate = async (plan: Plan, how: string[]) => {
    let result: RunResult | undefined, error: Error | undefined;
    try { result = await runPlan(plan); }
    catch (thrown) { error = thrown as Error; }
    const features = await coverage.take();
    runs++;
    const behaviour = result ? assertionFeatures(result) : new Set<number>();
    for (const feature of behaviour) features.add(feature);
    const failures = result?.failures ?? [`run: ${error?.message ?? error}`];
    if (failures.length) await failure(plan, result, failures, error);
    const fresh = [...features].filter(feature => !seen.has(feature));
    const newGoals = (result?.reached ?? []).filter(goal => !goals.has(goal));
    if (!fresh.length) return;
    for (const feature of fresh) seen.add(feature);
    for (const goal of newGoals) { goals.add(goal); say(JSON.stringify({ t: Math.round(elapsed() / 1000), worker, goal })); }
    // What it added beyond blocks: an assertion passed more often, held for the first time, a goal reached.
    const behaviours = [...behaviour].filter(feature => fresh.includes(feature)).length;
    const entry: Entry = { plan, features: [...features], goals: result?.reached ?? [], found: elapsed(), worker, how, adds: fresh.length, behaviours };
    const name = `${hash(JSON.stringify(plan)).toString(16).padStart(8, "0")}.json`;
    writeFileSync(join(options.corpus, name), JSON.stringify(entry));
    known.add(name);
    corpus.push({ name, entry });
    kept++;
  };

  const failure = async (plan: Plan, result: RunResult | undefined, failures: string[], error?: Error) => {
    failed++;
    const signature = failureSignature(failures[0], error);
    const file = join(options.failures, `${hash(signature).toString(16).padStart(8, "0")}.json`);
    // Claimed by creating the file: another worker that found it first already saved (and is minimizing) it.
    try { writeFileSync(file, JSON.stringify({ signature, found: elapsed(), worker, ...result ?? { plan, failures, error: error?.stack } }, null, 2), { flag: "wx" }); }
    catch { return; }
    say(JSON.stringify({ t: Math.round(elapsed() / 1000), worker, failure: signature, file }));
    if (!options.minimizeFailures || !result) return;
    try {
      const smaller = await minimize(plan, async candidate => (await runPlan(candidate).catch(thrown => ({ failures: [`run: ${(thrown as Error).message}`] }))).failures);
      const again = await runPlan(smaller);
      writeFileSync(file.replace(/\.json$/, ".min.json"), JSON.stringify({ signature, ...again }, null, 2));
      say(JSON.stringify({ t: Math.round(elapsed() / 1000), worker, minimized: file, steps: smaller.steps.length }));
    } catch (thrown) { say(JSON.stringify({ worker, minimizeFailed: file, error: String(thrown) })); }
    // What minimizing ran is not a fuzzing run's coverage.
    await coverage.take();
  };

  // An empty corpus begins from the committed seed plans.
  if (!corpus.length && !options.random && options.seeds) {
    for (const name of readdirSync(options.seeds).filter(name => name.endsWith(".json")).sort()) {
      const plan = read<{ plan?: Plan } & Plan>(join(options.seeds, name));
      if (plan) await evaluate(plan.plan ?? plan, ["seed"]);
    }
  }
  let lastReport = Date.now();
  while (Date.now() < options.until) {
    if (runs % 20 === 0) sync();
    let plan: Plan, how: string[];
    const roll = random.float();
    if (options.random || !corpus.length || roll < 0.2) {
      plan = generatePlan(`f${options.startedAt}-${worker}-${runs}`);
      how = ["fresh"];
    } else {
      // Plans that added behaviour (an assertion or goal: weighted well above blocks), newer ones, and ones that reached a
      // goal few plans reach are drawn more often.
      const reaching = new Map<string, number>();
      for (const { entry } of corpus) for (const goal of entry.goals) reaching.set(goal, (reaching.get(goal) ?? 0) + 1);
      const weights = corpus.map(({ entry }, index) => 1 + 0.5 * Math.log2(1 + entry.adds) + 4 * (entry.behaviours ?? 0) + (index >= corpus.length - 20 ? 1 : 0) + (entry.goals.some(goal => reaching.get(goal)! <= 3) ? 8 : 0));
      let pick = random.float() * weights.reduce((a, b) => a + b, 0), chosen = 0;
      while ((pick -= weights[chosen]) > 0 && chosen < corpus.length - 1) chosen++;
      const parent = corpus[chosen].entry.plan;
      if (roll < 0.4) { plan = branch(parent, random); how = ["branch"]; }
      else {
        const other = random.float() < 0.2 ? corpus[random.int(corpus.length)].entry.plan : undefined;
        ({ plan, how } = mutate(parent, random, other));
      }
    }
    await evaluate(plan, how);
    if (Date.now() - lastReport >= 60_000) {
      lastReport = Date.now();
      say(JSON.stringify({ t: Math.round(elapsed() / 1000), worker, runs, kept, corpus: corpus.length, features: seen.size, goals: goals.size, failed }));
    }
  }
  if (!options.coverage) await coverage.stop();
  const summary = { worker, runs, kept, corpus: corpus.length, features: seen.size, goals: goals.size, failed };
  say(JSON.stringify(summary));
  return summary;
}

/** What a corpus directory adds up to: features, goals and when each was first reached (s), for reports and benchmarks. */
export function corpusReport(dir: string, failures?: string) {
  const features = new Set<number>();
  const firstReached = new Map<string, number>();
  let entries = 0;
  for (const name of readdirSync(dir).filter(name => name.endsWith(".json"))) {
    const entry = read<Entry>(join(dir, name));
    if (!entry) continue;
    entries++;
    for (const feature of entry.features) features.add(feature);
    for (const goal of entry.goals) firstReached.set(goal, Math.min(firstReached.get(goal) ?? Infinity, Math.round(entry.found / 1000)));
  }
  const found = failures ? readdirSync(failures).filter(name => /^[0-9a-f]{8}\.json$/.test(name)).map(name => read<{ signature: string; found: number }>(join(failures, name))).filter(Boolean) : [];
  return {
    entries, features: features.size, goals: firstReached.size,
    firstReached: Object.fromEntries([...firstReached].sort((a, b) => a[1] - b[1])),
    failures: found.map(failure => ({ signature: failure!.signature, t: Math.round(failure!.found / 1000) })),
  };
}
