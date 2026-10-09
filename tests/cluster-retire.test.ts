import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime } from "../clients/typescript.ts";
import { cluster, fakeEcs, sleep, token, until } from "./cluster-helpers.ts";

const retiring = (node: { logs: any[] }) => node.logs.some(entry => entry.type === "retiring");

test("a superseded task keeps serving until its replacements run and one has joined, then retires to them", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const ecs = await fakeEcs(t);
  const a = await c.start("a", ecs.env);
  const viaA = new AgentRuntime({ url: a.url, apiKey: token });

  // A deployment begins: its tasks are not running yet, so A goes on serving as before.
  ecs.state.revision = 2;
  ecs.state.created = Date.now() / 1000;
  ecs.state.running = 0;
  await sleep(1_000);
  assert.ok(!retiring(a), "no replacement runs yet");
  const early = await viaA.createAgent({ tools: {}, idempotencyKey: "while-deploying" });
  await early.close();
  assert.equal(await c.owner(early.session.id), a.url);

  // Its task runs but has not joined the cluster: still nobody to hand work to.
  ecs.state.running = 1;
  await sleep(1_000);
  assert.ok(!retiring(a), "no peer has joined yet");

  const b = await c.start("b");
  await until(() => retiring(a), "A retired once B joined");
  const fresh = await viaA.createAgent({ tools: {}, idempotencyKey: "after-replacement" });
  await fresh.close();
  assert.equal(await c.owner(fresh.session.id), b.url, "new agents start on the replacement");
});

test("a retiring task whose peers are all gone goes back to serving, and retires again once one joins", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const ecs = await fakeEcs(t);
  const a = await c.start("a", ecs.env);
  const b = await c.start("b");
  ecs.state.revision = 2;
  ecs.state.created = Date.now() / 1000;
  await until(() => retiring(a), "A retired to B");

  b.child.kill("SIGKILL");
  await until(() => a.logs.some(entry => entry.type === "retire_paused"), "A saw it was alone");
  const health = await fetch(`${a.url}/healthz`);
  assert.deepEqual(await health.json(), { ok: true });
  const viaA = new AgentRuntime({ url: a.url, apiKey: token });
  const agent = await viaA.createAgent({ tools: {}, idempotencyKey: "served-while-alone" });
  assert.equal((await agent.execute('return "on a"', { timeoutMs: 30_000 })).output[0], "on a", "A takes and runs new work instead of refusing it");
  await agent.close();
  assert.equal(await c.owner(agent.session.id), a.url);

  await c.start("c");
  await until(() => a.logs.filter(entry => entry.type === "retiring").length === 2, "A retired again once C joined");
});

test("a request forwarded to a retiring task that does not hold its agent goes on to the owner, or a peer that takes it", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const ecs = await fakeEcs(t);
  const a = await c.start("a", { AGENT_IDLE_MS: "1000" });
  const b = await c.start("b", ecs.env);
  const viaA = new AgentRuntime({ url: a.url, apiKey: token });
  const held = await viaA.createAgent({ tools: {}, idempotencyKey: "held-by-a" });
  const released = await viaA.createAgent({ tools: {}, idempotencyKey: "released-by-a" });
  await released.close();
  // Released, or let go by a fence (a stall on a loaded runner): either way no node holds it.
  await until(async () => !await c.liveOwner(released.session.id), "A released the idle agent");
  // Keep the other one loaded on A.
  const keep = setInterval(() => void fetch(`${a.url}/clients/${held.session.id}/state`, { headers: { Authorization: `Bearer ${held.session.token}` } }).catch(() => {}), 200);
  t.after(() => { clearInterval(keep); return held.close(); });

  ecs.state.revision = 2;
  ecs.state.created = Date.now() / 1000;
  await until(() => retiring(b), "B retired to A");
  // As from a peer whose cached owner is B, a moment after B let the agent go.
  for (const agent of [held, released]) {
    const response = await fetch(`${b.url}/clients/${agent.session.id}/state`, { headers: { Authorization: `Bearer ${agent.session.token}`, "x-agent-runtime-forwarded": a.url } });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await c.owner(agent.session.id), a.url);
  }
});
