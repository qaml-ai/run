import { test } from "node:test";
import assert from "node:assert/strict";
import { startFixture } from "./fixture.ts";

test("workerd stores provider keys and key-scope/custom credentials without disclosing secrets", { timeout: 120_000 }, async t => {
  const r = await startFixture({ vars: {
    AGENT_SECRETS_KEY: "12".repeat(32), AGENT_BILLING_ADMINS: "camelrun-proto-local",
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
  } });
  t.after(() => r.stop());
  const call = async (path: string, method = "GET", body?: unknown, token = r.token) => {
    const response = await fetch(`${r.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, text: await response.text() };
  };
  assert.equal((await call("/v1/providers/openai/key", "PUT", { apiKey: "fake-provider-1234", verify: false })).status, 200);
  const scopes = await call("/v1/key-scopes/customer-1/providers/openai", "PUT", { apiKey: "fake-scope-5678", baseUrl: "http://127.0.0.1:1234/v1", headers: { "x-customer": "private-header-value" } });
  assert.equal(scopes.status, 200, scopes.text);
  assert.equal(scopes.text.includes("private-header-value"), false);
  assert.equal(scopes.text.includes("fake-scope"), false);
  const provider = { type: "openai-completions", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "fake-custom-9012", models: [{ id: "demo", contextWindow: 4096 }] };
  const custom = await call("/v1/providers/local-model", "PUT", provider);
  assert.equal(custom.status, 200, custom.text);
  assert.equal(custom.text.includes("fake-custom"), false);
  const ciphertext = (await r.db.query("select sealed from provider_keys where tenant=$1", ["camelrun-proto-local"])).rows[0].sealed;
  assert.deepEqual(Object.keys(ciphertext).sort(), ["ciphertext", "iv", "tag"]);
  assert.equal(JSON.stringify(ciphertext).includes("fake-provider"), false);
  const minted = await call("/v1/tokens", "POST", { name: "revoke test" });
  assert.equal(minted.status, 201, minted.text);
  const token = JSON.parse(minted.text);
  assert.equal((await call("/v1/providers", "GET", undefined, token.token)).status, 200);
  assert.equal((await call(`/v1/tokens/${token.id}`, "DELETE")).status, 200);
  assert.equal((await call("/v1/providers", "GET", undefined, token.token)).status, 401);
  assert.equal((await call("/v1/cors-origins")).status, 404);
  const created = await call("/v1/agents", "POST", {});
  assert.equal(created.status, 201, created.text);
  const { id } = JSON.parse(created.text);
  const mintedBrowser = await call(`/v1/agents/${id}/browser-tokens`, "POST", { scopes: ["history"], redact: ["usage.cost"] });
  assert.equal(mintedBrowser.status, 201, mintedBrowser.text);
  const browser = JSON.parse(mintedBrowser.text).token;
  const crossOrigin = (path: string, token: string, method = "GET") => fetch(`${r.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, origin: "https://customer.example" } });
  const read = await crossOrigin(`/v1/agents/${id}/history`, browser);
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("access-control-allow-origin"), "*");
  assert.equal(read.headers.get("access-control-allow-credentials"), null);
  assert.equal((await crossOrigin(`/v1/agents/${id}/state`, browser)).status, 403, "history-only token cannot read state");
  assert.equal((await crossOrigin(`/v1/agents/${id}/prompt`, browser, "POST")).status, 403, "browser token cannot start work");
  const own = await crossOrigin(`/v1/agents/${id}/history`, r.token);
  assert.equal(own.headers.get("access-control-allow-origin"), null, "tenant credential never receives CORS");
  const preflight = await crossOrigin(`/v1/agents/${id}/history`, "unused", "OPTIONS");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "GET");
  const eventToken = JSON.parse((await call(`/v1/agents/${id}/browser-tokens`, "POST", { scopes: ["events"], ttlSeconds: 5 })).text).token;
  const events = await crossOrigin(`/v1/agents/${id}/events`, eventToken);
  assert.equal(events.headers.get("access-control-allow-origin"), "*");
  const reader = events.body!.getReader();
  assert.equal((await reader.read()).done, false);
  await reader.cancel();
});
