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
  // Unsupported live transports fail before allocating a long-lived response.
  const abort = new AbortController();
  const legacy = await fetch(`${f.url}/clients/${credentials.id}/events?watch=1`, {
    headers: { authorization: `Bearer ${credentials.token}`, accept: "text/event-stream" }, signal: abort.signal,
  });
  assert.equal(legacy.status, 406);
  assert.equal((await legacy.json() as {code:string}).code, "WEBSOCKET_REQUIRED");
  abort.abort();
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
  const first = await openEventStream(fetch, `${f.url}/v1/agents/${a}/events`, { headers, signal: controller.signal });
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
