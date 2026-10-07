import { test } from "node:test";
import assert from "node:assert/strict";
import { Sim } from "./sim/sim.ts";

// Cluster scenarios (tests/cluster-*.test.ts) in the simulator: the same steps, on virtual time, so they run the same
// way every time instead of racing real timers.

async function prompt(sim: Sim, node: string, agent: string, text: string) {
  const accepted = await sim.call(node, `/v1/agents/${agent}/prompt`, { body: { text } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  return accepted.json.id as string;
}
const outcome = (sim: Sim, node: string, agent: string, id: string) =>
  sim.until(async () => { const record = (await sim.call(node, `/v1/agents/${agent}/requests/${id}`)).json; return record?.state === "completed" && record; }, `request ${id}`);
const owner = async (sim: Sim, agent: string) => (await sim.db.pglite.query<{ node: string }>("select node from actor_owners where actor = $1", [agent])).rows[0]?.node;

test("a turn still running when the drain times out is handed off and resumed by the next owner (cluster-handoff)", async t => {
  // The first model call never answers; the next does.
  const sim = await Sim.create({ seed: 31, respond: (_body, served) => served.length === 0 ? { stall: true } : { content: "resumed after the drain" } });
  t.after(() => sim.close());
  await sim.start("a", { AGENT_DRAIN_TIMEOUT_MS: "500" });
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  const id = await prompt(sim, "b", agent, "think for a long time");
  await sim.until(() => sim.model.served.length === 1, "a called the model");
  await sim.env.settle(sim.drain("a"));
  const drained = sim.env.logs.find(log => log.by === "a#1" && log.line.includes('"drain_finished"'));
  assert.equal(JSON.parse(drained!.line).unfinished, 1);
  const record = await outcome(sim, "b", agent, id);
  assert.equal(record.outcome.result.reply, "resumed after the drain");
  assert.deepEqual(sim.model.served.map(served => served.from), ["a.sim", "b.sim"]);
  assert.equal(sim.model.served[1].body.messages.filter((message: any) => message.role === "user").length, 1, "the turn was continued, not prompted again");
  assert.equal(await owner(sim, agent), "http://b.sim");
});

test("a draining node finishes the turn in flight, leaves the queued run for the next owner and releases (cluster-drain)", async t => {
  const sim = await Sim.create({ seed: 32, respond: (body, served) => ({ content: `answer ${served.length}`, delayMs: served.length === 0 ? 3_000 : 100 }) });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  const first = await prompt(sim, "b", agent, "first");
  await sim.until(() => sim.model.served.length === 1, "a called the model");
  const drained = sim.drain("a");
  // Accepted while a drains, but never begun there.
  const second = await prompt(sim, "b", agent, "second");
  await sim.env.settle(drained);
  assert.equal(JSON.parse(sim.env.logs.find(log => log.by === "a#1" && log.line.includes('"drain_finished"'))!.line).unfinished, 0);
  assert.equal((await outcome(sim, "b", agent, first)).outcome.result.reply, "answer 0", "the turn in flight finished on a");
  assert.equal((await outcome(sim, "b", agent, second)).outcome.result.reply, "answer 1");
  assert.deepEqual(sim.model.served.map(served => served.from), ["a.sim", "b.sim"]);
  assert.equal(await owner(sim, agent), "http://b.sim");
  assert.equal((await sim.db.pglite.query("select from runtime_nodes where node = 'http://a.sim'")).rows.length, 0, "a deleted its heartbeat");
});
