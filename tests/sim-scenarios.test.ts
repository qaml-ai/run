import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Sim, TOKEN } from "./sim/sim.ts";
import type { SimDb } from "./sim/db.ts";
import { runPlan } from "./sim/run.ts";
import { resumeId } from "../src/client-sessions.ts";
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

test("an acquire tries again when the owner's heartbeat expired between its insert and its owner query (corpus acquire-owner-expiry)", async () => {
  // a owns the agent and crashes. b, off the database, is prompted: its route fails (it pauses as it hears that), so it
  // serves the agent itself once back. Its acquire's insert still sees a's heartbeat live, and b pauses as it hears so;
  // by the time it asks who owns the agent, a's heartbeat has expired: no owner, so it tries again, and takes it.
  const plan: Plan = JSON.parse(readFileSync(new URL("./sim/corpus/acquire-owner-expiry.json", import.meta.url), "utf8"));
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
  assert.ok(result.reached.includes("an acquire tried again after a heartbeat expired between its statements"), result.reached.join(", "));
  // The acquire's insert took nothing the first time, and the prompt was accepted once b had the agent.
  assert.ok(result.ownership["insert actor_owners: none"] >= 1, JSON.stringify(result.ownership));
  assert.equal(result.history.find(event => event.op.op === "prompt")?.status, 202);
});

test("a request the database refuses for now (a statement timeout) is answered 503 DATABASE_RETRY with Retry-After, not 400", async t => {
  const sim = await Sim.create({ seed: 34, respond: () => ({ content: "ok" }) });
  t.after(() => sim.close());
  await sim.start("a");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  // Every statement times out from here on.
  const db = sim.db as SimDb;
  db.errors = { rate: 1, codes: ["57014"], random: { float: () => 0, int: () => 0 } };
  const response = await sim.asWorld(() => sim.net.networkFor("client.sim").fetch(`http://a.sim/v1/agents/${agent}/prompt`, {
    method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "hello" }),
  }));
  db.errors = undefined;
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal((await response.json()).code, "DATABASE_RETRY");
});

test("a compaction waiting ten seconds on a slow object store holds no transaction: its peers' leases go on meanwhile", async t => {
  // Every write compacts its log at once (BUGGIFY storage.compact.now), and the store, once slowed, takes ten seconds an operation.
  const sim = await Sim.create({ seed: 35, respond: () => ({ content: "ok", delayMs: 100 }), storageFaults: true, buggify: { "storage.compact.now": 1 }, env: { AGENT_LEASE_TTL_MS: "3000" } });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  await outcome(sim, "a", agent, await prompt(sim, "a", agent, "first"));
  sim.storageFaults = { rate: 1, kinds: ["slow"], slowMs: [10_000, 10_000] };
  const from = sim.env.elapsed;
  // a's next turn writes, and its compactions wait on the store.
  await prompt(sim, "a", agent, "second");
  await sim.advance(30_000);
  sim.storageFaults = undefined;
  assert.ok((sim.storageInjected.get("slow") ?? 0) > 0);
  // b renewed its heartbeat all along (every half second, a sixth of the lease), and no lease went stale: the database
  // was never held by a transaction waiting on the store.
  const renewals = sim.db.statements.filter(line => / b\.sim: update runtime_nodes set expires_at/.test(line)).map(line => Number(line.split(" ", 1)[0]) - sim.env.start).filter(at => at >= from);
  assert.ok(renewals.length >= 50, `${renewals.length} renewals by b in 30 s`);
  assert.deepEqual(sim.env.logs.filter(log => /"(lease_stale|self_fence)"/.test(log.line)).map(log => `${log.by} ${log.line}`), []);
  assert.deepEqual(sim.hooks.violations, []);
});

test("a compaction whose objects landed but whose rows were never deleted (its node cut off, then dead) leaves the log whole: the next owner finds them covered", async t => {
  const sim = await Sim.create({ seed: 36, respond: () => ({ content: "ok", delayMs: 100 }), storageFaults: true, buggify: { "storage.compact.now": 1 }, env: { AGENT_LEASE_TTL_MS: "3000" } });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  await outcome(sim, "a", agent, await prompt(sim, "a", agent, "first"));
  // a's next compaction writes its objects slowly; a loses the database before the rows' deletion, and then dies.
  sim.storageFaults = { rate: 1, kinds: ["slow"], slowMs: [2_000, 2_000] };
  await outcome(sim, "a", agent, await prompt(sim, "a", agent, "second"));
  sim.databaseDown("a");
  await sim.advance(5_000);
  sim.crash("a");
  sim.storageFaults = undefined;
  sim.databaseDown("a", false);
  const third = await prompt(sim, "b", agent, "third");
  await outcome(sim, "b", agent, third);
  const said = (await sim.call("b", `/v1/agents/${agent}/history`)).json.messages
    .filter((message: any) => message.role === "user").map((message: any) => message.content[0].text);
  assert.deepEqual(said, ["first", "second", "third"]);
  assert.ok(sim.hooks.reached.includes("a compaction found rows its store already held (an earlier one stopped after writing)"), sim.hooks.reached.join(", "));
  assert.deepEqual(sim.hooks.violations, []);
});

test("a node cut off the database holding metering deltas across a reconcile has them dropped, not counted on top of the listing (I17, seed 38104496)", async () => {
  // Minimized: b makes an agent; a forks it (b, its owner, writes the fork's objects and meters them); b is cut off the
  // database before it writes the deltas; a's reconcile lists the store, counting them; b, back, writes them: they used
  // to be added on top, metering the fork twice until the next reconcile (a week in production).
  const plan: Plan = {"seed": "38104496", "nodes": ["a", "b"], "leaseTtlMs": 12000, "durationMs": 60000, "skews": {"a": 0, "b": 0}, "modelDelayMs": [50, 2000], "buggify": false, "steps": [{"at": 20, "op": {"op": "create", "agent": 2, "node": "b"}}, {"at": 20895, "op": {"op": "fork", "agent": 2, "fork": 1, "node": "a"}}, {"at": 22414, "op": {"op": "databaseDown", "node": "b"}}]};
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.notes, []);
  assert.ok(result.logs.some(log => log.line.includes('"storage_reconciled"')));
});

test("a retry of a request still being taken is answered once its record is durable, not before (night 4, seed 27266)", async () => {
  // b took run-7 and was writing its record when the retry came; the retry was answered 202 from memory, the write then
  // failed (b cut off the database), and the request the client was told was taken never existed.
  const plan: Plan = JSON.parse(readFileSync(new URL("./sim/cases/retry-before-durable.json", import.meta.url), "utf8"));
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
  assert.ok(result.reached.includes("a retry waited for its request's record to be durable"), result.reached.join(", "));
});

test("a log closed with its records dropped fails the flushes still waiting for them, rather than seeming to write them (night 4, fuzz a025ff9b)", async () => {
  // b's session faulted (its transcript failed a write) while run-9's acceptance waited behind a journal write the
  // outage held up; giving the agent up dropped the journal's buffer, and run-9's flush then found nothing to write and
  // succeeded: answered 202, never stored, never run.
  const plan: Plan = JSON.parse(readFileSync(new URL("./sim/cases/discarded-flush.json", import.meta.url), "utf8"));
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
});

test("a run whose start the database refuses for now is tried again, not failed: it keeps its place and runs (I20)", async t => {
  const sim = await Sim.create({ seed: 37, respond: () => ({ content: "ok", delayMs: 100 }) });
  t.after(() => sim.close());
  await sim.start("a");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  await outcome(sim, "a", agent, await prompt(sim, "a", agent, "first"));
  // Settling the inputs a new prompt supersedes times out for the next three seconds; the start is tried again after.
  const db = sim.db as SimDb;
  db.errors = { rate: 1, codes: ["57014"], random: { float: () => 0, int: () => 0 }, only: /agent_inputs/ };
  const id = await prompt(sim, "a", agent, "second");
  await sim.advance(3_000);
  db.errors = undefined;
  const record = await outcome(sim, "a", agent, id);
  assert.equal(record.outcome.error, undefined, JSON.stringify(record.outcome));
  assert.ok(sim.env.logs.some(log => log.line.includes('"run_start_retry"')), "its start was tried again");
  assert.ok(sim.hooks.reached.includes("a run's start met a transient refusal and was tried again"));
});

/**
 * An agent behind an approval policy on a store's MCP server (tools.sim): its first model call deletes an item, which waits
 * for approval; the next says what the call returned. Returns the suspended run's id and its approval, and the store's calls.
 */
async function approvalAsked(sim: Sim) {
  const calls: unknown[] = [];
  sim.net.add("tools.sim", createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST") return void res.writeHead(405).end();
    const message = JSON.parse(text);
    if (message.id === undefined) return void res.writeHead(202).end();
    const reply = (result: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "shop", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: [{ name: "delete_item", description: "Delete an item", inputSchema: { type: "object", properties: { id: { type: "string" } } }, annotations: { destructiveHint: true } }] });
    if (message.method === "tools/call") { calls.push(message.params); return reply({ content: [{ type: "text", text: `deleted ${message.params.arguments.id}` }] }); }
    reply({});
  }), work => sim.asWorld(work));
  await sim.start("a");
  await sim.start("b");
  const definition = await sim.call("a", "/v1/definitions", { body: { name: "Shop", mcpServers: [{ name: "shop", url: "http://tools.sim/mcp", approval: { default: "destructive" } }] } });
  assert.equal(definition.status, 201, JSON.stringify(definition.json));
  const agent = (await sim.call("a", "/v1/agents", { body: { definition: definition.json.id } })).json.id;
  const suspension = await prompt(sim, "a", agent, "Delete item a");
  const [input] = (await outcome(sim, "a", agent, suspension)).outcome.result.inputs;
  assert.equal(input.kind, "approval");
  return { agent, suspension, input: input.id as string, calls };
}
const approvalWorld = (seed: number) => Sim.create({
  seed, env: { AGENT_LEASE_TTL_MS: "3000", AGENT_ORPHAN_SWEEP_MS: "2000", AGENT_IDLE_MS: "5000", AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "10.0.0.0/8" },
  respond: (body, served) => served.length === 0
    ? { tool_calls: [{ index: 0, id: "call_delete", type: "function", function: { name: "shop__delete_item", arguments: JSON.stringify({ id: "a" }) } }] }
    : { content: `heard: ${body.messages.filter((message: any) => message.role === "tool").at(-1)?.content}` },
});

test("an approval whose node is lost as its resume starts runs the approved call once on the next owner, not suspended with nothing to answer", async t => {
  const sim = await approvalWorld(43);
  t.after(() => sim.close());
  const { agent, suspension, input, calls } = await approvalAsked(sim);
  // a takes the answer (b forwards it), begins the resume run, and has its agent mark the turn active: its third log
  // append from here. It stops there, before the agent releases the call to run it, past its lease: b takes the agent
  // over and finds the turn still suspended on the very call the resume answers.
  sim.pauseAtDbAnswer("a", 10_000, "insert into log_records", 3);
  await sim.env.settle(sim.request("b", `/v1/agents/${agent}/inputs/${input}`, { body: { action: "accept" } }).catch(() => undefined));
  const record = await outcome(sim, "b", agent, resumeId(suspension));
  assert.equal(record.resumes, 1);
  assert.equal(record.outcome.result.stopped, undefined, JSON.stringify(record.outcome));
  assert.match(record.outcome.result.reply, /^heard: deleted a/);
  assert.equal(calls.length, 1, "the approved call ran once");
  assert.ok(sim.hooks.reached.includes("a resume found its turn still suspended on the calls it answers"), "the node was lost where this is about");
  assert.deepEqual(sim.model.served.map(served => served.from), ["a.sim", "b.sim"]);
  assert.deepEqual(sim.hooks.violations, []);
  // Nothing is left open: the agent unloads idle, and its row no longer says it has work.
  await sim.until(async () => !(await sim.db.query("select pending_runs from agents where id = $1", [agent])).rows[0].pending_runs, "pending_runs to clear");
});

test("an approval whose node is lost after its agent released the call ends it as unknown on the next owner, never running it again", async t => {
  const sim = await approvalWorld(44);
  t.after(() => sim.close());
  const { agent, suspension, input, calls } = await approvalAsked(sim);
  // One append later: the call is released (it may be running), so the next owner must not run it again.
  sim.pauseAtDbAnswer("a", 10_000, "insert into log_records", 4);
  await sim.env.settle(sim.request("b", `/v1/agents/${agent}/inputs/${input}`, { body: { action: "accept" } }).catch(() => undefined));
  const record = await outcome(sim, "b", agent, resumeId(suspension));
  assert.equal(record.resumes, 1);
  assert.match(record.outcome.result.reply, /outcome is unknown/);
  assert.equal(calls.length, 0, "never sent again");
  assert.deepEqual(sim.hooks.violations, []);
});
