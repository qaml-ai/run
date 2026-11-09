import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Sim } from "./sim/sim.ts";
import { prompt, outcome } from "./sim/scenario.ts";

/**
 * Tool-prepared children: a parent on a whose definition has a runtime-auth MCP server (tools.sim) with work_on_bot,
 * which answers with a spawn directive for the worker (b's agent). The parent's model calls it, and calls it again if
 * the first call's outcome was lost with its node; the worker answers after three seconds; the notification's turn says
 * "heard". Returns the parent and the worker, and the tool's calls.
 */
async function toolSpawned(sim: Sim, pause?: () => void) {
  const calls: unknown[] = [];
  let worker = "";
  sim.net.add("tools.sim", createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST") return void res.writeHead(405).end();
    const message = JSON.parse(text);
    if (message.id === undefined) return void res.writeHead(202).end();
    const reply = (result: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "app", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: [{ name: "work_on_bot", description: "Hand a task to the bot's worker", inputSchema: { type: "object", properties: { task: { type: "string" } } } }] });
    if (message.method === "tools/call") {
      calls.push(message.params);
      return reply({ content: [{ type: "text", text: "starting" }], _meta: { "camelrun/spawn": { agent: worker, task: message.params.arguments.task, name: "bot" } } });
    }
    reply({});
  }), work => sim.asWorld(work));
  for (const node of ["a", "b", "c"]) await sim.start(node);
  worker = (await sim.call("b", "/v1/agents", { body: { systemPrompt: "You are a WORKER.", ttlSeconds: null }, headers: { "Idempotency-Key": "worker" } })).json.id;
  await outcome(sim, "b", worker, await prompt(sim, "b", worker, "warm up"));
  const definition = await sim.call("a", "/v1/definitions", { body: { name: "Lead", mcpServers: [{ name: "app", url: "http://tools.sim/mcp", auth: { type: "runtime" } }] } });
  assert.equal(definition.status, 201, JSON.stringify(definition.json));
  const parent = (await sim.call("a", "/v1/agents", { body: { definition: definition.json.id } })).json.id;
  pause?.();
  // The first prompt's answer may be lost with a's node; its run ends on whichever node takes the agent.
  const sent = await sim.env.settle(sim.request("a", `/v1/agents/${parent}/prompt`, { body: { text: "work on the bot" }, headers: { "Idempotency-Key": "turn-1" } }).catch(() => undefined));
  return { parent, worker, calls, sent };
}
const toolSpawnWorld = (seed: number) => Sim.create({
  seed, env: { AGENT_LEASE_TTL_MS: "3000", AGENT_ORPHAN_SWEEP_MS: "2000", AGENT_CHILD_SWEEP_MS: "2000", AGENT_IDLE_MS: "600000", AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "10.0.0.0/8" },
  respond: body => {
    const system = JSON.stringify(body.messages.filter((message: any) => message.role === "system"));
    const last = body.messages.at(-1);
    if (system.includes("WORKER")) return { content: "worked", delayMs: 3_000 };
    if (JSON.stringify(last.content).includes("<agent_notification")) return { content: "heard" };
    // A call whose outcome was lost with its node is made again, once.
    if (last.role === "tool") return /unknown|was interrupted/.test(JSON.stringify(last.content)) && !body.messages.some((message: any) => message.tool_calls?.some((call: any) => call.id === "call_again"))
      ? { tool_calls: [{ index: 0, id: "call_again", type: "function", function: { name: "app__work_on_bot", arguments: JSON.stringify({ task: "fix it" }) } }] } : { content: "spawned" };
    return { tool_calls: [{ index: 0, id: "call_work", type: "function", function: { name: "app__work_on_bot", arguments: JSON.stringify({ task: "fix it" }) } }] };
  },
});
/**
 * Every directive the runtime took started at most one run of the worker, and every row of the parent's children reached
 * it exactly once: a run that started notifies with its ending, a row whose child never started with a failure.
 */
async function toolSpawnedOnce(sim: Sim, node: string, parent: string, worker: string) {
  const rows = await sim.until(async () => {
    const { rows } = await sim.db.query("select id, request_id, state, landed_by, status from agent_children where parent = $1 order by created_at", [parent]);
    return rows.length > 0 && rows.every(row => row.state === "notified") ? rows : undefined;
  }, "every row to reach the parent", 300_000);
  const runs = (await sim.call(node, `/v1/agents/${worker}`)).json.requests.filter((request: any) => request.id.startsWith("spawn_"));
  assert.equal(new Set(runs.map((run: any) => run.id)).size, runs.length);
  for (const run of runs) assert.ok(rows.some((row: any) => row.request_id === run.id), `the worker's run ${run.id} has its row`);
  const completed = runs.filter((run: any) => run.status === "completed");
  assert.equal(completed.length, 1, `one run of the worker did the task: ${JSON.stringify(runs.map((run: any) => [run.id, run.status]))}`);
  const history = (await sim.call(node, `/v1/agents/${parent}/history`)).json.messages;
  const notices = history.filter((message: any) => message.source?.kind === "agent");
  for (const row of rows) {
    const landed = notices.filter((message: any) => message.requestId === `child_${row.request_id}`).length;
    assert.equal(landed, 1, `row ${row.id} (${row.status}) reached the parent once`);
  }
  assert.equal(notices.filter((message: any) => message.metadata.status === "completed").length, 1, "one notification that the task was done");
  assert.equal(sim.model.served.filter(served => JSON.stringify(served.body.messages.at(-1).content).includes("<agent_notification") && JSON.stringify(served.body.messages.at(-1).content).includes("completed")).length, 1);
  assert.deepEqual(sim.hooks.violations, []);
  return { rows, runs };
}

test("a tool's spawn directive whose node is lost before the child's row is written starts the worker once, when the model calls again", async t => {
  const sim = await toolSpawnWorld(51);
  t.after(() => sim.close());
  // a has the directive and checks the agent it names: it is lost there, before anything is written.
  const { parent, worker, calls } = await toolSpawned(sim, () => sim.pauseAtDbAnswer("a", 10_000, "select name from agents where id"));
  await sim.until(() => sim.pauses.some(pause => pause.node === "a"), "a to stop as it takes the directive");
  sim.crash("a");
  const { rows } = await toolSpawnedOnce(sim, "b", parent, worker);
  assert.equal(rows.length, 1, "the lost directive wrote nothing");
  assert.equal(calls.length, 2, "the model called the tool again, its first call's outcome unknown");
});

test("a tool's spawn directive whose node is lost after the child's row, before its prompt, fails that row once and starts the worker once", async t => {
  const sim = await toolSpawnWorld(52);
  t.after(() => sim.close());
  // a commits the row, then asks who serves the worker, to send it the prompt: it is lost there (the turn's first owner
  // lookup from the prompt on, as the sim runs it).
  const { parent, worker } = await toolSpawned(sim, () => sim.pauseAtDbAnswer("a", 10_000, "select o.node, extract(epoch from n.expires_at"));
  await sim.until(() => sim.pauses.some(pause => pause.node === "a"), "a to stop after writing the row");
  assert.equal((await sim.db.query("select count(*)::int as n from agent_children where parent = $1", [parent])).rows[0].n, 1, "the row was written");
  sim.crash("a");
  const { rows } = await toolSpawnedOnce(sim, "b", parent, worker);
  assert.equal(rows.length, 2);
  assert.match(rows[0].status, /failed/, "the row whose child never started fails, once");
  assert.ok(sim.hooks.reached.includes("a sweep found a child's ended run that no one had recorded"), sim.hooks.reached.join(", "));
});

test("a spawn whose child cannot be reached fails its call and its row together, not two minutes later (seed 36888719)", async t => {
  // From seed 36888719: the parent's node wrote the worker's row, then asked the worker for a request it had not sent yet,
  // and that lookup failed (there, a refused statement as the worker loaded). The call failed, but its row stayed running:
  // it counted against the parent's children, and reached the parent only once the sweep's start grace (two minutes)
  // called it never started. Here a, the parent's node, cannot reach b, the worker's.
  const sim = await toolSpawnWorld(54);
  t.after(() => sim.close());
  const { parent, worker } = await toolSpawned(sim, () => sim.partition("a", "b"));
  await outcome(sim, "a", parent, "turn-1");
  const { rows } = await sim.db.query("select id, state, status, ended_at from agent_children where parent = $1", [parent]);
  assert.equal(rows.length, 1, "the directive wrote its row");
  assert.deepEqual([rows[0].state, rows[0].status], ["notified", "failed"], "the call failed, and its row with it");
  sim.net.heal();
  // Past the start grace and a few sweeps: the worker never ran the task, and nothing reached the parent about it.
  await sim.advance(150_000);
  const runs = (await sim.call("b", `/v1/agents/${worker}`)).json.requests.filter((request: any) => request.id.startsWith("spawn_"));
  assert.deepEqual(runs, []);
  const notices = (await sim.call("a", `/v1/agents/${parent}/history`)).json.messages.filter((message: any) => message.source?.kind === "agent");
  assert.deepEqual(notices, [], "no notification of a child the call already said had failed");
  assert.deepEqual(sim.hooks.violations, []);
});

test("a tool-prepared worker whose node is lost after its run ends, before delivery, notifies its parent once", async t => {
  const sim = await toolSpawnWorld(53);
  t.after(() => sim.close());
  const { parent, worker } = await toolSpawned(sim);
  await outcome(sim, "a", parent, "turn-1");
  // b ends the worker's run, and looks up its row to deliver it: it is lost there.
  sim.pauseAtDbAnswer("b", 10_000, "from agent_children where child");
  await sim.until(() => sim.pauses.some(pause => pause.node === "b"), "b to stop at the delivery");
  sim.crash("b");
  const { rows } = await toolSpawnedOnce(sim, "a", parent, worker);
  assert.equal(rows.length, 1);
  assert.ok(sim.hooks.reached.includes("a tool's spawn directive started a background child"));
  assert.ok(sim.hooks.reached.includes("a sweep found a child's ended run that no one had recorded"), sim.hooks.reached.join(", "));
});

/**
 * Two workers (agents of their own, served by b) that a parent on a starts together; its turn after starting them lasts
 * longer than they do, so both endings wait behind it and the first notification's turn carries the other (a batch).
 * The notification's turn says how many endings it heard.
 */
const batchWorld = (seed: number) => Sim.create({
  seed, env: { AGENT_LEASE_TTL_MS: "3000", AGENT_ORPHAN_SWEEP_MS: "2000", AGENT_CHILD_SWEEP_MS: "2000", AGENT_IDLE_MS: "600000" },
  respond: body => {
    const system = JSON.stringify(body.messages.filter((message: any) => message.role === "system"));
    const last = body.messages.at(-1);
    if (system.includes("WORKER")) return { content: "worked", delayMs: 2_000 };
    if (last.role === "tool") return { content: "spawned", delayMs: 6_000 };
    const said = JSON.stringify(last.content);
    if (said.includes("<agent_notification")) return { content: `heard ${said.split("<agent_notification ").length - 1}` };
    return { tool_calls: ["w1", "w2"].map((agent, index) => ({ index, id: `call_${agent}`, type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ agent, task: "work" }) } })) };
  },
});
async function spawnedTwo(sim: Sim, nodes: string[]) {
  for (const node of nodes) await sim.start(node);
  for (const key of ["w1", "w2"]) {
    const worker = (await sim.call("b", "/v1/agents", { body: { systemPrompt: "You are a WORKER." }, headers: { "Idempotency-Key": key } })).json.id;
    await outcome(sim, "b", worker, await prompt(sim, "b", worker, "warm up"));
  }
  const parent = (await sim.call("a", "/v1/agents", { body: { builtins: ["agents"], delegate: { agents: [{ agent: "w1" }, { agent: "w2" }] } } })).json.id;
  const first = await prompt(sim, "a", parent, "start both workers");
  return { parent, first };
}
/** Both endings reached the parent, each exactly once: in history (as a notification or in one's batch) and in what the model heard. */
async function bothHeardOnce(sim: Sim, node: string, parent: string) {
  await sim.until(async () => (await sim.db.query("select count(*)::int as n from agent_children where parent = $1 and state = 'notified'", [parent])).rows[0].n === 2, "both endings to land", 120_000);
  // (While its next owner takes the agent over, a read can answer without its requests: ask again.)
  await sim.until(async () => {
    const requests = (await sim.call(node, `/v1/agents/${parent}`)).json?.requests;
    return Array.isArray(requests) && requests.length > 0 && !requests.some((request: any) => request.state !== "completed");
  }, "the parent's runs to end", 120_000);
  const messages = ((await sim.call(node, `/v1/agents/${parent}/history`)).json.messages as any[]).filter((message: any) => message.source?.kind === "agent");
  const endings = messages.flatMap((message: any) => [message.metadata.agentId, ...(message.metadata.batch ?? []).map((ending: any) => ending.agentId)]);
  assert.equal(endings.length, 2, JSON.stringify(messages.map((message: any) => message.metadata)));
  assert.equal(new Set(endings).size, 2, "each ending once");
  const heard = sim.model.served.filter(served => JSON.stringify(served.body.messages.at(-1).content).includes("<agent_notification"))
    .reduce((sum, served) => sum + JSON.stringify(served.body.messages.at(-1).content).split("<agent_notification ").length - 1, 0);
  assert.equal(heard, 2, "the model heard each ending once");
  assert.deepEqual(sim.hooks.violations, []);
  return messages;
}

test("both endings wait behind a busy parent: one notification's turn carries the other, heard once", async t => {
  const sim = await batchWorld(61);
  t.after(() => sim.close());
  const { parent } = await spawnedTwo(sim, ["a", "b"]);
  const messages = await bothHeardOnce(sim, "a", parent);
  assert.equal(messages.length, 1, "one turn for both");
  assert.equal(messages[0].metadata.batch.length, 1);
});

test("a parent lost just after its notification claims a batch: the next owner lands the same batch, each ending heard once", async t => {
  const sim = await batchWorld(62);
  t.after(() => sim.close());
  const { parent } = await spawnedTwo(sim, ["a", "b", "c"]);
  // a's first notification claims the other ending into its turn (the statement commits) and is lost before the message lands.
  sim.pauseAtDbAnswer("a", 10_000, "jsonb_build_object('batchedInto'");
  await sim.until(() => sim.pauses.some(pause => pause.node === "a"), "a to stop as it claims the batch", 120_000);
  sim.crash("a");
  const messages = await bothHeardOnce(sim, "b", parent);
  assert.equal(messages.length, 1, "the next owner landed the claimed batch: one turn for both");
  // The carried child is charged to that turn once, though the claim's answer was lost with a (review of #725).
  const carried = (await sim.db.query("select notice->>'batchedInto' as into, notice->>'chargedInto' as charged from agent_children where parent = $1 and notice->>'batchedInto' is not null", [parent])).rows;
  assert.equal(carried.length, 1);
  assert.equal(carried[0].charged, carried[0].into);
});

test("a parent lost after its notification claims its own ending, before any batch: the other ending still lands once, on its own", async t => {
  const sim = await batchWorld(63);
  t.after(() => sim.close());
  const { parent } = await spawnedTwo(sim, ["a", "b", "c"]);
  sim.pauseAtDbAnswer("a", 10_000, "set landed_at = $3, landed_by = 'notice', state = 'notified', updated_at = $3 where child");
  await sim.until(() => sim.pauses.some(pause => pause.node === "a"), "a to stop as its notification lands", 120_000);
  sim.crash("a");
  await bothHeardOnce(sim, "b", parent);
});

/** A parent set to hear endings at once (delegate.notify "asap") that keeps working, a step at a time, until one reaches it. */
const asapWorld = (seed: number) => Sim.create({
  seed, env: { AGENT_LEASE_TTL_MS: "3000", AGENT_ORPHAN_SWEEP_MS: "2000", AGENT_CHILD_SWEEP_MS: "2000", AGENT_IDLE_MS: "600000" },
  respond: body => {
    const system = JSON.stringify(body.messages.filter((message: any) => message.role === "system"));
    const last = body.messages.at(-1);
    if (system.includes("WORKER")) return { content: "worked", delayMs: 1_000 };
    if (body.messages.some((message: any) => message.role === "user" && JSON.stringify(message.content).includes("<agent_notification"))) return { content: "heard" };
    const steps = body.messages.filter((message: any) => message.role === "tool").length;
    if (last.role === "tool" && steps < 120) return { tool_calls: [{ index: 0, id: `call_list_${steps}`, type: "function", function: { name: "list_agents", arguments: "{}" } }], delayMs: 250 };
    if (last.role === "tool") return { content: "never heard" };
    return { tool_calls: [{ index: 0, id: "call_spawn", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ agent: "w1", task: "work" }) } }] };
  },
});

test("asap: a parent lost as its running turn's notification is claimed still hears the ending exactly once", async t => {
  const sim = await asapWorld(64);
  t.after(() => sim.close());
  for (const node of ["a", "b", "c"]) await sim.start(node);
  const worker = (await sim.call("b", "/v1/agents", { body: { systemPrompt: "You are a WORKER." }, headers: { "Idempotency-Key": "w1" } })).json.id;
  await outcome(sim, "b", worker, await prompt(sim, "b", worker, "warm up"));
  const parent = (await sim.call("a", "/v1/agents", { body: { builtins: ["agents"], delegate: { agents: [{ agent: "w1" }], notify: "asap" } } })).json.id;
  await prompt(sim, "a", parent, "start the worker and keep working");
  // a claims the ending for its running turn (the landing's statement commits) and is lost before it offers it.
  sim.pauseAtDbAnswer("a", 10_000, "set landed_at = $3, landed_by = 'notice', state = 'notified', updated_at = $3 where child");
  await sim.until(() => sim.pauses.some(pause => pause.node === "a"), "a to stop as it claims the ending", 120_000);
  sim.crash("a");
  await sim.until(async () => (await sim.db.query("select state from agent_children where parent = $1", [parent])).rows[0]?.state === "notified", "the ending to land", 120_000);
  await sim.until(async () => {
    const requests = (await sim.call("b", `/v1/agents/${parent}`)).json?.requests;
    return Array.isArray(requests) && requests.length > 0 && !requests.some((request: any) => request.state !== "completed");
  }, "the parent's runs to end", 180_000);
  const messages = ((await sim.call("b", `/v1/agents/${parent}/history`)).json.messages as any[]).filter((message: any) => message.source?.kind === "agent");
  assert.equal(messages.length, 1, "one notification in history");
  const heard = sim.model.served.filter(served => JSON.stringify(served.body.messages.at(-1).content).includes("<agent_notification")).length;
  assert.equal(heard, 1, "the model heard it once");
  assert.deepEqual(sim.hooks.violations, []);
});
