import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("registry operator routes keep tenant isolation and reuse durable requests", { timeout: 120_000 }, async t => {
  const alice = "local-service-alice-fixture-token";
  const bob = "local-service-bob-fixture-token";
  const f = await startFixture({ token: alice, tenant: "alice", tenants: [{ id: "alice", token: alice }, { id: "bob", token: bob }] });
  t.after(() => f.stop());
  const call = (path: string, token = alice, init: RequestInit = {}) => fetch(f.url + path, {
    ...init, headers: { authorization: `Bearer ${token}`, ...init.headers as Record<string, string> },
  });
  const made = await call("/v1/agents", alice, { method: "POST", body: JSON.stringify({ name: "Service test", fileTools: false, codeMode: false }), headers: { "content-type": "application/json" } });
  assert.equal(made.status, 201);
  const agent = await made.json() as { id: string; token: string };
  assert.deepEqual((await (await call("/registry")).json() as { id: string }[]).map(row => row.id), [agent.id]);
  assert.deepEqual(await (await call("/registry", bob)).json(), []);
  const detail = await call(`/registry/${agent.id}`);
  assert.equal(detail.status, 200);
  const inspected = await detail.json() as { name: string; fileTools: boolean; requests: unknown[] };
  assert.equal(inspected.name, "Service test");
  assert.equal(inspected.fileTools, false);
  assert.deepEqual(inspected.requests, []);
  assert.equal((await call(`/registry/${agent.id}`, bob)).status, 404);
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "stop", method: "abort", params: {} }) };
  assert.equal((await call(`/registry/${agent.id}/requests`, bob, request)).status, 401);
  const accepted = await call(`/registry/${agent.id}/requests`, alice, request);
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json() as { id: string }).id, "stop");
  assert.equal((await call("/registry", agent.token)).status, 401);
  assert.equal((await call("/registry", alice, { headers: { origin: "https://browser.test" } })).status, 403);
  assert.equal((await call(`/registry/${agent.id}/requests`)).status, 405);
});
