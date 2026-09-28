import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { attach, runtime, until } from "./runtime-server.ts";

test("one application serves an agent's tools at a time: another connection is refused unless it takes over, and the replaced one is told why", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const tool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } };
  const created = (await r.call("/v1/agents", { body: { mcp: { tools: [tool] } } })).json;
  // A connection that only reads the stream (a relay that serves no tools, as chiridion's) holds nothing: it is replaced as before.
  const reader = new AbortController();
  t.after(() => reader.abort());
  const relay = await fetch(`${r.base}/clients/${created.id}/events`, { headers: { Authorization: `Bearer ${created.token}`, Accept: "text/event-stream" }, signal: reader.signal });
  assert.equal(relay.status, 200);

  const first = await attach(t, r.base, created.id, created.token);
  assert.equal(first.status, 200, "it replaced the relay, which served no tools");
  const second = await attach(t, r.base, created.id, created.token);
  assert.equal(second.status, 409);
  assert.match(second.body, /APPLICATION_CONNECTED[\s\S]*takeover=true/);
  assert.equal(first.frames.some(frame => frame.includes("event: closed")), false, "the first keeps its place");

  const third = await attach(t, r.base, created.id, created.token, undefined, "?takeover=true");
  assert.equal(third.status, 200);
  await first.ended;
  const closed = first.frames.find(frame => frame.includes("event: closed"));
  assert.ok(closed, "the replaced connection is told why it closes");
  assert.equal(JSON.parse(closed!.split("data:")[1]).reason, "replaced");
});

test("the application's own connection still answers a replay gap with 409 unless it asks for a snapshot, as relays that do not read snapshots expect", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const created = (await r.call("/v1/agents", { body: {} })).json;
  await r.prompt(created.id, "hi");
  const connect = (query: string) => fetch(`${r.base}/clients/${created.id}/events${query}`, { headers: { Authorization: `Bearer ${created.token}`, Accept: "text/event-stream", "Last-Event-ID": "1" } });
  const gap = await connect("");
  assert.equal(gap.status, 409);
  const asked = await connect("?snapshot=1");
  assert.equal(asked.status, 200);
  await asked.body?.cancel();
});

test("a run for an agent whose tools need its application is refused while none is connected, after a short wait for one reconnecting", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const tool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } };
  const created = (await r.call("/v1/agents", { body: { mcp: { tools: [tool] } } })).json;
  const refused = await r.call(`/v1/agents/${created.id}/prompt`, { body: { text: "hi" } });
  assert.equal(refused.status, 409);
  assert.match(refused.json.error, /^APPLICATION_NOT_CONNECTED/);
  const viaClient = await fetch(`${r.base}/clients/${created.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "c-1", method: "execute", params: { code: "return 1" } }) });
  assert.equal(viaClient.status, 409);
  const anyway = await r.call(`/v1/agents/${created.id}/prompt`, { body: { text: "anyway", allowDisconnected: true } });
  assert.equal(anyway.status, 202, "unless the caller says it may run without");

  // An application that connects while the request waits takes it.
  const waiting = r.call(`/v1/agents/${created.id}/prompt`, { body: { text: "soon" } });
  await new Promise(resolve => setTimeout(resolve, 500));
  await attach(t, r.base, created.id, created.token);
  const soon = await waiting;
  assert.equal(soon.status, 202);
  for (const id of [anyway.json.id, soon.json.id]) await until(async () => (await r.call(`/v1/agents/${created.id}/requests/${id}`)).json.state === "completed", "the run");

  // An agent with no tools of its application's runs without one.
  const plain = (await r.call("/v1/agents", { body: {} })).json;
  assert.equal((await r.prompt(plain.id, "hi")).state, "completed");
});

test("the application's ready event carries the hash of the tools it last declared, so an SDK reconfigures only on a change; a run's outcome carries its usage", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok", usage: { prompt_tokens: 12, completion_tokens: 3 } }));
  const tools = [{ name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } }];
  const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const created = (await r.call("/v1/agents", { body: { mcp: { tools } } })).json;
  const ready = (app: { frames: string[] }) => JSON.parse(app.frames.find(frame => frame.includes("event: ready"))!.split("data:")[1]);
  const first = await attach(t, r.base, created.id, created.token);
  assert.equal(ready(first).toolsHash, sha(tools));

  const changed = [...tools, { name: "save", description: "Save", inputSchema: { type: "object", properties: {} } }];
  const configure = await fetch(`${r.base}/clients/${created.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${created.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "tools-2", method: "configure", params: { mcp: { tools: changed } } }) });
  assert.equal(configure.status, 202);
  await until(async () => (await r.call(`/v1/agents/${created.id}/requests/tools-2`)).json.state === "completed", "the configuration");
  const second = await attach(t, r.base, created.id, created.token, undefined, "?takeover=true");
  assert.equal(ready(second).toolsHash, sha(changed));

  const done = await r.prompt(created.id, "hi");
  assert.deepEqual([done.outcome.result.usage.responses, done.outcome.result.usage.input, done.outcome.result.usage.output], [1, 12, 3]);
});

test("a connection that holds an agent but no longer answers (half-open) is replaced without a takeover", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const tool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } };
  const created = (await r.call("/v1/agents", { body: { mcp: { tools: [tool] } } })).json;
  const first = await attach(t, r.base, created.id, created.token);
  assert.equal((await attach(t, r.base, created.id, created.token)).status, 409, "a live holder keeps its place");
  first.stall();
  const second = await attach(t, r.base, created.id, created.token);
  assert.equal(second.status, 200, "one that does not answer a ping holds nothing");
});
