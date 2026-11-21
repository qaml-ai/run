import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../ingress/index.ts";

test("dispatches v2 API, voice, webhook, channel, and WebSocket requests directly to V2", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 599 }));
  const nativeResponse = new Response(JSON.stringify({ ok: true }), { status: 200 });
  const native = t.mock.fn(async (_request: Request) => nativeResponse);
  const env = { V2: { fetch: native } };

  const cases: Array<[string, RequestInit?]> = [
    ["/v2"],
    ["/v2/health"],
    ["/v2/agents/example/runs", { method: "POST", body: "{\"text\":\"test\"}" }],
    ["/v2/agents/example/ws", { headers: { upgrade: "websocket" } }],
    ["/v2/webhooks", { method: "POST", body: "{}" }],
    ["/v2/channels/ch_123/inbound", { method: "POST", body: "{}" }],
    ["/v2/voice/calls", { method: "POST", body: "{}" }],
    ["/v2/voice/providers/elevenlabs/post-call", { method: "POST", body: "{}" }],
    ["/v2/voice/providers/elevenlabs/tools/ask_agent", { method: "POST", body: "{}" }],
  ];

  for (const [path, init] of cases) {
    const request = new Request("https://run.camelai.com" + path, init);
    assert.equal(await worker.fetch(request, env), nativeResponse, path);
    assert.equal(native.mock.calls.at(-1)?.arguments[0], request);
  }
  assert.equal(native.mock.callCount(), cases.length);
  assert.equal(origin.mock.callCount(), 0);
});

test("returns HTTP 410 V1_OPERATION_RETIRED for retired legacy API paths on API hosts", async t => {
  const origin = t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 599 }));
  const native = t.mock.fn(async (_request: Request) => new Response(null));
  const env = { V2: { fetch: native } };

  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    for (const path of ["/v1", "/v1/agents", "/v1/models", "/%76%31/agents", "/clients/old", "/mcp", "/mcp/"]) {
      const response = await worker.fetch(new Request(`https://${host}${path}`), env);
      assert.equal(response.status, 410, `${host}${path}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(((await response.json()) as { code: string }).code, "V1_OPERATION_RETIRED");
    }
  }
  assert.equal(native.mock.callCount(), 0);
  assert.equal(origin.mock.callCount(), 0);
});

test("passes non-API paths through to the configured origin without following redirects", async t => {
  const originRedirect = new Response(null, { status: 307, headers: { Location: "/login" } });
  const origin = t.mock.method(globalThis, "fetch", async () => originRedirect);
  const native = t.mock.fn(async (_request: Request) => new Response(null));
  const env = { V2: { fetch: native } };

  for (const url of [
    "https://run.camelai.com/",
    "https://run.camelai.com/v20",
    "https://run.camelai.com/oauth/authorize",
    "https://agents.camelai.dev/v2/health",
    "https://agents.camelai.dev/.well-known/oauth-protected-resource",
  ]) {
    const request = new Request(url);
    assert.equal(await worker.fetch(request, env), originRedirect, url);
    assert.deepEqual(origin.mock.calls.at(-1)?.arguments, [request, { redirect: "manual" }]);
  }
  assert.equal(native.mock.callCount(), 0);
  assert.equal(origin.mock.callCount(), 5);
});
