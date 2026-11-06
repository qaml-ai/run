import assert from "node:assert/strict";
import test from "node:test";
import { bridgeEvents, bridgeOptions, wantsEventStream } from "../src/sse-bridge.ts";

/** The Worker's side of the object's socket: frames in, close out. */
class Socket extends EventTarget {
  accepted = false;
  closed?: { code: number; reason: string };
  accept() { this.accepted = true; }
  close(code: number, reason: string) { this.closed ??= { code, reason }; }
  frame(value: unknown) { this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(value) })); }
  end() { this.dispatchEvent(new Event("close")); }
}

const sse = (url = "https://runtime.test/clients/a/events?watch=1", headers: Record<string, string> = {}, signal?: AbortSignal) =>
  new Request(url, { headers: { authorization: "Bearer token", accept: "text/event-stream", "last-event-id": "7", ...headers }, signal });

async function bridged(options: { heartbeatMs?: number; idleMs?: number } = {}, signal?: AbortSignal) {
  const socket = new Socket();
  let upstream: Request | undefined;
  const response = await bridgeEvents(sse(undefined, {}, signal), async request => {
    upstream = request;
    return { status: 101, webSocket: socket } as unknown as Response;
  }, { heartbeatMs: 60_000, idleMs: 60_000, ...options });
  return { socket, response, upstream: upstream!, reader: response.body!.getReader() };
}
const text = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  const { value, done } = await reader.read();
  return done ? undefined : new TextDecoder().decode(value);
};

test("only live reads that do not offer the WebSocket capability are bridged", () => {
  const get = (accept?: string, url = "https://runtime.test/v1/agents/a/events", headers: Record<string, string> = {}) =>
    wantsEventStream(new Request(url, { headers: { ...(accept ? { accept } : {}), ...headers } }));
  assert.equal(get("text/event-stream"), true);
  assert.equal(get(), true, "no Accept is SSE, as on Node");
  assert.equal(get("*/*"), true);
  assert.equal(get("application/vnd.camelrun.events+json, text/event-stream"), false, "the SDK's offer negotiates a WebSocket");
  assert.equal(get(undefined, "https://runtime.test/v1/agents/a/events?poll=1&wait=25"), false, "long polls stay JSON");
  assert.equal(get(undefined, undefined, { upgrade: "websocket" }), false);
  assert.equal(wantsEventStream(new Request("https://runtime.test/v1/agents/a/events", { method: "POST" })), false);
  assert.deepEqual(bridgeOptions({ AGENT_SSE_HEARTBEAT_MS: "250", AGENT_SSE_IDLE_MS: "2000" }), { heartbeatMs: 250, idleMs: 2000 });
  assert.deepEqual(bridgeOptions({}), { heartbeatMs: undefined, idleMs: undefined });
});

test("the object's frames become Node's SSE frames, and its closed frame ends the stream", async () => {
  const { socket, response, upstream, reader } = await bridged();
  assert.equal(upstream.headers.get("upgrade"), "websocket");
  assert.equal(upstream.headers.get("accept"), null, "no capability offer: the object upgrades");
  assert.equal(upstream.headers.get("authorization"), "Bearer token");
  assert.equal(upstream.headers.get("last-event-id"), "7", "resume semantics are the object's");
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-agent-transport"), null);
  assert.ok(socket.accepted);
  socket.frame({ event: "ready", data: { version: 5, agentId: "a", watch: true } });
  assert.equal(await text(reader), `event: ready\ndata: {"version":5,"agentId":"a","watch":true}\n\n`);
  socket.frame({ id: 8, data: { type: "event", event: { type: "agent_start" } } });
  assert.equal(await text(reader), `id: 8\ndata: {"type":"event","event":{"type":"agent_start"}}\n\n`);
  socket.frame({ data: { type: "mcp", message: { id: 1 } } });
  assert.equal(await text(reader), `data: {"type":"mcp","message":{"id":1}}\n\n`, "live-only frames keep no id");
  socket.frame({ event: "closed", data: { reason: "replaced" } });
  assert.equal(await text(reader), `event: closed\ndata: {"reason":"replaced"}\n\n`);
  assert.equal(await text(reader), undefined);
  assert.deepEqual(socket.closed, { code: 1000, reason: "Stream closed" });
});

test("a refusal before the upgrade is the answer as it is", async () => {
  const refusal = Response.json({ error: "REPLAY_GAP: recover from session state" }, { status: 409 });
  assert.equal(await bridgeEvents(sse(), async () => refusal), refusal);
});

test("heartbeats keep an idle stream open; the idle backstop ends it with a reconnect frame", async () => {
  const { socket, reader } = await bridged({ heartbeatMs: 20, idleMs: 120 });
  socket.frame({ event: "ready", data: {} });
  await text(reader);
  assert.equal(await text(reader), ": heartbeat\n\n");
  let rest = "";
  for (let chunk; (chunk = await text(reader)) !== undefined;) rest += chunk;
  assert.match(rest, /^(?:: heartbeat\n\n)+event: reconnect\nretry: 0\ndata: \{"type":"reconnect","reason":"idle","retryMs":0\}\n\n$/);
  assert.deepEqual(socket.closed, { code: 1000, reason: "Stream closed" });
});

test("events push the idle backstop back", async () => {
  const { socket, reader } = await bridged({ idleMs: 150 });
  for (let id = 1; id <= 4; id++) {
    await new Promise(resolve => setTimeout(resolve, 75));
    socket.frame({ id, data: { type: "event" } });
    assert.match((await text(reader))!, new RegExp(`^id: ${id}\n`));
  }
  assert.equal(socket.closed, undefined, "300 ms with an event every 75 ms is not idle");
  await reader.cancel();
});

test("a subscriber that goes away closes the object's socket", async () => {
  const { socket, reader } = await bridged();
  await reader.cancel();
  assert.deepEqual(socket.closed, { code: 1000, reason: "Subscriber gone" });
  const abort = new AbortController();
  const second = await bridged({}, abort.signal);
  abort.abort();
  assert.deepEqual(second.socket.closed, { code: 1000, reason: "Subscriber gone" });
});

test("the object's socket closing ends the stream", async () => {
  const { socket, reader } = await bridged();
  socket.end();
  assert.equal(await text(reader), undefined);
});

test("a subscriber more than two frames behind is cut off, as on Node", async () => {
  const { socket, reader } = await bridged();
  const big = "x".repeat(600_000);
  for (let id = 1; id <= 4; id++) socket.frame({ id, data: big });
  await assert.rejects(async () => { for (;;) if ((await reader.read()).done) break; }, /too slow/);
  assert.deepEqual(socket.closed, { code: 1011, reason: "Subscriber too slow" });
});
