import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Sim, TOKEN } from "./sim/sim.ts";
import { runPlan } from "./sim/run.ts";
import type { Plan } from "./sim/workload.ts";

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

test("a session whose commit fails while its node still owns the agent gives the agent up, and the run resumes (seed 2686)", async () => {
  // Minimized from the first nightly: the began record's append lands but its answer is lost five times (BUGGIFY
  // tail.append.lost_ack), so the commit fails with the lease healthy. The faulted session used to stay loaded, holding
  // run-5 open (and the agent refusing runs) until its node restarted.
  const plan: Plan = {"seed": "2686", "nodes": ["a", "b", "c"], "leaseTtlMs": 3000, "durationMs": 60000, "skews": {"a": 0, "b": 0, "c": 0}, "modelDelayMs": [50, 8000], "buggify": "swarm", "steps": [{"at": 0, "op": {"op": "create", "agent": 0, "node": "a"}}, {"at": 10, "op": {"op": "create", "agent": 1, "node": "c"}}, {"at": 1055, "op": {"op": "prompt", "agent": 0, "run": 0, "node": "a"}}, {"at": 2429, "op": {"op": "prompt", "agent": 1, "run": 1, "node": "b"}}, {"at": 4024, "op": {"op": "prompt", "agent": 1, "run": 2, "node": "b"}}, {"at": 5308, "op": {"op": "prompt", "agent": 1, "run": 3, "node": "b"}}, {"at": 6669, "op": {"op": "prompt", "agent": 0, "run": 4, "node": "c"}}, {"at": 8444, "op": {"op": "prompt", "agent": 0, "run": 5, "node": "a"}}]};
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
  assert.ok(result.logs.some(log => log.line.includes('"session_fault_released"')), "the faulted session was released");
});

test("an abort that reaches a resumed turn before the agent has it settles the turn, so a fork holds it (seed 11188)", async () => {
  // Minimized from seed 11188: run-6 began on a, then a was cut off from its peers and the database; once healed, its
  // session reloaded and resumed the turn, which the transcript holds open (active) for the continue. The abort reached
  // the run before the agent had it, so the session ended it without the agent, and the transcript kept the turn open
  // until the next prompt: a fork made in between left the aborted run's prompt out.
  const plan: Plan = {"seed": "11188", "nodes": ["a", "b"], "leaseTtlMs": 3000, "durationMs": 60000, "skews": {"a": 0, "b": 0}, "modelDelayMs": [50, 8000], "buggify": "swarm", "steps": [{"at": 20, "op": {"op": "create", "agent": 2, "node": "a"}}, {"at": 13939, "op": {"op": "prompt", "agent": 2, "run": 6, "node": "a"}}, {"at": 19442, "op": {"op": "isolate", "node": "b"}}, {"at": 20806, "op": {"op": "isolate", "node": "a"}}, {"at": 24624, "op": {"op": "heal"}}, {"at": 25136, "op": {"op": "abort", "agent": 2, "node": "a"}}, {"at": 26467, "op": {"op": "fork", "agent": 2, "fork": 2, "node": "a"}}]};
  let run: any;
  const result = await runPlan(plan, { quiet: true, inspect: async (sim, agents) => { run = (await sim.call("a", `/v1/agents/${agents.get(2)}/requests/run-6`)).json; } });
  assert.deepEqual(result.failures, []);
  // Ended by its agent, which closed the turn: an aborted run.
  assert.equal(run?.outcome?.result?.code, "aborted", JSON.stringify(run?.outcome));
});

test("a run that ends at a load past its resumes settles the turn it left open, so a fork holds it (seed 2)", async () => {
  // Minimized from seed 2: database outages fence agent-0 and move it until run-0 has been resumed twice; the next load
  // ends it uncertain, with no host to close its turn, and nothing did until the agent next started: a fork 40 s later
  // ended before it (atMessage null) though every node's history showed run-0's prompt.
  const plan: Plan = {"seed": "2", "nodes": ["a", "b", "c"], "leaseTtlMs": 6000, "durationMs": 60000, "skews": {"a": 3412, "b": 3958, "c": 80}, "modelDelayMs": [50, 200], "buggify": "swarm", "steps": [{"at": 0, "op": {"op": "create", "agent": 0, "node": "a"}}, {"at": 20, "op": {"op": "create", "agent": 2, "node": "b"}}, {"at": 1324, "op": {"op": "prompt", "agent": 0, "run": 0, "node": "a"}}, {"at": 5674, "op": {"op": "prompt", "agent": 2, "run": 1, "node": "b"}}, {"at": 6936, "op": {"op": "databaseDown", "node": "a"}}, {"at": 12684, "op": {"op": "databaseDown", "node": "b"}}, {"at": 15736, "op": {"op": "databaseUp", "node": "a"}}, {"at": 18094, "op": {"op": "databaseDown", "node": "c"}}, {"at": 55944, "op": {"op": "fork", "agent": 0, "fork": 4, "node": "a"}}]};
  let run: any;
  const result = await runPlan(plan, { quiet: true, inspect: async (sim, agents) => { run = (await sim.call("a", `/v1/agents/${agents.get(0)}/requests/run-0`)).json; } });
  assert.deepEqual(result.failures, []);
  assert.equal(run?.outcome?.uncertain, true, JSON.stringify(run?.outcome));
});

test("parallel children on a cluster: an abort of the parent sent to another node aborts every child it waits on (cluster-multi-agent)", async t => {
  // The parent fans out to three children whose model never answers; the abort goes to b, a's peer.
  const system = (body: any) => JSON.stringify(body.messages.filter((message: any) => message.role === "system"));
  const call = (id: string, task: string) => ({ index: Number(id.slice(1)) - 1, id, type: "function", function: { name: "delegate", arguments: JSON.stringify({ instructions: "You are SLOW.", task }) } });
  const sim = await Sim.create({ seed: 33, respond: body => {
    if (system(body).includes("SLOW")) return { stall: true };
    if (body.messages.at(-1).role === "tool") return { content: "after" };
    return { tool_calls: [call("c1", "one"), call("c2", "two"), call("c3", "three")] };
  } });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const parent = (await sim.call("a", "/v1/agents", { body: { builtins: ["delegate"], delegate: { instructions: true } } })).json.id;
  assert.equal((await sim.call("a", `/v1/agents/${parent}/prompt`, { body: { text: "go", requestId: "fan-out" } })).status, 202);
  await sim.until(() => sim.model.served.filter(served => system(served.body).includes("SLOW")).length === 3, "three children running at once");
  const aborted = sim.env.elapsed;
  assert.equal((await sim.call("b", `/v1/agents/${parent}/abort`, { body: {} })).status, 200);
  const record = await outcome(sim, "b", parent, "fan-out");
  assert.ok(record.outcome, JSON.stringify(record));
  const children = (await sim.call("b", "/v1/agents")).json.filter((agent: any) => agent.parentAgentId === parent);
  assert.equal(children.length, 3);
  for (const child of children) {
    const run = await sim.until(async () => {
      const found = (await sim.call("b", `/v1/agents/${child.id}`)).json.requests.find((request: any) => request.method === "prompt");
      return found?.state === "completed" && found;
    }, `child ${child.id} to end`, 15_000);
    assert.ok(run.endedAt - sim.env.start - aborted < 15_000, "at the abort, not when the model would have answered");
  }
  // Every child's model call was cut, none answered.
  assert.ok(sim.model.served.filter(served => system(served.body).includes("SLOW")).every(served => served.closedAt !== undefined));
  assert.deepEqual(sim.hooks.violations, []);
});

test("an acquire tries again when its own heartbeat was ended between its statements: a peer that cannot reach it reaped it (corpus acquire-retry)", async () => {
  // b is cut off the database long enough to look dead to a, which cannot reach it (refused) and ends its heartbeat;
  // b, back on the database and still registered, takes an agent whose owner died: its insert finds its own heartbeat
  // gone, the owner query finds none, and it tries again (then 503s and fences, and the next prompt takes the agent).
  const plan: Plan = JSON.parse(readFileSync(new URL("./sim/corpus/acquire-retry.json", import.meta.url), "utf8"));
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
  assert.ok(result.reached.includes("an acquire tried again after a heartbeat expired between its statements"), result.reached.join(", "));
});
