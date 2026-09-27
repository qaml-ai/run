import { test } from "node:test";
import assert from "node:assert/strict";
import { originAllowed } from "../src/cors.ts";
import { OPERATOR, OTHER_OPERATOR, runtime } from "./runtime-server.ts";

test("origins match exactly, or as any subdomain of a wildcard", () => {
  const allowed = ["https://app.example.com", "https://*.camelai.dev", "http://localhost:5173"];
  for (const origin of ["https://app.example.com", "https://x.camelai.dev", "https://a.b.camelai.dev", "http://localhost:5173"]) assert.ok(originAllowed(allowed, origin), origin);
  for (const origin of ["https://camelai.dev", "http://x.camelai.dev", "https://evilcamelai.dev", "https://x.camelai.dev.evil.com", "https://app.example.com:8443", "http://localhost:3000", "null"]) assert.ok(!originAllowed(allowed, origin), origin);
});

test("a tenant's origins may read its agents with browser tokens, and only those routes, only with those tokens", async t => {
  const r = await runtime(t, () => ({ content: "hello" }));
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  const bobs = (await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR })).json.id as string;
  for (const bad of [["https://app.example.com/path"], ["ftp://x.com"], ["*"], ["https://*"], ["http://example.com"], "https://x.com"]) {
    assert.equal((await r.call("/v1/cors-origins", { method: "PUT", body: { origins: bad } })).status, 400, JSON.stringify(bad));
  }
  const set = await r.call("/v1/cors-origins", { method: "PUT", body: { origins: ["https://app.example.com", "https://*.camelai.dev"] } });
  assert.equal(set.status, 200, set.text);
  assert.deepEqual((await r.call("/v1/cors-origins")).json.origins, ["https://app.example.com", "https://*.camelai.dev"]);
  assert.deepEqual((await r.call("/v1/cors-origins", { token: OTHER_OPERATOR })).json.origins, []);

  const preflight = (path: string, origin: string) => fetch(`${r.base}${path}`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization, last-event-id" } });
  const ok = await preflight(`/v1/agents/${agent}/events`, "https://tab.camelai.dev");
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), "https://tab.camelai.dev");
  assert.match(ok.headers.get("access-control-allow-headers")!, /Authorization/);
  assert.equal(ok.headers.get("access-control-max-age"), "86400");
  for (const [path, origin] of [[`/v1/agents/${agent}/events`, "https://evil.com"], [`/v1/agents/${bobs}/events`, "https://app.example.com"]]) {
    const refused = await preflight(path, origin);
    assert.equal(refused.status, 403, `${path} from ${origin}`);
    assert.equal(refused.headers.get("access-control-allow-origin"), null);
  }
  assert.equal((await preflight(`/v1/agents/${agent}/prompt`, "https://app.example.com")).headers.get("access-control-allow-origin"), null, "no other route");

  const token = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: { ttlSeconds: 5 } })).json.token;
  const read = async (path: string, authorization: string, origin = "https://app.example.com") => {
    const controller = new AbortController();
    const response = await fetch(`${r.base}${path}`, { headers: { Authorization: `Bearer ${authorization}`, Origin: origin }, signal: controller.signal });
    controller.abort();
    return response;
  };
  const state = await read(`/v1/agents/${agent}/state`, token);
  assert.equal(state.status, 200);
  assert.equal(state.headers.get("access-control-allow-origin"), "https://app.example.com");
  assert.equal(state.headers.get("vary"), "Origin");
  const stream = await read(`/v1/agents/${agent}/events`, token);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.equal(stream.headers.get("access-control-allow-origin"), "https://app.example.com", "the stream too");
  assert.equal((await read(`/v1/agents/${agent}/state`, token, "https://evil.com")).headers.get("access-control-allow-origin"), null);
  assert.equal((await read(`/v1/agents/${agent}/state`, OPERATOR)).headers.get("access-control-allow-origin"), null, "never for the tenant's own tokens");
  await new Promise(resolve => setTimeout(resolve, 5_500));
  const expired = await read(`/v1/agents/${agent}/state`, token);
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get("access-control-allow-origin"), "https://app.example.com", "a browser can read that its token expired");
});
