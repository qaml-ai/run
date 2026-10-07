import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Sim, TOKEN } from "./sim/sim.ts";

// Cluster scenarios (tests/cluster-*.test.ts) in the simulator: the same steps, on virtual time, so they run the same
// way every time instead of racing real timers.

async function prompt(sim: Sim, node: string, agent: string, text: string) {
  const accepted = await sim.call(node, `/v1/agents/${agent}/prompt`, { body: { text } });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  return accepted.json.id as string;
}
const outcome = (sim: Sim, node: string, agent: string, id: string) =>
  sim.until(async () => { const record = (await sim.call(node, `/v1/agents/${agent}/requests/${id}`)).json; return record?.state === "completed" && record; }, `request ${id}`);
const owner = async (sim: Sim, agent: string) => (await sim.db.query("select node from actor_owners where actor = $1", [agent])).rows[0]?.node as string | undefined;

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
  assert.equal((await sim.db.query("select from runtime_nodes where node = 'http://a.sim'")).rows.length, 0, "a deleted its heartbeat");
});

test("a tenant's own maxAgents replaces the default limit, and an idle agent makes room under the default (api maxAgents)", async t => {
  const BOB = "bob-operator-token-at-least-24-chars";
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const tenants = {
    alice: { tokenSha256: sha(TOKEN), apiKeys: { openrouter: "sim-model-key" } },
    bob: { tokenSha256: sha(BOB), apiKeys: { openrouter: "sim-model-key" }, maxAgents: 2 },
  };
  // A turn that says "hold" waits on a model that never answers: its agent is busy, so nothing evicts it.
  const sim = await Sim.create({
    seed: 33, env: { AGENT_TENANTS_JSON: JSON.stringify({ tenants }), AGENT_MAX_AGENTS: "10", AGENT_MAX_AGENTS_PER_TENANT: "1" },
    respond: body => JSON.stringify(body.messages).includes("hold") ? { stall: true } : { content: "ok" },
  });
  t.after(() => sim.close());
  await sim.start("a");
  const create = (token: string, key: string) => sim.request("a", "/v1/agents", { body: {}, token, headers: { "Idempotency-Key": key } });
  const statuses = (results: { status: number }[]) => results.map(result => result.status).sort();
  // Three concurrent starts for bob (his own limit, 2), two for alice (the default, 1).
  const [bobs, alices] = await sim.env.settle(Promise.all([Promise.all(["b1", "b2", "b3"].map(key => create(BOB, key))), Promise.all(["a1", "a2"].map(key => create(TOKEN, key)))]));
  assert.deepEqual(statuses(bobs), [201, 201, 429]);
  assert.deepEqual(statuses(alices), [201, 429]);
  const refused = ["b1", "b2", "b3"][bobs.findIndex(result => result.status === 429)];
  // Bob's two agents are busy, so nothing can be evicted for the refused one.
  for (const agent of bobs.filter(result => result.status === 201).map(result => result.json)) {
    assert.equal((await sim.call("a", `/v1/agents/${agent.id}/prompt`, { body: { text: "hold" }, token: BOB })).status, 202);
  }
  await sim.until(() => sim.model.served.length === 2, "bob's two turns to be waiting on the model");
  assert.equal((await sim.env.settle(create(BOB, refused))).status, 429);
  // Alice's one agent settled after creation is idle: it makes room for another under the default, the first time.
  await sim.advance(1_000);
  assert.equal((await sim.env.settle(create(TOKEN, "a3"))).status, 201, "alice's idle agent makes room under the default");
});
