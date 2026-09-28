import { test } from "node:test";
import assert from "node:assert/strict";
import { attach, runtime } from "./runtime-server.ts";

test("one application serves an agent's tools at a time: another connection is refused unless it takes over, and the replaced one is told why", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const tool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } };
  const created = (await r.call("/v1/agents", { body: { mcp: { tools: [tool] } } })).json;
  // A connection that only reads the stream (a relay that serves no tools, as chiridion's) holds nothing: it is replaced as before.
  const reader = new AbortController();
  t.after(() => reader.abort());
  const relay = await fetch(`${r.base}/clients/${created.id}/events`, { headers: { Authorization: `Bearer ${created.token}`, Accept: "text/event-stream" }, signal: reader.signal });
  assert.equal(relay.status, 200);

  const first = await attach(t, r.base, created.id, created.token);
  assert.equal(first.status, 200, "it replaced the relay, which served no tools");
  const second = await attach(t, r.base, created.id, created.token);
  assert.equal(second.status, 409);
  assert.match(second.body, /APPLICATION_CONNECTED[\s\S]*takeover=true/);
  assert.equal(first.frames.some(frame => frame.includes("event: closed")), false, "the first keeps its place");

  const third = await attach(t, r.base, created.id, created.token, undefined, "?takeover=true");
  assert.equal(third.status, 200);
  await first.ended;
  const closed = first.frames.find(frame => frame.includes("event: closed"));
  assert.ok(closed, "the replaced connection is told why it closes");
  assert.equal(JSON.parse(closed!.split("data:")[1]).reason, "replaced");
});
