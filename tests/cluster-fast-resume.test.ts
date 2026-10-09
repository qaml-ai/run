import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeEcs, fakeModel, sleep, token, until } from "./cluster-helpers.ts";

// Production's lease, and a periodic sweep too slow to matter: what resumes the work below is a dead node
// found by its peers, or a node that left work telling them.
const PROD = { AGENT_LEASE_TTL_MS: "90000", AGENT_ORPHAN_SWEEP_MS: "600000" };
/**
 * How soon work a node leaves behind gets going on a peer. The node tells its peers as it gives the agent up, so one
 * loads it at once, not at its next sweep (10 min here) or once the lease runs out (90 s). That takes about 0.6 s on an
 * idle machine. On a loaded runner it took up to 6.8 s, past the 3 s these tests once asked for: up to 2.6 s from the
 * turn's end to the peer's load, and up to 3.6 s for the peer to start the agent's process. 10 s still tells being told
 * apart from those.
 */
const PROMPTLY_MS = 10_000;

const call = (base: string, path: string, body?: unknown) => fetch(base + path, {
  method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
}).then(response => response.json() as Promise<any>);

/** Two nodes, and an agent on A whose turn is waiting on its first model call. `env` is A's; `both` is both nodes'. */
async function midTurn(t: Parameters<typeof cluster>[0], env: Record<string, string>, respond: Parameters<typeof fakeModel>[1], both: Record<string, string> = {}) {
  const c = await cluster(t);
  const model = await fakeModel(t, respond);
  const a = await c.start("a", { ...model.env, ...PROD, ...both, ...env });
  const b = await c.start("b", { ...model.env, ...PROD, ...both });
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

test("a drain that times out hands its turn off, and a peer calls the model again within seconds of the hand-off", { timeout: 90_000 }, async t => {
  const { c, model, a, b, agent } = await midTurn(t, { AGENT_DRAIN_TIMEOUT_MS: "1000" }, (_body, index) => index === 0 ? undefined : { role: "assistant", content: "resumed" });
  const exited = once(a.child, "exit");
  const signalled = Date.now();
  a.child.kill("SIGTERM");
  await until(() => model.bodies.length === 2, "B to resume the handed-off turn", 30_000);
  // The drain waits 1 s for the turn, then hands it off.
  const ms = Date.now() - signalled - 1_000;
  assert.ok(ms < PROMPTLY_MS, `resumed ${ms} ms after the hand-off`);
  assert.equal((await exited)[0], 0);
  assert.equal(a.logs.find(entry => entry.type === "drain_finished")?.unfinished, 1);
  assert.ok(!b.logs.some(entry => entry.type === "node_reaped" && entry.node === a.url), "the drained node left; it was not found dead");
  assert.equal(await c.owner(agent), b.url);
});

test("a deploy: a retiring task finishes its turn, and the run it left queued starts on the replacement within seconds", { timeout: 90_000 }, async t => {
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
  assert.ok(ms < PROMPTLY_MS, `the queued run started ${ms} ms after the turn ended`);
  assert.match(JSON.stringify(model.bodies[1].messages), /second/);
  assert.equal(await c.owner(agent), b.url);
});

test("a stalled node is not taken for dead: its peer waits, and its turn carries on there when it wakes", { timeout: 90_000 }, async t => {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  // A 30 s lease: renewed every 3 s, so a suspect once its last renewal began 9 s ago; A fences itself 27 s after its last
  // successful renewal began. The stop must outlast the suspicion and stay short of the fence wherever it falls between
  // renewals. 12 s does both with room: B suspects A at most 9 s into it and probes at its next renewal, at most 3 s
  // later; and A wakes at most 18 s after a renewal it saw succeed, 9 s before its fence, even if the renewal due as it
  // stopped had not landed. Under a 12 s lease for A (fence at 10.8 s) a 7.5 s stop left 1.3 s for that: on a loaded CI
  // runner A woke 11.5 s after its last renewal, fenced, and the turn moved to B. Both nodes have the lease, as a cluster's do.
  const { c, model, a, b, agent } = await midTurn(t, {}, async (_body, index) => { if (index === 0) await gate.promise; return { role: "assistant", content: "finished on a" }; }, { AGENT_LEASE_TTL_MS: "30000" });
  // As a long pause would (garbage collection, a blocked event loop): no renewal, but its socket still accepts.
  a.child.kill("SIGSTOP");
  await sleep(12_000);
  a.child.kill("SIGCONT");
  assert.ok(!b.logs.some(entry => entry.type === "node_reaped" && entry.node === a.url), "B probed A and found it alive");
  assert.equal(await c.owner(agent), a.url);
  gate.resolve();
  await until(async () => (await call(b.url, `/v1/agents/${agent}/state`)).requests.find((request: any) => request.id === "turn-1")?.state === "completed", "the turn to finish on A");
  assert.equal(model.bodies.length, 1, "the model was called once: the turn never moved");
  const turn = (await call(b.url, `/v1/agents/${agent}/state`)).requests.find((request: any) => request.id === "turn-1");
  assert.equal(turn.resumes, undefined, JSON.stringify(turn));
  assert.equal(turn.outcome.error, undefined, JSON.stringify(turn));
});
