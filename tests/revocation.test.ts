import { test } from "node:test";
import assert from "node:assert/strict";
import { listen, runtime } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

test("an agent's token can be rotated: the old one stops working at once, and credentials give the new one", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const created = await r.call("/v1/agents", { body: { systemPrompt: "Hi." }, headers: { "Idempotency-Key": "rotating" } });
  const { id, token: old } = created.json;
  assert.equal((await r.call(`/clients/${id}/state`, { token: old })).status, 200);
  assert.equal((await r.call(`/v1/agents/rotating/credentials`)).json.token, old);

  const rotated = await r.call(`/v1/agents/${id}/credentials/rotate`, { body: {} });
  assert.equal(rotated.status, 200);
  assert.equal(rotated.json.id, id);
  assert.notEqual(rotated.json.token, old);
  assert.equal((await r.call(`/clients/${id}/state`, { token: old })).status, 401, "the old token is refused");
  assert.equal((await r.call(`/clients/${id}/state`, { token: rotated.json.token })).status, 200);
  // Every way of asking for the agent's token now gives the new one.
  assert.equal((await r.call(`/v1/agents/rotating/credentials`)).json.token, rotated.json.token);
  assert.equal((await r.call(`/v1/agents/${id}/credentials`)).json.token, rotated.json.token);
  assert.equal((await r.call("/v1/agents", { body: { systemPrompt: "Hi." }, headers: { "Idempotency-Key": "rotating" } })).json.token, rotated.json.token);
  // Again, and for an agent made without a key, whose token could not be given again before.
  const again = await r.call(`/v1/agents/${id}/credentials/rotate`, { body: {} });
  assert.notEqual(again.json.token, rotated.json.token);
  assert.equal((await r.call(`/clients/${id}/state`, { token: rotated.json.token })).status, 401);
  const keyless = (await r.call("/v1/agents", { body: { systemPrompt: "Hi." } })).json;
  assert.equal((await r.call(`/v1/agents/${keyless.id}/credentials`)).status, 409);
  const fresh = (await r.call(`/v1/agents/${keyless.id}/credentials/rotate`, { body: {} })).json;
  assert.equal((await r.call(`/clients/${keyless.id}/state`, { token: keyless.token })).status, 401);
  assert.equal((await r.call(`/v1/agents/${keyless.id}/credentials`)).json.token, fresh.token);
  assert.equal((await r.call(`/v1/agents/${id}/credentials/rotate`, { body: {}, token: "other-operator-token-at-least-24-chars" })).status, 404, "another tenant's agent");
});

test("revoking an API token lists the webhooks and trace export it set, which keep sending", async t => {
  const hook = await listen(t, (_req, res) => void res.writeHead(204).end());
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const made = (await r.call("/v1/tokens", { body: { name: "ci" } })).json;
  const asToken = (path: string, init: { method?: string; body?: unknown } = {}) => r.call(path, { ...init, token: made.token });
  const endpoint = (await asToken("/v1/webhooks", { body: { url: hook, events: ["run.completed"] } })).json;
  assert.equal(endpoint.setBy, `token:${made.id}`);
  assert.equal((await asToken("/v1/usage-webhook", { method: "PUT", body: { url: `${hook}/usage` } })).status, 200);
  assert.equal((await asToken("/v1/telemetry", { method: "PUT", body: { endpoint: `${hook}/traces` } })).json.setBy, `token:${made.id}`);
  // One the console set is not the token's.
  const own = (await r.call("/v1/webhooks", { body: { url: `${hook}/own`, events: ["run.completed"] } })).json;
  assert.equal(own.setBy, "operator");

  const revoked = await r.call(`/v1/tokens/${made.id}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.json, { revoked: true, left: [
    { kind: "webhook", id: endpoint.id, url: hook },
    { kind: "usage-webhook", url: `${hook}/usage` },
    { kind: "telemetry", url: `${hook}/traces` },
  ] });
  assert.equal((await asToken("/v1/me")).status, 401);
  assert.equal((await r.call(`/v1/webhooks/${endpoint.id}`)).json.setBy, `token:${made.id}`, "kept, and shown, until the tenant changes it");
});
