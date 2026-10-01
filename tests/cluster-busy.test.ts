import { test } from "node:test";
import assert from "node:assert/strict";
import { cluster, fakeModel, token, until } from "./cluster-helpers.ts";

test("a tenant's busy-agent limit holds across nodes: a run past it gets 429 BUSY_AGENT_LIMIT on any node, and a slot freed on one node is free on all", { timeout: 90_000 }, async t => {
  // Each turn's model call waits until the test lets that agent's turn finish.
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const gate = (text: string) => { if (!gates.has(text)) gates.set(text, Promise.withResolvers()); return gates.get(text)!; };
  const model = await fakeModel(t, async body => {
    const said = JSON.stringify(body.messages.filter((message: any) => message.role === "user").at(-1)?.content);
    const name = /hold-(\w+)/.exec(said)?.[1];
    if (name) await gate(name).promise;
    return { role: "assistant", content: "done" };
  });
  const c = await cluster(t);
  const env = { ...model.env, AGENT_MAX_AGENTS_PER_TENANT: "2" };
  const a = await c.start("a", env);
  const b = await c.start("b", env);
  const call = async (node: { url: string }, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${node.url}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, json: await response.json() as any };
  };
  // Each agent is owned by the node it was created on.
  const create = async (node: { url: string }, key: string) => {
    const created = await call(node, "/v1/agents", {}, { "Idempotency-Key": key });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    return created.json.id as string;
  };
  const [x, y, z] = [await create(a, "x"), await create(b, "y"), await create(a, "z")];
  assert.deepEqual([await c.owner(x), await c.owner(y), await c.owner(z)], [a.url, b.url, a.url]);

  // One busy agent on each node: the tenant's two.
  assert.equal((await call(a, `/v1/agents/${x}/prompt`, { text: "hold-x" })).status, 202);
  assert.equal((await call(b, `/v1/agents/${y}/prompt`, { text: "hold-y" })).status, 202);
  await until(() => model.bodies.length >= 2, "both turns to call the model");

  // A third, on either node (B forwards to Z's owner, A), is refused, and says why.
  for (const node of [a, b]) {
    const refused = await call(node, `/v1/agents/${z}/prompt`, { text: "go" });
    assert.equal(refused.status, 429, JSON.stringify(refused.json));
    assert.equal(refused.json.code, "BUSY_AGENT_LIMIT");
    assert.equal(refused.headers.get("retry-after"), "5");
    assert.deepEqual(refused.json.busyAgents, { busy: 2, limit: 2, source: "default" });
    assert.match(refused.json.error, /has 2 agents busy, the most this account allows; retry when one finishes/);
  }
  // A busy agent takes more work without another slot: it queues behind its turn.
  assert.equal((await call(b, `/v1/agents/${x}/prompt`, { text: "queued" })).status, 202);
  const busy = async () => Number((await c.db.query("select count(*) as n from busy_agents where tenant = 'alice'")).rows[0].n);
  assert.equal(await busy(), 2);

  // X's turns end on A; its slot is free on B too.
  gate("x").resolve();
  await until(async () => await busy() === 1, "X to give its slot up once its queued turn ends too");
  const accepted = await call(b, `/v1/agents/${z}/prompt`, { text: "hold-z" });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.json));
  assert.equal((await call(a, `/v1/agents/${x}/prompt`, { text: "again" })).status, 429, "Y and Z are busy now");

  gate("y").resolve();
  gate("z").resolve();
  await until(async () => await busy() === 0, "every slot to be given up");
  assert.equal((await call(a, `/v1/agents/${x}/prompt`, { text: "again" })).status, 202);
});
