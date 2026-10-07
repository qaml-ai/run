import { prng } from "./env.ts";
import type { BuggifyPlan } from "./hooks.ts";

/** One thing the workload does: a client call, or a fault. Agents and runs are numbered; their ids come at run time. */
export type Op =
  | { op: "create"; agent: number; node: string }
  /** `requestId`: the run's key goes in the body's requestId rather than the Idempotency-Key header. */
  | { op: "prompt"; agent: number; run: number; node: string; key?: "requestId" }
  /**
   * A client sends run `run`'s prompt again, with the same key (as a retry after a lost answer does), to `node`: before
   * the first answered, or after; checked by I14.
   */
  | { op: "retry"; agent: number; run: number; node: string }
  /** The node's wall clock jumps by `ms` (NTP stepping it, a VM restored): forward or back. Monotonic time does not. */
  | { op: "clockJump"; node: string; ms: number }
  /** The database fails over: every node's connections drop for `ms` (the new primary's promotion and reconnects). */
  | { op: "failover"; ms: number }
  | { op: "abort"; agent: number; node: string }
  /** A client watching the agent's events for `forMs`, resuming after the last event its lane saw. */
  | { op: "watch"; agent: number; node: string; forMs: number }
  /** A deploy takes the node out: it drains, then exits (and a `restart` brings a new process). */
  | { op: "deploy"; node: string }
  /** The node's process stops for `ms` and goes on (SIGSTOP, a GC pause): its timers and I/O wait, its peers do not. */
  | { op: "pause"; node: string; ms: number }
  /**
   * The node stops for `ms` as it next hears a database answer (to a statement containing `statement`, if given, such
   * as "insert into actor_owners"): between two statements of one request, where a race needs time to pass.
   */
  | { op: "pauseOnDb"; node: string; ms: number; statement?: string }
  /**
   * The node is cut off from its peers (blackholed: their liveness probes time out, so they reap it as dead) and from the
   * database, while it still reaches the model and clients: the reap-by-probe-timeout path (H1). A `heal` ends it.
   */
  | { op: "isolate"; node: string }
  | { op: "crash"; node: string }
  | { op: "restart"; node: string }
  | { op: "partition"; a: string; b: string; how: "refused" | "blackhole" }
  | { op: "heal" }
  | { op: "databaseDown"; node: string }
  | { op: "databaseUp"; node: string }
  /** A fork of an agent: the fork's history is the source's up to the fork point, and later turns stay apart (I11). */
  | { op: "fork"; agent: number; fork: number; node: string }
  /** A schedule that prompts the agent `inSeconds` later: once due, it fires, once (I13). */
  | { op: "schedule"; agent: number; schedule: number; inSeconds: number; node: string }
  /** Volumes: one made, a file written (each write its own path and content), a volume forked (I2, I11). */
  | { op: "volume"; volume: number; node: string }
  | { op: "write"; volume: number; write: number; node: string }
  | { op: "forkVolume"; volume: number; fork: number; node: string };

/**
 * A run of the simulation as explicit data: the cluster, its settings, the model's latency, the BUGGIFY plan and every
 * step at its virtual time. A plan replays exactly (with its seed for the rest), and can be cut down to a smaller one
 * that fails the same way.
 */
export type Plan = {
  seed: string;
  nodes: string[];
  /** Each node's wall-clock skew, ms. */
  skews: Record<string, number>;
  leaseTtlMs: number;
  /** The model's latency per call, drawn from [min, max] ms. */
  modelDelayMs: [number, number];
  /**
   * Each pool query's round trip to the database, drawn from [min, max] ms (missing: none). With none, a request's
   * statements all run at one virtual instant and see one now(); with some, time passes between them, as on a real server.
   */
  dbLatencyMs?: [number, number];
  /**
   * Now and then a query's round trip is far longer (a stall: a checkpoint, a lock, a network hiccup): at `rate`, drawn
   * from `ms` instead. A tail like this is what opens the races a steady latency never does (a peer's statement slower
   * than an owner's last renewal by more than the lease's margin).
   */
  dbSpikes?: { rate: number; ms: [number, number] };
  /**
   * Errors the database answers some statements with, at `rate`: 40001 (serialization), 40P01 (deadlock), 57014
   * (statement timeout), ECONNRESET (the connection reset, before the statement or after it took effect).
   */
  dbErrors?: { rate: number; codes: string[] };
  /** Each node's clock rates off true: `wall` on its wall clock, `monotonic` on its monotonic clock (fractions, ±). */
  drifts?: Record<string, { wall?: number; monotonic?: number }>;
  /**
   * The object store misbehaving, until recovery: at `rate`, an operation is slow (`slowMs` more), refused (a 500, a
   * 503 SlowDown), or (a create or delete) takes effect with its answer lost.
   */
  storageFaults?: { rate: number; kinds: ("slow" | "error" | "throttle" | "lost")[]; slowMs: [number, number] };
  buggify: BuggifyPlan;
  steps: { at: number; op: Op }[];
  /** Virtual ms the steps span; then every fault heals, and the run settles. */
  durationMs: number;
};

/** Which fault classes a run uses: each run enables a random subset (swarm testing). */
export const FAULTS = ["crash", "partition", "database", "abort", "buggify", "skew", "deploy", "watch", "pause", "forks", "schedules", "volumes"] as const;

/**
 * A plan for `seed`: 2 or 3 nodes, a few agents made at once, then prompts and the faults the run enabled, over a
 * minute of virtual time. Every fault a run starts it also ends (a crash restarts, a partition heals, an outage ends)
 * before the steps run out.
 */
export function generatePlan(seed: string, options: { steps?: number; durationMs?: number; faults?: readonly (typeof FAULTS)[number][] } = {}): Plan {
  const random = prng(`${seed}:plan`);
  const pick = <T>(items: readonly T[]) => items[random.int(items.length)];
  const nodes = ["a", "b", "c"].slice(0, 2 + random.int(2));
  const faults = new Set(options.faults ?? FAULTS.filter(() => random.float() < 0.5));
  const durationMs = options.durationMs ?? 60_000;
  const leaseTtlMs = pick([3_000, 6_000, 12_000]);
  const agents = 2 + random.int(3);
  const steps: Plan["steps"] = [];
  for (let agent = 0; agent < agents; agent++) steps.push({ at: agent * 10, op: { op: "create", agent, node: pick(nodes) } });
  const volumes = faults.has("volumes") ? 1 + random.int(2) : 0;
  for (let volume = 0; volume < volumes; volume++) steps.push({ at: 50 + volume * 10, op: { op: "volume", volume, node: pick(nodes) } });
  let run = 0, forks = 0, schedules = 0, writes = 0, volumeForks = 0;
  const count = options.steps ?? 30;
  const down = new Map<string, "crash" | "database">();
  for (let index = 0; index < count; index++) {
    const at = 1_000 + Math.floor((index / count) * (durationMs * 0.7)) + random.int(500);
    const roll = random.float();
    const live = nodes.filter(node => !down.has(node));
    const any = () => pick(live.length ? live : nodes);
    if (volumes && random.float() < 0.3) {
      // Volume traffic rides along with the rest: writes mostly, now and then a fork.
      steps.push({ at, op: random.float() < 0.85 ? { op: "write", volume: random.int(volumes), write: writes++, node: any() } : { op: "forkVolume", volume: random.int(volumes), fork: volumeForks++, node: any() } });
    } else if (faults.has("forks") && random.float() < 0.08) steps.push({ at, op: { op: "fork", agent: random.int(agents), fork: forks++, node: any() } });
    else if (faults.has("schedules") && random.float() < 0.08) steps.push({ at, op: { op: "schedule", agent: random.int(agents), schedule: schedules++, inSeconds: 1 + random.int(20), node: any() } });
    else if (roll < 0.5 || !faults.size) steps.push({ at, op: { op: "prompt", agent: random.int(agents), run: run++, node: any() } });
    else if (roll < 0.6 && faults.has("watch")) steps.push({ at, op: { op: "watch", agent: random.int(agents), node: pick(live.length ? live : nodes), forMs: 1_000 + random.int(20_000) } });
    else if (roll < 0.65 && faults.has("deploy") && live.length > 1) {
      const node = pick(live);
      down.set(node, "crash");
      steps.push({ at, op: { op: "deploy", node } });
      steps.push({ at: at + 5_000 + random.int(20_000), op: { op: "restart", node } });
    }
    else if (roll < 0.7 && faults.has("abort")) steps.push({ at, op: { op: "abort", agent: random.int(agents), node: pick(live.length ? live : nodes) } });
    else if (roll < 0.8 && faults.has("crash") && live.length > 1) {
      const node = pick(live);
      down.set(node, "crash");
      steps.push({ at, op: { op: "crash", node } });
      steps.push({ at: at + 2_000 + random.int(15_000), op: { op: "restart", node } });
    } else if (roll < 0.85 && faults.has("pause") && live.length) {
      // From one to ten heartbeats (a sixth of the lease each).
      steps.push({ at, op: { op: "pause", node: pick(live), ms: (1 + random.int(10)) * Math.floor(leaseTtlMs / 6) } });
    } else if (roll < 0.9 && faults.has("partition") && nodes.length > 1) {
      const a = pick(nodes), b = pick(nodes.filter(node => node !== a));
      const kind = random.float();
      steps.push({ at, op: kind < 0.25 ? { op: "isolate", node: a } : { op: "partition", a, b: kind < 0.45 ? "db" : b, how: random.float() < 0.5 ? "refused" : "blackhole" } });
      steps.push({ at: at + 1_000 + random.int(leaseTtlMs * 2), op: { op: "heal" } });
    } else if (faults.has("database") && live.length > 1) {
      const node = pick(live);
      down.set(node, "database");
      steps.push({ at, op: { op: "databaseDown", node } });
      steps.push({ at: at + 1_000 + random.int(leaseTtlMs * 2), op: { op: "databaseUp", node } });
    } else steps.push({ at, op: { op: "prompt", agent: random.int(agents), run: run++, node: pick(live.length ? live : nodes) } });
    // A fault's end is in the plan; once it is due, the node counts as up again for later picks.
    for (const [node] of down) if (steps.some(step => step.at <= at && (step.op.op === "restart" || step.op.op === "databaseUp") && step.op.node === node)) down.delete(node);
  }
  steps.sort((a, b) => a.at - b.at || 0);
  // For some seeds with pauses, one at a node's next database answer (to an ownership statement, mostly), from a stream
  // of its own as the tail below is.
  const between = prng(`${seed}:db-pause`);
  if (faults.has("pause") && between.float() < 0.3) {
    const statement = [undefined, "insert into actor_owners", "from actor_owners o join runtime_nodes", "update runtime_nodes"][between.int(4)];
    steps.push({ at: 1_000 + between.int(Math.floor(durationMs * 0.7)), op: { op: "pauseOnDb", node: nodes[between.int(nodes.length)], ms: (1 + between.int(10)) * Math.floor(leaseTtlMs / 6), ...(statement ? { statement } : {}) } });
    steps.sort((a, b) => a.at - b.at);
  }
  // Clocks, database errors and failovers, and clients retrying: for some seeds each, from a stream of its own.
  const more = prng(`${seed}:faults-2`);
  const extra: Partial<Plan> = {};
  if (more.float() < 0.25) {
    // Wall clocks jump (ten seconds at most each, so they stay within the minute nodes' signed requests to each other
    // allow) and drift; monotonic clocks drift a little, well inside the lease's margin (a tenth of it).
    for (let jumps = 1 + more.int(3); jumps > 0; jumps--) steps.push({ at: 1_000 + more.int(Math.floor(durationMs * 0.7)), op: { op: "clockJump", node: nodes[more.int(nodes.length)], ms: more.int(20_001) - 10_000 } });
    extra.drifts = Object.fromEntries(nodes.map(node => [node, { wall: (more.int(201) - 100) / 10_000, monotonic: (more.int(201) - 100) / 100_000 }]));
  }
  if (more.float() < 0.2) extra.dbErrors = { rate: [0.001, 0.005, 0.02][more.int(3)], codes: ["40001", "40P01", "57014", "ECONNRESET"].filter(() => more.float() < 0.6) };
  if (extra.dbErrors && !extra.dbErrors.codes.length) delete extra.dbErrors;
  if (more.float() < 0.15) steps.push({ at: 1_000 + more.int(Math.floor(durationMs * 0.7)), op: { op: "failover", ms: 500 + more.int(leaseTtlMs) } });
  if (more.float() < 0.3) {
    // Retries of some prompts, soon (while the first is in flight) or late, to any node; some keyed by requestId.
    const prompts = steps.filter(step => step.op.op === "prompt");
    for (const step of prompts) {
      const op = step.op as Extract<Op, { op: "prompt" }>;
      if (more.float() < 0.25) op.key = "requestId";
      if (more.float() < 0.3) steps.push({ at: step.at + (more.float() < 0.5 ? more.int(50) : 500 + more.int(10_000)), op: { op: "retry", agent: op.agent, run: op.run, node: nodes[more.int(nodes.length)] } });
    }
  }
  steps.sort((a, b) => a.at - b.at);
  // An object store that misbehaves, for some seeds, from a stream of its own. Slow by two seconds at most: a log's
  // compaction writes to it inside a database transaction, and PGlite's one session would hold every node up meanwhile,
  // which a real server's concurrent sessions do not.
  const store = prng(`${seed}:faults-3`);
  if (store.float() < 0.25) {
    const kinds = (["slow", "error", "throttle", "lost"] as const).filter(() => store.float() < 0.6);
    if (kinds.length) extra.storageFaults = { rate: [0.01, 0.05, 0.2][store.int(3)], kinds: [...kinds], slowMs: [50, [200, 500, 2_000][store.int(3)]] };
  }
  // A database with a tail for some seeds, from a stream of its own, so every other draw of the plan stays as it was.
  const latency = prng(`${seed}:db-latency`);
  const tail = latency.float() < 0.3 ? { dbLatencyMs: [1, 5] as [number, number], dbSpikes: { rate: 0.01 + latency.int(2) * 0.01, ms: [200, 800] as [number, number] } } : {};
  return {
    seed, nodes, leaseTtlMs, durationMs,
    skews: Object.fromEntries(nodes.map(node => [node, faults.has("skew") ? random.int(10_001) - 5_000 : 0])),
    modelDelayMs: [50, pick([200, 2_000, 8_000])],
    buggify: faults.has("buggify") ? "swarm" : false,
    steps,
    ...tail,
    ...extra,
  };
}
