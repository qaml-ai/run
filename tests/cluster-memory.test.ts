import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeModel, sleep, token, until } from "./cluster-helpers.ts";

test("a node short of memory starts no agent and takes no orphaned work; a node with room does both", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const model = await fakeModel(t, async (_body, index) => { if (index === 0) await sleep(2_000); return { role: "assistant", content: `answer ${index}` }; });
  // Any resident memory is over a 1-byte mark: A is always short of it.
  const a = await c.start("a", { ...model.env, AGENT_MEMORY_HIGH_BYTES: "1", AGENT_ORPHAN_SWEEP_MS: "300" });
  const b = await c.start("b", { ...model.env, AGENT_ORPHAN_SWEEP_MS: "300" });
  const call = (base: string, path: string, body?: unknown) => fetch(base + path, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(async response => ({ status: response.status, json: await response.json().catch(() => undefined) as any }));
  const refused = await call(a.url, "/v1/agents", {});
  assert.equal(refused.status, 503); assert.match(JSON.stringify(refused.json), /short of memory/);
  const agent = (await call(b.url, "/v1/agents", {})).json.id as string;
  await call(b.url, `/v1/agents/${agent}/prompt`, { text: "first", requestId: "first" });
  await call(b.url, `/v1/agents/${agent}/prompt`, { text: "second", requestId: "second" });
  await until(() => model.bodies.length === 1, "the first run to call the model");
  // B drains: the second run, never begun, is left queued; A's sweeps, short of memory, leave it.
  const exited = once(b.child, "exit");
  b.child.kill("SIGTERM");
  await exited;
  await sleep(2_000);
  assert.equal(model.bodies.length, 1);
  // A node with room takes it.
  await c.start("c", { ...model.env, AGENT_ORPHAN_SWEEP_MS: "300" });
  await until(() => model.bodies.length === 2, "the new node's sweep to run the queued prompt", 20_000);
});
