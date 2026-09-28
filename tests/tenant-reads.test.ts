import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("a tenant's own watcher bound, from the tenants file, replaces the default", async t => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const r = await runtime(t, () => ({ content: "hello" }), {}, { tenants: {
    alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: "fixture-model-key" }, maxWatchers: 2 },
  } });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const events = `${r.base}/v1/agents/${agent}/events`;
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  assert.equal((await watchEvents(t, events, auth, { query: "" })).status, 200);
  assert.equal((await watchEvents(t, events, auth, { query: "" })).status, 200);
  assert.equal((await watchEvents(t, events, auth, { query: "" })).status, 429);
});

test("an idle agent's history, state and inputs are read without loading it", { timeout: 60_000 }, async t => {
  const r = await runtime(t, () => ({ content: "hello" }), { AGENT_IDLE_MS: "1000" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const done = await r.prompt(agent, "hi");
  const owner = async () => (await r.db.query("select node from actor_owners where actor = $1", [agent])).rows[0]?.node ?? null;
  await until(async () => (await r.db.query("select indexed from agent_history_index where agent = $1", [agent])).rows[0]?.indexed === 2 && await owner() === null, "the idle agent to be released", 20_000);
  const { token } = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: {} })).json;
  for (const reader of [undefined, token]) {
    assert.deepEqual((await r.call(`/v1/agents/${agent}/history`, { token: reader })).json.messages.map((message: any) => message.role), ["user", "assistant"]);
    assert.deepEqual((await r.call(`/v1/agents/${agent}/history?limit=5`, { token: reader })).json.entries.map((entry: any) => entry.index), [0, 1]);
    const state = (await r.call(`/v1/agents/${agent}/state`, { token: reader })).json;
    assert.ok(state.requests.some((request: any) => request.id === done.id && request.state === "completed"));
    assert.ok(state.cursor > 0);
    assert.deepEqual((await r.call(`/v1/agents/${agent}/inputs?state=pending`, { token: reader })).json, []);
  }
  assert.equal(await owner(), null, "nothing loaded it");
  // Its state's cursor is where a stream of it picks up, with no gap.
  const cursor = (await r.call(`/v1/agents/${agent}/state`)).json.cursor;
  const poll = await fetch(`${r.base}/v1/agents/${agent}/events?poll=1`, { headers: { Authorization: `Bearer ${OPERATOR}`, "Last-Event-ID": String(cursor) } });
  assert.equal(poll.status, 200);
});

test("an agent with work left that cannot be loaded is tried again with capped backoff, never for good, and says so", { timeout: 60_000 }, async t => {
  const r = await runtime(t, () => ({ content: "hello" }), { AGENT_IDLE_MS: "1000", AGENT_ORPHAN_SWEEP_MS: "200" });
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.prompt(agent, "hi");
  await until(async () => !(await r.db.query("select node from actor_owners where actor = $1", [agent])).rows[0]?.node, "the idle agent to be released", 20_000);
  // Work left, and a header no node can load.
  await r.db.query("update agents set pending_runs = true, header = jsonb_set(header::jsonb, '{version}', '99')::json where id = $1", [agent]);
  const row = async () => (await r.db.query("select resume_failures, resume_after from agents where id = $1", [agent])).rows[0];
  await until(async () => (await row()).resume_failures >= 2, "the sweeps to fail and back off");
  // Backing off, doubling: a few windows in a couple of seconds, not a try per sweep.
  await sleep(2_000);
  assert.ok((await row()).resume_failures <= 5, `${(await row()).resume_failures} failures in about 2.5 s of 200 ms sweeps`);
  // Reads answer from storage, and say it waits.
  const state = await r.call(`/v1/agents/${agent}/state`);
  assert.equal(state.status, 200);
  assert.ok(state.json.resume.failures >= 2);
  assert.equal((await r.call("/v1/agents")).json.find((entry: any) => entry.id === agent).resume.failures, state.json.resume.failures, "the listing says so too");
  // However many failures, it is tried again: at most an hour apart.
  await r.db.query("update agents set resume_failures = 40, resume_after = 0 where id = $1", [agent]);
  await until(async () => (await row()).resume_failures === 41, "another try");
  const after = Number((await row()).resume_after);
  assert.ok(after - Date.now() <= 3_600_000 && after - Date.now() > 3_500_000, `capped at an hour (${after - Date.now()} ms)`);
});
