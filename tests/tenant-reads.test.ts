import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, OTHER_OPERATOR, runtime, sleep, until, watchEvents } from "./runtime-server.ts";

test("a tenant reads its agent's events, state, history and inputs with its own token, and no other tenant can", async t => {
  const r = await runtime(t, () => ({ content: "hello" }));
  const created = await r.call("/v1/agents", { body: {} });
  assert.equal(created.status, 201, created.text);
  const agent = created.json.id as string;
  const events = `${r.base}/v1/agents/${agent}/events`;

  const first = await watchEvents(t, events, { Authorization: `Bearer ${OPERATOR}` }, { query: "" });
  const second = await watchEvents(t, events, { Authorization: `Bearer ${OPERATOR}` }, { query: "" });
  assert.equal(first.status, 200);
  const done = await r.prompt(agent, "hi");
  const settled = (watcher: typeof first) => watcher.frames.some(frame => frame.data.type === "response" && frame.data.id === done.id);
  await until(() => settled(first) && settled(second), "both of the tenant's watchers to see the outcome");
  assert.ok(first.frames.some(frame => frame.data.type === "event" && frame.data.event.type === "message_update"), "streamed events reach the tenant");
  assert.equal(first.frames[0].data.watch, true, "a tenant's stream is always a watcher");

  const state = await r.call(`/v1/agents/${agent}/state`);
  assert.equal(state.status, 200);
  assert.ok(state.json.cursor >= first.frames.at(-1)!.id!);
  assert.ok(state.json.requests.some((request: any) => request.id === done.id && request.outcome));
  const poll = await fetch(`${events}?poll=1`, { headers: { Authorization: `Bearer ${OPERATOR}`, "Last-Event-ID": String(state.json.cursor) } });
  assert.deepEqual(await poll.json(), { cursor: state.json.cursor, events: [] });
  assert.equal((await r.call(`/v1/agents/${agent}/history`)).json.messages.length, 2);
  assert.deepEqual((await r.call(`/v1/agents/${agent}/inputs`)).json, []);

  // Another tenant's token finds no such agent, for every read and for answering; no token is refused outright.
  for (const path of ["/events", "/events?poll=1", "/state", "/history", "/inputs"]) {
    assert.equal((await r.call(`/v1/agents/${agent}${path}`, { token: OTHER_OPERATOR })).status, 404, path);
    assert.equal((await r.call(`/v1/agents/${agent}${path}`, { token: null })).status, 401, path);
  }
  assert.equal((await r.call(`/v1/agents/${agent}/inputs/input_x`, { token: OTHER_OPERATOR, body: { action: "accept" } })).status, 404);
  // The agent's own token is not a tenant's.
  assert.equal((await r.call(`/v1/agents/${agent}/events?poll=1`, { token: created.json.token })).status, 401);
  // A deleted agent's stream is gone.
  assert.equal((await r.call(`/v1/agents/${agent}`, { method: "DELETE" })).status, 200);
  assert.equal((await r.call(`/v1/agents/${agent}/events?poll=1`)).status, 404);
});

test("a subscriber that goes away before its stream opens gives its place back", async t => {
  const r = await runtime(t, () => ({ content: "hello" }));
  const created = (await r.call("/v1/agents", { body: {} })).json;
  const agent = created.id as string;
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  // Watchers and waiting polls whose clients give up while the request is still being authorized and loaded.
  const abandon = (url: string, headers: Record<string, string>, count: number) => Promise.all(Array.from({ length: count }, async (_, index) => {
    const aborts = new AbortController();
    setTimeout(() => aborts.abort(), index % 5);
    await fetch(url, { headers, signal: aborts.signal }).then(response => response.body?.cancel()).catch(() => {});
  }));
  await abandon(`${r.base}/v1/agents/${agent}/events`, auth, 150);
  await abandon(`${r.base}/v1/agents/${agent}/events?poll=1&wait=20`, auth, 150);
  await sleep(500);
  assert.equal((await watchEvents(t, `${r.base}/v1/agents/${agent}/events`, auth, { query: "" })).status, 200, "every place was given back");
  // The application's connection likewise: one gone before it opened is not kept as the agent's connection.
  await abandon(`${r.base}/clients/${agent}/events`, { Authorization: `Bearer ${created.token}` }, 50);
  await sleep(500);
  const listed = (await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent);
  assert.equal(listed.connected, false);
});
