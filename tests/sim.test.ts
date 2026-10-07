import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Sim } from "./sim/sim.ts";

// The deterministic simulator (tests/sim/): runtime nodes in this process on a simulated network, database, store and
// clock. These check the simulator itself; scenarios and checkers build on it.

test("two simulated nodes serve agents over the simulated network and database, on virtual time", async t => {
  const sim = await Sim.create({ seed: 1, respond: body => ({ content: `answered: ${JSON.stringify(body.messages.at(-1).content)}`, delayMs: 2_000 }) });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b", {}, { skewMs: 5_000, drift: 0.01 });
  const created = await sim.call("a", "/v1/agents", { body: { name: "x" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const agent = created.json.id;
  // Node b forwards the prompt to a, which owns the agent.
  const accepted = await sim.call("b", `/v1/agents/${agent}/prompt`, { body: { text: "hi" } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  const record = await sim.until(async () => { const r = (await sim.call("a", `/v1/agents/${agent}/requests/${accepted.json.id}`)).json; return r.state === "completed" && r; }, "the turn");
  assert.equal(record.outcome.result.reply, 'answered: [{"type":"text","text":"hi"}]');
  assert.deepEqual(sim.model.served.map(served => served.from), ["a.sim"]);
  assert.ok(sim.env.elapsed >= 2_000, "the model's two seconds passed on the virtual clock");
  assert.deepEqual(sim.env.leaks, [], "no real I/O");
  // A node's timers run as that node, on its skewed clock.
  const b = sim.nodes.get("b")!.runtime;
  const seen = await sim.env.settle(b.run(() => new Promise<number>(resolve => setTimeout(() => resolve(Date.now() - sim.env.clock.now), 10))));
  assert.equal(seen, 5_000);
});

/** Three agents on two nodes, prompted across nodes; the run's trace, hashed. */
async function scenario(seed: number) {
  const sim = await Sim.create({ seed, respond: (body, served) => ({ content: `answer ${served.length}: ${JSON.stringify(body.messages.at(-1).content)}`, delayMs: 500 + served.length * 37 }) });
  try {
    await sim.start("a");
    await sim.start("b", {}, { skewMs: 3_000 });
    const agents: string[] = [];
    for (const node of ["a", "b", "a"]) agents.push((await sim.call(node, "/v1/agents", { body: {} })).json.id);
    const requests: [string, string][] = [];
    for (const [index, agent] of agents.entries()) requests.push([agent, (await sim.call(index % 2 ? "a" : "b", `/v1/agents/${agent}/prompt`, { body: { text: `p${index}` } })).json.id]);
    for (const [agent, id] of requests) await sim.until(async () => (await sim.call("a", `/v1/agents/${agent}/requests/${id}`)).json.state === "completed", "a turn");
    await sim.advance(30_000);
    const trace = JSON.stringify({ statements: sim.db.statements, connections: sim.net.connections, served: sim.model.served.map(served => [served.from, served.at, served.answer.content]), agents, requests, elapsed: sim.env.elapsed });
    return { hash: createHash("sha256").update(trace).digest("hex"), leaks: sim.env.leaks };
  } finally { await sim.close(); }
}

test("a seed runs the same way every time, and another seed does not", async () => {
  const first = await scenario(7), again = await scenario(7), other = await scenario(8);
  assert.deepEqual(first.leaks, []);
  assert.equal(again.hash, first.hash);
  assert.notEqual(other.hash, first.hash);
});

test("the nightly mode runs the same simulator on a real Postgres server, on the machine's clock", async t => {
  const sim = await Sim.create({ seed: 2, database: "postgres", respond: () => ({ content: "from a real database" }) });
  t.after(() => sim.close());
  assert.equal(sim.env.realTime, true);
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  const id = (await sim.call("b", `/v1/agents/${agent}/prompt`, { body: { text: "hi" } })).json.id;
  const record = await sim.until(async () => { const r = (await sim.call("a", `/v1/agents/${agent}/requests/${id}`)).json; return r.state === "completed" && r; }, "the turn");
  assert.equal(record.outcome.result.reply, "from a real database");
  assert.ok(sim.db.statements.length > 0);
});
