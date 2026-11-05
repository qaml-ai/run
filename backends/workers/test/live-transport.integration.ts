import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../../../clients/typescript.ts";
import { startFixture } from "./fixture.ts";

test("negotiated WebSocket stays connected when idle and streams the next turn", { timeout: 90_000 }, async t => {
  const f = await startFixture();
  t.after(() => f.stop());
  let negotiations = 0;
  const fetcher: typeof fetch = (url, init) => {
    if (String(url).includes("/events")) negotiations++;
    return fetch(url, init);
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
