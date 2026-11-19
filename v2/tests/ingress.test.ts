import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../ingress/index.ts";

test("dispatches native and legacy requests once, preserving the origin response", async t => {
  const legacyRedirect = new Response(null, { status: 307, headers: { Location: "/login" } });
  const origin = t.mock.method(globalThis, "fetch", async () => legacyRedirect);
  const nativeFailure = new Response(null, { status: 503 });
  const native = t.mock.fn(async () => nativeFailure);
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
