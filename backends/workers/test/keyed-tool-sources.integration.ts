import assert from "node:assert/strict";
import test from "node:test";
import { startFixture } from "./fixture.ts";

test("a keyed upsert preserves definition-owned tool sources and records its configuration", { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  const request = async (path: string, body?: unknown, key?: string) => {
    const response = await fetch(fixture.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${fixture.token}`, "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json() as any;
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(value)}`);
    return value;
  };
  const definition = await request("/v1/definitions", { name: "Reader", builtins: ["web_fetch"] });
  const first = await request("/v1/agents", { definition: definition.id }, "reader");
  const again = await request("/v1/agents", { definition: definition.id }, "reader");
  assert.equal(again.id, first.id);
  assert.equal(typeof again.reconfigured.id, "string");
  assert.equal(again.reconfigured.state, "completed");
  assert.equal(again.reconfigured.outcome.result.changed, false);
  assert.deepEqual((await request(`/v1/agents/${first.id}`)).builtins, ["web_fetch"]);
  assert.deepEqual(await request(`/v1/agents/${first.id}/requests/${again.reconfigured.id}`), again.reconfigured);
});
