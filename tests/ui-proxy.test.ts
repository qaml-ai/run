import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import express from "express";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createAgentHandler, type AgentHandler } from "../clients/handler.ts";
import { createAgentChat } from "../clients/chat.ts";
import { nodeListener } from "../clients/node.ts";
import { listen, OPERATOR, runtime, sleep, until, type T } from "./runtime-server.ts";

/** A model that streams its answer word by word and holds the rest back until `release`. */
async function heldModel(t: T) {
  const gate = Promise.withResolvers<void>();
  t.after(() => gate.resolve());
  const url = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the request */ }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null = null) => res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    chunk({ role: "assistant", content: "Streaming " });
    await gate.promise;
    chunk({ content: "done." });
    chunk({}, "stop");
    res.end("data: [DONE]\n\n");
  });
  return { url: `${url}/v1`, release: () => gate.resolve() };
}

const USERS: Record<string, string> = { "cookie-alice": "alice", "cookie-bob": "bob" };
async function setup(t: T) {
  const model = await heldModel(t);
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const upstreamSignals: AbortSignal[] = [];
  const handler = createAgentHandler({
    apiKey: OPERATOR, url: r.base, proxy: true,
    authorize: request => { const user = USERS[request.headers.get("cookie") ?? ""]; return user ? { userId: user } : null; },
    agent: { instructions: "You help." },
    fetch: (input, init) => { if (init?.signal) upstreamSignals.push(init.signal); return fetch(input, init); },
  });
  t.after(() => handler.close());
  return { r, model, handler, upstreamSignals };
}
type Call = (path: string, init?: RequestInit) => Promise<Response>;
const post = async (call: Call, body: object, cookie = "cookie-alice") =>
  (await call("/api/agent", { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body) })).json() as Promise<any>;

/**
 * Reads the proxied event stream at `base` while a run streams, and proves the proxy does not buffer:
 * the run's first words arrive while the model still holds back the rest.
 */
async function streamsIncrementally(t: T, call: Call, model: { release(): void }) {
  const { agentId, proxy } = await post(call, { action: "token" });
  assert.equal(proxy, true);
  const response = await call(`/api/agent/v1/agents/${agentId}/events?snapshot=1`, { headers: { cookie: "cookie-alice", Accept: "text/event-stream" } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  let text = "";
  const decoder = new TextDecoder();
  const readUntil = async (pattern: RegExp) => {
    while (!pattern.test(text)) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the stream ended before ${pattern}: ${text.slice(-300)}`);
      text += decoder.decode(value, { stream: true });
    }
  };
  await readUntil(/event: ready/);
  await post(call, { action: "send", text: "go", clientId: "cm_proxy_0001" });
  // The first words, while the model holds the rest: nothing waits for the end of the run.
  await readUntil(/"delta":"Streaming "/);
  assert.doesNotMatch(text, /done\./);
  model.release();
  await readUntil(/"type":"response"/);
  assert.match(text, /done\./);
}

test("proxy: a fetch-style route (Next.js route handlers, Workers) streams the user's own agent's events as they come", async t => {
  const { model, handler } = await setup(t);
  // Next.js: export const GET = handler, POST = handler (in app/api/agent/[[...path]]/route.ts); Workers: { fetch: handler }.
  const call: Call = (path, init = {}) => handler(new Request(`https://app.example${path}`, init));
  await streamsIncrementally(t, call, model);
  // Reads are authorized like everything else: a stranger gets 401, and another user's agent is not found.
  const { agentId: bobs } = await post(call, { action: "token" }, "cookie-bob");
  assert.equal((await call(`/api/agent/v1/agents/${bobs}/history`, { headers: { cookie: "" } })).status, 401);
  assert.equal((await call(`/api/agent/v1/agents/${bobs}/history`, { headers: { cookie: "cookie-alice" } })).status, 404);
  const own = await call(`/api/agent/v1/agents/${bobs}/history?limit=10`, { headers: { cookie: "cookie-bob" } });
  assert.equal(own.status, 200);
  assert.deepEqual((await own.json() as any).entries, []);
  // Only the four reads pass; the proxy adds the token, and never passes the browser's own Authorization on.
  assert.equal((await call(`/api/agent/v1/agents/${bobs}/prompt`, { headers: { cookie: "cookie-bob" } })).status, 404);
  assert.equal((await call(`/api/agent/v1/agents/${bobs}/state`, { headers: { cookie: "cookie-bob", Authorization: `Bearer ${OPERATOR}` } })).status, 200);
  assert.equal((await call(`/api/agent/v1/agents/${bobs}/events?poll=1&wait=0`, { headers: { cookie: "cookie-bob" } })).status, 200, "the long-poll fallback");
});

test("proxy: a browser that goes away aborts the upstream stream", async t => {
  const { handler, upstreamSignals } = await setup(t);
  const token = await (await handler(new Request("https://app.example/api/agent", { method: "POST", headers: { "Content-Type": "application/json", cookie: "cookie-alice" }, body: JSON.stringify({ action: "token" }) }))).json() as any;
  const browser = new AbortController();
  const response = await handler(new Request(`https://app.example/api/agent/v1/agents/${token.agentId}/events?snapshot=1`, { headers: { cookie: "cookie-alice" }, signal: browser.signal }));
  assert.equal(response.status, 200);
  const upstream = upstreamSignals.at(-1)!;
  assert.equal(upstream.aborted, false);
  browser.abort();
  await until(() => upstream.aborted, "the upstream read to be cancelled");
});

test("proxy: Hono streams it", async t => {
  const { model, handler } = await setup(t);
  const app = new Hono();
  app.all("/api/agent", c => handler(c.req.raw));
  app.all("/api/agent/*", c => handler(c.req.raw));
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }) as Server;
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await streamsIncrementally(t, (path, init) => fetch(base + path, init), model);
});

test("proxy: Express (nodeListener) streams it", { todo: "nodeListener buffers response bodies until clients/node.ts streams them (asked of the core SDK)" }, async t => {
  const { model, handler } = await setup(t);
  const app = express();
  app.use("/api/agent", nodeListener(handler));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await Promise.race([
    streamsIncrementally(t, (path, init) => fetch(base + path, init), model),
    sleep(10_000).then(() => { model.release(); throw new Error("no events within 10 s: the response is buffered"); }),
  ]);
});

test("proxy: the chat store reads only through the route, per thread", async t => {
  const model = await heldModel(t);
  model.release();
  const r = await runtime(t, () => ({}), { AGENT_BASE_URL: model.url });
  const handler: AgentHandler = createAgentHandler({ apiKey: OPERATOR, url: r.base, proxy: true, authorize: () => ({ userId: "alice" }), agent: { instructions: "You help." } });
  t.after(() => handler.close());
  const seen: string[] = [];
  const chat = createAgentChat({
    endpoint: "/api/agent", thread: "t 1",
    fetch: async (input, init) => {
      seen.push(String(input));
      assert.ok(String(input).startsWith("/api/agent"), `the browser only calls the route: ${input}`);
      return handler(new Request(`https://app.example${input}`, init));
    },
  });
  t.after(() => chat.destroy());
  await until(() => chat.getSnapshot().connected, "the chat to connect");
  await chat.send("hi");
  await until(() => chat.getSnapshot().status === "ready" && chat.getSnapshot().messages.length === 2, "the reply");
  const reply = chat.getSnapshot().messages[1];
  assert.equal(reply.role === "assistant" && reply.parts.map(part => part.type === "text" ? part.text : "").join(""), "Streaming done.");
  assert.ok(seen.some(url => url.startsWith("/api/agent/threads/t%201/v1/agents/") && url.includes("/events")), seen.join("\n"));
});
