import { test } from "node:test";
import assert from "node:assert/strict";
import { openEventStream } from "../clients/event-transport.ts";
import { eventFrame, negotiateEvents, websocketAuthorization, webSocketRequired, EVENT_PROTOCOL } from "../backends/workers/src/live-transport.ts";
import { watchAgent } from "../clients/watch.ts";

class Socket extends EventTarget {
  static last: Socket;
  readyState = 1;
  protocol = EVENT_PROTOCOL;
  readonly url: string;
  readonly protocols: string[];
  constructor(url: string | URL, protocols: string[]) {
    super(); this.url = String(url); this.protocols = protocols; Socket.last = this;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  close() { this.readyState = 3; }
  message(value: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
}

test("Workers select WebSocket in either offer order and refuse SSE-only streams", async () => {
  for (const accept of ["application/vnd.camelrun.events+json, text/event-stream", "text/event-stream, application/vnd.camelrun.events+json"]) {
    const response = negotiateEvents(new Request("https://runtime.test/events", { headers: { accept } }));
    assert.ok(response);
    assert.equal((await response.json()).transport, "websocket");
  }
  for (const accept of ["text/event-stream", "application/json", "*/*"]) {
    assert.equal(negotiateEvents(new Request("https://runtime.test/events", { headers: { accept } })), undefined);
  }
  const refused = webSocketRequired();
  assert.equal(refused.status, 406);
  assert.equal((await refused.json()).code, "WEBSOCKET_REQUIRED");
});

test("SSE Content-Type explicitly selects the current Node stream in one request", async () => {
  let calls = 0;
  const response = new Response("event: ready\ndata: {}\n\n", { headers: { "content-type": "text/event-stream" } });
  const selected = await openEventStream(async (_url, init) => {
    calls++; assert.equal(new Headers(init?.headers).get("accept"), "application/vnd.camelrun.events+json, text/event-stream");
    return response;
  }, "https://runtime.test/clients/a/events", { headers: { authorization: "Bearer secret" } });
  assert.equal(selected, response); assert.equal(calls, 1);
});

test("negotiated WebSockets preserve frames and carry credentials outside URLs", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const signal = new AbortController();
  try {
    let calls = 0;
    const response = await openEventStream(async () => {
      calls++;
      return negotiateEvents(new Request("https://runtime.test/clients/a/events?snapshot=1", { headers: { accept: "application/vnd.camelrun.events+json, text/event-stream" } }))!;
    }, "https://runtime.test/clients/a/events?snapshot=1", { headers: { authorization: "Bearer secret", "last-event-id": "9" }, signal: signal.signal });
    assert.equal(response.headers.get("x-agent-transport"), "websocket");
    assert.equal(Socket.last.url, "wss://runtime.test/clients/a/events?snapshot=1&cursor=9");
    assert.deepEqual(Socket.last.protocols, [EVENT_PROTOCOL, "bearer.c2VjcmV0"]);
    Socket.last.message(JSON.parse(eventFrame({}, undefined, "ready")));
    Socket.last.message(JSON.parse(eventFrame({ type: "snapshot", cursor: 9, turn: null }, 9)));
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "event: ready\ndata: {}\n\n");
    const second = await reader.read();
    assert.equal(new TextDecoder().decode(second.value), 'id: 9\ndata: {"type":"snapshot","cursor":9,"turn":null}\n\n');
    Socket.last.dispatchEvent(new Event("error"));
    await assert.rejects(reader.read(), /WebSocket failed/);
    assert.equal(calls, 1, "a failed socket never silently downgrades to SSE");
  } finally { signal.abort(); globalThis.WebSocket = original; }
});

test("capability response cannot send a bearer credential to another origin", async () => {
  await assert.rejects(openEventStream(async () => Response.json({ transport: "websocket", protocol: EVENT_PROTOCOL, url: "https://evil.test/events" }, { headers: { "content-type": "application/vnd.camelrun.events+json" } }), "https://runtime.test/events", { headers: { authorization: "Bearer secret" } }), /origin/);
});

test("a protocol close ends the reader before the host closes the transport", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  try {
    const response = await openEventStream(async () => negotiateEvents(new Request("https://runtime.test/events", {
      headers: { accept: "application/vnd.camelrun.events+json" },
    }))!, "https://runtime.test/events", { headers: { authorization: "Bearer fixture" } });
    const reader = response.body!.getReader();
    Socket.last.message({ event: "closed", data: { reason: "expired" } });
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'event: closed\ndata: {"reason":"expired"}\n\n');
    assert.deepEqual(await reader.read(), { value: undefined, done: true });
    assert.equal(Socket.last.readyState, 3, "the client also initiates transport closure");
  } finally { globalThis.WebSocket = original; }
});

test("browser upgrade authentication accepts only the named protocol", () => {
  const request = new Request("https://runtime.test/events", { headers: { upgrade: "websocket", "sec-websocket-protocol": `${EVENT_PROTOCOL}, bearer.c2VjcmV0` } });
  assert.equal(websocketAuthorization(request).headers.get("authorization"), "Bearer secret");
  assert.equal(websocketAuthorization(new Request(request, { headers: { upgrade: "websocket", "sec-websocket-protocol": "unrelated, bearer.c2VjcmV0" } })).headers.get("authorization"), null);
});

test("browser watcher preserves capability headers and selects a WebSocket", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  let offered = "";
  const watcher = watchAgent({
    url: "https://runtime.test", agentId: `client_${"a".repeat(40)}`, token: "fixture",
    fetch: async (url, init) => {
      const request = new Request(url, init);
      if (request.url.includes("/events")) {
        offered = request.headers.get("accept") ?? "";
        return negotiateEvents(request)!;
      }
      if (request.url.includes("/state")) return Response.json({ cursor: 1, running: false, requests: [] });
      if (request.url.includes("/history")) return Response.json({ entries: [], next: null });
      return Response.json([]);
    },
  });
  try {
    for (let i = 0; i < 100 && !offered; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(offered, "application/vnd.camelrun.events+json, text/event-stream");
    Socket.last.message(JSON.parse(eventFrame({}, undefined, "ready")));
    for (let i = 0; i < 100 && !watcher.state.connected; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(watcher.state.transport, "websocket");
  } finally { watcher.close(); globalThis.WebSocket = original; }
});

test("a watcher closes its socket when consuming an event fails", async () => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket as unknown as typeof WebSocket;
  const previous = Socket.last;
  let selected: Socket | undefined;
  const errors: Error[] = [];
  const watcher = watchAgent({
    url: "https://runtime.test", agentId: `client_${"a".repeat(40)}`, token: "fixture",
    onEvent() { throw new Error("Consumer failed"); },
    onError(error) { errors.push(error); },
    fetch: async (url, init) => {
      const request = new Request(url, init);
      if (request.url.includes("/events")) return negotiateEvents(request)!;
      if (request.url.includes("/state")) return Response.json({ cursor: 1, requests: [] });
      if (request.url.includes("/history")) return Response.json({ entries: [], next: null });
      return Response.json([]);
    },
  });
  try {
    for (let i = 0; i < 100 && !selected; i++) {
      await new Promise(resolve => setTimeout(resolve, 1));
      if (Socket.last !== previous && Socket.last?.url.includes("/events")) selected = Socket.last;
    }
    assert.ok(selected);
    selected.message({ event: "ready", data: {} });
    selected.message({ id: 2, data: { type: "event", event: { type: "agent_start" } } });
    for (let i = 0; i < 100 && selected.readyState !== 3; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(selected.readyState, 3, "the failed reader must not leave an idle socket connected");
    assert.ok(errors.some(error => error.message === "Consumer failed"));
  } finally { watcher.close(); globalThis.WebSocket = original; }
});
