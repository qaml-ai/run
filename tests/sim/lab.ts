import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Coverage, hash } from "./coverage.ts";
import { prng } from "./env.ts";
import { corpusReport, fuzz, type Entry } from "./fuzz.ts";
import { BUGGIFY_SITES, COVERAGE_GOALS } from "./hooks.ts";
import { minimize } from "./minimize.ts";
import { branch } from "./mutate.ts";
import { runPlan, type RunResult } from "./run.ts";
import { generatePlan, type Plan } from "./workload.ts";

/**
 * The simulator as a service, for an agent to drive (tests/sim/mcp.ts serves it over MCP): run plans it writes, seeds
 * and fuzzing sessions; look into any run; cut failures down; keep plans in the corpus. One run at a time, each within
 * caps, every run's leak detector on; what each run covered is measured against everything this lab ran before.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Caps per call: virtual time a plan spans, its steps and nodes, seeds per batch, fuzzing minutes, wall time of a batch. */
export const CAPS = { durationMs: 30 * 60_000, steps: 400, nodes: 5, seeds: 100, fuzzMinutes: 30, batchWallMs: 15 * 60_000, branches: 10 };

const Node = z.string().regex(/^[a-z]$/).describe("a node's name: one letter");
const Count = z.number().int().min(0).max(10_000);
const Op = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), agent: Count, node: Node }).describe("A client makes agent N (Idempotency-Key agent-N: making it again is the same agent)"),
  z.object({ op: z.literal("prompt"), agent: Count, run: Count, node: Node }).describe("A client prompts agent N as run M (Idempotency-Key run-M; each run number once per plan)"),
  z.object({ op: z.literal("abort"), agent: Count, node: Node }).describe("A client stops agent N's runs"),
  z.object({ op: z.literal("watch"), agent: Count, node: Node, forMs: z.number().int().min(1).max(600_000) }).describe("A client watches agent N's events for forMs, resuming after the last event its lane saw"),
  z.object({ op: z.literal("deploy"), node: Node }).describe("The node drains and exits, as a deploy replaces it (restart brings a new process)"),
  z.object({ op: z.literal("pause"), node: Node, ms: z.number().int().min(1).max(600_000) }).describe("The node's process stops for ms (SIGSTOP, a GC pause): its timers and I/O wait, its peers go on"),
  z.object({ op: z.literal("pauseOnDb"), node: Node, ms: z.number().int().min(1).max(600_000), statement: z.string().max(200).optional() }).describe("The node stops for ms as it next hears a database answer (to a statement containing `statement`, case-insensitive, if given: e.g. 'insert into actor_owners', 'from actor_owners o join runtime_nodes', 'update runtime_nodes'): between two statements of one request"),
  z.object({ op: z.literal("isolate"), node: Node }).describe("The node is blackholed from its peers (their probes time out, they reap it) and cut off the database; it still reaches the model and clients. heal ends it"),
  z.object({ op: z.literal("crash"), node: Node }).describe("The node's process dies at once"),
  z.object({ op: z.literal("restart"), node: Node }).describe("A crashed or drained node starts again as a new process"),
  z.object({ op: z.literal("partition"), a: Node, b: z.union([Node, z.literal("db")]), how: z.enum(["refused", "blackhole"]) }).describe("The link from a to b (a node, or db: the database) fails: refused at once, or blackholed (calls hang). heal ends it"),
  z.object({ op: z.literal("heal") }).describe("Every partition and isolation ends"),
  z.object({ op: z.literal("databaseDown"), node: Node }).describe("The node is cut off the database (its connections fail)"),
  z.object({ op: z.literal("databaseUp"), node: Node }).describe("The node reaches the database again"),
  z.object({ op: z.literal("fork"), agent: Count, fork: Count, node: Node }).describe("A client forks agent N (key fork-M); checked by I11"),
  z.object({ op: z.literal("schedule"), agent: Count, schedule: Count, inSeconds: z.number().int().min(1).max(3_600), node: Node }).describe("A client schedules a prompt to agent N inSeconds from now; checked by I13"),
  z.object({ op: z.literal("volume"), volume: Count, node: Node }).describe("A client makes volume N (no Idempotency-Key: make each volume once)"),
  z.object({ op: z.literal("write"), volume: Count, write: Count, node: Node }).describe("A client writes f-M.txt to volume N; checked by I2 and I11"),
  z.object({ op: z.literal("forkVolume"), volume: Count, fork: Count, node: Node }).describe("A client forks volume N; checked by I11"),
]);
export const PlanSchema = z.object({
  seed: z.string().min(1).max(200).describe("Every other draw (model latency per call, BUGGIFY decisions, ids) comes from it"),
  nodes: z.array(Node).min(1).max(CAPS.nodes),
  skews: z.record(z.string(), z.number().int().min(-600_000).max(600_000)).describe("Each node's wall-clock skew, ms (missing: 0)"),
  leaseTtlMs: z.number().int().min(1_000).max(120_000).describe("The ownership lease; a heartbeat is a sixth of it"),
  modelDelayMs: z.tuple([z.number().int().min(0), z.number().int().min(0).max(120_000)]).describe("Each model call's latency, drawn from [min, max] ms"),
  dbLatencyMs: z.tuple([z.number().int().min(0), z.number().int().min(0).max(5_000)]).optional().describe("Each pool query's round trip to the database, drawn from [min, max] ms (missing: none, so a request's statements share one instant and one now())"),
  dbSpikes: z.object({ rate: z.number().min(0).max(1), ms: z.tuple([z.number().int().min(0), z.number().int().min(0).max(30_000)]) }).optional().describe("Now and then (at rate) a query's round trip is drawn from ms instead: a database stall. The tail opens races a steady latency never does"),
  buggify: z.union([z.literal(false), z.literal("swarm"), z.record(z.string(), z.number().min(0).max(1))]).describe("false: none; swarm: a random subset of sites at random rates; or chosen sites and their rates"),
  steps: z.array(z.object({ at: z.number().int().min(0), op: Op })).max(CAPS.steps).describe("Each step at its virtual ms from the start"),
  durationMs: z.number().int().min(1_000).max(CAPS.durationMs).describe("Virtual ms the steps span; then every fault heals, crashed nodes restart, and the run settles and is checked"),
});

export const CHECKERS = {
  I1: "One executor per agent: no agent has model calls on two nodes at once, faults included (a paused node's call does not count while it is stopped and a heartbeat after)",
  I2: "Every acknowledged volume write reads back on every live node",
  I3: "Every accepted run ends, with exactly one outcome, within a bound after recovery (lease, sweep, the agent's queue of model calls)",
  I8: "A watcher's stream only moves forward, and an event id is never two events",
  I9: "No model call for an agent comes after its abort was acknowledged",
  I11: "A fork (agent or volume) holds what was there when it was asked for (a failed run exactly when its source's history has it), and nothing asked for after it was made",
  I13: "A schedule fires once it is due, and its prompt is delivered (once)",
  assertion: "No always() failed and no unreachable() was reached in the runtime's code",
  "real I/O": "Nothing touched the real network, disk or clock (the leak detector)",
  determinism: "With twice: the second run of the plan hashes the same as the first",
};

/** Every always/sometimes/reachable/unreachable point in the runtime's code, where it is. */
function assertionPoints() {
  const points: { kind: string; message: string; file: string; line: number; excerpt: string }[] = [];
  for (const dir of ["src", "shared"]) {
    for (const name of readdirSync(join(ROOT, dir)).filter(name => name.endsWith(".ts"))) {
      const lines = readFileSync(join(ROOT, dir, name), "utf8").split("\n");
      lines.forEach((text, index) => {
        for (const match of text.matchAll(/\b(always|sometimes|reachable|unreachable)\((?:[^;]*?,\s*)?"([^"]+)"\)/g)) {
          points.push({ kind: match[1], message: match[2], file: `${dir}/${name}`, line: index + 1, excerpt: text.trim().slice(0, 200) });
        }
      });
    }
  }
  return points;
}

type Snapshot = Record<string, unknown>;
/** A run this lab made: its plan, result, what it covered, and the cluster as the run left it. */
type Run = { id: string; source: string; plan: Plan; result: Omit<RunResult, "plan">; features: number[]; snapshot: Snapshot; twice?: string };

/** A runPlan inspect hook that keeps the cluster as the run left it in `snapshot`, for `inspect`. */
function capture(plan: Plan, snapshot: Snapshot): NonNullable<Parameters<typeof runPlan>[1]>["inspect"] {
  return async (sim, agents) => {
    // The cluster as the run left it, for `inspect`.
    const node = [...sim.nodes.values()].find(candidate => !candidate.crashed)?.name ?? plan.nodes[0];
    for (const [index, id] of agents) {
      const state = (await sim.call(node, `/v1/agents/${id}/state`)).json;
      const history = (await sim.call(node, `/v1/agents/${id}/history`)).json;
      snapshot[`agent-${index}`] = {
        id,
        requests: (state?.requests ?? []).map((record: any) => ({ id: record.id, state: record.state, method: record.method, began: record.began, resumes: record.resumes, endedAt: record.endedAt, outcome: record.outcome?.error ?? record.outcome?.result?.error ?? (record.outcome ? "ok" : undefined) })),
        busy: state?.busy, activeRun: state?.activeRun, queuedRuns: state?.queuedRuns,
        history: (history?.messages ?? []).map((message: any) => `${message.role}: ${JSON.stringify(message.content ?? "").slice(0, 80)}`),
      };
    }
    for (const [name, query] of [
      ["actor_owners", "select actor, node, epoch from actor_owners order by actor"],
      ["runtime_nodes", "select node, expires_at from runtime_nodes order by node"],
      ["agents", "select id, pending_runs, resume_after, resume_failures from agents order by id"],
    ] as const) snapshot[name] = (await sim.db.query(query).catch(error => ({ rows: [String(error)] }))).rows;
  };
}

const read = <T>(file: string): T | undefined => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
const limited = <T>(items: T[], limit: number) => items.length > limit ? { items: items.slice(0, limit), more: items.length - limit } : { items };

export class SimLab {
  readonly coverage = new Coverage();
  private readonly seen = new Set<number>();
  private readonly held = new Set<string>();
  private readonly runs = new Map<string, Run>();
  private next = 1;
  private queue: Promise<unknown> = Promise.resolve();
  readonly dir: string;
  readonly corpus: string;

  constructor(options: { dir?: string; corpus?: string } = {}) {
    this.dir = options.dir ?? join(ROOT, "sim-mcp");
    this.corpus = options.corpus ?? join(ROOT, "sim-corpus");
    mkdirSync(this.dir, { recursive: true });
  }

  async start() { await this.coverage.start(); }
  async stop() { await this.coverage.stop(); }

  /** One sim at a time: calls wait their turn. */
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.queue.then(work, work);
    this.queue = turn.catch(() => {});
    return turn;
  }

  schema() {
    return { plan: z.toJSONSchema(PlanSchema), caps: CAPS, checkers: CHECKERS, buggifySites: BUGGIFY_SITES, example: generatePlan("example", { steps: 6 }) };
  }

  /** The plan's errors: the schema's, and what it cannot express (names it does not have, numbers used twice). */
  validate(input: unknown): { plan?: Plan; errors: string[] } {
    const parsed = PlanSchema.safeParse(input);
    if (!parsed.success) return { errors: parsed.error.issues.slice(0, 20).map(issue => `${issue.path.join(".")}: ${issue.message}`) };
    const plan = parsed.data as Plan;
    const errors: string[] = [];
    const nodes = new Set(plan.nodes);
    if (nodes.size !== plan.nodes.length) errors.push("nodes: a name is given twice");
    plan.steps.forEach(({ at, op }, index) => {
      if (at > plan.durationMs) errors.push(`steps.${index}.at: past durationMs`);
      for (const node of [("node" in op ? op.node : undefined), ...(op.op === "partition" ? [op.a, op.b === "db" ? undefined : op.b] : [])]) {
        if (node && !nodes.has(node)) errors.push(`steps.${index}.op: node ${node} is not in nodes`);
      }
      if (op.op === "partition" && op.a === op.b) errors.push(`steps.${index}.op: a partition from a node to itself`);
    });
    for (const [kind, key] of [["prompt", "run"], ["fork", "fork"], ["schedule", "schedule"], ["write", "write"], ["forkVolume", "fork"], ["volume", "volume"]] as const) {
      const numbers = plan.steps.filter(step => step.op.op === kind).map(step => (step.op as any)[key]);
      const twice = numbers.filter((number, index) => numbers.indexOf(number) !== index);
      if (twice.length) errors.push(`${kind}: ${key} ${[...new Set(twice)].join(", ")} used twice (each must be unique: a shared number is one request)`);
    }
    if (typeof plan.buggify === "object") for (const site of Object.keys(plan.buggify)) if (!BUGGIFY_SITES.includes(site)) errors.push(`buggify: no site ${site}`);
    return errors.length ? { errors } : { plan, errors };
  }

  /** Run a plan, record it, and say what it found and covered that this lab had not seen. */
  private async execute(plan: Plan, source: string, twice = false) {
    const snapshot: Snapshot = {};
    let result: RunResult;
    try {
      result = await runPlan(plan, { inspect: capture(plan, snapshot) });
    } catch (error) {
      result = { plan, failures: [`run: ${(error as Error).message}`], notes: [], history: [], reached: [], checked: {}, ownership: {}, fired: {}, served: 0, watchedEvents: 0, logs: [], elapsedMs: 0, hash: "", trace: [] };
    }
    const features = await this.coverage.take();
    for (const goal of result.reached) features.add(hash(`goal:${goal}`));
    for (const outcome of Object.keys(result.ownership)) features.add(hash(`ownership:${outcome}`));
    const fresh = [...features].filter(feature => !this.seen.has(feature));
    for (const feature of fresh) this.seen.add(feature);
    const newlyHeld = Object.entries(result.checked).filter(([message, { held }]) => held > 0 && !this.held.has(message)).map(([message]) => message);
    for (const message of newlyHeld) this.held.add(message);
    let again: string | undefined;
    if (twice) {
      // Asked the same at its end, as the first was: those calls are in the trace too.
      const second = await runPlan(plan, { inspect: capture(plan, {}) }).catch(() => undefined);
      await this.coverage.take();
      again = second?.hash;
      if (second && second.hash !== result.hash) result.failures.push(`determinism: the second run hashed ${second.hash.slice(0, 12)}, the first ${result.hash.slice(0, 12)}`);
    }
    const id = `r${this.next++}`;
    const { plan: _plan, ...rest } = result;
    const run: Run = { id, source, plan, result: rest, features: [...features], snapshot, ...(again ? { twice: again } : {}) };
    this.runs.set(id, run);
    // Kept in memory for the latest runs only; every run is on disk for `inspect` and `replay`.
    if (this.runs.size > 10) this.runs.delete(this.runs.keys().next().value!);
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify(run));
    return { run, newCoverage: fresh.length, newlyHeld };
  }

  private run(id: string): Run {
    const run = this.runs.get(id) ?? read<Run>(join(this.dir, `${id}.json`));
    if (!run) throw new Error(`No run ${id}`);
    return run;
  }

  /** A run's answer: compact, with its trace summarized to `lines` lines. */
  private summary({ run, newCoverage, newlyHeld }: Awaited<ReturnType<SimLab["execute"]>>, lines = 30) {
    const { result } = run;
    const trace = result.history.map(event => {
      const op = event.op as any;
      const where = op.node ?? (op.a ? `${op.a}->${op.b}` : "");
      const detail = event.status ?? event.result ?? "";
      return `${event.invoked}ms ${op.op}${op.agent !== undefined ? ` agent-${op.agent}` : ""}${op.run !== undefined ? ` run-${op.run}` : ""} ${where} -> ${detail}${event.ended !== undefined && event.ended !== event.invoked ? ` @${event.ended}ms` : ""}`;
    });
    return {
      runId: run.id, failures: result.failures, notes: result.notes, newGoals: newlyHeld.filter(message => COVERAGE_GOALS.includes(message)),
      newlyHeld: newlyHeld.filter(message => !COVERAGE_GOALS.includes(message)), reached: result.reached, newCoverage, fired: result.fired,
      served: result.served, hash: result.hash.slice(0, 12), elapsedMs: result.elapsedMs, trace: limited(trace, lines),
    };
  }

  runPlan(input: unknown, options: { twice?: boolean; lines?: number } = {}) {
    const { plan, errors } = this.validate(input);
    if (!plan) return Promise.resolve({ errors });
    return this.exclusive(async () => this.summary(await this.execute(plan, "run_plan", options.twice), options.lines));
  }

  /** Generated plans for seeds from..to, within the caps; the runs that failed or covered something new. */
  runSeeds(from: number, to: number) {
    return this.exclusive(async () => {
      const started = Date.now();
      const count = Math.min(to - from + 1, CAPS.seeds);
      const failed: { runId: string; seed: string; failures: string[] }[] = [], interesting: { runId: string; seed: string; newCoverage: number; newGoals: string[] }[] = [];
      let ran = 0;
      for (let seed = from; seed < from + count; seed++) {
        if (Date.now() - started > CAPS.batchWallMs) break;
        const outcome = await this.execute(generatePlan(String(seed)), `seed ${seed}`);
        ran++;
        if (outcome.run.result.failures.length) failed.push({ runId: outcome.run.id, seed: String(seed), failures: outcome.run.result.failures.slice(0, 3) });
        const goals = outcome.newlyHeld.filter(message => COVERAGE_GOALS.includes(message));
        if (outcome.newCoverage > 0 || goals.length) interesting.push({ runId: outcome.run.id, seed: String(seed), newCoverage: outcome.newCoverage, newGoals: goals });
      }
      return { ran, asked: to - from + 1, ...(ran < to - from + 1 ? { stopped: `caps: ${CAPS.seeds} seeds, ${CAPS.batchWallMs / 60_000} minutes` } : {}), seconds: Math.round((Date.now() - started) / 1000), failed, interesting: limited(interesting.sort((a, b) => b.newGoals.length - a.newGoals.length || b.newCoverage - a.newCoverage), 20) };
    });
  }

  /** A fuzzing session in this process, into the corpus; the failures it found, saved under sim-failures/fuzz. */
  fuzz(minutes: number) {
    return this.exclusive(async () => {
      const startedAt = Date.now();
      const failures = join(ROOT, "sim-failures", "fuzz");
      mkdirSync(this.corpus, { recursive: true });
      mkdirSync(failures, { recursive: true });
      const before = new Set(readdirSync(this.corpus).filter(name => name.endsWith(".json")));
      const failedBefore = new Set(readdirSync(failures));
      const summary = await fuzz({
        startedAt, until: startedAt + Math.min(minutes, CAPS.fuzzMinutes) * 60_000, corpus: this.corpus, failures, minimizeFailures: true,
        seeds: join(ROOT, "tests", "sim", "corpus"), coverage: this.coverage, say: () => {},
      });
      const report = corpusReport(this.corpus, failures);
      const added = readdirSync(this.corpus).filter(name => name.endsWith(".json") && !before.has(name)).map(name => ({ name, entry: read<Entry>(join(this.corpus, name)) }))
        .filter(({ entry }) => entry).sort((a, b) => (b.entry!.behaviours ?? 0) - (a.entry!.behaviours ?? 0)).map(({ name, entry }) => ({ corpus: name, goals: entry!.goals.length, behaviours: entry!.behaviours ?? 0, how: entry!.how }));
      // Failures this session found first (others are saved once, by whoever found them first).
      const found = readdirSync(failures).filter(name => /^[0-9a-f]{8}\.json$/.test(name) && !failedBefore.has(name))
        .map(name => ({ file: `sim-failures/fuzz/${name}`, signature: read<{ signature: string }>(join(failures, name))?.signature, minimized: readdirSync(failures).includes(name.replace(".json", ".min.json")) }));
      return { ...summary, goalsInCorpus: report.goals, featuresInCorpus: report.features, failures: limited(found, 20), added: limited(added, 15) };
    });
  }

  /** Slices of a run: its logs (filtered), its history (a range), its trace (filtered), and the cluster as it left it. */
  inspect(runId: string, options: { logs?: string; history?: [number, number]; trace?: string; agent?: number; state?: boolean; plan?: boolean; limit?: number } = {}) {
    const run = this.run(runId);
    const limit = Math.min(options.limit ?? 50, 500);
    const match = (pattern: string) => {
      const regex = pattern.startsWith("/") && pattern.lastIndexOf("/") > 0 ? new RegExp(pattern.slice(1, pattern.lastIndexOf("/")), pattern.slice(pattern.lastIndexOf("/") + 1)) : undefined;
      return (text: string) => regex ? regex.test(text) : text.includes(pattern);
    };
    const answer: Record<string, unknown> = { runId, source: run.source, failures: run.result.failures, steps: run.plan.steps.length };
    if (options.plan) answer.plan = run.plan;
    if (options.logs !== undefined) answer.logs = limited(run.result.logs.filter(log => !log.line.includes("_aws") && match(options.logs!)(`${log.by} ${log.line}`)).map(log => `${log.at} ${log.by} ${log.line.slice(0, 400)}`), limit);
    if (options.history) answer.history = run.result.history.slice(options.history[0], options.history[1]).slice(0, limit).map(event => ({ ...event, detail: JSON.stringify(event.detail ?? null).slice(0, 300) }));
    if (options.trace !== undefined) answer.trace = limited(run.result.trace.filter(match(options.trace)), limit);
    if (options.agent !== undefined) answer.agent = run.snapshot[`agent-${options.agent}`] ?? `no agent-${options.agent} (agents: ${Object.keys(run.snapshot).filter(key => key.startsWith("agent-")).join(", ")})`;
    if (options.state) answer.state = { actor_owners: run.snapshot.actor_owners, runtime_nodes: run.snapshot.runtime_nodes, agents: run.snapshot.agents };
    return answer;
  }

  /** Cut a failing run's plan down to the steps its failure needs; the smaller plan is run and recorded. */
  minimize(runId: string) {
    const run = this.run(runId);
    if (!run.result.failures.length) return Promise.resolve({ error: `${runId} did not fail` });
    return this.exclusive(async () => {
      const smaller = await minimize(run.plan, async candidate => (await runPlan(candidate).catch(error => ({ failures: [`run: ${(error as Error).message}`] }))).failures);
      await this.coverage.take();
      const outcome = await this.execute(smaller, `minimize ${runId}`);
      return { from: runId, steps: [run.plan.steps.length, smaller.steps.length], ...this.summary(outcome) };
    });
  }

  /** Run a plan again: a run's, a corpus entry's, or one in a file (a failure saved by --fuzz or npm run sim). */
  replay(source: { runId?: string; corpus?: string; file?: string }, options: { twice?: boolean } = {}) {
    let plan: Plan | undefined;
    if (source.runId) plan = this.run(source.runId).plan;
    else if (source.corpus) plan = read<Entry>(join(this.corpus, source.corpus.replace(/[^0-9a-zA-Z_.-]/g, "")))?.plan;
    else if (source.file) {
      const path = resolve(ROOT, source.file);
      if (!path.startsWith(ROOT)) return Promise.resolve({ error: "file: within the checkout only" });
      const data = read<{ plan?: Plan } & Plan>(path);
      plan = data?.plan ?? data;
    }
    if (!plan) return Promise.resolve({ error: "nothing to replay: give runId, corpus or file" });
    return this.runPlan(plan, options);
  }

  /** Keep a run's first k steps and draw the rest at random, n times. */
  branch(runId: string, k: number, n: number) {
    const run = this.run(runId);
    return this.exclusive(async () => {
      const random = prng(`branch:${runId}:${k}:${Date.now()}`);
      const outcomes = [];
      for (let index = 0; index < Math.min(n, CAPS.branches); index++) {
        const outcome = await this.execute(branch(run.plan, random, Math.min(k, run.plan.steps.length)), `branch ${runId} k=${k}`);
        outcomes.push({ runId: outcome.run.id, failures: outcome.run.result.failures.slice(0, 3), newCoverage: outcome.newCoverage, newGoals: outcome.newlyHeld.filter(message => COVERAGE_GOALS.includes(message)), reached: outcome.run.result.reached.length });
      }
      return { from: runId, k, runs: outcomes };
    });
  }

  /** Keep a run's plan in the corpus (the fuzzer draws on it), with a note. */
  corpusAdd(runId: string, note: string) {
    const run = this.run(runId);
    mkdirSync(this.corpus, { recursive: true });
    const name = `${hash(JSON.stringify(run.plan)).toString(16).padStart(8, "0")}.json`;
    const entry: Entry & { note: string } = { plan: run.plan, features: run.features, goals: run.result.reached, found: 0, worker: -1, how: ["mcp"], adds: 0, behaviours: 1, note };
    writeFileSync(join(this.corpus, name), JSON.stringify(entry));
    return { corpus: name };
  }

  corpusList(limit = 30) {
    let names: string[] = [];
    try { names = readdirSync(this.corpus).filter(name => name.endsWith(".json")); } catch { /* none yet */ }
    const entries = names.map(name => ({ name, entry: read<Entry & { note?: string }>(join(this.corpus, name)) })).filter(({ entry }) => entry)
      .map(({ name, entry }) => ({ corpus: name, steps: entry!.plan.steps.length, goals: entry!.goals.length, behaviours: entry!.behaviours ?? 0, how: entry!.how.join("+"), ...(entry!.note ? { note: entry!.note } : {}) }))
      .sort((a, b) => b.behaviours - a.behaviours || b.goals - a.goals);
    return { total: entries.length, ...limited(entries, Math.min(limit, 200)) };
  }

  /** Coverage goals and assertion points: where each is, and whether this lab or the corpus reached it. */
  goals(options: { all?: boolean; context?: number } = {}) {
    let inCorpus = new Set<string>();
    try { inCorpus = new Set(Object.keys(corpusReport(this.corpus).firstReached)); } catch { /* no corpus yet */ }
    return assertionPoints().filter(point => options.all || point.kind === "sometimes" || point.kind === "reachable").map(point => {
      const lines = options.context ? readFileSync(join(ROOT, point.file), "utf8").split("\n").slice(Math.max(0, point.line - 1 - options.context), point.line + options.context).join("\n") : point.excerpt;
      return { ...point, excerpt: lines, reachedHere: this.held.has(point.message), reachedInCorpus: inCorpus.has(point.message) };
    });
  }
}
