import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, runtime, until } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

test("an Idempotency-Key header on any POST replays its first success, refuses other parameters, and names a prompt's request", async t => {
  const hook = await listen(t, (_req, res) => void res.writeHead(204).end());
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const key = { "Idempotency-Key": "create-hook-1" };
  const body = { url: hook, events: ["run.completed"] };
  const first = await r.call("/v1/webhooks", { body, headers: key });
  assert.equal(first.status, 201, first.text);
  const again = await r.call("/v1/webhooks", { body, headers: key });
  assert.equal(again.status, 201);
  assert.deepEqual(again.json, first.json, "the first response, replayed");
  assert.equal((await r.call("/v1/webhooks")).json.length, 1, "made once");
  const other = await r.call("/v1/webhooks", { body: { ...body, events: ["run.failed"] }, headers: key });
  assert.equal(other.status, 409);
  assert.match(other.json.error, /Idempotency-Key/);
  // Keys are the tenant's own.
  assert.equal((await r.call("/v1/webhooks", { body, headers: key, token: "other-operator-token-at-least-24-chars" })).status, 201);
  // A failure is not kept: the retry runs again.
  const bad = { "Idempotency-Key": "bad-then-good" };
  assert.equal((await r.call("/v1/volumes", { body: { name: 42 }, headers: bad })).status, 400);
  assert.equal((await r.call("/v1/volumes", { body: { name: 42 }, headers: bad })).status, 400);

  // A prompt takes the key as its request's id.
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const prompt = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "hi" }, headers: { "Idempotency-Key": "prompt-1" } });
  assert.equal(prompt.status, 202, prompt.text);
  assert.equal(prompt.json.id, "prompt-1");
  assert.equal((await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "hi" }, headers: { "Idempotency-Key": "prompt-1" } })).json.startedAt, prompt.json.startedAt);
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/prompt-1`)).json.state === "completed", "the prompt");
});
