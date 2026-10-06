import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { balancer, cluster, fakeEcs, fakeModel, sleep, token, until } from "./cluster-helpers.ts";

// As in cluster-step-handoff: what moves the turn is the leaving node telling its peers, not the slow periodic sweep.
const QUIET = { AGENT_ORPHAN_SWEEP_MS: "600000", AGENT_TOOL_TIMEOUT_MS: "120000", ...(process.env.AGENT_HOSTING ? { AGENT_HOSTING: process.env.AGENT_HOSTING } : {}) };
type T = Parameters<typeof cluster>[0];

async function ecsNode(t: T, c: Awaited<ReturnType<typeof cluster>>, name: string, env: Record<string, string>) {
  const ecs = await fakeEcs(t);
  return { ...await c.start(name, { ...ecs.env, ...QUIET, ...env }), ecs };
}

test("a node that retires ends its event streams with a reconnect hint: the SDK reconnects at once, without backoff, and its events go on with no gap or repeat", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const model = await fakeModel(t, (_body, index) => index === 0
    ? { role: "assistant", tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "slow", arguments: "{}" } }] }
    : { role: "assistant", content: "finished on b" });
  const tools = { slow: tool({ description: "A slow step", input: schema.Object({}, { additionalProperties: false }), execute: async () => { await gate.promise; return "done"; } }) };
  const a = await ecsNode(t, c, "a", model.env);
  const b = await ecsNode(t, c, "b", model.env);
  const created = await new AgentRuntime({ url: a.url, apiKey: token }).createAgent({ tools, idempotencyKey: "reconnect-hint" });
  await created.close();
  const app = await new AgentRuntime({ url: a.url, fetch: balancer([a, b]).fetch }).connectAgent(created.session, { tools });
  t.after(() => app.close());

  // A watcher (no tools), through a balancer of its own: when each /events request starts, and every frame it gets.
  const frames: string[] = [];
  const starts: number[] = [];
  let hintedAt: number | undefined;
  const watching = balancer([a, b], frame => {
    frames.push(frame);
    if (frame.includes("event: reconnect")) hintedAt ??= Date.now();
    return frame;
  });
  const statuses: number[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const events = String(input).includes("/events");
    if (events) starts.push(Date.now());
    const response = await watching.fetch(input, init);
    if (events) statuses.push(response.status);
    return response;
  };
  const watcher = await new AgentRuntime({ url: a.url, fetch: fetcher as typeof fetch }).connectAgent(created.session, { tools: {}, attach: false, onEvent: () => {} });
  t.after(() => watcher.close());

  const run = app.prompt("go", { idempotencyKey: "long-turn", timeoutMs: 90_000 });
  await until(() => model.bodies.length === 1, "A to call the model");
  await sleep(300);
  // A newer deploy supersedes A: it lets the tool call finish, hands the turn off, releases the agent, then ends its streams.
  a.ecs.state.revision++;
  a.ecs.state.created = Date.now() / 1000;
  await until(() => a.logs.some(entry => entry.type === "retiring"), "A to retire");
  const before = starts.length;
  gate.resolve();
  assert.equal((await run).reply, "finished on b");
  await until(() => hintedAt !== undefined, "the reconnect hint");
  await until(() => starts.length > before, "the watcher to reconnect");
  const next = starts.find(at => at >= hintedAt!)!;
  // Without the hint the SDK waits at least 250 ms before reconnecting.
  assert.ok(next - hintedAt! < 200, `reconnected ${next - hintedAt!} ms after the hint`);
  const hint = frames.find(frame => frame.includes("event: reconnect"))!;
  assert.match(hint, /^retry: 0$/m);
  assert.deepEqual(JSON.parse(hint.split("\n").find(line => line.startsWith("data:"))!.slice(5)), { type: "reconnect", reason: "drain", retryMs: 0 });
  assert.ok(!hint.includes("id:"), "the hint moves no cursor");
  // Every event once, in order, and no replay gap: the stream resumed where it stopped.
  await until(() => frames.some(frame => frame.includes("finished on b")), "the watcher to see the turn end on B");
  const ids = frames.flatMap(frame => frame.split("\n").filter(line => line.startsWith("id:")).map(line => Number(line.slice(3))));
  assert.deepEqual(ids, [...new Set(ids)].sort((x, y) => x - y), "strictly increasing, no repeats");
  assert.ok(!statuses.includes(409), `no replay gap: ${statuses.join(",")}`);
  assert.ok(!frames.some(frame => frame.includes("replay_gap")));
});
