import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import worker, { fetchLegacyApi } from "../ingress/index.ts";

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

test("offers hosted MCP on both hosts and limits its origin binding to the legacy API", async t => {
  const answer = new Response(null, { status: 202 });
  const origin = t.mock.method(globalThis, "fetch", async () => answer);
  const route = t.mock.fn(async () => answer);
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    assert.equal(await worker.fetch(new Request(`https://${host}/mcp`), env), answer);
    assert.equal(await fetchLegacyApi(new Request(`https://${host}/v1/agents`)), answer);
  }
  for (const url of ["https://example.com/v1/agents", "https://run.camelai.com/mcp", "https://run.camelai.com/v2/health"]) {
    assert.equal((await fetchLegacyApi(new Request(url))).status, 404);
  }
  assert.equal(route.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 2);
});

test("can select one test credential before sending all legacy requests to the Worker", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 202 }));
  const route = t.mock.fn(async () => new Response(null, { status: 204 }));
  const authorization = "Bearer synthetic-cutover-credential";
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route },
    LEGACY_V1_CANARY_AUTH_SHA256: createHash("sha256").update(authorization).digest("hex") };
  const path = "https://run.camelai.com/mcp";
  assert.equal((await worker.fetch(new Request(path), env)).status, 202);
  assert.equal((await worker.fetch(new Request(path, { headers: { authorization: "Bearer different" } }), env)).status, 202);
  assert.equal((await worker.fetch(new Request(path, { headers: { authorization } }), env)).status, 204);
  assert.equal(route.mock.callCount(), 1);
  assert.equal(origin.mock.callCount(), 2);
});

test("keeps legacy end-user writes on the origin while serving reads on the Worker", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 201 }));
  const route = t.mock.fn(async () => new Response(null, { status: 204 }));
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  for (const path of ["/v1/end-users", "/v1/end-users/example/usage"]) {
    const url = `https://run.camelai.com${path}`;
    assert.equal((await worker.fetch(new Request(url), env)).status, 204);
    assert.equal((await worker.fetch(new Request(url, { method: "POST" }), env)).status, 201);
  }
  assert.equal(route.mock.callCount(), 2);
  assert.equal(origin.mock.callCount(), 2);
});

test("serves registration, token exchange, revocation and discovery on the existing hostnames", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 202 }));
  const route = t.mock.fn(async () => new Response(null, { status: 204 }));
  const env = { V2: { fetch: async () => new Response(null) }, LEGACY_V1: { route } };
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    for (const pathname of ["/oauth/register", "/oauth/token", "/oauth/revoke"]) {
      for (const method of ["POST", "OPTIONS"]) {
        assert.equal((await worker.fetch(new Request(`https://${host}${pathname}`, { method }), env)).status, 204);
      }
    }
    for (const pathname of ["/.well-known/oauth-authorization-server", "/.well-known/jwks.json", "/.well-known/oauth-protected-resource/v1/ops/mcp"]) {
      assert.equal((await worker.fetch(new Request(`https://${host}${pathname}`), env)).status, 204);
    }
    assert.equal((await worker.fetch(new Request(`https://${host}/oauth/authorize`), env)).status, 202);
  }
  assert.equal(route.mock.callCount(), 18);
  assert.equal(origin.mock.callCount(), 2);
});

test("routes volume and signed file traffic to the configured origin through both entrypoints", async t => {
  const origin = t.mock.method(globalThis, "fetch", async (request: Request, init: RequestInit) => {
    assert.equal(init.redirect, "manual");
    if (new URL(request.url).hostname === "run.camelai.com") return new Response("ECS");
    assert.equal(request.headers.get("authorization"), "Bearer original-key");
    assert.equal(request.headers.get("x-camelrun-volume-origin"), "private origin token");
    assert.equal(request.headers.get("x-agent-runtime-internal"), null);
    if (request.method === "PUT") assert.equal(await request.text(), "updated");
    return new Response(request.url, { status: 202, headers: { "X-File-Version": "7" } });
  });
  const env = {
    V2: { fetch: async () => new Response(null) },
    LEGACY_VOLUMES_ORIGIN: "https://volume-origin.example",
    LEGACY_VOLUMES_ORIGIN_TOKEN: "private origin token",
  };
  const original = { authorization: "Bearer original-key", "x-camelrun-volume-origin": "caller supplied", "x-agent-runtime-internal": "forged" };
  for (const path of ["/v1/volumes", "/v1/links/token/report%20A.pdf", "/v1/volumes/vol_example/files/report%20A.md?snapshot=snap_abc"]) {
    for (const send of [worker.fetch, fetchLegacyApi]) {
      const response = await send(new Request(`https://run.camelai.com${path}`, { headers: original }), env);
      assert.equal(response.status, 202);
      assert.equal(response.headers.get("x-file-version"), "7");
      assert.equal(await response.text(), `https://volume-origin.example${path}`);
    }
  }
  const file = "https://agents.camelai.dev/v1/volumes/vol_example/files/report.md";
  assert.equal((await worker.fetch(new Request(file, { method: "PUT", body: "updated", headers: original }), env)).status, 202);
  assert.equal(await (await worker.fetch(new Request("https://run.camelai.com/v1/volumes2"), env)).text(), "ECS");
  assert.equal(await (await worker.fetch(new Request("https://run.camelai.com/v1/volumes"), { V2: env.V2 })).text(), "ECS");
  assert.equal((await worker.fetch(new Request(file), { ...env, LEGACY_VOLUMES_ORIGIN_TOKEN: undefined })).status, 503);
  assert.equal((await worker.fetch(new Request(file), { ...env, LEGACY_VOLUMES_ORIGIN: "invalid" })).status, 503);
  assert.equal(origin.mock.callCount(), 9);
});

test("an enabled volume origin fails without retrying ECS", async t => {
  const send = t.mock.method(globalThis, "fetch", async () => { throw new Error("unreachable"); });
  const env = {
    V2: { fetch: async () => new Response(null) },
    LEGACY_VOLUMES_ORIGIN: "https://volume-origin.example",
    LEGACY_VOLUMES_ORIGIN_TOKEN: "private origin token",
  };
  const response = await worker.fetch(new Request("https://run.camelai.com/v1/volumes"), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { code: string }).code, "VOLUME_ORIGIN_UNAVAILABLE");
  assert.equal(send.mock.callCount(), 1);
});
