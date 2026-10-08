import { prng } from "./env.ts";
import { BUGGIFY_SITES } from "./hooks.ts";
import { generatePlan, type Op, type Plan } from "./workload.ts";

type Random = ReturnType<typeof prng>;

/** Statements a pause at a database answer is aimed at: taking an actor, finding its owner, renewing a heartbeat. */
const OWNERSHIP_STATEMENTS = ["insert into actor_owners", "from actor_owners o join runtime_nodes", "update runtime_nodes", "select node from runtime_nodes"];
type Step = Plan["steps"][number];

/**
 * A plan as any run can take it, after a mutation made it up: steps in time order within the run, and every run, fork,
 * schedule, write and volume fork numbered afresh in that order, so no two share a number (a shared number would be a
 * shared Idempotency-Key, which checkers read as one request). Agents and volumes keep theirs: a step on one never made
 * does nothing. Faults need no pairing: the run heals every fault and restarts every node at its end.
 */
export function normalize(plan: Plan): Plan {
  const steps = plan.steps
    .map(step => ({ at: Math.max(0, Math.min(plan.durationMs, Math.round(step.at))), op: { ...step.op } as Op }))
    .filter(step => step.op.op === "partition" || !("node" in step.op) || plan.nodes.includes(step.op.node))
    .filter(step => step.op.op !== "partition" || (plan.nodes.includes(step.op.a) && (step.op.b === "db" || (plan.nodes.includes(step.op.b) && step.op.b !== step.op.a))))
    .sort((a, b) => a.at - b.at);
  // A volume is made without an Idempotency-Key, so making it again is another volume: only the first counts.
  const made = new Set<number>();
  for (let index = 0; index < steps.length; index++) {
    const op = steps[index].op;
    if (op.op !== "volume") continue;
    if (made.has(op.volume)) steps.splice(index--, 1);
    else made.add(op.volume);
  }
  const next = { run: 0, fork: 0, schedule: 0, write: 0, volumeFork: 0 };
  // A retry names its run by number: it follows its prompt's new number, and one whose prompt is gone goes with it.
  const renumbered = new Map<number, number>();
  for (const { op } of steps) {
    if (op.op === "prompt") { const run = next.run++; if (!renumbered.has(op.run)) renumbered.set(op.run, run); op.run = run; }
    else if (op.op === "fork") op.fork = next.fork++;
    else if (op.op === "schedule") op.schedule = next.schedule++;
    else if (op.op === "write") op.write = next.write++;
    else if (op.op === "forkVolume") op.fork = next.volumeFork++;
  }
  for (let index = 0; index < steps.length; index++) {
    const op = steps[index].op;
    if (op.op !== "retry") continue;
    if (renumbered.has(op.run)) op.run = renumbered.get(op.run)!;
    else steps.splice(index--, 1);
  }
  // A database whose every round trip takes a large part of a heartbeat (a sixth of the lease) keeps every lease stale,
  // so nodes cut every model call they make and no turn ever ends: no production database is that slow next to a
  // 90-second lease. Its steady latency stays under a thirtieth of the lease (spikes, being rare, may go past it).
  const most = Math.floor(plan.leaseTtlMs / 30);
  const dbLatencyMs = plan.dbLatencyMs && plan.dbLatencyMs[1] > most ? [Math.min(plan.dbLatencyMs[0], most), most] as [number, number] : plan.dbLatencyMs;
  return { ...plan, ...(dbLatencyMs ? { dbLatencyMs } : {}), steps };
}

/** How many agents and volumes the plan makes (what its steps can name). */
function counts(plan: Plan) {
  const agents = Math.max(1, ...plan.steps.map(step => step.op.op === "create" ? step.op.agent + 1 : 0));
  const volumes = Math.max(0, ...plan.steps.map(step => step.op.op === "volume" ? step.op.volume + 1 : 0));
  return { agents, volumes };
}

/** A step of any kind, at a random time, naming the plan's nodes, agents and volumes. */
export function randomStep(plan: Plan, random: Random): Step {
  const pick = <T>(items: readonly T[]) => items[random.int(items.length)];
  const { agents, volumes } = counts(plan);
  const node = pick(plan.nodes), agent = random.int(agents), at = random.int(plan.durationMs);
  const heartbeat = Math.floor(plan.leaseTtlMs / 6);
  const ops: (() => Op)[] = [
    () => ({ op: "prompt", agent, run: 0, node }),
    () => ({ op: "prompt", agent, run: 0, node }),
    () => ({ op: "abort", agent, node }),
    () => ({ op: "watch", agent, node, forMs: 1_000 + random.int(20_000) }),
    () => ({ op: "deploy", node }),
    () => ({ op: "pause", node, ms: (1 + random.int(10)) * heartbeat }),
    () => ({ op: "pauseOnDb", node, ms: (1 + random.int(10)) * heartbeat, ...(random.float() < 0.7 ? { statement: pick(OWNERSHIP_STATEMENTS) } : {}) }),
    () => ({ op: "isolate", node }),
    () => ({ op: "crash", node }),
    () => ({ op: "restart", node }),
    () => {
      const b = plan.nodes.filter(other => other !== node);
      return { op: "partition", a: node, b: !b.length || random.float() < 0.3 ? "db" : pick(b), how: random.float() < 0.5 ? "refused" : "blackhole" };
    },
    () => ({ op: "heal" }),
    () => ({ op: "databaseDown", node }),
    () => ({ op: "databaseUp", node }),
    () => ({ op: "fork", agent, fork: 0, node }),
    () => {
      const prompts = plan.steps.filter(step => step.op.op === "prompt");
      const prompt = prompts.length ? prompts[random.int(prompts.length)].op as Extract<Op, { op: "prompt" }> : undefined;
      return prompt ? { op: "retry", agent: prompt.agent, run: prompt.run, node } : { op: "prompt", agent, run: 0, node };
    },
    () => ({ op: "clockJump", node, ms: random.int(20_001) - 10_000 }),
    () => ({ op: "failover", ms: 500 + random.int(plan.leaseTtlMs) }),
    () => ({ op: "schedule", agent, schedule: 0, inSeconds: 1 + random.int(20), node }),
    () => ({ op: "create", agent: random.int(agents + 1), node, ...(random.float() < 0.3 ? { ttlSeconds: 60 * (1 + random.int(30)) } : {}) }),
    () => ({ op: "deleteAgent", agent, node }),
    ...volumes ? [
      () => ({ op: "write", volume: random.int(volumes), write: 0, node }) as Op,
      () => ({ op: "forkVolume", volume: random.int(volumes), fork: 0, node }) as Op,
      () => ({ op: "deleteVolume", volume: random.int(volumes), node }) as Op,
    ] : [() => ({ op: "volume", volume: 0, node }) as Op],
  ];
  return { at, op: pick(ops)() };
}

/** The same step aimed elsewhere: another node, agent, duration or kind of cut. */
function retarget(step: Step, plan: Plan, random: Random): Step {
  const op = { ...step.op } as Op;
  const pick = <T>(items: readonly T[]) => items[random.int(items.length)];
  const { agents } = counts(plan);
  if ("node" in op && random.float() < 0.5) op.node = pick(plan.nodes);
  if ("agent" in op && op.op !== "create" && random.float() < 0.5) op.agent = random.int(agents);
  if (op.op === "pause" || op.op === "pauseOnDb") op.ms = Math.max(1, Math.round(op.ms * (0.25 + random.float() * 3)));
  if (op.op === "pauseOnDb" && random.float() < 0.3) op.statement = random.float() < 0.2 ? undefined : pick(OWNERSHIP_STATEMENTS);
  if (op.op === "watch") op.forMs = 500 + random.int(30_000);
  if (op.op === "schedule") op.inSeconds = 1 + random.int(30);
  if (op.op === "clockJump") op.ms = random.int(20_001) - 10_000;
  if (op.op === "failover") op.ms = 500 + random.int(plan.leaseTtlMs * 2);
  if (op.op === "prompt" && random.float() < 0.3) op.key = op.key ? undefined : "requestId";
  if (op.op === "partition") {
    op.how = op.how === "refused" ? "blackhole" : "refused";
    if (random.float() < 0.5) op.a = pick(plan.nodes);
  }
  return { at: step.at, op };
}

/** A shift in time: small (who goes first within a few ms) or large (another phase of the run). */
const shift = (random: Random) => (random.float() < 0.5 ? 1 + random.int(50) : 100 + random.int(5_000)) * (random.float() < 0.5 ? -1 : 1);

/**
 * The plan's settings: the lease, the model's and the database's latency (and its spikes), a node's skew, the BUGGIFY
 * plan, or the seed (every other draw).
 */
function retune(plan: Plan, random: Random): Plan {
  const pick = <T>(items: readonly T[]) => items[random.int(items.length)];
  switch (random.int(10)) {
    case 6: return { ...plan, drifts: random.float() < 0.2 ? undefined : Object.fromEntries(plan.nodes.map(node => [node, { wall: (random.int(201) - 100) / 10_000, monotonic: (random.int(201) - 100) / 100_000 }])) };
    case 8: return { ...plan, storageFaults: random.float() < 0.2 ? undefined : { rate: pick([0.01, 0.05, 0.2]), kinds: (["slow", "error", "throttle", "lost"] as const).filter(() => random.float() < 0.6).concat(["lost"]), slowMs: [50, pick([500, 2_000, 10_000])] } };
    case 7: return { ...plan, dbErrors: random.float() < 0.2 ? undefined : { rate: pick([0.001, 0.005, 0.02, 0.05]), codes: ["40001", "40P01", "57014", "ECONNRESET"].filter(() => random.float() < 0.6).concat(["ECONNRESET"]) } };
    case 0: return { ...plan, leaseTtlMs: pick([3_000, 6_000, 12_000]) };
    case 4: return { ...plan, dbLatencyMs: random.float() < 0.2 ? undefined : [0, pick([1, 5, 20, 200, 1_000])] };
    case 5: return random.float() < 0.2 ? { ...plan, dbSpikes: undefined } : {
      ...plan, dbLatencyMs: plan.dbLatencyMs ?? [1, 5], dbSpikes: { rate: pick([0.005, 0.01, 0.02, 0.05]), ms: pick([[200, 800], [100, 400], [500, 2_000]] as [number, number][]) },
    };
    case 1: return { ...plan, modelDelayMs: [50, pick([200, 2_000, 8_000, 20_000])] };
    case 2: return { ...plan, skews: { ...plan.skews, [pick(plan.nodes)]: random.int(10_001) - 5_000 } };
    case 3: {
      if (random.float() < 0.3) return { ...plan, buggify: plan.buggify ? false : "swarm" };
      // A few chosen sites at chosen rates: the swarm's draw, made on purpose.
      const sites = Object.fromEntries(Array.from({ length: 1 + random.int(3) }, () => [pick(BUGGIFY_SITES), pick([0.01, 0.05, 0.25, 0.5])]));
      return { ...plan, buggify: typeof plan.buggify === "object" && plan.buggify ? { ...plan.buggify, ...sites } : sites };
    }
    default: return { ...plan, seed: `${plan.seed.split("~")[0]}~${random.int(1 << 30)}` };
  }
}

/**
 * One mutation of `plan`, named for the report: a step inserted, deleted, swapped with another in time, duplicated,
 * shifted or aimed elsewhere; a setting changed; or `other` (another corpus plan) spliced in after a cut.
 */
export function mutateOnce(plan: Plan, random: Random, other?: Plan): { plan: Plan; how: string } {
  const steps = [...plan.steps];
  const index = () => random.int(steps.length);
  const kinds = ["insert", "delete", "swap", "duplicate", "shift", "retarget", "retune", ...other ? ["splice"] : []];
  const how = steps.length ? kinds[random.int(kinds.length)] : "insert";
  switch (how) {
    case "insert": steps.push(randomStep(plan, random)); break;
    case "delete": steps.splice(index(), 1 + random.int(Math.min(3, steps.length))); break;
    case "swap": {
      const a = index(), b = index();
      [steps[a], steps[b]] = [{ ...steps[a], at: steps[b].at }, { ...steps[b], at: steps[a].at }];
      break;
    }
    case "duplicate": { const step = steps[index()]; steps.push({ ...step, at: step.at + shift(random) }); break; }
    case "shift": { const at = index(); steps[at] = { ...steps[at], at: steps[at].at + shift(random) }; break; }
    case "retarget": { const at = index(); steps[at] = retarget(steps[at], plan, random); break; }
    case "retune": return { plan: normalize(retune(plan, random)), how };
    case "splice": {
      // The other plan's steps after a cut, on this plan's nodes, agents and volumes.
      const cut = random.int(plan.durationMs);
      const node = (name: string) => plan.nodes.includes(name) ? name : plan.nodes[name.charCodeAt(0) % plan.nodes.length];
      const { agents, volumes } = counts(plan);
      const moved = other!.steps.filter(step => step.at >= cut && step.op.op !== "create" && step.op.op !== "volume").map(step => {
        const op = { ...step.op } as any;
        if (op.node) op.node = node(op.node);
        if (op.op === "partition") { op.a = node(op.a); if (op.b !== "db") op.b = node(op.b); }
        if ("agent" in op) op.agent %= agents;
        if ("volume" in op) { if (!volumes) return undefined; op.volume %= volumes; }
        return { at: step.at, op: op as Op };
      }).filter((step): step is Step => !!step);
      return { plan: normalize({ ...plan, steps: [...steps.filter(step => step.at < cut), ...moved] }), how };
    }
  }
  return { plan: normalize({ ...plan, steps }), how };
}

/** A few mutations stacked (havoc): each run of the fuzzer tries one of these. */
export function mutate(plan: Plan, random: Random, other?: Plan): { plan: Plan; how: string[] } {
  let current = plan;
  const how: string[] = [];
  for (let count = 1 + random.int(4); count > 0; count--) {
    const next = mutateOnce(current, random, other);
    current = next.plan;
    how.push(next.how);
  }
  return { plan: current, how };
}

/**
 * Prefix branching: the plan's first `k` steps (by default a random number of them), then a fresh random rest, from a generated plan of the same
 * shape, so a state the corpus reached is explored onward in new ways.
 */
export function branch(plan: Plan, random: Random, k = random.int(plan.steps.length + 1)): Plan {
  const kept = plan.steps.slice(0, k);
  const from = kept.at(-1)?.at ?? 0;
  const fresh = generatePlan(`${plan.seed.split("~")[0]}~branch-${random.int(1 << 30)}`, { durationMs: plan.durationMs });
  const { agents, volumes } = counts(plan);
  const node = (name: string) => plan.nodes.includes(name) ? name : plan.nodes[name.charCodeAt(0) % plan.nodes.length];
  const rest = fresh.steps.filter(step => step.at > from && step.op.op !== "create" && step.op.op !== "volume").map(step => {
    const op = { ...step.op } as any;
    if (op.node) op.node = node(op.node);
    if (op.op === "partition") { op.a = node(op.a); if (op.b !== "db") op.b = node(op.b); }
    if ("agent" in op) op.agent %= agents;
    if ("volume" in op) { if (!volumes) return undefined; op.volume %= volumes; }
    return { at: step.at, op: op as Op };
  }).filter((step): step is Step => !!step);
  return normalize({ ...plan, steps: [...kept, ...rest] });
}
