import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRuntime, type SessionCredentials } from "../clients/typescript.ts";

const session: SessionCredentials = { id: `client_${"a".repeat(40)}`, token: "scoped-test-token", expiresAt: Date.now() + 60_000 };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test("portable SDK hands events to consumers apart from the stream, and attaches with saved credentials", async () => {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let eventStream: ReadableStreamDefaultController<Uint8Array>;
  const encode = new TextEncoder();
  const requestIds: (string | undefined)[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/events?snapshot=1")) {
      assert.equal(new Headers(init?.headers).get("Last-Event-ID"), "0", "a new client starts from the snapshot");
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        eventStream = controller;
        controller.enqueue(encode.encode('event: ready\ndata: {}\n\n'));
        init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
      } });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    assert.ok(url.endsWith("/state"));
    return Response.json({ cursor: 4, calls: [], requests: [] });
  };
  const client = await new AgentRuntime({ fetch: fetcher }).connectAgent(session, {
    tools: {}, async onEvent(_event, requestId) { requestIds.push(requestId); started.resolve(); await gate.promise; },
  });
  try {
    eventStream!.enqueue(encode.encode('id: 5\ndata: {"type":"event","requestId":"turn-123","event":{"type":"message_end"}}\n\n'));
    await started.promise;
    // A consumer still busy with a display event never holds up the stream.
    eventStream!.enqueue(encode.encode('id: 6\ndata: {"type":"tool_cancel","id":"none"}\n\n'));
    await tick();
    gate.resolve(); await tick();
    assert.deepEqual(requestIds, ["turn-123"]);
  } finally { gate.resolve(); await client.close(); }
});

test("the SDK keeps no cursor store: a restarted client resumes from a snapshot", async () => {
  const sdk = await import("../clients/typescript.ts");
  const node = await import("../clients/node.ts");
  assert.equal("memoryJournalStore" in sdk, false);
  assert.equal("fileJournalStore" in node, false);
});

test("the SDK is its agent's MCP server: it answers initialize, tools/list and tools/call on the connection it was given, and honours cancellation", async () => {
  let eventStream: ReadableStreamDefaultController<Uint8Array>;
  const posted: { connection: string | null; message: any }[] = [];
  const answered = Promise.withResolvers<void>();
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/events?snapshot=1")) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      eventStream = controller;
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"version":4,"connection":"conn-1"}\n\n'));
      init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
    if (url.endsWith("/state")) return Response.json({ cursor: 0, requests: [] });
    assert.ok(url.endsWith("/mcp"));
    posted.push({ connection: new Headers(init?.headers).get("X-Agent-Connection"), message: JSON.parse(String(init?.body)) });
    if (posted.length === 3) answered.resolve();
    return Response.json({ accepted: true }, { status: 202 });
  };
  const cancelled = Promise.withResolvers<void>();
  const client = await new AgentRuntime({ fetch: fetcher }).connectAgent(session, { tools: {
    echo: { description: "echo", input: { type: "object" }, execute: (args: any, context) => ({ said: args.text, callId: context.callId }) },
    slow: { description: "slow", input: { type: "object" }, execute: (_args, context) => new Promise((_, reject) => context.signal.addEventListener("abort", () => { cancelled.resolve(); reject(new Error("stopped")); })) },
  } });
  try {
    const send = (message: unknown) => eventStream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "mcp", message })}\n\n`));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" }, _meta: { "agent-runtime/callId": "call-9" } } });
    send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "slow", arguments: {} } });
    await answered.promise;
    send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 4 } });
    await cancelled.promise;
    const byId = Object.fromEntries(posted.map(entry => [entry.message.id, entry.message]));
    assert.deepEqual(new Set(posted.map(entry => entry.connection)), new Set(["conn-1"]));
    assert.equal(byId[1].result.protocolVersion, "2025-06-18");
    assert.deepEqual(byId[1].result.capabilities, { tools: {} });
    assert.deepEqual(byId[2].result.tools.map((tool: any) => tool.name), ["echo", "slow"]);
    assert.deepEqual(byId[3].result.structuredContent, { said: "hi", callId: "call-9" });
  } finally { await client.close(); }
});

test("native fetch is bound to the global receiver required by Workers", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async function (this: unknown, input, init) {
    assert.equal(this, globalThis);
    calls++;
    if (String(input).endsWith("/events?snapshot=1")) return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
      init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
    } }), { headers: { "Content-Type": "text/event-stream" } });
    return Response.json({ cursor: 0, calls: [], requests: [] });
  };
  try {
    const client = await new AgentRuntime().connectAgent(session, { tools: {} });
    await client.close();
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

test("JSON transport uses manual redirects and rejects them without following credentials", async () => {
  let calls = 0;
  let cancelled = false;
  const runtime = new AgentRuntime({ apiKey: "operator-key", fetch: async (_input, init) => {
    calls++; assert.equal(init?.redirect, "manual");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 302, headers: { Location: "https://untrusted.example/steal" },
    });
  } });
  await assert.rejects(runtime.createAgent({ tools: {} }), /redirects are not allowed/);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test("SSE transport uses manual redirects and cancels redirect bodies without following", async () => {
  let calls = 0;
  let cancelled = false;
  const runtime = new AgentRuntime({ fetch: async (_input, init) => {
    calls++; assert.equal(init?.redirect, "manual");
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 307, headers: { Location: "https://untrusted.example/steal" },
    });
  } });
  await assert.rejects(runtime.connectAgent(session, { tools: {} }), /redirects are not allowed/);
  assert.equal(calls, 1); assert.equal(cancelled, true);
});

test("the SDK retries 429s, honouring Retry-After, even for requests it does not otherwise retry", async () => {
  const seen: number[] = [];
  let refusals = 2;
  const fetcher: typeof fetch = async () => {
    seen.push(Date.now());
    if (refusals-- > 0) return Response.json({ error: "This tenant already has 1 agents running" }, { status: 429, headers: { "Retry-After": "1" } });
    return Response.json({ id: `vol_${"b".repeat(24)}`, name: "v", createdAt: 1 }, { status: 201 });
  };
  const runtime = new AgentRuntime({ fetch: fetcher, apiKey: "operator" });
  const volume = await runtime.createVolume({ name: "v" });
  assert.equal(volume.name, "v");
  assert.equal(seen.length, 3);
  assert.ok(seen[1] - seen[0] >= 1000 && seen[2] - seen[1] >= 1000, "waited for Retry-After");

  // A runtime that keeps refusing is given up on, with the status.
  let attempts = 0;
  const refusing = new AgentRuntime({ apiKey: "operator", fetch: async () => { attempts++; return Response.json({ error: "busy" }, { status: 429, headers: { "Retry-After": "0" } }); } });
  await assert.rejects(refusing.listVolumes(), (error: any) => error.status === 429 && error.retryAfterMs === 0);
  assert.equal(attempts, 8);
});

test("a file transfer that stalls fails instead of hanging its caller", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const runtime = new AgentRuntime({ apiKey: "operator", fetch: async (_input, init) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(new TextEncoder().encode("part of the file"));
      init!.signal!.addEventListener("abort", () => stream.error(init!.signal!.reason));
    },
  }), { headers: { ETag: '"1"', "Content-Length": "1000" } }) });
  const read = runtime.volume(`vol_${"c".repeat(24)}`).read("report.md");
  read.catch(() => {});
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30_000);
  await assert.rejects(read, /File transfer stalled/);
});

test("a file's version comes from X-File-Version, whatever a proxy made of its ETag", async () => {
  const runtime = new AgentRuntime({ apiKey: "operator", fetch: async () => new Response("bytes", { headers: { ETag: 'W/"2"', "X-File-Version": "2" } }) });
  assert.equal((await runtime.volume(`vol_${"c".repeat(24)}`).read("report.md")).version, 2);
});
