import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Sim } from "./sim/sim.ts";
import { BUGGIFY_SITES, COVERAGE_GOALS } from "./sim/hooks.ts";

// Faults in the simulator: crashes, restarts, partitions, database outages and BUGGIFY, on virtual time.

const echo = (delayMs = 0) => (body: any) => ({ content: `answered: ${JSON.stringify(body.messages.filter((message: any) => message.role === "user").at(-1)?.content)}`, delayMs });

/** Prompt `agent` through `node`, retrying a 503 a second later as clients do (Retry-After). */
async function prompt(sim: Sim, node: string, agent: string, text: string) {
  const accepted = await sim.until(async () => {
    const answer = await sim.call(node, `/v1/agents/${agent}/prompt`, { body: { text }, headers: { "Idempotency-Key": `prompt-${text.replace(/[^a-z0-9]/gi, "-")}` } });
    if (answer.status === 503) return undefined;
    return answer;
  }, "the prompt to be accepted", 60_000, 1_000);
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  return accepted.json.id as string;
}
/** The request's record once it ended, asked of whichever live node answers. */
function ended(sim: Sim, agent: string, id: string, limitMs = 120_000) {
  return sim.until(async () => {
    for (const node of sim.nodes.values()) {
      if (node.crashed) continue;
      const record = (await sim.call(node.name, `/v1/agents/${agent}/requests/${id}`)).json;
      if (record?.state === "completed") return record;
    }
    return undefined;
  }, `request ${id} to end`, limitMs);
}

test("a node that crashes mid-turn: a peer reaps it, takes its agent over and finishes the run", async t => {
  const sim = await Sim.create({ seed: 11, respond: echo(5_000) });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  const id = await prompt(sim, "a", agent, "survive this");
  await sim.until(() => sim.model.served.length === 1, "the model call");
  sim.crash("a");
  const record = await ended(sim, agent, id);
  assert.equal(record.outcome.error, undefined, JSON.stringify(record.outcome));
  // The turn was made again on b: the first call's answer never reached the runtime.
  assert.deepEqual(sim.model.served.map(served => served.from), ["a.sim", "b.sim"]);
  assert.ok(sim.hooks.reached.includes("an actor was taken again, under a later epoch"), sim.hooks.reached.join(", "));
  assert.deepEqual(sim.hooks.violations, []);
  assert.deepEqual(sim.env.leaks, []);
  // a comes back as a new process and serves again.
  await sim.restart("a");
  assert.equal((await sim.call("a", `/v1/agents/${agent}/state`)).status, 200);
});

test("a node cut off from the database fences itself, and its agents move to a peer", async t => {
  const sim = await Sim.create({ seed: 12, respond: echo() });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  await ended(sim, agent, await prompt(sim, "a", agent, "first"));
  sim.databaseDown("a");
  await sim.until(() => sim.hooks.reached.includes("a node fenced itself"), "a to fence itself");
  const record = await ended(sim, agent, await prompt(sim, "b", agent, "second"));
  assert.equal(record.outcome.error, undefined, JSON.stringify(record.outcome));
  assert.equal(sim.model.served.at(-1)!.from, "b.sim");
  assert.deepEqual(sim.hooks.violations, []);
});

test("BUGGIFY: a lost append answer is repeated, and the turn's records land once", async t => {
  const sim = await Sim.create({ seed: 13, respond: echo(), buggify: { "tail.append.lost_ack": 0.5 } });
  t.after(() => sim.close());
  await sim.start("a");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  for (const text of ["one", "two", "three"]) assert.equal((await ended(sim, agent, await prompt(sim, "a", agent, text))).outcome.error, undefined);
  assert.ok((sim.hooks.fired.get("tail.append.lost_ack") ?? 0) > 0);
  assert.ok(sim.hooks.reached.includes("a tail append was repeated while the database was unavailable"));
  const history = (await sim.call("a", `/v1/agents/${agent}/history`)).json;
  const said = history.messages.filter((message: any) => message.role === "user").map((message: any) => JSON.stringify(message.content));
  assert.equal(said.length, 3, JSON.stringify(said));
});

test("the simulator knows the runtime's BUGGIFY sites and coverage goals", () => {
  assert.ok(BUGGIFY_SITES.includes("ownership.renew.fails") && BUGGIFY_SITES.length >= 7, BUGGIFY_SITES.join(", "));
  assert.ok(COVERAGE_GOALS.includes("a node fenced itself") && COVERAGE_GOALS.length >= 9, COVERAGE_GOALS.join(", "));
});

/** Two nodes, swarm BUGGIFY, a crash and a restart mid-run; the trace, hashed. */
async function faulty(seed: number) {
  const sim = await Sim.create({ seed, respond: echo(1_500), buggify: "swarm" });
  try {
    await sim.start("a");
    await sim.start("b");
    const agents: string[] = [];
    for (const node of ["a", "b"]) agents.push((await sim.call(node, "/v1/agents", { body: {} })).json.id);
    const ids = [await prompt(sim, "a", agents[0], "zero"), await prompt(sim, "b", agents[1], "one")];
    await sim.advance(700);
    sim.crash("a");
    await sim.advance(3_000);
    await sim.restart("a");
    const outcomes = [];
    for (const [index, id] of ids.entries()) outcomes.push((await ended(sim, agents[index], id)).outcome);
    return createHash("sha256").update(JSON.stringify({ outcomes, statements: sim.db.statements, connections: sim.net.connections, served: sim.model.served.map(served => [served.from, served.at]), fired: [...sim.hooks.fired], plan: sim.hooks.plan })).digest("hex");
  } finally { await sim.close(); }
}

test("a run with BUGGIFY, a crash and a restart replays the same way from its seed", async () => {
  assert.equal(await faulty(21), await faulty(21));
});

test("a turn whose commits lose their answers past the retry window is given up and resumed from storage, not left running (seed 2686)", async t => {
  // From the turn's model call on, every append's answer is lost: the commits after it are repeated until the window
  // closes, and the session faults with its lease still healthy, the turn begun in its journal and not ended.
  let armed = false;
  const sim = await Sim.create({ seed: 14, respond: (body, served) => {
    if (served.length === 0) { sim.hooks.plan["tail.append.lost_ack"] = 1; armed = true; }
    return echo(1_000)(body);
  } });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  const released = () => sim.env.logs.filter(log => log.line.includes('"session_fault_released"'));
  const id = await prompt(sim, "a", agent, "begin");
  await sim.until(() => released().length > 0, "the faulted session to be given up", 30_000).catch(() => {});
  assert.ok(armed);
  delete sim.hooks.plan["tail.append.lost_ack"];
  // Its next load resumes it from storage, rather than it being left running on a node that can no longer write it.
  const record = await ended(sim, agent, id);
  assert.equal(record.outcome.error, undefined, JSON.stringify(record.outcome));
  // Its answer was written with the answers lost (as they were): the next owner finds it there and calls the model no more.
  assert.equal(sim.model.served.length, 1);
  assert.equal(released().length, 1);
  assert.equal(released()[0].by, "a#1");
  assert.match(released()[0].line, /"store":"(journal|transcript)"/);
  // The agent takes new work afterwards, wherever it is served now.
  const next = await ended(sim, agent, await prompt(sim, "b", agent, "after"));
  assert.equal(next.outcome.error, undefined, JSON.stringify(next.outcome));
  const history = (await sim.call("b", `/v1/agents/${agent}/history`)).json;
  const said = history.messages.filter((message: any) => message.role === "user" && Array.isArray(message.content)).map((message: any) => message.content[0].text);
  assert.deepEqual(said, ["begin", "after"]);
  assert.deepEqual(sim.hooks.violations, []);
  assert.deepEqual(sim.env.leaks, []);
});

test("an agent whose appends keep losing their answers is given up once per sweep interval, not in a loop", async t => {
  const sim = await Sim.create({ seed: 15, respond: (body, served) => {
    if (served.length === 0) sim.hooks.plan["tail.append.lost_ack"] = 1;
    return echo(1_000)(body);
  } });
  t.after(() => sim.close());
  await sim.start("a");
  await sim.start("b");
  const agent = (await sim.call("a", "/v1/agents", { body: {} })).json.id;
  const id = await prompt(sim, "a", agent, "begin");
  await sim.until(() => sim.model.served.length === 1, "the model call");
  const from = sim.env.elapsed;
  await sim.env.advance(120_000);
  const since = (type: string) => sim.env.logs.filter(log => log.at >= from && log.line.includes(`"${type}"`)).length;
  assert.ok(since("session_fault_released") >= 1 && since("session_fault_released") <= 6, `released ${since("session_fault_released")} times in two minutes`);
  assert.ok(since("agent_resume_failed") <= 6, `${since("agent_resume_failed")} failed loads in two minutes`);
  delete sim.hooks.plan["tail.append.lost_ack"];
  await ended(sim, agent, id, 3_600_000);
  const next = await ended(sim, agent, await prompt(sim, "b", agent, "after"));
  assert.equal(next.outcome.error, undefined, JSON.stringify(next.outcome));
  assert.deepEqual(sim.hooks.violations, []);
});
