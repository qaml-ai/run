import { createHash } from "node:crypto";
import { prng } from "./env.ts";
import { Sim, TOKEN } from "./sim.ts";
import type { Op, Plan } from "./workload.ts";

/** What a client saw of one call: when it asked, and when and how it ended (`info`: unknown, as a lost connection leaves it). */
export type Event = { op: Op; invoked: number; ended?: number; result?: "ok" | "fail" | "info"; status?: number; detail?: unknown };

/** A run's outcome: what went wrong (empty when nothing did), what it covered, and its trace's hash. */
export type RunResult = {
  plan: Plan;
  failures: string[];
  /** Findings worth reading that are not failures. */
  notes: string[];
  history: Event[];
  reached: string[];
  fired: Record<string, number>;
  served: number;
  /** Events watchers received, over all their connections. */
  watchedEvents: number;
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
  /** What watchers received: per agent, each connection's event ids and payloads, in order. */
  const watched = new Map<number, { node: string; from: number; events: { id: number; data: string }[]; status?: number }[]>();
  /** The last event id each agent's watcher lane saw, which its next connection resumes after. */
  const lastSeen = new Map<number, number>();
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
    /**
     * A watcher: the agent's event stream from `node` for `forMs`, after the last event its lane saw (Last-Event-ID).
     * Each connection's frames are kept for I8.
     */
    const watch = async (op: Extract<Op, { op: "watch" }>, agent: string) => {
      const from = lastSeen.get(op.agent) ?? 0;
      const connection: { node: string; from: number; events: { id: number; data: string }[]; status?: number } = { node: op.node, from, events: [] };
      watched.set(op.agent, [...watched.get(op.agent) ?? [], connection]);
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), op.forMs);
      try {
        const response = await sim.net.networkFor("client.sim").fetch(`http://${op.node}.sim/v1/agents/${agent}/events?snapshot=0`, {
          headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream", ...(from ? { "Last-Event-ID": String(from) } : {}) }, signal: stop.signal,
        });
        connection.status = response.status;
        if (!response.ok || !response.body) { await response.body?.cancel(); return; }
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk as Uint8Array, { stream: true });
          for (let end; (end = buffer.indexOf("\n\n")) !== -1; buffer = buffer.slice(end + 2)) {
            const lines = buffer.slice(0, end).split("\n");
            const id = lines.find(line => line.startsWith("id:"))?.slice(3).trim();
            if (!id) continue;
            connection.events.push({ id: Number(id), data: lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n") });
            lastSeen.set(op.agent, Number(id));
          }
        }
      } catch { /* the watch ended: stopped, or the node went away */ }
      finally { clearTimeout(timer); }
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
        case "watch": {
          const agent = agents.get(op.agent);
          if (agent) pending.push(watch(op, agent));
          return;
        }
        case "deploy": if (!sim.nodes.get(op.node)?.crashed) pending.push(sim.drain(op.node)); break;
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
    await sim.env.settle(Promise.allSettled(pending), 10 * 60_000).catch(() => {
      const open = history.filter(event => event.ended === undefined).map(event => `${event.op.op} at ${event.invoked}`);
      throw new Error(`Calls still open 10 virtual minutes after recovery: ${open.join(", ") || "(a restart, drain or watch)"}`);
    });
    for (const node of sim.nodes.values()) if (node.crashed) await sim.restart(node.name);
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

    // I1: one executor per agent: no two nodes have model calls for one agent in flight at once, faults or not. A node
    // whose lease goes stale cuts its model requests before its peers could take its agents (FRESH_RENEWALS before
    // SUSPECT_RENEWALS), so even a partitioned node's calls end first; a dead node's end when it died.
    // The model logs the base clock's time; the history counts from the start.
    const served = sim.model.served.map(call => ({ ...call, at: call.at - sim.env.start, run: runOf(call.body), until: call.at - sim.env.start + (call.answer.delayMs ?? 0) }));
    const agentOf = new Map(plan.steps.flatMap(step => step.op.op === "prompt" ? [[step.op.run, step.op.agent] as const] : []));
    const byAgent = new Map<number, typeof served>();
    for (const call of served) {
      const agent = call.run === undefined ? undefined : agentOf.get(call.run);
      if (agent !== undefined) byAgent.set(agent, [...byAgent.get(agent) ?? [], call]);
    }
    const faultTimes = history.filter(event => ["crash", "partition", "databaseDown", "deploy"].includes(event.op.op)).map(event => event.invoked);
    // A call whose node died stopped being anyone's execution then, whatever the model went on sending.
    const deaths = history.filter(event => event.op.op === "crash").map(event => ({ host: `${(event.op as { node: string }).node}.sim`, at: event.invoked }));
    // And one its node cut (a stale lease interrupts its model requests) ended when the node hung up.
    const until = (call: (typeof served)[number]) => Math.min(call.until, call.closedAt === undefined ? Infinity : call.closedAt - sim.env.start, ...deaths.filter(death => death.host === call.from && death.at >= call.at).map(death => death.at));
    for (const [agent, calls] of byAgent) {
      for (let i = 0; i < calls.length; i++) for (let j = i + 1; j < calls.length; j++) {
        const [x, y] = [calls[i], calls[j]];
        if (x.from === y.from || until(x) <= y.at || until(y) <= x.at) continue;
        const overlap = Math.min(until(x), until(y)) - Math.max(x.at, y.at);
        const faulted = faultTimes.some(at => at <= Math.max(x.at, y.at));
        failures.push(`I1: agent-${agent} had model calls on ${x.from} (run-${x.run}) and ${y.from} (run-${y.run}) at once for ${overlap} ms${faulted ? " after a fault" : ""}`);
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

    // I8: within a connection, event ids only grow; across every connection, one id is always the same event (an id is
    // never reused for an agent, H2); a resume gets events after its Last-Event-ID, or a 409.
    for (const [agent, connections] of watched) {
      const byId = new Map<number, string>();
      for (const connection of connections) {
        for (let index = 0; index < connection.events.length; index++) {
          const { id, data } = connection.events[index];
          if (index > 0 && id <= connection.events[index - 1].id) failures.push(`I8: agent-${agent}'s stream from ${connection.node} went from event ${connection.events[index - 1].id} back to ${id}`);
          if (index === 0 && connection.from && id <= connection.from) failures.push(`I8: agent-${agent}'s stream resumed after ${connection.from} from ${connection.node} began at ${id}`);
          const known = byId.get(id);
          if (known !== undefined && known !== data) failures.push(`I8: agent-${agent}'s event ${id} was two different events (${known.slice(0, 120)} / ${data.slice(0, 120)})`);
          byId.set(id, data);
        }
      }
    }

    for (const violation of sim.hooks.violations) failures.push(`assertion: ${violation}`);
    for (const leak of sim.env.leaks) failures.push(`real I/O: ${leak.split("\n").slice(0, 3).join(" ")}`);

    const trace = JSON.stringify({ statements: sim.db.statements, connections: sim.net.connections, served: served.map(call => [call.from, call.at, call.run]), history: history.map(event => [event.op, event.invoked, event.ended, event.result, event.status]) });
    return {
      plan, failures, notes, history, reached: sim.hooks.reached, fired: Object.fromEntries(sim.hooks.fired), served: served.length, logs: sim.env.logs,
      watchedEvents: [...watched.values()].flat().reduce((sum, connection) => sum + connection.events.length, 0),
      elapsedMs: sim.env.elapsed, hash: createHash("sha256").update(trace).digest("hex"),
    };
  } finally {
    await sim.close();
  }
}
