import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { cluster, fakeEcs, fakeModel, sleep, token, toolMessages, until } from "./cluster-helpers.ts";

// Stateless runs are sessions like any agent's, so a run is as durable as an agent's run: these are the cluster
// scenarios of cluster-resume and cluster-step-handoff, for a run whose tool is a remote MCP server's (a side effect
// the runtime calls itself: a run has no application connected).
type T = Parameters<typeof cluster>[0];
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_TOOL_TIMEOUT_MS: "120000", ...(process.env.AGENT_HOSTING ? { AGENT_HOSTING: process.env.AGENT_HOSTING } : {}) };

const api = async (base: string, path: string, body?: unknown) => {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, json: await response.json() as any };
};

/** An MCP server with one tool, `effect`: each call is counted, and waits for `gate` (open unless closed). */
async function mcpServer(t: T) {
  const calls: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  const entered: (() => void)[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const server = createServer(async (req, res) => {
    let body: unknown;
    if (req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      body = JSON.parse(text);
    }
    const id = req.headers["mcp-session-id"] as string | undefined;
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      if (id || !isInitializeRequest(body)) { res.writeHead(404).end(); return; }
      const mcp = new McpServer({ name: "ops", version: "1.0.0" });
      mcp.registerTool("effect", { description: "Does something with a side effect", inputSchema: { step: z.number() } }, async ({ step }) => {
        calls.push(`effect:${step}`);
        for (const wake of entered.splice(0)) wake();
        await gate;
        return { content: [{ type: "text" as const, text: `effect-${step}-done` }] };
      });
      const created = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: session => { sessions.set(session, created); } });
      await mcp.connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, calls,
    /** Hold the next calls until `release`. */
    close() { const held = Promise.withResolvers<void>(); gate = held.promise; return held.resolve; },
    entered: () => new Promise<void>(resolve => entered.push(resolve)),
  };
}
const effect = (step: number) => ({ role: "assistant", tool_calls: [{ index: 0, id: `call_${step}`, type: "function", function: { name: "ops__effect", arguments: JSON.stringify({ step }) } }] });

/**
 * Follow a run's event stream as a client does, from whichever node is up and not draining, reconnecting with
 * Last-Event-ID: every raw frame, and when each request started. Ends with the run's response frame.
 */
function follow(nodes: { url: string; child: { exitCode: number | null; signalCode: NodeJS.Signals | null }; logs: any[] }[], runId: string) {
  const frames: string[] = [], starts: number[] = [];
  let cursor = 0, turn = 0;
  const done = (async () => {
    for (const deadline = Date.now() + 90_000; Date.now() < deadline;) {
      const up = nodes.filter(node => node.child.exitCode === null && node.child.signalCode === null && !node.logs.some(entry => entry.type === "retiring" || entry.type === "drain_started"));
      const node = up[turn++ % up.length];
      starts.push(Date.now());
      try {
        const response = await fetch(`${node.url}/v1/runs/${runId}/events`, { headers: { Authorization: `Bearer ${token}`, ...(cursor ? { "Last-Event-ID": String(cursor) } : {}) } });
        if (!response.ok || !response.body) { await response.body?.cancel(); await sleep(100); continue; }
        let buffer = "";
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          buffer += chunk;
          for (let end; (end = buffer.indexOf("\n\n")) !== -1; buffer = buffer.slice(end + 2)) {
            const frame = buffer.slice(0, end);
            frames.push(frame);
            const id = frame.split("\n").find(line => line.startsWith("id:"));
            if (id) cursor = Number(id.slice(3));
            if (/"type":"response"/.test(frame)) return;
          }
        }
      } catch { /* cut off: reconnect */ }
    }
  })();
  return { frames, starts, done };
}

async function definition(base: string, url: string) {
  const made = await api(base, "/v1/definitions", { name: "Ops", mcpServers: [{ name: "ops", url, exposure: "direct" }] });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  return made.json.id as string;
}
/** A run's request once it ends, asked of whichever node answers. */
async function ended(nodes: { url: string; child: { exitCode: number | null; signalCode: NodeJS.Signals | null } }[], runId: string) {
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    const node = nodes.find(entry => entry.child.exitCode === null && entry.child.signalCode === null)!;
    const read = await api(node.url, `/v1/runs/${runId}?wait=5`).catch(() => undefined);
    if (read?.json.status && read.json.status !== "running") return read.json;
    await sleep(200);
  }
  throw new Error("The run did not end");
}

test("a run whose node dies after its tool call completed resumes on another node, without calling the tool again", { timeout: 90_000 }, async t => {
  const c = await cluster(t);
  const mcp = await mcpServer(t);
  // The tool call, then a model call that never answers on A (its node dies during it), then the answer on B.
  const model = await fakeModel(t, (_body, index) => index === 0 ? effect(1) : index === 1 ? undefined : { role: "assistant", content: "effect done once" });
  // A lease that outlasts a database or CPU stall on a loaded runner, as cluster-resume's has: under the cluster's 1.5 s, a
  // stall fenced B as well and moved the run again, a second resume. B still takes over soon after A dies: it ends a dead
  // peer's late heartbeat (Ownership.reap).
  const lease = { AGENT_LEASE_TTL_MS: "6000" };
  const a = await c.start("a", { ...model.env, ...LOCAL, ...lease });
  const b = await c.start("b", { ...model.env, ...LOCAL, ...lease });
  const created = await api(a.url, "/v1/runs", { definition: await definition(a.url, mcp.url), input: "do the thing" });
  assert.equal(created.status, 202, JSON.stringify(created.json));
  const runId = created.json.id;
  await until(() => model.bodies.length === 2, "A to call the model after the tool");
  assert.deepEqual(mcp.calls, ["effect:1"]);
  a.child.kill("SIGKILL");
  await once(a.child, "close");

  const run = await ended([b], runId);
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.text, "effect done once");
  assert.equal(run.resumes, 1);
  assert.deepEqual(mcp.calls, ["effect:1"], "the tool was not called again");
  assert.equal(model.bodies.length, 3, "one more model call, not a new run");
  assert.equal(model.bodies[2].messages.filter((message: any) => message.role === "user").length, 1, "the input was not sent again");
  assert.ok(toolMessages(model.bodies[2]).some((content: string) => content.includes("effect-1-done")), "the completed step's result carried over");
  // A lost node's tool calls and usage died with it (as an agent's run after a crash): its history has the call.
  const history = (await api(b.url, `/v1/runs/${runId}/messages`)).json.messages;
  assert.equal(history.filter((message: any) => message.role === "toolResult").length, 1);
  assert.equal(await c.owner(`client_${runId.slice(4)}`), b.url);
  // Still no agent.
  assert.deepEqual((await api(b.url, "/v1/agents")).json, []);
});

test("a run on a retiring node finishes its tool call there, and is handed off at the step boundary: nothing lost, no resume spent", { timeout: 120_000 }, async t => {
  const c = await cluster(t);
  const mcp = await mcpServer(t);
  const model = await fakeModel(t, (_body, index) => index === 0 ? effect(1) : { role: "assistant", content: "continued on b" });
  const QUIET = { AGENT_ORPHAN_SWEEP_MS: "600000" };
  const ecsA = await fakeEcs(t), ecsB = await fakeEcs(t);
  const a = await c.start("a", { ...ecsA.env, ...model.env, ...LOCAL, ...QUIET });
  const b = await c.start("b", { ...ecsB.env, ...model.env, ...LOCAL, ...QUIET });
  const release = mcp.close();
  t.after(() => release());
  const entered = mcp.entered();
  const created = await api(a.url, "/v1/runs", { definition: await definition(a.url, mcp.url), input: "long step" });
  const runId = created.json.id, session = `client_${runId.slice(4)}`;
  await entered;
  assert.equal(await c.owner(session), a.url);
  const watcher = follow([a, b], runId);
  // A newer deploy supersedes A: it retires, but lets its step finish.
  ecsA.state.revision++;
  ecsA.state.created = Date.now() / 1000;
  await until(() => a.logs.some(entry => entry.type === "retiring"), "A to retire");
  await sleep(500);
  assert.equal(await c.owner(session), a.url, "A keeps the run while its step runs");
  release();

  const run = await ended([b, a], runId);
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.equal(run.text, "continued on b");
  assert.deepEqual(mcp.calls, ["effect:1"], "the tool call ran once, on A");
  assert.equal(model.bodies.length, 2, "one model call per step");
  assert.ok(!toolMessages(model.bodies[1]).some((content: string) => /outcome is unknown|may or may not have/.test(content)));
  assert.equal(run.resumes, undefined, "a hand-off at a boundary is not a resume");
  assert.deepEqual(run.handoffs.map((entry: any) => entry.reason), ["retire"]);
  const [line] = b.logs.filter(entry => entry.type === "turn_handed_off");
  assert.equal(line?.Step, "tool", JSON.stringify(line));
  assert.equal(line.request, runId);
  assert.equal(await c.owner(session), b.url);
  assert.equal(run.usage.responses, 2, "usage counts both nodes' responses");
  // The run's stream on A ended with a reconnect hint, and picked up on B with every event once, through its response.
  await watcher.done;
  const hint = watcher.frames.findIndex(frame => frame.includes("event: reconnect"));
  assert.ok(hint >= 0, "a reconnect hint");
  assert.match(watcher.frames[hint], /"reason":"drain"/);
  assert.ok(watcher.starts.length >= 2, "it reconnected");
  const ids = watcher.frames.flatMap(frame => frame.split("\n").filter(line => line.startsWith("id:")).map(line => Number(line.slice(3))));
  assert.deepEqual(ids, [...new Set(ids)].sort((x, y) => x - y), "every event once, in order");
  assert.match(watcher.frames.at(-1)!, /continued on b/);
});
