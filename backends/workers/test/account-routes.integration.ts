import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { startFixture } from "./fixture.ts";

test("account route corrections hold through workerd authentication and routing", { timeout: 120_000 }, async t => {
  const origin = "https://runtime.example.test";
  const r = await startFixture({ vars: { AGENT_PUBLIC_URL: origin } });
  t.after(() => r.stop());
  const call = async (path: string, method = "GET", body?: unknown, token = r.token) => {
    const response = await fetch(r.url + path, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  };
  await t.test("OAuth metadata is public and points to the configured canonical origin", async () => {
    const response = await call("/.well-known/oauth-authorization-server", "GET", undefined, "unused");
    assert.equal(response.status, 200);
    assert.equal(response.json.issuer, origin);
    assert.equal(response.json.authorization_endpoint, origin + "/oauth/authorize");
    assert.equal(response.json.token_endpoint, origin + "/oauth/token");
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
  });
  await t.test("OAuth may list providers but cannot mint a persistent token", async () => {
    const token = `aro_${"a".repeat(43)}`, id = "oauth-route-fixture";
    await r.db.query("insert into oauth_grants(id,tenant,client_id,client_name,scope,created_at) values ($1,'camelrun-proto-local','fixture-client','Fixture','agents',$2)", [id, Date.now()]);
    await r.db.query("insert into oauth_tokens(sha256,kind,grant_id,expires_at) values ($1,'access',$2,$3)", [createHash("sha256").update(token).digest("hex"), id, Date.now() + 60_000]);
    assert.equal((await call("/v1/providers", "GET", undefined, token)).status, 200);
    assert.equal((await call("/v1/tokens", "POST", { name: "forbidden" }, token)).status, 403);
  });
  await t.test("API token cannot revoke itself; another credential revokes it and names its retained webhooks", async () => {
    const created = await call("/v1/tokens", "POST", { name: "route fixture" });
    assert.equal(created.status, 201);
    const token = created.json;
    assert.equal((await call(`/v1/tokens/${token.id}`, "DELETE", undefined, token.token)).status, 400);
    const endpoint = await call("/v1/webhooks", "POST", { url: "http://127.0.0.1:9/no-network", events: ["run.completed"] }, token.token);
    assert.equal(endpoint.status, 201);
    const revoked = await call(`/v1/tokens/${token.id}`, "DELETE");
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.json, { revoked: true, left: [{ kind: "webhook", id: endpoint.json.id, url: "http://127.0.0.1:9/no-network" }] });
    assert.equal((await call(`/v1/tokens/${token.id}`, "DELETE")).status, 404);
    assert.equal((await call("/v1/providers", "GET", undefined, token.token)).status, 401);
  });
});
