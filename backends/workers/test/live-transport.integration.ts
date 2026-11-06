import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { openEventStream } from "../../../clients/event-transport.ts";
import { AgentRuntime } from "../../../clients/typescript.ts";
import WebSocket from "ws";
import { startFixture } from "./fixture.ts";

test("negotiated WebSocket stays connected when idle and streams the next turn", { timeout: 90_000 }, async t => {
  const f = await startFixture();
  t.after(() => f.stop());
  let negotiations = 0;
  let socketsSelected = 0;
  // Counted on the global fetch: an SDK given its own fetch asks for SSE through it instead.
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/events")) negotiations++;
    const response = await original(url, init);
    if (response.headers.get("content-type")?.startsWith("application/vnd.camelrun.events+json")) {
      const selection = await response.clone().json() as { transport: string };
      assert.equal(selection.transport, "websocket");
      socketsSelected++;
    }
    return response;
  };
  const runtime = new AgentRuntime({ url: f.url, apiKey: f.token });
  const credentials = await (await fetch(f.url + "/v1/agents", {
    method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "test/echo", codeMode: false, fileTools: false }),
  })).json() as { id: string; token: string; expiresAt: number };
  const events: any[] = [];
  const errors: string[] = [];
  const client = await runtime.connectAgent(credentials, { attach: false, onEvent: event => { events.push(event); }, onError: error => { errors.push(error.message); } });
  t.after(() => client.close());
  assert.equal(negotiations, 1);
  assert.equal(socketsSelected, 1, "the unchanged SDK's default offer selects a WebSocket");
  // More than the old SSE watchdog (20s): an idle hibernatable socket must stay open.
  await new Promise(resolve => setTimeout(resolve, 22_000));
  assert.equal(negotiations, 1, `idle WebSocket must not reconnect on the SSE heartbeat watchdog: ${errors.join("; ")}`);
  const result = await client.prompt("after idle", { timeoutMs: 15_000 });
  assert.equal(result.reply, "Echo: after idle");
  assert.ok(events.some(event => event.type === "text_delta" || event.type === "message_end"));
  assert.equal(negotiations, 1);
  // A client that offers only SSE gets SSE, from the front Worker.
  const abort = new AbortController();
  const legacy = await fetch(`${f.url}/clients/${credentials.id}/events?watch=1`, {
    headers: { authorization: `Bearer ${credentials.token}`, accept: "text/event-stream" }, signal: abort.signal,
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get("content-type"), "text/event-stream");
  abort.abort();
});

type Frame = { event?: string; id?: number; data?: any; comment?: string };
/** SSE frames as they arrive, comments (heartbeats) included. */
async function* frames(response: Response): AsyncGenerator<Frame> {
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end; (end = buffer.indexOf("\n\n")) !== -1;) {
        const lines = buffer.slice(0, end).split("\n");
        buffer = buffer.slice(end + 2);
        const field = (name: string) => lines.find(line => line.startsWith(`${name}:`))?.slice(name.length + 1).trim();
        if (lines.every(line => line.startsWith(":"))) { yield { comment: lines.join("\n") }; continue; }
        yield { event: field("event"), id: field("id") ? Number(field("id")) : undefined, data: JSON.parse(field("data") ?? "null") };
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

test("SSE is bridged by the front Worker: the object's frames, Last-Event-ID, heartbeats, an idle reconnect the SDK follows", { timeout: 90_000 }, async t => {
  const f = await startFixture({ vars: { AGENT_SSE_HEARTBEAT_MS: "250", AGENT_SSE_IDLE_MS: "2000" } });
  t.after(() => f.stop());
  const tenant = { authorization: `Bearer ${f.token}`, "content-type": "application/json" };
  const credentials = await (await fetch(f.url + "/v1/agents", {
    method: "POST", headers: tenant, body: JSON.stringify({ model: "test/echo", codeMode: false, fileTools: false }),
  })).json() as { id: string; token: string; expiresAt: number };
  const open = (cursor?: number, query = "watch=1") => fetch(`${f.url}/clients/${credentials.id}/events?${query}`, {
    headers: { authorization: `Bearer ${credentials.token}`, accept: "text/event-stream", ...(cursor ? { "last-event-id": String(cursor) } : {}) },
  });
  const stream = await open();
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.equal(stream.headers.get("x-agent-transport"), null, "an SSE body, not the SDK's WebSocket adapter");
  const seen: Frame[] = [];
  let prompted = false;
  for await (const frame of frames(stream)) {
    seen.push(frame);
    if (frame.event === "ready" && !prompted) {
      prompted = true;
      assert.equal(frame.data.agentId, credentials.id);
      const sent = await fetch(`${f.url}/v1/agents/${credentials.id}/requests`, {
        method: "POST", headers: tenant, body: JSON.stringify({ id: "bridged", method: "prompt", params: { text: "over the bridge", allowDisconnected: true } }),
      });
      assert.equal(sent.status, 202);
    }
    if (frame.event === "reconnect") break;
  }
  const events = seen.filter(frame => frame.id !== undefined && frame.data?.type !== "snapshot");
  assert.ok(events.some(frame => frame.data.type === "response" && frame.data.id === "bridged"), "the run's events arrive as SSE");
  assert.ok(events.every((frame, i) => i === 0 || frame.id! > events[i - 1].id!), "ids are the object's cursors, in order");
  assert.ok(seen.some(frame => frame.comment === ": heartbeat"), "an idle stream carries heartbeats");
  const last = seen.at(-1)!;
  assert.equal(last.event, "reconnect", "a stream idle past the backstop ends with a reconnect frame");
  assert.equal(last.data.reason, "idle");

  // Last-Event-ID resumes after that event, as on Node.
  const middle = events[Math.floor(events.length / 2)].id!;
  const resumed: Frame[] = [];
  for await (const frame of frames(await open(middle))) {
    if (frame.id !== undefined) resumed.push(frame);
    if (frame.data?.type === "response") break;
  }
  assert.deepEqual(resumed.map(frame => frame.id), events.filter(frame => frame.id! > middle).map(frame => frame.id));

  // Refusals before the upgrade keep their status: a replay gap without a snapshot is 409.
  const gap = await open(1_000_000, "watch=1&snapshot=0");
  assert.equal(gap.status, 409);
  await gap.body?.cancel();

  // The SDK, offered SSE only, follows the idle reconnects and resumes without losing events.
  let streams = 0;
  const sseOnly: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    if (String(url).includes("/events")) { streams++; headers.set("accept", "text/event-stream"); }
    return fetch(url, { ...init, headers });
  };
  const errors: string[] = [];
  const client = await new AgentRuntime({ url: f.url, apiKey: f.token, fetch: sseOnly })
    .connectAgent(credentials, { attach: false, onError: error => { errors.push(error.message); } });
  t.after(() => client.close());
  await new Promise(resolve => setTimeout(resolve, 5_000));
  assert.ok(streams >= 3, `idle streams were closed and reopened (${streams})`);
  const result = await client.prompt("after idle reconnects", { timeoutMs: 15_000 });
  assert.equal(result.reply, "Echo: after idle reconnects");
  assert.deepEqual(errors, []);
});

test("browser WebSockets keep filters, redaction, read-only scopes and expiry", { timeout: 45_000 }, async t => {
  const f = await startFixture();
  t.after(() => f.stop());
  const credentials = await (await fetch(f.url + "/v1/agents", {
    method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "test/echo", codeMode: false, fileTools: false }),
  })).json() as { id: string };
  const minted = await fetch(`${f.url}/v1/agents/${credentials.id}/browser-tokens`, {
    method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ ttlSeconds: 5, scopes: ["events"], events: ["message_end"], redact: ["usage.cost"] }),
  });
  assert.equal(minted.status, 201);
  const { token } = await minted.json() as { token: string };
  const frames: any[] = [];
  const socket = new WebSocket(`${f.url.replace(/^http/, "ws")}/v1/agents/${credentials.id}/events`, ["camelrun.events.v1", `bearer.${Buffer.from(token).toString("base64url")}`]);
  t.after(() => socket.terminate());
  socket.on("error", () => {});
  socket.on("message", value => frames.push(JSON.parse(String(value))));
  const closed = new Promise<number>(resolve => socket.once("close", code => resolve(code)));
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const sent = await fetch(`${f.url}/v1/agents/${credentials.id}/requests`, {
    method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "browser-projection", method: "prompt", params: { text: "filtered", allowDisconnected: true } }),
  });
  assert.equal(sent.status, 202);
  for (let i = 0; i < 100 && !frames.some(frame => frame.data?.type === "response"); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(frames.some(frame => frame.data?.event?.type === "message_end"));
  const events = frames.filter(frame => frame.data?.type === "event");
  assert.ok(events.every(frame => frame.data.event.type === "message_end"));
  const noCosts = (value: any): boolean => !value || typeof value !== "object" || Object.entries(value).every(([key, item]) =>
    (key !== "usage" || !item || typeof item !== "object" || Object.keys(item).every(field => !/cost/i.test(field))) && noCosts(item));
  assert.ok(frames.every(noCosts));
  const response = frames.find(frame => frame.data?.type === "response");
  assert.ok(response);
  assert.equal(response.data.outcome.result, undefined);
  const write = await fetch(`${f.url}/v1/agents/${credentials.id}/requests`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(write.status, 403);
  assert.equal(await Promise.race([closed, new Promise(resolve => setTimeout(() => resolve("timeout"), 10_000))]), 1008);
});


test("watcher reservations enforce one tenant limit across agents and release on disconnect", { timeout: 45_000 }, async t => {
  const token = "local-quota-fixture-only-not-a-real-credential", tenant = "socket-quota";
  const f = await startFixture({ token, tenant, vars: { AGENT_TENANTS_JSON: JSON.stringify({ tenants: {
    [tenant]: { tokenSha256: createHash("sha256").update(token).digest("hex"), apiKeys: {}, maxWatchers: 2 },
  } }) } });
  t.after(() => f.stop());
  const headers = { authorization: `Bearer ${token}` };
  const create = async () => (await (await fetch(`${f.url}/v1/agents`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ model: "test/echo", codeMode: false, fileTools: false }),
  })).json() as { id: string }).id;
  const a = await create(), b = await create();
  const controller = new AbortController();
  t.after(() => controller.abort());
  // The first is bridged SSE: its reservation is the object's socket's, and cancelling the stream returns it.
  const first = await fetch(`${f.url}/v1/agents/${a}/events`, { headers: { ...headers, accept: "text/event-stream" }, signal: controller.signal });
  assert.equal(first.headers.get("content-type"), "text/event-stream");
  const second = await openEventStream(fetch, `${f.url}/v1/agents/${b}/events`, { headers, signal: controller.signal });
  for (const response of [first, second]) {
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
    reader.releaseLock();
  }
  const negotiate = () => fetch(`${f.url}/v1/agents/${a}/events`, { headers: { ...headers, accept: "application/vnd.camelrun.events+json, text/event-stream" } });
  assert.equal((await negotiate()).status, 429, "different agents share the configured tenant limit");
  await first.body!.cancel();
  let released = false;
  for (let i = 0; i < 100; i++) {
    if ((await negotiate()).status === 200) { released = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(released, "closing a socket returns its durable reservation");
  const cursor = (await (await fetch(`${f.url}/v1/agents/${a}/state`, { headers })).json() as { cursor: number }).cursor;
  const pollAbort = new AbortController();
  const poll = fetch(`${f.url}/v1/agents/${a}/events?poll=1&snapshot=0&wait=20`, {
    headers: { ...headers, "last-event-id": String(cursor) }, signal: pollAbort.signal,
  }).catch(() => undefined);
  t.after(() => pollAbort.abort());
  let shared = false;
  for (let i = 0; i < 100; i++) {
    if ((await negotiate()).status === 429) { shared = true; break; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(shared, "bounded JSON polls and sockets share the same quota");
  pollAbort.abort();
  await poll;
  await second.body!.cancel();
});
