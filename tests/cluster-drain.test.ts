import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { AgentRuntime, memoryJournalStore, schema, tool } from "../clients/typescript.ts";
import { balancer, cluster, sleep, token } from "./cluster-helpers.ts";

test("a draining node finishes the turn in flight, leaves queued runs for the next owner, releases, and exits 0", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const tools = {
    slow: tool({ description: "Wait for the test", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "slow-done"; } }),
  };
  const created = await new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() }).createAgent({ tools, idempotencyKey: "draining-agent" });
  await created.close();
  assert.equal(await c.owner(created.session.id), a.url);

  // The client reaches A through B, as it would through the load balancer.
  const client = await new AgentRuntime({ url: b.url, apiKey: token, journalStore: memoryJournalStore() }).connectAgent(created.session, { tools });
  t.after(() => client.close());
  const first = client.execute("return await tools.slow({})", { timeoutMs: 60_000 });
  await entered.promise;

  const exited = once(a.child, "exit");
  a.child.kill("SIGTERM");
  for (let tries = 0; (await fetch(`${a.url}/healthz`)).status !== 503; tries++) { assert.ok(tries < 50, "/healthz fails while draining"); await sleep(50); }
  assert.ok(a.logs.some(entry => entry.type === "drain_started"));
  // Accepted by A while it drains, but never begun there.
  const second = client.execute('return "after the move"', { timeoutMs: 60_000 });
  await sleep(500);
  assert.equal(await c.owner(created.session.id), a.url, "A holds the agent while its turn runs");
  const pending = await (await fetch(`${b.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } })).json() as any;
  assert.deepEqual(pending.requests.map((request: any) => [request.state, !!request.began]), [["running", true], ["running", false]]);

  gate.resolve();
  assert.equal((await first).output[0], "slow-done", "the turn in flight finished on A");
  const [code] = await exited;
  assert.equal(code, 0);
  const finished = a.logs.find(entry => entry.type === "drain_finished");
  assert.equal(finished?.unfinished, 0);
  assert.equal((await c.db.query("select count(*) as count from runtime_nodes where node = $1", [a.url])).rows[0].count, 0, "A deleted its heartbeat");

  // The client's stream closed after the release; it reconnected through B, which now serves the agent and runs the queued request.
  assert.equal((await second).output[0], "after the move");
  assert.equal(await c.owner(created.session.id), b.url);
  const state = await (await fetch(`${b.url}/clients/${created.session.id}/state`, { headers: { Authorization: `Bearer ${created.session.token}` } })).json() as any;
  assert.ok(state.requests.every((request: any) => request.state === "completed" && !request.outcome.error), JSON.stringify(state.requests));
});

test("a draining node sends requests for actors it does not hold to a live peer", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a");
  const b = await c.start("b");
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const tools = { slow: tool({ description: "Wait", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "ok"; } }) };
  const viaA = new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() });
  const busy = await viaA.createAgent({ tools, idempotencyKey: "keeps-a-draining" });
  t.after(() => busy.close());
  const running = busy.execute("return await tools.slow({})", { timeoutMs: 60_000 });
  await entered.promise;
  a.child.kill("SIGTERM");
  for (let tries = 0; (await fetch(`${a.url}/healthz`)).status !== 503; tries++) { assert.ok(tries < 50); await sleep(50); }

  // A new agent and a new volume asked of A while it drains are made on B.
  const agent = await viaA.createAgent({ tools: {}, idempotencyKey: "made-during-drain" });
  await agent.close();
  assert.equal(await c.owner(agent.session.id), b.url);
  const { id } = await viaA.createVolume({ name: "during-drain" });
  await viaA.volume(id).write("a.txt", "x");
  assert.equal(await c.owner(id), b.url);
  gate.resolve();
  await running;
  assert.equal((await once(a.child, "exit"))[0], 0);
});

test("with no live peer, a draining node answers 503 with Retry-After for anything it would have to take", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const a = await c.start("a", { AGENT_IDLE_MS: "1000" });
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const tools = { slow: tool({ description: "Wait", input: schema.Object({}, { additionalProperties: false }), execute: async () => { entered.resolve(); await gate.promise; return "ok"; } }) };
  const runtime = new AgentRuntime({ url: a.url, apiKey: token, journalStore: memoryJournalStore() });
  const idle = await runtime.createAgent({ tools: {}, idempotencyKey: "released-early" });
  await idle.close();
  const busy = await runtime.createAgent({ tools, idempotencyKey: "keeps-a-draining" });
  t.after(() => busy.close());
  const running = busy.execute("return await tools.slow({})", { timeoutMs: 60_000 });
  await entered.promise;
  // The idle agent unloads, so A no longer holds it.
  for (let tries = 0; await c.owner(idle.session.id); tries++) { assert.ok(tries < 100, "the idle agent was released"); await sleep(100); }
  a.child.kill("SIGTERM");
  for (let tries = 0; (await fetch(`${a.url}/healthz`)).status !== 503; tries++) { assert.ok(tries < 50); await sleep(50); }

  const created = await fetch(`${a.url}/v1/agents`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "during-drain" }, body: "{}" });
  assert.equal(created.status, 503, await created.clone().text());
  assert.equal(created.headers.get("retry-after"), "1");
  const loaded = await fetch(`${a.url}/clients/${idle.session.id}/state`, { headers: { Authorization: `Bearer ${idle.session.token}` } });
  assert.equal(loaded.status, 503);
  assert.equal(loaded.headers.get("retry-after"), "1");
  gate.resolve();
  assert.equal((await running).output[0], "ok");
  assert.equal((await once(a.child, "exit"))[0], 0);
});
