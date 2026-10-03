import { test } from "node:test";
import assert from "node:assert/strict";
import { cluster, fakeModel, token, until } from "./cluster-helpers.ts";

test("a fork asked of any node copies the source's whole history, its latest turn included, wherever the source is served", { timeout: 120_000 }, async t => {
  const model = await fakeModel(t, async body => {
    const said = JSON.stringify(body.messages.filter((message: any) => message.role === "user").at(-1)?.content);
    return { role: "assistant", content: `answer to ${/say-(\w+)/.exec(said)?.[1]}` };
  });
  const c = await cluster(t);
  const a = await c.start("a", model.env);
  const b = await c.start("b", model.env);
  const call = async (node: { url: string }, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${node.url}${path}`, {
      method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() as any };
  };
  const source = (await call(a, "/v1/agents", {}, { "Idempotency-Key": "source" })).json.id as string;
  for (const word of ["one", "two"]) {
    const prompted = await call(a, `/v1/agents/${source}/prompt`, { text: `say-${word}` });
    assert.equal(prompted.status, 202);
    await until(async () => (await call(a, `/v1/agents/${source}/requests/${prompted.json.id}`)).json.state === "completed", `turn ${word}`);
  }
  assert.equal(await c.owner(source), a.url, "A serves the source, whose latest turns are in no history chunk yet");
  const whole = (await call(a, `/v1/agents/${source}/history`)).json.messages;
  assert.equal(whole.length, 4);

  // Asked of B, the fork is made where the source is served.
  const viaB = await call(b, `/v1/agents/${source}/fork`, { key: "via-b" });
  assert.equal(viaB.status, 201, JSON.stringify(viaB.json));
  assert.deepEqual(viaB.json.forkedFrom, { agentId: source, atMessage: 3 });
  for (const node of [a, b]) assert.deepEqual((await call(node, `/v1/agents/${viaB.json.id}/history`)).json.messages, whole);

  // Made on B itself (as when ownership moves between routing and the read), it reads the source's log, which every
  // committed turn is in, not B's view of the source's history index.
  const onB = await call(b, `/v1/agents/${source}/fork`, { key: "on-b" }, { "x-agent-runtime-forwarded": "test" });
  assert.equal(onB.status, 201, JSON.stringify(onB.json));
  assert.equal(await c.owner(source), a.url);
  assert.deepEqual(onB.json.forkedFrom, { agentId: source, atMessage: 3 });
  for (const node of [a, b]) assert.deepEqual((await call(node, `/v1/agents/${onB.json.id}/history`)).json.messages, whole);
  const page = (await call(b, `/v1/agents/${onB.json.id}/history?limit=50`)).json;
  assert.deepEqual(page.entries.map((entry: any) => entry.message), whole);

  // Each fork takes its own turns on whichever node serves it.
  const prompted = await call(b, `/v1/agents/${onB.json.id}/prompt`, { text: "say-three" });
  await until(async () => (await call(b, `/v1/agents/${onB.json.id}/requests/${prompted.json.id}`)).json.state === "completed", "the fork's turn");
  assert.equal((await call(a, `/v1/agents/${onB.json.id}/history`)).json.messages.length, 6);
  assert.equal((await call(b, `/v1/agents/${source}/history`)).json.messages.length, 4);
});
