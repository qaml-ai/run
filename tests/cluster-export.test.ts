import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { cluster, fakeModel, sleep, token, until } from "./cluster-helpers.ts";
import { unzip } from "./unzip.ts";

test("an export from any node holds every agent's whole history: agents loaded on this node, on another, and on none", { timeout: 120_000 }, async t => {
  const model = await fakeModel(t, async body => {
    const said = JSON.stringify(body.messages.filter((message: any) => message.role === "user").at(-1)?.content);
    return { role: "assistant", content: `answer to ${/say-(\w+)/.exec(said)?.[1]}` };
  });
  const c = await cluster(t);
  // Idle agents unload after a second (the shortest allowed), so one can be left loaded nowhere.
  const a = await c.start("a", { ...model.env, AGENT_IDLE_MS: "1000", AGENT_BILLING_ADMINS: "alice" });
  const b = await c.start("b", { ...model.env, AGENT_BILLING_ADMINS: "alice" });
  const call = async (node: { url: string }, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${node.url}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() as any };
  };
  // Each agent is owned by the node it was created on, and answers one prompt there.
  const create = async (node: { url: string }, key: string) => {
    const created = await call(node, "/v1/agents", {}, { "Idempotency-Key": key });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const id = created.json.id as string;
    const prompted = await call(node, `/v1/agents/${id}/prompt`, { text: `say-${key}` });
    assert.equal(prompted.status, 202, JSON.stringify(prompted.json));
    await until(async () => (await call(node, `/v1/agents/${id}/history`)).json.messages?.length === 2, `${key}'s turn to settle`);
    keys.set(id, key);
    return id;
  };
  const keys = new Map<string, string>();
  const expect = {
    user: (id: string) => `0 user ${JSON.stringify([{ type: "text", text: `say-${keys.get(id)}` }])}`,
    assistant: (id: string) => `1 assistant ${JSON.stringify([{ type: "text", text: `answer to ${keys.get(id)}` }])}`,
  };
  const idle = await create(a, "idle");
  await until(async () => !await c.owner(idle), "the idle agent to unload", 30_000);
  const onA = await create(a, "ona");
  const onB = await create(b, "onb");
  assert.deepEqual([await c.owner(onA), await c.owner(onB)], [a.url, b.url]);

  const exported = async (node: { url: string }, path = "/v1/account/export") => {
    const response = await fetch(`${node.url}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    return unzip(Buffer.from(await response.arrayBuffer()));
  };
  const histories = (files: Map<string, Buffer>, ids: string[]) => ids.map(id => [...files.keys()]
    .filter(name => name.startsWith(`agents/${id}/history/`)).sort()
    .flatMap(name => JSON.parse(files.get(name)!.toString("utf8")).map((entry: any) => `${entry.index} ${entry.message.role} ${JSON.stringify(entry.message.content)}`)));
  const ids = [idle, onA, onB];
  const whole = ids.map(id => [expect.user(id), expect.assistant(id)]);

  // Each node reads the agents another node serves from that node: the operator's export of the tenant too, which shares the code.
  for (const [node, path] of [[a, "/v1/account/export"], [b, "/v1/account/export"], [a, "/v1/tenants/alice/export"], [b, "/v1/tenants/alice/export"]] as const) {
    assert.deepEqual(histories(await exported(node, path), ids), whole, `${node.url}${path} has every agent's history`);
  }

  // B dies with its agent loaded: while its lease runs, no node can read that agent's history, and A's export fails
  // instead of answering a zip without it.
  b.child.kill("SIGKILL");
  await once(b.child, "close");
  const failed = await fetch(`${a.url}/v1/account/export`, { headers: { Authorization: `Bearer ${token}` } });
  await assert.rejects(failed.arrayBuffer(), "the export is cut off, not completed without the agent B served");
  // Once the lease lapses, A serves that agent from storage, and its export is whole again.
  await sleep(1500 + 500);
  assert.deepEqual(histories(await exported(a), ids), whole);
});
