import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeEcs, fakeModel, sleep, token, until } from "./cluster-helpers.ts";

// Production's lease, and a periodic sweep too slow to matter: what resumes the work below is a dead node
// found by its peers, or a node that left work telling them.
const PROD = { AGENT_LEASE_TTL_MS: "90000", AGENT_ORPHAN_SWEEP_MS: "600000" };

const call = (base: string, path: string, body?: unknown) => fetch(base + path, {
  method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(response => response.json() as Promise<any>);

/** Two nodes, and an agent on A whose turn is waiting on its first model call. */
async function midTurn(t: Parameters<typeof cluster>[0], env: Record<string, string>, respond: Parameters<typeof fakeModel>[1]) {
  const c = await cluster(t);
  const model = await fakeModel(t, respond);
  const a = await c.start("a", { ...model.env, ...PROD, ...env });
  const b = await c.start("b", { ...model.env, ...PROD });
  const agent = (await call(a.url, "/v1/agents", {})).id as string;
  await call(a.url, `/v1/agents/${agent}/prompt`, { text: "go", requestId: "turn-1" });
  await until(() => model.bodies.length === 1, "A to call the model");
  return { c, model, a, b, agent };
}

test("a node killed mid-turn: a peer finds it dead and calls the model again within 20 s (6-13 s: three renewals late, then a probe), not after the 90 s lease", { timeout: 90_000 }, async t => {
  const { c, model, a, b, agent } = await midTurn(t, {}, (_body, index) => index === 0 ? undefined : { role: "assistant", content: "resumed" });
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  const killed = Date.now();
  await until(() => model.bodies.length === 2, "B to resume the turn", 30_000);
  const ms = Date.now() - killed;
  assert.ok(ms < 20_000, `resumed ${ms} ms after the crash`);
  assert.ok(b.logs.some(entry => entry.type === "node_reaped" && entry.node === a.url));
  assert.equal(await c.owner(agent), b.url);
  await until(async () => (await call(b.url, `/v1/agents/${agent}/state`)).requests.find((request: any) => request.id === "turn-1")?.state === "completed", "the turn to finish");
  assert.equal((await call(b.url, `/v1/agents/${agent}/state`)).requests.find((request: any) => request.id === "turn-1").resumes, 1);
});

test("a drain that times out hands its turn off, and a peer calls the model again within 3 s of the hand-off", { timeout: 90_000 }, async t => {
  const { c, model, a, b, agent } = await midTurn(t, { AGENT_DRAIN_TIMEOUT_MS: "1000" }, (_body, index) => index === 0 ? undefined : { role: "assistant", content: "resumed" });
  const exited = once(a.child, "exit");
  const signalled = Date.now();
  a.child.kill("SIGTERM");
  await until(() => model.bodies.length === 2, "B to resume the handed-off turn", 30_000);
  // The drain waits 1 s for the turn, then hands it off.
  const ms = Date.now() - signalled - 1_000;
  assert.ok(ms < 3_000, `resumed ${ms} ms after the hand-off`);
  assert.equal((await exited)[0], 0);
  assert.equal(a.logs.find(entry => entry.type === "drain_finished")?.unfinished, 1);
  assert.ok(!b.logs.some(entry => entry.type === "node_reaped"), "the drained node left; nothing was found dead");
  assert.equal(await c.owner(agent), b.url);
});

test("a deploy: a retiring task finishes its turn, and the run it left queued starts on the replacement within 3 s", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const ecs = await fakeEcs(t);
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const model = await fakeModel(t, async (_body, index) => { if (index === 0) await gate.promise; return { role: "assistant", content: `answer ${index}` }; });
  const a = await c.start("a", { ...model.env, ...PROD, ...ecs.env });
  const agent = (await call(a.url, "/v1/agents", {})).id as string;
  await call(a.url, `/v1/agents/${agent}/prompt`, { text: "first", requestId: "first" });
  await until(() => model.bodies.length === 1, "the first run to call the model");
  ecs.state.revision = 2;
  ecs.state.created = Date.now() / 1000;
  const b = await c.start("b", { ...model.env, ...PROD });
  await until(() => a.logs.some(entry => entry.type === "retiring"), "A to retire once B joined");
  // Queued behind the running turn: a retiring node leaves it for the next owner.
  await call(a.url, `/v1/agents/${agent}/prompt`, { text: "second", requestId: "second" });
  await sleep(300);
  gate.resolve();
  const released = Date.now();
  await until(() => model.bodies.length === 2, "B to run the queued prompt", 30_000);
  const ms = Date.now() - released;
  assert.ok(ms < 3_000, `the queued run started ${ms} ms after the turn ended`);
  assert.match(JSON.stringify(model.bodies[1].messages), /second/);
  assert.equal(await c.owner(agent), b.url);
});

test("a stalled node is not taken for dead: its peer waits, and its turn carries on there when it wakes", { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  // A 12 s lease: renewed every 2 s, so a suspect after 6 s; A fences itself 10.8 s after its last renewal began.
  const { c, model, a, b, agent } = await midTurn(t, { AGENT_LEASE_TTL_MS: "12000" }, async (_body, index) => { if (index === 0) await gate.promise; return { role: "assistant", content: "finished on a" }; });
  // As a long pause would (garbage collection, a blocked event loop): no renewal, but its socket still accepts.
  a.child.kill("SIGSTOP");
  await sleep(7_500);
  a.child.kill("SIGCONT");
  assert.ok(!b.logs.some(entry => entry.type === "node_reaped"), "B probed A and found it alive");
  assert.equal(await c.owner(agent), a.url);
  gate.resolve();
  await until(async () => (await call(b.url, `/v1/agents/${agent}/state`)).requests.find((request: any) => request.id === "turn-1")?.state === "completed", "the turn to finish on A");
  assert.equal(model.bodies.length, 1, "the model was called once: the turn never moved");
  const turn = (await call(b.url, `/v1/agents/${agent}/state`)).requests.find((request: any) => request.id === "turn-1");
  assert.equal(turn.resumes, undefined, JSON.stringify(turn));
  assert.equal(turn.outcome.error, undefined, JSON.stringify(turn));
});
