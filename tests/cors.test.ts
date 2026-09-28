import { test } from "node:test";
import assert from "node:assert/strict";
import { OPERATOR, runtime } from "./runtime-server.ts";

test("any origin may read an agent with a browser token, on the four read routes only; the tenant's own tokens never get CORS", async t => {
  const r = await runtime(t, () => ({ content: "hello" }));
  const agent = (await r.call("/v1/agents", { body: {} })).json.id as string;
  assert.equal((await r.call("/v1/cors-origins")).status, 404, "there is no allow-list");

  const preflight = (path: string, origin: string) => fetch(`${r.base}${path}`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization, last-event-id" } });
  for (const origin of ["https://app.example.com", "https://anything.test", "http://localhost:5173"]) {
    for (const route of ["events", "state", "history", "inputs"]) {
      const ok = await preflight(`/v1/agents/${agent}/${route}`, origin);
      assert.equal(ok.status, 204, `${route} from ${origin}`);
      assert.equal(ok.headers.get("access-control-allow-origin"), "*");
      assert.equal(ok.headers.get("access-control-allow-credentials"), null);
      assert.equal(ok.headers.get("access-control-allow-methods"), "GET");
      assert.match(ok.headers.get("access-control-allow-headers")!, /Authorization/);
      assert.equal(ok.headers.get("access-control-max-age"), "86400");
    }
  }
  for (const path of [`/v1/agents/${agent}/prompt`, `/v1/agents/${agent}`, "/v1/agents"]) {
    assert.equal((await preflight(path, "https://app.example.com")).headers.get("access-control-allow-origin"), null, `no CORS on ${path}`);
  }

  const token = (await r.call(`/v1/agents/${agent}/browser-tokens`, { body: { ttlSeconds: 5 } })).json.token;
  const read = async (path: string, authorization: string, origin = "https://app.example.com") => {
    const controller = new AbortController();
    const response = await fetch(`${r.base}${path}`, { headers: { Authorization: `Bearer ${authorization}`, Origin: origin }, signal: controller.signal });
    controller.abort();
    return response;
  };
  for (const origin of ["https://app.example.com", "https://elsewhere.example"]) {
    const state = await read(`/v1/agents/${agent}/state`, token, origin);
    assert.equal(state.status, 200);
    assert.equal(state.headers.get("access-control-allow-origin"), "*");
    assert.equal(state.headers.get("access-control-allow-credentials"), null);
  }
  const stream = await read(`/v1/agents/${agent}/events`, token);
  assert.equal(stream.headers.get("content-type"), "text/event-stream");
  assert.equal(stream.headers.get("access-control-allow-origin"), "*", "the stream too");
  for (const origin of ["https://app.example.com", "https://elsewhere.example"]) {
    assert.equal((await read(`/v1/agents/${agent}/state`, OPERATOR, origin)).headers.get("access-control-allow-origin"), null, "never for the tenant's own tokens");
  }
  await new Promise(resolve => setTimeout(resolve, 5_500));
  const expired = await read(`/v1/agents/${agent}/state`, token);
  assert.equal(expired.status, 401);
  assert.equal(expired.headers.get("access-control-allow-origin"), "*", "a browser can read that its token expired");
});
