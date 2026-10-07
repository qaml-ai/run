import { createHash } from "node:crypto";
import { prng } from "./env.ts";
import { Sim } from "./sim.ts";
import type { Op, Plan } from "./workload.ts";

/** What a client saw of one call: when it asked, and when and how it ended (`info`: unknown, as a lost connection leaves it). */
export type Event = { op: Op; invoked: number; ended?: number; result?: "ok" | "fail" | "info"; status?: number; detail?: unknown };

/** A run's outcome: what went wrong (empty when nothing did), what it covered, and its trace's hash. */
export type RunResult = {
  plan: Plan;
  failures: string[];
  /** Findings that are allowed but worth a number (a stale node's model calls after a partition, H1). */
  notes: string[];
  history: Event[];
  reached: string[];
  fired: Record<string, number>;
  served: number;
  /** The runtime's log lines, by node and virtual time. */
  logs: { at: number; by: string; line: string }[];
  elapsedMs: number;
  hash: string;
};

const RUN = /\brun-(\d+)\b/;
/** The run a model request is for: the latest user message names it. */
function runOf(body: any): number | undefined {
  const users = (body.messages ?? []).filter((message: any) => message.role === "user");
  const content = users.at(-1)?.content;
  const text = typeof content === "string" ? content : (content ?? []).map((part: any) => part.text ?? "").join("");
  const match = RUN.exec(text);
  return match ? Number(match[1]) : undefined;
}

/**
 * Run `plan` in a fresh simulation: start its nodes, issue its steps at their virtual times as concurrent clients would,
 * then heal every fault, restart every crashed node and let the cluster settle; then check what happened (`check`).
 */
export async function runPlan(plan: Plan, options: { quiet?: boolean } = {}): Promise<RunResult> {
  const modelRandom = prng(`${plan.seed}:model`);
  const [low, high] = plan.modelDelayMs;
  const sim = await Sim.create({
    seed: plan.seed, buggify: plan.buggify, quiet: options.quiet ?? true,
    env: { AGENT_LEASE_TTL_MS: String(plan.leaseTtlMs), AGENT_ORPHAN_SWEEP_MS: "2000" },
    respond: body => ({ content: `done ${runOf(body) ?? "?"}`, delayMs: low + modelRandom.int(high - low + 1) }),
  });
  const history: Event[] = [];
  const agents = new Map<number, string>();
  /** Accepted runs: their agent and request id. */
  const runs = new Map<number, { agent: number; id: string; acceptedAt: number }>();
  const pending: Promise<unknown>[] = [];
  const databaseCut = new Set<string>();
  try {
    for (const node of plan.nodes) await sim.start(node, {}, { skewMs: plan.skews[node] ?? 0 });

    /** A client call, recorded; a node that cannot be reached (crashed, partitioned) fails it as unknown. */
    const client = (op: Op, node: string, path: string, body?: unknown, headers?: Record<string, string>) => {
      const event: Event = { op, invoked: sim.env.elapsed };
      history.push(event);
      const call = sim.request(node, path, { body, headers }).then(answer => {
        Object.assign(event, { ended: sim.env.elapsed, status: answer.status, result: answer.status < 300 ? "ok" : answer.status >= 500 ? "info" : "fail", detail: answer.json });
        return answer;
      }, error => { Object.assign(event, { ended: sim.env.elapsed, result: "info", detail: String(error?.cause?.code ?? error) }); return undefined; });
      pending.push(call);
      return call;
    };
    /** Start a crashed node again; one that cannot start yet (no database) is tried again a second later, as ECS would. */
    const restart = (node: string): Promise<unknown> => sim.restart(node).catch(() => new Promise(resolve => setTimeout(resolve, 1_000)).then(() => sim.nodes.get(node)?.crashed ? restart(node) : undefined));
    const apply = (op: Op) => sim.asWorld(() => {
      switch (op.op) {
        case "create":
          void client(op, op.node, "/v1/agents", { name: `agent-${op.agent}` }, { "Idempotency-Key": `agent-${op.agent}` })
            .then(answer => { if (answer?.status === 201 || answer?.status === 200) agents.set(op.agent, answer.json.id); });
          return;
        case "prompt": {
          const agent = agents.get(op.agent);
          if (!agent) return;
          void client(op, op.node, `/v1/agents/${agent}/prompt`, { text: `run-${op.run} agent-${op.agent}` }, { "Idempotency-Key": `run-${op.run}` })
            .then(answer => { if (answer?.status === 202) runs.set(op.run, { agent: op.agent, id: answer.json.id, acceptedAt: sim.env.elapsed }); });
          return;
        }
        case "abort": {
          const agent = agents.get(op.agent);
          if (agent) void client(op, op.node, `/v1/agents/${agent}/abort`, {});
          return;
        }
        case "crash": if (!sim.nodes.get(op.node)?.crashed) sim.crash(op.node); break;
        case "restart": if (sim.nodes.get(op.node)?.crashed) pending.push(restart(op.node)); break;
        case "partition":
          if (op.b === "db") { databaseCut.add(op.a); sim.databaseDown(op.a); } else sim.partition(op.a, op.b, op.how);
          break;
        case "heal":
          sim.heal();
          for (const node of databaseCut) sim.databaseDown(node, false);
          databaseCut.clear();
          break;
        case "databaseDown": sim.databaseDown(op.node); break;
        case "databaseUp": sim.databaseDown(op.node, false); break;
      }
      history.push({ op, invoked: sim.env.elapsed, ended: sim.env.elapsed, result: "ok" });
    });

    for (const step of plan.steps) {
      if (step.at > sim.env.elapsed) await sim.advance(step.at - sim.env.elapsed);
      apply(step.op);
    }
    if (plan.durationMs > sim.env.elapsed) await sim.advance(plan.durationMs - sim.env.elapsed);

    // Recovery: every fault ends, and every crashed node comes back. Then the cluster has its lease, a sweep and the
    // slowest model call to finish what it holds.
    sim.heal();
    for (const node of plan.nodes) sim.databaseDown(node, false);
    for (const node of sim.nodes.values()) if (node.crashed) await sim.restart(node.name);
    await sim.env.settle(Promise.allSettled(pending));
    const healedAt = sim.env.elapsed;
    const failures: string[] = [], notes: string[] = [];

    // I3: every accepted run ends, with exactly one outcome, within the recovery bound.
    const live = () => [...sim.nodes.values()].filter(node => !node.crashed).map(node => node.name);
    const bound = 2 * plan.leaseTtlMs + 2_000 + high + 30_000;
    const records = new Map<number, any>();
    for (const [run, { agent, id }] of runs) {
      const record = await sim.until(async () => {
        for (const node of live()) {
          const answer = await sim.call(node, `/v1/agents/${agents.get(agent)}/requests/${id}`);
          if (answer.status === 200 && answer.json?.state === "completed") return answer.json;
        }
        return undefined;
      }, `run-${run} to end`, Math.max(1, healedAt + bound - sim.env.elapsed)).catch(() => undefined);
      if (!record) failures.push(`I3: run-${run} (agent-${agent}, ${id}) never ended within ${bound} ms of recovery`);
      else records.set(run, record);
    }
    // The outcome stays what it was.
    await sim.advance(5_000);
    for (const [run, record] of records) {
      const { agent, id } = runs.get(run)!;
      const again = await sim.call(live()[0], `/v1/agents/${agents.get(agent)}/requests/${id}`);
      if (JSON.stringify(again.json?.outcome) !== JSON.stringify(record.outcome)) failures.push(`I3: run-${run}'s outcome changed after it ended`);
    }

    // I1: one executor per agent: model calls for one agent from two nodes overlap only while a fault separates them.
    // The model logs the base clock's time; the history counts from the start.
    const served = sim.model.served.map(call => ({ ...call, at: call.at - sim.env.start, run: runOf(call.body), until: call.at - sim.env.start + (call.answer.delayMs ?? 0) }));
    const agentOf = new Map(plan.steps.flatMap(step => step.op.op === "prompt" ? [[step.op.run, step.op.agent] as const] : []));
    const byAgent = new Map<number, typeof served>();
    for (const call of served) {
      const agent = call.run === undefined ? undefined : agentOf.get(call.run);
      if (agent !== undefined) byAgent.set(agent, [...byAgent.get(agent) ?? [], call]);
    }
    const faultTimes = history.filter(event => ["crash", "partition", "databaseDown"].includes(event.op.op)).map(event => event.invoked);
    for (const [agent, calls] of byAgent) {
      for (let i = 0; i < calls.length; i++) for (let j = i + 1; j < calls.length; j++) {
        const [x, y] = [calls[i], calls[j]];
        if (x.from === y.from || x.until <= y.at || y.until <= x.at) continue;
        const overlap = Math.min(x.until, y.until) - Math.max(x.at, y.at);
        const faulted = faultTimes.some(at => at <= Math.max(x.at, y.at));
        if (faulted) notes.push(`I1: agent-${agent} had model calls on ${x.from} and ${y.from} at once for ${overlap} ms after a fault`);
        else failures.push(`I1: agent-${agent} had model calls on ${x.from} (run-${x.run}) and ${y.from} (run-${y.run}) at once, with no fault`);
      }
    }

    // I9: after an abort is acknowledged, the agent's runs from before it make no new model call (past a lease, which
    // a stale node may still use).
    for (const event of history) {
      if (event.op.op !== "abort" || event.result !== "ok") continue;
      const { agent } = event.op;
      const late = served.filter(call => call.run !== undefined && runs.get(call.run)?.agent === agent && runs.get(call.run)!.acceptedAt <= event.invoked && call.at > event.ended! + plan.leaseTtlMs);
      for (const call of late) failures.push(`I9: agent-${agent}'s run-${call.run} called the model at ${call.at} ms, after an abort acknowledged at ${event.ended} ms`);
    }

    for (const violation of sim.hooks.violations) failures.push(`assertion: ${violation}`);
    for (const leak of sim.env.leaks) failures.push(`real I/O: ${leak.split("\n").slice(0, 3).join(" ")}`);

    const trace = JSON.stringify({ statements: sim.db.statements, connections: sim.net.connections, served: served.map(call => [call.from, call.at, call.run]), history: history.map(event => [event.op, event.invoked, event.ended, event.result, event.status]) });
    return {
      plan, failures, notes, history, reached: sim.hooks.reached, fired: Object.fromEntries(sim.hooks.fired), served: served.length, logs: sim.env.logs,
      elapsedMs: sim.env.elapsed, hash: createHash("sha256").update(trace).digest("hex"),
    };
  } finally {
    await sim.close();
  }
}
