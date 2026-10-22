import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Sim } from "./sim/sim.ts";
import type { SimDb } from "./sim/db.ts";
import { runPlan } from "./sim/run.ts";
import { resumeId } from "../src/client-sessions.ts";
import type { Plan } from "./sim/workload.ts";
import { prompt, outcome } from "./sim/scenario.ts";

/** What the host's markers in its Pi journal hold (their entries' values): the turn marked active or ended, a waiting call released. */
const HOST_MARKER = '"kind":"camel.history.marker"';
const TURN_ACTIVE = '{"t":"turn","active":true', TURN_ENDED = '{"t":"turn","active":false';
const RELEASED = '"released":true';

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
  // a takes the answer (b forwards it), begins the resume run, and has its agent mark the turn active (a marker in its Pi
  // journal). It stops there, before the agent releases the call to run it, past its lease: b takes the agent
  // over and finds the turn still suspended on the very call the resume answers.
  sim.pauseAtDbCommit("a", 10_000, TURN_ACTIVE);
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
  // One marker later: the call is released (it may be running), so the next owner must not run it again.
  sim.pauseAtDbCommit("a", 10_000, [HOST_MARKER, RELEASED]);
  await sim.env.settle(sim.request("b", `/v1/agents/${agent}/inputs/${input}`, { body: { action: "accept" } }).catch(() => undefined));
  const record = await outcome(sim, "b", agent, resumeId(suspension));
  assert.equal(record.resumes, 1);
  assert.match(record.outcome.result.reply, /outcome is unknown/);
  assert.equal(calls.length, 0, "never sent again");
  assert.deepEqual(sim.hooks.violations, []);
});

test("a prompt whose node is lost after its turn ended, before its run recorded the end, ends with the turn's reply on the next owner", async t => {
  const sim = await Sim.create({ seed: 46, env: { AGENT_LEASE_TTL_MS: "3000", AGENT_ORPHAN_SWEEP_MS: "2000" }, respond: () => ({ content: "the answer" }) });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  // a's marker ending the turn (the reply is written before it): a stops there, past its lease.
  sim.pauseAtDbCommit("a", 10_000, TURN_ENDED);
  await sim.env.settle(sim.request("b", `/v1/agents/${agent}/prompt`, { body: { text: "hi" }, headers: { "Idempotency-Key": "turn-1" } }).catch(() => undefined));
  const record = await outcome(sim, "b", agent, "turn-1");
  assert.equal(record.resumes, 1);
  assert.equal(record.outcome.error, undefined, JSON.stringify(record.outcome));
  assert.equal(record.outcome.result.reply, "the answer");
  assert.deepEqual(sim.model.served.map(served => served.from), ["a.sim"], "the model was not asked again");
  assert.ok(sim.hooks.reached.includes("a resumed run took the outcome of its turn that had ended"), "the node was lost where this is about");
});

test("an approval whose node is lost after its turn ended, before the resume recorded the end, ends with the turn's reply on the next owner", async t => {
  const sim = await approvalWorld(45);
  t.after(() => sim.close());
  const { agent, suspension, input, calls } = await approvalAsked(sim);
  // a's marker ending the resumed turn, its reply written: a stops there, past its lease.
  sim.pauseAtDbCommit("a", 10_000, TURN_ENDED);
  await sim.env.settle(sim.request("b", `/v1/agents/${agent}/inputs/${input}`, { body: { action: "accept" } }).catch(() => undefined));
  const record = await outcome(sim, "b", agent, resumeId(suspension));
  assert.equal(record.resumes, 1);
  assert.match(record.outcome.result.reply, /^heard: deleted a/, JSON.stringify(record.outcome));
  assert.equal(calls.length, 1);
  assert.deepEqual(sim.model.served.map(served => served.from), ["a.sim", "a.sim"]);
  assert.ok(sim.hooks.reached.includes("a resumed run took the outcome of its turn that had ended"), "the node was lost where this is about");
});

/**
 * A parent on a that starts the worker (an agent of its own, served by b) in the background: its first turn spawns it and
 * ends; the worker answers after three seconds; the notification's turn says "heard". Returns the parent, the worker and
 * the notification's request id.
 */
async function spawned(sim: Sim, nodes: string[]) {
  for (const node of nodes) await sim.start(node);
  // The worker is b's: made and run there first.
  const worker = (await sim.call("b", "/v1/agents", { body: { systemPrompt: "You are a WORKER." }, headers: { "Idempotency-Key": "worker" } })).json.id;
  await outcome(sim, "b", worker, await prompt(sim, "b", worker, "warm up"));
  const parent = (await sim.call("a", "/v1/agents", { body: { builtins: ["agents"], delegate: { agents: [{ agent: "worker" }] } } })).json.id;
  const first = await outcome(sim, "a", parent, await prompt(sim, "a", parent, "start the worker"));
  const call = first.outcome.result.toolCalls.find((entry: any) => entry.tool === "spawn_agent");
  assert.equal(call?.agentId, worker, JSON.stringify(first.outcome));
  const row = (await sim.db.query("select request_id from agent_children where parent = $1", [parent])).rows[0];
  return { parent, worker, notice: `child_${row.request_id}` };
}
const agentsWorld = (seed: number) => Sim.create({
  seed, env: { AGENT_LEASE_TTL_MS: "3000", AGENT_ORPHAN_SWEEP_MS: "2000", AGENT_CHILD_SWEEP_MS: "2000", AGENT_IDLE_MS: "600000" },
  respond: body => {
    const system = JSON.stringify(body.messages.filter((message: any) => message.role === "system"));
    const last = body.messages.at(-1);
    if (system.includes("WORKER")) return { content: "worked", delayMs: 3_000 };
    if (last.role === "tool") return { content: "spawned" };
    if (JSON.stringify(last.content).includes("<agent_notification")) return { content: "heard" };
    return { tool_calls: [{ index: 0, id: "call_spawn", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ agent: "worker", task: "work" }) } }] };
  },
});
/** The notification reached the parent once: one request, one message in history, one turn that heard it. */
async function notifiedOnce(sim: Sim, node: string, parent: string, notice: string) {
  const record = await outcome(sim, node, parent, notice);
  assert.equal(record.outcome.result.reply, "heard", JSON.stringify(record.outcome));
  const requests = (await sim.call(node, `/v1/agents/${parent}`)).json.requests.filter((request: any) => request.id.startsWith("child_"));
  assert.deepEqual(requests.map((request: any) => request.id), [notice]);
  const messages = (await sim.call(node, `/v1/agents/${parent}/history`)).json.messages.filter((message: any) => message.source?.kind === "agent");
  assert.equal(messages.length, 1, "one notification in history");
  assert.equal(sim.model.served.filter(served => JSON.stringify(served.body.messages.at(-1).content).includes("<agent_notification")).length, 1, "the model heard it once");
  const row = (await sim.db.query("select state, landed_by from agent_children where parent = $1", [parent])).rows[0];
  assert.deepEqual(row, { state: "notified", landed_by: "notice" });
  assert.deepEqual(sim.hooks.violations, []);
}

test("a child whose node is lost right after its run ends, before it delivers the ending, is delivered once by a sweep", async t => {
  const sim = await agentsWorld(47);
  t.after(() => sim.close());
  const { parent, notice } = await spawned(sim, ["a", "b"]);
  // b records the worker's run's end, then looks up its row to deliver it: it is lost there.
  sim.pauseAtDbAnswer("b", 10_000, "from agent_children where child");
  await sim.until(() => sim.pauses.some(pause => pause.node === "b"), "b to stop at the delivery");
  sim.crash("b");
  await notifiedOnce(sim, "a", parent, notice);
  assert.ok(sim.hooks.reached.includes("a sweep found a child's ended run that no one had recorded"), sim.hooks.reached.join(", "));
});

test("a parent whose node is lost as it takes a child's notification gets it once, from the next owner", async t => {
  const sim = await agentsWorld(48);
  t.after(() => sim.close());
  const { parent, notice } = await spawned(sim, ["a", "b", "c"]);
  // a writes the notification's record (its journal append lands) and is lost before it answers b.
  sim.pauseAtDbAnswer("a", 10_000, "insert into log_records");
  await sim.until(() => sim.pauses.some(pause => pause.node === "a"), "a to stop as it takes the notification");
  sim.crash("a");
  await notifiedOnce(sim, "b", parent, notice);
  // b's delivery got no answer: the notification was a's already (in its journal), and the next owner ran it.
  assert.ok(sim.hooks.reached.includes("a child's notification failed to reach its parent and was left for a sweep"), sim.hooks.reached.join(", "));
});

test("a child's node and then its parent's are both lost on the way: the notification still lands once, on the node left", async t => {
  const sim = await agentsWorld(49);
  t.after(() => sim.close());
  const { parent, notice } = await spawned(sim, ["a", "b", "c"]);
  sim.pauseAtDbAnswer("b", 10_000, "from agent_children where child");
  await sim.until(() => sim.pauses.some(pause => pause.node === "b"), "b to stop at the delivery");
  sim.crash("b");
  // A sweep records the ending and delivers it to a, which is lost as its notification's turn lands it.
  sim.pauseAtDbAnswer("a", 10_000, "set landed_at");
  await sim.until(() => sim.pauses.some(pause => pause.node === "a"), "a to stop as the notification lands", 120_000);
  sim.crash("a");
  await notifiedOnce(sim, "c", parent, notice);
  assert.ok(sim.hooks.reached.includes("a sweep found a child's ended run that no one had recorded"), sim.hooks.reached.join(", "));
  assert.ok(sim.hooks.reached.includes("a child's notification whose node was lost before its message landed landed on the next owner"), sim.hooks.reached.join(", "));
});

test("a notification refused at the wake cap whose node is lost after its message landed stays refused on the next owner: no model call", async t => {
  const sim = await Sim.create({
    seed: 50, env: { AGENT_LEASE_TTL_MS: "3000", AGENT_ORPHAN_SWEEP_MS: "2000", AGENT_CHILD_SWEEP_MS: "2000", AGENT_IDLE_MS: "600000", AGENT_WAKES_PER_HOUR: "1" },
    respond: body => {
      const system = JSON.stringify(body.messages.filter((message: any) => message.role === "system"));
      const last = body.messages.at(-1);
      if (system.includes("WORKER")) return { content: "worked", delayMs: 3_000 };
      if (last.role === "tool") return { content: "spawned" };
      if (JSON.stringify(last.content).includes("<agent_notification")) return { content: "heard" };
      return { tool_calls: [{ index: 0, id: "call_spawn", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ agent: "worker", task: "work" }) } }] };
    },
  });
  t.after(() => sim.close());
  const { parent, notice: first } = await spawned(sim, ["a", "b", "c"]);
  assert.equal((await outcome(sim, "a", parent, first)).outcome.result.reply, "heard", "the first notification's turn is within the cap");
  // The second spawn's notification is refused: a lands it, and is lost before it closes the turn.
  await outcome(sim, "a", parent, await prompt(sim, "a", parent, "start the worker again"));
  const heard = () => sim.model.served.filter(served => JSON.stringify(served.body.messages.at(-1).content).includes("<agent_notification")).length;
  const before = heard();
  // a lands the refused notification in its journal (a native entry of its own), and stops there, before it closes the turn.
  sim.pauseAtDbCommit("a", 10_000, ['"kind":"camel.user"', '"source":{"kind":"agent"']);
  const second = await sim.until(async () => (await sim.db.query("select request_id from agent_children where parent = $1 and id <> $2 and kind = 'spawn'", [parent, first.slice("child_".length)])).rows[0]?.request_id, "the second spawn's row");
  await sim.until(() => sim.pauses.some(pause => pause.node === "a"), "a to stop as the refused notification lands", 60_000);
  sim.crash("a");
  const record = await outcome(sim, "b", parent, `child_${second}`);
  assert.equal(record.outcome.result.stopped, "agent_loop_limit", JSON.stringify(record.outcome));
  assert.equal(heard(), before, "the model never heard the refused notification");
  const messages = (await sim.call("b", `/v1/agents/${parent}/history`)).json.messages.filter((message: any) => message.source?.kind === "agent");
  assert.equal(messages.length, 2, "both notifications are in history, once each");
  assert.ok(sim.hooks.reached.includes("a turn refused as its notification landed was resumed on another node, and kept the refusal"), sim.hooks.reached.join(", "));
  assert.deepEqual(sim.hooks.violations, []);
});

test("a notification delivered while the checks run is in its parent's history once its turn ends (seed 29880893)", async () => {
  // Minimized from seed 29880893: both nodes were lost around the child's ending, so its notification was delivered late,
  // as I21 looked. A notification lands (landed_at) as its turn begins, and its message is in history only once the turn
  // has it: I21 read the history in between and found it missing.
  const plan: Plan = JSON.parse(readFileSync(new URL("./sim/cases/notification-turn-running.json", import.meta.url), "utf8"));
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
});

test("a notification whose landing the database refuses for now is landed when tried again, not lost (seed 39319804)", async () => {
  // Minimized from seed 39319804: the notification's run marked the row landed, then counting its wake met a deadlock
  // (40P01), which failed the run: the message never reached history, and its request, ended, was never sent again.
  // A landing is now tried again on a transient refusal, as a run's start is.
  const plan: Plan = JSON.parse(readFileSync(new URL("./sim/cases/notification-landing-deadlock.json", import.meta.url), "utf8"));
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
});

test("a notification an abort reaches before its turn lands without one, not lost (seed 23594457)", async () => {
  // Minimized from seed 23594457: the parent was aborted while a child's notification run waited to land; the run ended
  // aborted after its row was marked landed, and the message never reached history. An abort now lands a notification
  // (and a child's message to its parent) without a turn, whether it was queued or about to begin. Timing elsewhere
  // moves where this plan's abort lands; the two scenarios below reach each path on purpose.
  const plan: Plan = JSON.parse(readFileSync(new URL("./sim/cases/notification-aborted.json", import.meta.url), "utf8"));
  const result = await runPlan(plan, { quiet: true });
  assert.deepEqual(result.failures, []);
});

/**
 * A parent that spawns a worker, then takes a three-second turn ("busy") the worker's notification queues behind. The
 * worker answers after a second; the notification's turn says "heard".
 */
const abortWorld = (seed: number) => Sim.create({
  seed, env: { AGENT_CHILD_SWEEP_MS: "2000", AGENT_IDLE_MS: "600000" },
  respond: body => {
    const system = JSON.stringify(body.messages.filter((message: any) => message.role === "system"));
    const last = body.messages.at(-1), said = JSON.stringify(last.content);
    if (system.includes("WORKER")) return { content: "worked", delayMs: 1_000 };
    if (last.role === "tool") return { content: "spawned" };
    if (said.includes("<agent_notification")) return { content: "heard" };
    if (said.includes("busy")) return { content: "busy done", delayMs: 3_000 };
    return { tool_calls: [{ index: 0, id: "call_spawn", type: "function", function: { name: "spawn_agent", arguments: JSON.stringify({ instructions: "You are a WORKER.", task: "work" }) } }] };
  },
});
/** The parent's notification ended aborted, its message in history once, and no turn ran for it. */
async function landedWithoutTurn(sim: Sim, parent: string) {
  const id = (await sim.until(async () => (await sim.call("a", `/v1/agents/${parent}`)).json.requests.find((request: any) => request.id.startsWith("child_") && request.state === "completed"), "the notification to end")).id;
  const record = await outcome(sim, "a", parent, id);
  assert.equal(record.outcome.result?.code, "aborted", JSON.stringify(record.outcome));
  const history = (await sim.call("a", `/v1/agents/${parent}/history`)).json.messages;
  assert.equal(history.filter((message: any) => message.requestId === id).length, 1, "the notification is in history once");
  assert.ok(!sim.model.served.some(served => JSON.stringify(served.body.messages.at(-1).content).includes("<agent_notification")), "no turn ran for it");
  assert.deepEqual(sim.hooks.violations, []);
}

test("an abort that reaches a notification queued behind the parent's turn lands it without a turn", async t => {
  const sim = await abortWorld(54);
  t.after(() => sim.close());
  await sim.start("a");
  const parent = (await sim.call("a", "/v1/agents", { body: { builtins: ["agents"], delegate: { instructions: true } } })).json.id;
  await outcome(sim, "a", parent, await prompt(sim, "a", parent, "spawn"));
  await prompt(sim, "a", parent, "busy");
  await sim.until(async () => (await sim.call("a", `/v1/agents/${parent}`)).json.requests.some((request: any) => request.id.startsWith("child_") && request.state === "running" && !request.began), "the notification to queue");
  assert.equal((await sim.call("a", `/v1/agents/${parent}/abort`, { body: {} })).status, 200);
  await landedWithoutTurn(sim, parent);
  assert.ok(sim.hooks.reached.includes("an abort reached a notification queued behind the turn, which lands without one"), sim.hooks.reached.join(", "));
});

test("an abort that reaches a notification's run after it began, before its message landed, lands it without a turn", async t => {
  const sim = await abortWorld(55);
  t.after(() => sim.close());
  await sim.start("a");
  const parent = (await sim.call("a", "/v1/agents", { body: { builtins: ["agents"], delegate: { instructions: true } } })).json.id;
  await outcome(sim, "a", parent, await prompt(sim, "a", parent, "spawn"));
  await prompt(sim, "a", parent, "busy");
  await sim.until(async () => (await sim.call("a", `/v1/agents/${parent}`)).json.requests.some((request: any) => request.id.startsWith("child_") && request.state === "running"), "the notification to queue");
  // The notification's run begins, and its start (settling the inputs a new message supersedes) meets statement
  // timeouts, so it waits to try again: the abort comes then.
  const db = sim.db as SimDb;
  db.errors = { rate: 1, codes: ["57014"], random: { float: () => 0, int: () => 0 }, only: /agent_inputs/ };
  await sim.until(async () => (await sim.call("a", `/v1/agents/${parent}`)).json.requests.some((request: any) => request.id.startsWith("child_") && request.began), "the notification's run to begin");
  await sim.call("a", `/v1/agents/${parent}/abort`, { body: {} });
  db.errors = undefined;
  await landedWithoutTurn(sim, parent);
  assert.ok(sim.hooks.reached.includes("an abort reached a notification's run before its message landed, which landed without a turn"), sim.hooks.reached.join(", "));
});

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
    if (last.role === "tool") return JSON.stringify(last.content).includes("unknown") && !body.messages.some((message: any) => message.tool_calls?.some((call: any) => call.id === "call_again"))
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
