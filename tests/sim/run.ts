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
  /** How its ownership statements came out (which statement, and whether it found or changed a row), counted. */
  ownership: Record<string, number>;
  /** Every assertion the run passed through: how often, and how often it held. */
  checked: Record<string, { kind: string; hits: number; held: number }>;
  fired: Record<string, number>;
  served: number;
  /** Events watchers received, over all their connections. */
  watchedEvents: number;
  /** The runtime's log lines, by node and virtual time. */
  logs: { at: number; by: string; line: string }[];
  elapsedMs: number;
  hash: string;
  /** What the hash is of, line by line, for finding where two runs of one plan part ways. */
  trace: string[];
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
export async function runPlan(plan: Plan, options: { quiet?: boolean; inspect?: (sim: Sim, agents: Map<number, string>) => Promise<void> } = {}): Promise<RunResult> {
  const modelRandom = prng(`${plan.seed}:model`);
  const [low, high] = plan.modelDelayMs;
  const sim = await Sim.create({
    seed: plan.seed, buggify: plan.buggify, quiet: options.quiet ?? true, ...(plan.dbLatencyMs ? { dbLatencyMs: plan.dbLatencyMs } : {}), ...(plan.dbSpikes ? { dbSpikes: plan.dbSpikes } : {}),
    env: { AGENT_LEASE_TTL_MS: String(plan.leaseTtlMs), AGENT_ORPHAN_SWEEP_MS: "2000" },
    respond: body => ({ content: `done ${runOf(body) ?? "?"}`, delayMs: low + modelRandom.int(high - low + 1) }),
  });
  const history: Event[] = [];
  const agents = new Map<number, string>();
  /** Accepted runs: their agent and request id. */
  const runs = new Map<number, { agent: number; id: string; askedAt: number; acceptedAt: number }>();
  const pending: Promise<unknown>[] = [];
  const databaseCut = new Set<string>();
  /** What watchers received: per agent, each connection's event ids and payloads, in order. */
  const watched = new Map<number, { node: string; from: number; events: { id: number; data: string }[]; status?: number }[]>();
  /** The last event id each agent's watcher lane saw, which its next connection resumes after. */
  const lastSeen = new Map<number, number>();
  /** Agent forks made: of which agent, the fork's id, and when the call was made and answered. */
  const forks = new Map<number, { agent: number; id: string; invoked: number; ended: number }>();
  /** Schedules made (201). */
  const schedules = new Map<number, { agent: number; at: number; request: string }>();
  /** Volumes made, writes acknowledged, and volume forks made. */
  const volumes = new Map<number, string>();
  const writes = new Map<number, { volume: number; invoked: number; ended: number }>();
  const volumeForks = new Map<number, { volume: number; id: string; invoked: number; ended: number }>();
  /** Every write tried, acknowledged or not, by when it was asked: a fork may hold one whose answer was lost. */
  const tried = new Map<number, { volume: number; invoked: number }>();
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
    const restart = (node: string): Promise<unknown> => sim.restart(node, { drive: false }).catch(() => new Promise(resolve => setTimeout(resolve, 1_000)).then(() => sim.nodes.get(node)?.crashed ? restart(node) : undefined));
    const apply = (op: Op) => sim.asWorld(() => {
      switch (op.op) {
        case "create":
          void client(op, op.node, "/v1/agents", { name: `agent-${op.agent}` }, { "Idempotency-Key": `agent-${op.agent}` })
            .then(answer => { if (answer?.status === 201 || answer?.status === 200) agents.set(op.agent, answer.json.id); });
          return;
        case "prompt": {
          const agent = agents.get(op.agent);
          if (!agent) return;
          const askedAt = sim.env.elapsed;
          void client(op, op.node, `/v1/agents/${agent}/prompt`, { text: `run-${op.run} agent-${op.agent}` }, { "Idempotency-Key": `run-${op.run}` })
            .then(answer => { if (answer?.status === 202) runs.set(op.run, { agent: op.agent, id: answer.json.id, askedAt, acceptedAt: sim.env.elapsed }); });
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
        case "fork": {
          const agent = agents.get(op.agent);
          if (!agent) return;
          const invoked = sim.env.elapsed;
          void client(op, op.node, `/v1/agents/${agent}/fork`, { key: `fork-${op.fork}` })
            .then(answer => { if (answer?.status === 201) forks.set(op.fork, { agent: op.agent, id: answer.json.id, invoked, ended: sim.env.elapsed }); });
          return;
        }
        case "schedule": {
          const agent = agents.get(op.agent);
          if (!agent) return;
          void client(op, op.node, `/v1/agents/${agent}/schedules`, { text: `sched-${op.schedule} agent-${op.agent}`, inSeconds: op.inSeconds })
            .then(answer => { if (answer?.status === 201) schedules.set(op.schedule, { agent: op.agent, at: sim.env.elapsed + op.inSeconds * 1000, request: `schedule-${answer.json.id}-${answer.json.dueAt}` }); });
          return;
        }
        case "volume":
          void client(op, op.node, "/v1/volumes", { name: `volume-${op.volume}` }).then(answer => { if (answer?.status === 201) volumes.set(op.volume, answer.json.id); });
          return;
        case "write": {
          const volume = volumes.get(op.volume);
          if (!volume) return;
          const invoked = sim.env.elapsed;
          tried.set(op.write, { volume: op.volume, invoked });
          const event: Event = { op, invoked };
          history.push(event);
          const call = sim.request(op.node, `/v1/volumes/${volume}/files/f-${op.write}.txt`, { method: "PUT", raw: `content-${op.write}` }).then(answer => {
            Object.assign(event, { ended: sim.env.elapsed, status: answer.status, result: answer.status < 300 ? "ok" : answer.status >= 500 ? "info" : "fail" });
            if (answer.status === 201) writes.set(op.write, { volume: op.volume, invoked, ended: sim.env.elapsed });
          }, error => { Object.assign(event, { ended: sim.env.elapsed, result: "info", detail: String(error?.cause?.code ?? error) }); });
          pending.push(call);
          return;
        }
        case "forkVolume": {
          const volume = volumes.get(op.volume);
          if (!volume) return;
          const invoked = sim.env.elapsed;
          void client(op, op.node, `/v1/volumes/${volume}/fork`, { name: `fork-${op.fork}` })
            .then(answer => { if (answer?.status === 201) volumeForks.set(op.fork, { volume: op.volume, id: answer.json.id, invoked, ended: sim.env.elapsed }); });
          return;
        }
        case "crash": if (!sim.nodes.get(op.node)?.crashed) sim.crash(op.node); break;
        case "restart": if (sim.nodes.get(op.node)?.crashed) pending.push(restart(op.node)); break;
        case "partition":
          if (op.b === "db") { databaseCut.add(op.a); sim.databaseDown(op.a); } else sim.partition(op.a, op.b, op.how);
          break;
        case "pause": if (!sim.nodes.get(op.node)?.crashed) pending.push(sim.pause(op.node, op.ms)); break;
        case "pauseOnDb": sim.pauseAtDbAnswer(op.node, op.ms, op.statement); break;
        case "isolate":
          for (const peer of plan.nodes) if (peer !== op.node) sim.partition(op.node, peer, "blackhole");
          databaseCut.add(op.node);
          sim.databaseDown(op.node);
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

    // Schedules due late in the run get their time to fire: a scan, and the slowest model call.
    const lastDue = Math.max(0, ...[...schedules.values()].map(schedule => schedule.at));
    if (lastDue + 10_000 + high > sim.env.elapsed) await sim.advance(lastDue + 10_000 + high - sim.env.elapsed);

    // I3: every accepted run ends, with exactly one outcome, within the recovery bound.
    const live = () => [...sim.nodes.values()].filter(node => !node.crashed).map(node => node.name);
    // An agent's runs go one at a time: the last of a long queue waits for every model call before it.
    const queued = (agent: number) => [...runs.values()].filter(run => run.agent === agent).length;
    const records = new Map<number, any>();
    for (const [run, { agent, id }] of runs) {
      // At most ten calls' worth: a queue that long still ending is the point, not how long it takes.
      const bound = 2 * plan.leaseTtlMs + 2_000 + high * Math.min(10, queued(agent)) + 30_000;
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
    const faultTimes = [...history.filter(event => ["crash", "partition", "databaseDown", "deploy", "isolate"].includes(event.op.op)).map(event => event.invoked), ...sim.pauses.map(pause => pause.at)];
    // A paused node acts on nothing while it is stopped, and cuts what its lease no longer covers as soon as it runs
    // again: a call of its open across a pause counts as its execution only outside the pause and the heartbeat after.
    const heartbeat = Math.min(Math.floor(plan.leaseTtlMs / 6), 3_000);
    const pauses = sim.pauses.map(pause => ({ host: `${pause.node}.sim`, from: pause.at, to: pause.at + pause.ms + heartbeat }));
    // A call whose node died stopped being anyone's execution then, whatever the model went on sending.
    const deaths = history.filter(event => event.op.op === "crash").map(event => ({ host: `${(event.op as { node: string }).node}.sim`, at: event.invoked }));
    // And one its node cut (a stale lease interrupts its model requests) ended when the node hung up.
    const until = (call: (typeof served)[number]) => Math.min(call.until, call.closedAt === undefined ? Infinity : call.closedAt - sim.env.start, ...deaths.filter(death => death.host === call.from && death.at >= call.at).map(death => death.at));
    /** When a call was its node's execution: from its start to its end, less the pauses of its node. */
    const acting = (call: (typeof served)[number]) => {
      let spans: [number, number][] = [[call.at, until(call)]];
      for (const pause of pauses) {
        if (pause.host !== call.from) continue;
        spans = spans.flatMap(([from, to]): [number, number][] => to <= pause.from || from >= pause.to ? [[from, to]] : [[from, Math.max(from, pause.from)], [Math.min(to, pause.to), to]].filter(([a, b]) => b > a) as [number, number][]);
      }
      return spans;
    };
    const overlapOf = (x: (typeof served)[number], y: (typeof served)[number]) => {
      let total = 0;
      for (const [a, b] of acting(x)) for (const [c, d] of acting(y)) total += Math.max(0, Math.min(b, d) - Math.max(a, c));
      return total;
    };
    for (const [agent, calls] of byAgent) {
      for (let i = 0; i < calls.length; i++) for (let j = i + 1; j < calls.length; j++) {
        const [x, y] = [calls[i], calls[j]];
        if (x.from === y.from) continue;
        const overlap = overlapOf(x, y);
        if (!overlap) continue;
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

    // I2: every acknowledged volume write reads back, whole, on every live node.
    for (const [write, { volume }] of writes) {
      for (const node of live()) {
        const answer = await sim.call(node, `/v1/volumes/${volumes.get(volume)}/files/f-${write}.txt`);
        if (answer.status !== 200 || answer.json !== `content-${write}`) failures.push(`I2: write ${write} to volume-${volume} was acknowledged, but ${node} reads ${answer.status} ${JSON.stringify(answer.json).slice(0, 80)}`);
      }
    }
    // I11 (volumes): a fork holds every write acknowledged before it was asked for, and none asked for after it answered.
    for (const [fork, { volume, id, invoked, ended }] of volumeForks) {
      const listed = await sim.call(live()[0], `/v1/volumes/${id}/files?limit=1000`);
      const paths = new Set<string>((listed.json?.files ?? []).map((file: { path: string }) => file.path));
      for (const [write, done] of writes) if (done.volume === volume && done.ended < invoked && !paths.has(`/f-${write}.txt`)) failures.push(`I11: volume fork ${fork} of volume-${volume} lacks write ${write}, acknowledged before the fork was asked for`);
      for (const [write, asked] of tried) if (asked.volume === volume && asked.invoked > ended && paths.has(`/f-${write}.txt`)) failures.push(`I11: volume fork ${fork} of volume-${volume} has write ${write}, asked for after the fork was made`);
    }
    // I11 (agents): a fork's history is its source's up to the fork point: every run of the source that ended before
    // the fork was asked for (one that failed exactly when its source holds it; one a stop cancelled before it began
    // never entered the history), and no run asked for after it was made.
    const runsIn = async (agent: string) => {
      const answer = await sim.call(live()[0], `/v1/agents/${agent}/history`);
      const messages: any[] = answer.json?.messages ?? [];
      return new Set(messages.filter(message => message.role === "user").map(message => runOf({ messages: [message] })).filter((run): run is number => run !== undefined));
    };
    for (const [fork, { agent, id, invoked, ended }] of forks) {
      const has = await runsIn(id);
      // A run that failed may never have entered its agent's history (its prompt not stored when the agent was given up
      // after a fault, say): the fork must hold it exactly when its source does.
      const source = await runsIn(agents.get(agent)!);
      for (const [run, record] of records) {
        if (runs.get(run)!.agent !== agent) continue;
        // endedAt is the owner node's clock: allow for the most any node's is off.
        const endedAt = Number(record.endedAt) - sim.env.start + Math.max(0, ...Object.values(plan.skews).map(Math.abs));
        const inHistory = (record.outcome?.error === undefined && record.outcome?.result?.error === undefined) || source.has(run);
        if (endedAt < invoked && record.outcome?.result?.code !== "cancelled" && inHistory && !has.has(run)) failures.push(`I11: fork ${fork} of agent-${agent} lacks run-${run}, which ended before the fork was asked for`);
      }
      // Asked for after: its acceptance's answer may come long after the run was accepted (a paused node), so not by that.
      for (const [run, { agent: of, askedAt }] of runs) if (of === agent && askedAt > ended && has.has(run)) failures.push(`I11: fork ${fork} of agent-${agent} has run-${run}, asked for after the fork was made`);
    }
    // I13: a schedule made fires once it is due. A delivery that failed (its agent's node was down) is
    // tried again once its claim times out (a minute, src/scheduler.ts), so the bound is that past the later of its due
    // time and recovery.
    if (schedules.size) {
      const by = Math.max(healedAt, ...[...schedules.values()].map(schedule => schedule.at)) + 60_000 + 10_000 + high;
      if (by > sim.env.elapsed) await sim.advance(by - sim.env.elapsed);
    }
    // Firing is delivering its prompt under an id derived from the schedule, so a repeat is the same request: the
    // request is there (it may since have been cancelled by an abort, which is not the schedule's to decide).
    for (const [schedule, { agent, request }] of schedules) {
      const answer = await sim.call(live()[0], `/v1/agents/${agents.get(agent)}/requests/${request}`);
      if (answer.status !== 200) failures.push(`I13: schedule ${schedule} of agent-${agent} never delivered its prompt (${request}: ${answer.status})`);
    }

    for (const violation of sim.hooks.violations) failures.push(`assertion: ${violation}`);
    // For debugging a plan: look at the cluster as the run left it.
    await options.inspect?.(sim, agents);
    for (const leak of sim.env.leaks) failures.push(`real I/O: ${leak.split("\n").slice(0, 3).join(" ")}`);

    const trace = [...sim.env.timerTrace, ...sim.db.statements, ...sim.net.connections, ...served.map(call => JSON.stringify([call.from, call.at, call.run])), ...history.map(event => JSON.stringify([event.op, event.invoked, event.ended, event.result, event.status]))];
    return {
      plan, failures, notes, history, reached: sim.hooks.reached, checked: Object.fromEntries(sim.hooks.checked), ownership: Object.fromEntries(sim.db.outcomes), fired: Object.fromEntries(sim.hooks.fired), served: served.length, logs: sim.env.logs,
      watchedEvents: [...watched.values()].flat().reduce((sum, connection) => sum + connection.events.length, 0),
      elapsedMs: sim.env.elapsed, hash: createHash("sha256").update(trace.join("\n")).digest("hex"), trace,
    };
  } finally {
    await sim.close();
  }
}
