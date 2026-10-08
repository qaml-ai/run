import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentError, AgentRuntime, Agents, RunError, schema, tool, type StreamPart } from "../clients/node.ts";
import { OPERATOR, runtime, until } from "./runtime-server.ts";

/** A fetch that counts the event streams it holds open: one per /events request, until its signal aborts or its body ends. */
function countingFetch() {
  const counts = { opened: 0, open: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.includes("/events")) return globalThis.fetch(input, init);
    counts.opened++; counts.open++;
    let closed = false;
    const close = () => { if (!closed) { closed = true; counts.open--; } };
    init?.signal?.addEventListener("abort", close, { once: true });
    try {
      const response = await globalThis.fetch(input, init);
      if (!response.body) { close(); return response; }
      const body = response.body.pipeThrough(new TransformStream({ flush: close }));
      return new Response(body, { status: response.status, headers: response.headers });
    } catch (error) { close(); throw error; }
  };
  return { counts, fetch };
}

test("lazy handles (the Agents default) hold no event stream while idle, and run without one", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Yes." }));
  const { counts, fetch } = countingFetch();
  const agents = new Agents({ url: r.base, apiKey: OPERATOR, fetch });
  t.after(() => agents.close());
  // 50 handles on 4 agents (the fixture's tenant runs at most 4 at once).
  const keys = ["yes", "no", "maybe", "unsure"];
  const handles = [];
  for (const key of keys) handles.push(await agents.upsert(key, { instructions: "Answer yes or no." }));
  while (handles.length < 50) handles.push(await agents.get(keys[handles.length % keys.length]));
  assert.equal(counts.opened, 0, "neither upsert nor get connects");
  for (let index = 0; index < handles.length; index += 4) {
    const runs = await Promise.all(handles.slice(index, index + 4).map(agent => agent.run("Is water wet?")));
    assert.ok(runs.every(run => run.status === "completed" && run.text === "Yes."));
  }
  assert.equal(counts.opened, 0, "a run settles without an event stream");
});

test("a lazy handle's stream() connects for the run, yields it from its start, and lets the stream go after", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Streamed answer.", delayMs: 200 }));
  const { counts, fetch } = countingFetch();
  const agents = new Agents({ url: r.base, apiKey: OPERATOR, fetch });
  t.after(() => agents.close());
  const agent = await agents.upsert("streamer");
  assert.equal(counts.opened, 0);
  for (const attempt of [1, 2]) {
    const parts: StreamPart[] = [];
    let peak = 0;
    for await (const part of agent.stream(`Go ${attempt}`)) { parts.push(part); peak = Math.max(peak, counts.open); }
    assert.deepEqual([attempt, ...parts.map(part => part.type)], [attempt, "text", "done"]);
    assert.equal((parts[0] as { text: string }).text, "Streamed answer.");
    assert.equal(peak, 1, "one stream while the run streams");
    await until(() => counts.open === 0, "the stream to close once the run ended");
  }
  // A run between streams needs none.
  const before = counts.opened;
  assert.equal((await agent.run("Quiet")).text, "Streamed answer.");
  assert.equal(counts.opened, before);
});

test("handles that need the stream keep it: onEvent, served tools, or connection: eager", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Hi." }));
  const { counts, fetch } = countingFetch();
  const agents = new Agents({ url: r.base, apiKey: OPERATOR, fetch });
  t.after(() => agents.close());
  await agents.upsert("plain");
  const events: string[] = [];
  const watching = await agents.get("plain", { onEvent: event => { events.push(event.type); } });
  assert.equal(counts.open, 1, "onEvent connects at once");
  await watching.run("Hello");
  await watching.client.drained();
  assert.ok(events.includes("agent_end"));
  await agents.upsert("served", { tools: { ping: tool({ description: "Ping", input: schema.Object({}), execute: () => "pong" }) } });
  assert.equal(counts.open, 2, "a handle serving tools connects at once");
  await agents.get("plain", { connection: "eager" });
  assert.equal(counts.open, 3, "connection: eager connects at once");
  const eager = new Agents({ url: r.base, apiKey: OPERATOR, fetch, connection: "eager" });
  t.after(() => eager.close());
  await eager.get("plain");
  assert.equal(counts.open, 4, "AgentsOptions.connection: eager is every handle's default");
  await agents.close();
  await eager.close();
  assert.equal(counts.open, 0);
});

test("a lazy run whose agent is deleted mid-run fails with the refusal, and close() stops its wait", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Late.", delayMs: 1_500 }));
  const agents = new Agents({ url: r.base, apiKey: OPERATOR });
  t.after(() => agents.close());
  const agent = await agents.upsert("deleted");
  const pending = agent.run("Slow").then(() => assert.fail("expected the run to fail"), error => error);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal((await r.call(`/v1/agents/${agent.id}`, { method: "DELETE" })).status, 200);
  // Settled as revoked by the runtime, or refused by its poll (404, 410): either way the wait ends.
  const error = await pending;
  assert.ok(error instanceof RunError ? /revoked/.test(error.message) : error instanceof AgentError && [404, 410].includes(error.status), String(error));
  // The lower-level client stays eager by default; lazy is opt-in there.
  const runtimeClient = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const { session } = await runtimeClient.upsertAgent("closing", {});
  const client = await runtimeClient.connectAgent(session, { attach: false, connection: "lazy" });
  const waiting = client.prompt("Slow too");
  await new Promise(resolve => setTimeout(resolve, 200));
  const started = Date.now();
  await client.close();
  await assert.rejects(waiting, /Client closed/);
  assert.ok(Date.now() - started < 1_000, "close does not wait out the poll");
});
