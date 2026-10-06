import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, schema, tool } from "../clients/typescript.ts";
import { cluster, databaseLink, freePort, nodeLink, sha, sleep, token, until } from "./cluster-helpers.ts";

// Production's lease (renewed every 3 s, fresh for 6 s, suspected at 9 s), and a periodic sweep too slow to matter.
const PROD = { AGENT_LEASE_TTL_MS: "90000", AGENT_ORPHAN_SWEEP_MS: "600000" };

type Served = { node: string; prompt: string; started: number; ended?: number; cut?: boolean };

/**
 * An OpenAI-compatible model that logs each call with the node that made it (each node has its own key for the
 * tenant, see `env`), when it started, and when it ended (`cut` when the caller closed it first). The prompt "stream"
 * answers slowly, a chunk every 200 ms for 40 s, the first time; "loop" asks for js_exec looking up keys one by one.
 */
async function servingModel(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "agent-fresh-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const served: Served[] = [];
  const answered = new Set<string>();
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const node = String(req.headers.authorization).replace(/^Bearer fixture-key-/, "");
    const user = body.messages.find((message: any) => message.role === "user");
    const prompt = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content ?? "");
    const kind = prompt.includes("stream") ? "stream" : prompt.includes("loop") ? "loop" : "other";
    const entry: Served = { node, prompt: kind, started: Date.now() };
    served.push(entry);
    res.on("close", () => { entry.ended ??= Date.now(); if (!res.writableFinished) entry.cut = true; });
    const chunk = (delta: object, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const finished = body.messages.some((message: any) => message.role === "tool");
    if (kind === "stream" && !answered.has("stream")) {
      answered.add("stream");
      for (let index = 0; index < 200 && !res.destroyed; index++) { chunk({ role: "assistant", content: `w${index} ` }); await sleep(200); }
    } else if (kind === "loop" && !finished && !answered.has("loop")) {
      answered.add("loop");
      const code = "for (let i = 0; i < 160; i++) await tools.lookup({ key: String(i) }); return 'looped';";
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_loop", type: "function", function: { name: "js_exec", arguments: JSON.stringify({ code, timeoutMs: 60_000 }) } }] });
      chunk({}, "tool_calls");
      return res.end("data: [DONE]\n\n");
    } else chunk({ role: "assistant", content: `answered by ${node}` });
    if (!res.destroyed) { chunk({}, "stop"); res.end("data: [DONE]\n\n"); }
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const port = (server.address() as { port: number }).port;
  // An agent keeps its model's URL wherever it moves; the tenant's key is the serving node's.
  const env = (node: string) => {
    const tenants = join(root, `${node}.json`);
    writeFileSync(tenants, JSON.stringify({ tenants: { alice: { tokenSha256: sha(token), apiKeys: { openrouter: `fixture-key-${node}` } } } }));
    return { AGENT_PROVIDER: "openrouter", AGENT_MODEL: "openai/gpt-4o-mini", AGENT_BASE_URL: `http://127.0.0.1:${port}/v1`, AGENT_TENANTS_FILE: tenants };
  };
  return { served, env };
}

/** The tool code calls: each lookup takes 250 ms, and is logged with when it started. */
function slowLookup(calls: { key: string; at: number }[]) {
  return {
    lookup: tool({
      description: "Look up a value", input: schema.Object({ key: schema.String() }, { additionalProperties: false }),
      execute: async ({ key }) => { calls.push({ key, at: Date.now() }); await sleep(250); return `value-of-${key}`; },
    }),
  };
}

/** Two agents on `url`: one in a js_exec loop of tool calls, one waiting on a slow model stream. */
async function busyAgents(t: { after(fn: () => Promise<void> | void): void }, url: string, calls: { key: string; at: number }[], served: Served[]) {
  const runtime = new AgentRuntime({ url, apiKey: token });
  const looping = await runtime.createAgent({ tools: slowLookup(calls), idempotencyKey: "looping" });
  const streaming = await runtime.createAgent({ tools: {}, idempotencyKey: "streaming" });
  t.after(async () => { await looping.close().catch(() => {}); await streaming.close().catch(() => {}); });
  const runs = [looping.prompt("loop", { idempotencyKey: "loop-turn", timeoutMs: 120_000 }), streaming.prompt("stream", { idempotencyKey: "stream-turn", timeoutMs: 120_000 })];
  for (const run of runs) run.catch(() => {});
  await until(() => calls.length >= 3 && served.some(entry => entry.prompt === "stream"), "both agents to be making effects");
  return { looping, streaming, runs };
}

test("a node cut off from its peers and the database is reaped, and from the moment a peer resumes its agents it makes no model or tool call", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await servingModel(t);
  const port = await freePort();
  const peers = await nodeLink(port);
  const database = await databaseLink(new URL(c.databaseUrl));
  t.after(() => database.close());
  const a = await c.start("a", { ...model.env("a"), ...PROD, AGENT_NODE_URL: peers.url, AGENT_DATABASE_URL: database.url, AGENT_DATABASE_QUERY_TIMEOUT_MS: "2000" }, port);
  const b = await c.start("b", { ...model.env("b"), ...PROD });
  const calls: { key: string; at: number }[] = [];
  const { looping, streaming } = await busyAgents(t, a.url, calls, model.served);

  // A still reaches the model and its client (the test), but neither its peers nor Postgres.
  peers.cut();
  database.down("reset");
  const partitioned = Date.now();
  await until(() => model.served.filter(entry => entry.node === "b").length >= 2, "B to resume both agents", 60_000);
  const resumed = Math.min(...model.served.filter(entry => entry.node === "b").map(entry => entry.started));
  assert.ok(b.logs.some(entry => entry.type === "node_reaped" && entry.node === peers.url), "B found A dead");
  // Long enough for A to have kept going, were it going to: its tool loop has 30 s of calls left, its stream 30 s.
  // (Before the fresh lease, A went on until it fenced: its stream ran 71 s past B's resume, its tool calls 31 s.)
  await sleep(8_000);

  const fromA = model.served.filter(entry => entry.node === "a");
  const lastToolCall = Math.max(...calls.map(call => call.at));
  const lastModel = Math.max(...fromA.map(entry => entry.ended ?? Date.now()));
  const overlap = Math.max(lastToolCall, lastModel) - resumed;
  t.diagnostic(`B resumed ${resumed - partitioned} ms after the partition; A's last tool call ${lastToolCall - partitioned} ms, its last model byte ${lastModel - partitioned} ms after it; overlap ${overlap} ms`);
  assert.ok(fromA.every(entry => entry.started < resumed), "A started no model call once B resumed");
  assert.ok(fromA.every(entry => entry.ended !== undefined && entry.ended < resumed), "A's stream was cut before B resumed");
  assert.ok(fromA.some(entry => entry.cut), "A cut its stream in flight");
  assert.ok(lastToolCall < resumed, "A made no tool call once B resumed");
  assert.ok(a.logs.some(entry => entry.type === "lease_interrupt"), "A's lease went stale and it cut its model requests");
  assert.ok(!a.logs.some(entry => entry.type === "self_fence"), "A has not reached its deadline");
  assert.equal(await c.owner(looping.session.id), b.url);
  assert.equal(await c.owner(streaming.session.id), b.url);
});

test("a 20 s database outage with no partition: nobody is reaped, effects pause and then go on, every turn completes, and nothing is served twice", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await servingModel(t);
  const database = await databaseLink(new URL(c.databaseUrl));
  t.after(() => database.close());
  const a = await c.start("a", { ...model.env("a"), ...PROD, AGENT_DATABASE_URL: database.url, AGENT_DATABASE_QUERY_TIMEOUT_MS: "2000" });
  const b = await c.start("b", { ...model.env("b"), ...PROD, AGENT_DATABASE_URL: database.url, AGENT_DATABASE_QUERY_TIMEOUT_MS: "2000" });
  const calls: { key: string; at: number }[] = [];
  const { runs } = await busyAgents(t, a.url, calls, model.served);

  database.down("reset");
  const down = Date.now();
  await sleep(20_000);
  database.up();
  const up = Date.now();
  const [loop, stream] = await Promise.all(runs);
  assert.equal(loop.error, null, JSON.stringify(loop));
  assert.equal(stream.error, null, JSON.stringify(stream));
  assert.equal(stream.reply, "answered by a", "the cut stream was asked again and answered");

  // Paused: from two renewals after the database went away (6 s, plus a renewal's slack) until it came back.
  const paused = calls.filter(call => call.at > down + 7_000 && call.at < up);
  assert.deepEqual(paused, [], "no tool call while the lease was stale");
  assert.ok(calls.some(call => call.at > up), "tool calls went on after the outage");
  assert.equal(new Set(calls.map(call => call.key)).size, calls.length, "no lookup was made twice");
  assert.equal(calls.length, 160);
  const started = model.served.filter(entry => entry.started > down + 7_000 && entry.started < up);
  assert.deepEqual(started, [], "no model call started while the lease was stale");
  assert.ok(model.served.every(entry => entry.node === "a"), "only A served its agents");
  assert.ok(model.served.some(entry => entry.prompt === "stream" && entry.cut), "the stream in flight was cut, not left running");
  for (const node of [a, b]) {
    assert.ok(!node.logs.some(entry => entry.type === "node_reaped" || entry.type === "self_fence"), `${node.name}: no reap, no fence`);
    assert.ok(node.logs.some(entry => entry.type === "lease_fresh"), `${node.name} went stale and fresh again`);
  }
});

test("a SIGSTOP shorter than the fresh window: no takeover, no cut, and effects go on as soon as the node wakes", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const model = await servingModel(t);
  const a = await c.start("a", { ...model.env("a"), ...PROD });
  const b = await c.start("b", { ...model.env("b"), ...PROD });
  const calls: { key: string; at: number }[] = [];
  const runtime = new AgentRuntime({ url: a.url, apiKey: token });
  const looping = await runtime.createAgent({ tools: slowLookup(calls), idempotencyKey: "looping" });
  t.after(() => looping.close());
  const run = looping.prompt("loop", { idempotencyKey: "loop-turn", timeoutMs: 120_000 });
  await until(() => calls.length >= 5, "the tool loop to run");

  // 4 s: under the 6 s fresh window, though up to 7 s after the last renewal began.
  a.child.kill("SIGSTOP");
  await sleep(4_000);
  a.child.kill("SIGCONT");
  const woke = Date.now();
  await until(() => calls.some(call => call.at > woke), "a tool call after A woke", 10_000);
  const next = calls.find(call => call.at > woke)!.at - woke;
  assert.ok(next < 1_000, `the next tool call came ${next} ms after A woke`);
  const result = await run;
  assert.equal(result.error, null, JSON.stringify(result));
  assert.equal(result.reply, "answered by a");
  assert.equal(calls.length, 160);
  assert.ok(model.served.every(entry => entry.node === "a" && !entry.cut), "every model call was A's, and none was cut");
  assert.ok(!a.logs.some(entry => entry.type === "lease_interrupt" || entry.type === "self_fence"), "no cut, no fence");
  assert.ok(!b.logs.some(entry => entry.type === "node_reaped"), "B found A alive");
  assert.equal(await c.owner(looping.session.id), a.url);
});
