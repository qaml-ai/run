import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../../../clients/typescript.ts";
import { openEventStream } from "../../../clients/event-transport.ts";
import WebSocket from "ws";
import { startFixture } from "./fixture.ts";

test("negotiated WebSocket stays connected when idle and streams the next turn", { timeout: 90_000 }, async t => {
  const f = await startFixture();
  t.after(() => f.stop());
  let negotiations = 0;
  let socketsSelected = 0;
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).includes("/events")) negotiations++;
    const response = await fetch(url, init);
    if (response.headers.get("content-type")?.startsWith("application/vnd.camelrun.events+json")) {
      const selection = await response.clone().json() as { transport: string };
      assert.equal(selection.transport, "websocket");
      socketsSelected++;
    }
    return response;
  };
  const runtime = new AgentRuntime({ url: f.url, apiKey: f.token, fetch: fetcher });
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
  // Explicit SSE clients continue to get an actual SSE body.
  const abort = new AbortController();
  const legacy = await fetch(`${f.url}/clients/${credentials.id}/events?watch=1`, {
    headers: { authorization: `Bearer ${credentials.token}`, accept: "text/event-stream" }, signal: abort.signal,
  });
  assert.match(legacy.headers.get("content-type") ?? "", /^text\/event-stream/);
  abort.abort();
});

test("browser tokens explicitly select filtered SSE and cannot upgrade to a WebSocket", { timeout: 30_000 }, async t => {
  const f = await startFixture();
  t.after(() => f.stop());
  const credentials = await (await fetch(f.url + "/v1/agents", {
    method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "test/echo", codeMode: false, fileTools: false }),
  })).json() as { id: string };
  const minted = await fetch(`${f.url}/v1/agents/${credentials.id}/browser-tokens`, {
    method: "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
    body: JSON.stringify({ scopes: ["events"], events: ["agent_start"] }),
  });
  assert.equal(minted.status, 201);
  const { token } = await minted.json() as { token: string };
  const abort = new AbortController();
  t.after(() => abort.abort());
  let offered = "", calls = 0;
  const stream = await openEventStream((url, init) => {
    calls++;
    offered = new Headers(init?.headers).get("accept") ?? "";
    return fetch(url, init);
  }, `${f.url}/v1/agents/${credentials.id}/events`, {
    headers: { authorization: `Bearer ${token}`, origin: "https://browser.test" }, signal: abort.signal,
  });
  assert.equal(offered, "application/vnd.camelrun.events+json, text/event-stream");
  assert.equal(calls, 1);
  assert.equal(stream.headers.get("x-agent-transport"), null);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.equal(stream.headers.get("access-control-allow-origin"), "*");
  const reader = stream.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  await reader.cancel();
  const socket = new WebSocket(`${f.url.replace(/^http/, "ws")}/v1/agents/${credentials.id}/events`, ["camelrun.events.v1", `bearer.${Buffer.from(token).toString("base64url")}`]);
  t.after(() => socket.terminate());
  socket.on("error", () => {});
  const status = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser upgrade did not settle")), 10_000);
    socket.once("unexpected-response", (_request, response) => { clearTimeout(timer); response.resume(); resolve(response.statusCode!); });
    socket.once("open", () => { clearTimeout(timer); reject(new Error("Browser token unexpectedly upgraded")); });
  });
  assert.equal(status, 403);
});
