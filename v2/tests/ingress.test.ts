import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../ingress/index.ts";

test("dispatches native and legacy requests once, preserving the origin response", async t => {
  const legacyRedirect = new Response(null, { status: 307, headers: { Location: "/login" } });
  const origin = t.mock.method(globalThis, "fetch", async () => legacyRedirect);
  const nativeFailure = new Response(null, { status: 503 });
  const native = t.mock.fn(async (_request: Request) => nativeFailure);
  const env = { V2: { fetch: native } };

  for (const path of ["/v2", "/v2/agents/example/runs"]) {
    const request = new Request("https://run.camelai.com" + path, { method: "POST", body: "{\"text\":\"test\"}" });
    assert.equal(await worker.fetch(request, env), nativeFailure);
    assert.equal(native.mock.calls.at(-1)?.arguments[0], request);
  }
  assert.equal(native.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 0);

  for (const path of ["/v1/agents", "/mcp", "/v20", "/oauth/authorize"]) {
    const request = new Request("https://run.camelai.com" + path);
    assert.equal(await worker.fetch(request, env), legacyRedirect);
    assert.deepEqual(origin.mock.calls.at(-1)?.arguments, [request, { redirect: "manual" }]);
  }
  assert.equal(native.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 4);
});

test("preserves routes and the request host on the legacy alias", async t => {
  const response = new Response(null, { status: 204 });
  const origin = t.mock.method(globalThis, "fetch", async () => response);
  const native = t.mock.fn(async (_request: Request) => new Response(null));
  const env = { V2: { fetch: native } };
  for (const path of ["/v2/health", "/mcp", "/.well-known/oauth-protected-resource", "/v1/billing/stripe/webhook"]) {
    const request = new Request("https://agents.camelai.dev" + path);
    assert.equal(await worker.fetch(request, env), response);
    assert.deepEqual(origin.mock.calls.at(-1)?.arguments, [request, { redirect: "manual" }]);
  }
  assert.equal(native.mock.callCount(), 0);
});

test("uses ECS only for legacy compatibility misses and keeps the original request body", async t => {
  const path = `/v1/agents/client_${"0".repeat(40)}/prompt`;
  const answer = new Response(null, { status: 503 });
  const origin = t.mock.method(globalThis, "fetch", async (request: Request) => Response.json(await request.json()));
  const route = t.mock.fn(async (request: Request) => {
    const body = await request.json() as { migrated: boolean };
    return body.migrated ? answer : null;
  });
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  const prompt = (migrated: boolean) => new Request("https://run.camelai.com" + path, {
    method: "POST", body: JSON.stringify({ migrated }),
  });
  assert.equal(await worker.fetch(prompt(true), env), answer);
  assert.equal(origin.mock.callCount(), 0);
  assert.deepEqual(await (await worker.fetch(prompt(false), env)).json(), { migrated: false });
  assert.equal(origin.mock.callCount(), 1);
  assert.equal(route.mock.callCount(), 2);
});
