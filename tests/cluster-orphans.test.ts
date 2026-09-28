import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeModel, sleep, token, until } from "./cluster-helpers.ts";

/** A tenant's agent whose first model call hangs on node A, which then dies: its turn is left unfinished, owned by a dead node. */
async function orphaned(t: Parameters<typeof cluster>[0], env: Record<string, string>) {
  const c = await cluster(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? undefined : { role: "assistant", content: "resumed" });
  const a = await c.start("a", { ...model.env, ...env });
  const b = await c.start("b", { ...model.env, ...env });
  const call = (base: string, path: string, body?: unknown) => fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(response => response.json() as Promise<any>);
  const agent = (await call(a.url, "/v1/agents", {})).id as string;
  await call(a.url, `/v1/agents/${agent}/prompt`, { text: "go", requestId: "turn-1" });
  await until(() => model.bodies.length === 1, "A to call the model");
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  await sleep(1500 + 500);
  return { c, b, model, agent, call };
}

test("reads of an agent whose node died answer from storage, and a prompt, which acts on it, resumes its turn", { timeout: 90_000 }, async t => {
  const { c, b, model, agent, call } = await orphaned(t, { AGENT_ORPHAN_SWEEP_MS: "0" });
  // Reads, as a REST tenant with browser watchers makes: from storage, loading nothing.
  await call(b.url, `/v1/agents/${agent}/history?limit=10`);
  const state = await call(b.url, `/v1/agents/${agent}/state`);
  assert.equal(state.requests.find((request: any) => request.id === "turn-1").state, "running");
  await sleep(500);
  assert.notEqual(await c.owner(agent), b.url);
  assert.equal(model.bodies.length, 1);
  // A prompt loads it on B, which resumes the turn first.
  await call(b.url, `/v1/agents/${agent}/prompt`, { text: "next", requestId: "turn-2" });
  await until(async () => (await call(b.url, `/v1/agents/${agent}/state`)).requests.filter((request: any) => ["turn-1", "turn-2"].includes(request.id) && request.state === "completed").length === 2, "both turns to finish", 20_000);
  assert.equal((await call(b.url, `/v1/agents/${agent}/state`)).requests.find((request: any) => request.id === "turn-1").resumes, 1);
});

test("an agent whose node died is resumed by the others' sweep, with no one reading it", { timeout: 90_000 }, async t => {
  const { c, b, model, agent, call } = await orphaned(t, { AGENT_ORPHAN_SWEEP_MS: "500" });
  await until(() => model.bodies.length === 2, "a sweep to resume the turn", 20_000);
  assert.equal(await c.owner(agent), b.url);
  await until(async () => (await call(b.url, `/v1/agents/${agent}/state`)).requests.find((request: any) => request.id === "turn-1")?.state === "completed", "the turn to finish", 20_000);
});

test("a run a drain left queued runs on another node's sweep, with no one reading the agent", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, async (_body, index) => { if (index === 0) await sleep(2_000); return { role: "assistant", content: `answer ${index}` }; });
  const env = { ...model.env, AGENT_ORPHAN_SWEEP_MS: "500" };
  const a = await c.start("a", env);
  await c.start("b", env);
  const call = (path: string, body?: unknown) => fetch(a.url + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(response => response.json() as Promise<any>);
  const agent = (await call("/v1/agents", {})).id as string;
  await call(`/v1/agents/${agent}/prompt`, { text: "first", requestId: "first" });
  await call(`/v1/agents/${agent}/prompt`, { text: "second", requestId: "second" });
  await until(() => model.bodies.length === 1, "the first run to call the model");
  // A drains: the first run finishes there; the second, never begun, is left queued for the next owner.
  const exited = once(a.child, "exit");
  a.child.kill("SIGTERM");
  await exited;
  assert.equal(model.bodies.length, 1);
  await until(() => model.bodies.length === 2, "B's sweep to run the queued prompt", 20_000);
  assert.match(JSON.stringify(model.bodies[1].messages), /second/);
});

test("a full node's sweep leaves an orphaned turn for a node with room, and never fails it for capacity", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  // The orphan's first call hangs on A (which dies); B's own agent holds B's one slot until the gate opens.
  const model = await fakeModel(t, async (body, index) => {
    const asked = JSON.stringify(body.messages);
    if (asked.includes("orphan-turn") && index === 0) return undefined;
    if (asked.includes("occupy")) await gate.promise;
    return { role: "assistant", content: "done" };
  });
  const env = { ...model.env, AGENT_ORPHAN_SWEEP_MS: "300", AGENT_IDLE_MS: "1000" };
  const a = await c.start("a", env);
  const b = await c.start("b", { ...env, AGENT_MAX_AGENTS: "1", AGENT_MAX_AGENTS_PER_TENANT: "1" });
  const call = (base: string, path: string, body?: unknown) => fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }).then(response => response.json() as Promise<any>);
  const made = await call(a.url, "/v1/agents", {});
  const orphan = made.id as string;
  await call(a.url, `/v1/agents/${orphan}/prompt`, { text: "orphan-turn", requestId: "turn-1" });
  await until(() => model.bodies.length === 1, "A to call the model");
  const busy = (await call(b.url, "/v1/agents", {})).id as string;
  await call(b.url, `/v1/agents/${busy}/prompt`, { text: "occupy", requestId: "occupy" });
  await until(() => model.bodies.length === 2, "B's own turn to take its slot");
  a.child.kill("SIGKILL");
  await once(a.child, "close");
  // B sweeps several times while full: the orphan's turn must not end.
  await sleep(1500 + 1_500);
  // Requests to it on B, which has no room for it: a read answers from storage, and a prompt or an
  // application's connection is asked to retry, instead of B loading it only to hand it back.
  const read = await call(b.url, `/v1/agents/${orphan}/state`);
  assert.equal(read.requests.find((request: any) => request.id === "turn-1").state, "running");
  const prompt = await fetch(`${b.url}/v1/agents/${orphan}/prompt`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ text: "more" }) });
  assert.equal(prompt.status, 503);
  assert.ok(prompt.headers.get("retry-after"));
  const attach = await fetch(`${b.url}/clients/${orphan}/events`, { headers: { Authorization: `Bearer ${made.token}` } });
  assert.equal(attach.status, 503);
  assert.ok(attach.headers.get("retry-after"));
  await attach.body?.cancel();
  await sleep(500);
  assert.notEqual(await c.owner(orphan), b.url, "nothing loaded it on B");
  gate.resolve();
  await until(async () => (await call(b.url, `/v1/agents/${orphan}/state`)).requests?.find((request: any) => request.id === "turn-1")?.state === "completed", "the orphan's turn to resume once B has room", 30_000);
  const outcome = (await call(b.url, `/v1/agents/${orphan}/state`)).requests.find((request: any) => request.id === "turn-1").outcome;
  assert.equal(outcome.error, undefined, JSON.stringify(outcome));
  const resumed = (await call(b.url, `/v1/agents/${orphan}/state`)).requests.find((request: any) => request.id === "turn-1");
  assert.equal(resumed.resumes, 1, "handing it back spent no resume");
  await until(async () => (await c.db.query("select pending_runs from agents where id = $1", [orphan])).rows[0].pending_runs === false, "its unload, with nothing open, to clear its mark", 20_000);
});
