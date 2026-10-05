import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, runtime, until } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

test("an Idempotency-Key header on any POST replays its first success, refuses other parameters, and names a prompt's request", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const key = { "Idempotency-Key": "create-volume-1" };
  const body = { name: "shared" };
  const first = await r.call("/v1/volumes", { body, headers: key });
  assert.equal(first.status, 201, first.text);
  const again = await r.call("/v1/volumes", { body, headers: key });
  assert.equal(again.status, 201);
  assert.deepEqual(again.json, first.json, "the first response, replayed");
  assert.equal((await r.call("/v1/volumes")).json.filter((volume: any) => volume.name === "shared").length, 1, "made once");
  const other = await r.call("/v1/volumes", { body: { name: "other" }, headers: key });
  assert.deepEqual([other.status, other.json.code], [409, "IDEMPOTENCY_CONFLICT"]);
  // Keys are the tenant's own.
  assert.equal((await r.call("/v1/volumes", { body, headers: key, token: "other-operator-token-at-least-24-chars" })).status, 201);
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

test("a response carrying a secret shown once is never kept or replayed: its key's retry is a conflict", async t => {
  const hook = await listen(t, (_req, res) => void res.writeHead(204).end());
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const volume = (await r.call("/v1/volumes", { body: { name: "v" } })).json.id as string;
  const endpoint = (await r.call("/v1/webhooks", { body: { url: hook, events: ["run.started"] } })).json.id as string;
  await r.call("/v1/usage-webhook", { method: "PUT", body: { url: hook } });
  const routes: [string, object][] = [
    ["/v1/tokens", { name: "ci" }], ["/v1/webhooks", { url: hook, events: ["run.failed"] }], [`/v1/webhooks/${endpoint}/secret`, {}],
    ["/v1/usage-webhook/secret", {}], [`/v1/agents/${agent}/browser-tokens`, {}], [`/v1/agents/${agent}/credentials/rotate`, {}], [`/v1/volumes/${volume}/links`, { path: "/a.txt" }],
  ];
  for (const [path, body] of routes) {
    const headers = { "Idempotency-Key": `secret-${path}` };
    const first = await r.call(path, { body, headers });
    assert.ok(first.status < 300, `${path}: ${first.text}`);
    const replay = await r.call(path, { body, headers });
    assert.deepEqual([replay.status, replay.json.code], [409, "IDEMPOTENCY_CONFLICT"], path);
    assert.match(replay.json.error, /shown once/);
  }
  const kept = await r.db.query("select count(*)::int as count from idempotency_keys where body is not null and key like 'secret-%'");
  assert.equal(kept.rows[0].count, 0, "no secret-bearing answer is stored");
});

test("a key whose request died mid-way is taken over after a while, and a body past the limit is refused before it is read whole", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { ...LOCAL, AGENT_IDEMPOTENCY_LOCK_MS: "500" });
  const tenant = "alice";
  await r.db.query("insert into idempotency_keys (tenant, key, fingerprint, created_at) values ($1, 'orphaned', 'x', $2)", [tenant, Date.now()]);
  const locked = await r.call("/v1/volumes", { body: { name: "a" }, headers: { "Idempotency-Key": "orphaned" } });
  assert.deepEqual([locked.status, locked.json.code], [409, "IDEMPOTENCY_IN_PROGRESS"], "while it may still be running");
  await new Promise(resolve => setTimeout(resolve, 600));
  const taken = await r.call("/v1/volumes", { body: { name: "a" }, headers: { "Idempotency-Key": "orphaned" } });
  assert.equal(taken.status, 201, taken.text);

  const huge = await fetch(`${r.base}/v1/volumes`, { method: "POST", headers: { Authorization: "Bearer fixture-operator-token-at-least-24-chars", "Content-Type": "application/json", "Idempotency-Key": "huge" }, body: JSON.stringify({ name: "x".repeat(9 * 1024 * 1024) }) });
  assert.equal(huge.status, 413);
});
