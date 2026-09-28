import { test } from "node:test";
import assert from "node:assert/strict";
import { runtime } from "./runtime-server.ts";

test("every error body names a machine-readable code beside its message", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const codeOf = (response: { json: any }) => response.json.code;
  assert.equal(codeOf(await r.call(`/v1/agents/client_${"0".repeat(40)}`)), "NOT_FOUND");
  assert.equal(codeOf(await r.call("/v1/agents", { body: { ttlSeconds: 1 } })), "INVALID_REQUEST");

  const tool = { name: "lookup", description: "Look up", inputSchema: { type: "object", properties: {} } };
  const withTools = (await r.call("/v1/agents", { body: { mcp: { tools: [tool] } } })).json;
  const refused = await r.call(`/v1/agents/${withTools.id}/prompt`, { body: { text: "hi" } });
  assert.deepEqual([refused.status, codeOf(refused)], [409, "APPLICATION_NOT_CONNECTED"]);
  assert.match(refused.json.error, /^APPLICATION_NOT_CONNECTED: /, "the message is as it was");

  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "one", requestId: "same" } });
  const reused = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "two", requestId: "same" } });
  assert.deepEqual([reused.status, codeOf(reused)], [409, "IDEMPOTENCY_CONFLICT"]);
  await r.call("/v1/webhooks", { body: { url: "https://example.com/hook", events: ["run.started"] }, headers: { "Idempotency-Key": "k" } }).catch(() => undefined);
  const keyed = await r.call("/v1/tokens", { body: { name: "a" }, headers: { "Idempotency-Key": "t" } });
  assert.equal(keyed.status, 201, keyed.text);
  assert.equal(codeOf(await r.call("/v1/tokens", { body: { name: "b" }, headers: { "Idempotency-Key": "t" } })), "IDEMPOTENCY_CONFLICT");

  assert.equal((await r.call(`/v1/agents/${agent}/configuration`, { method: "PATCH", body: { spendLimit: { usd: 0 } } })).status, 202);
  const spent = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "more" } });
  assert.deepEqual([spent.status, codeOf(spent)], [402, "SPEND_LIMIT"]);

  const gap = await fetch(`${r.base}/v1/agents/${agent}/events?poll=1&snapshot=0`, { headers: { Authorization: `Bearer fixture-operator-token-at-least-24-chars`, "Last-Event-ID": "1" } });
  assert.deepEqual([gap.status, (await gap.json() as any).code], [409, "REPLAY_GAP"]);
});
