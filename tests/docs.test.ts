import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { runtime } from "./runtime-server.ts";

test("the docs are served without credentials: llms.txt, llms-full.txt and every page but the operators', pointing at this runtime", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const get = (path: string) => fetch(`${r.base}${path}`);
  const index = await get("/llms.txt");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type")!, /^text\/plain/);
  assert.equal(index.headers.get("cache-control"), "public, max-age=300");
  assert.equal(index.headers.get("access-control-allow-origin"), "*");
  const text = await index.text();
  assert.doesNotMatch(text, /agents\.camelai\.dev/, "a runtime elsewhere points at itself");
  const linked = /\((https:\/\/agents\.example\.test\/docs\/[^)]+\.md)\)/.exec(text)![1];
  const page = await get(new URL(linked).pathname);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type")!, /^text\/markdown/);
  assert.ok((await page.text()).length > 100);
  assert.equal((await get("/llms-full.txt")).status, 200);
  // Every link in llms.txt to this runtime is served.
  for (const [, url] of text.matchAll(/\((https:\/\/agents\.example\.test\/[^)]+)\)/g)) assert.equal((await get(new URL(url).pathname)).status, 200, url);

  // Sent as written (fetch would fold dot segments first): nothing outside docs/, nor the operators' pages, is served.
  const raw = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const { hostname, port } = new URL(r.base);
    request({ hostname, port, path, method: "GET" }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    }).on("error", reject).end();
  });
  for (const path of ["/docs/operations/architecture.md", "/docs/operations/README.md", "/docs/../package.json", "/docs/%2e%2e/package.json", "/docs/..%2fsrc%2fserver.ts", "/docs/guides/../../README.md", "/docs/quickstart", "/docs/", "/docs"]) {
    const refused = await raw(path);
    assert.equal(refused.status, 404, `${path}: ${refused.status}`);
    assert.equal(JSON.parse(refused.body).code, "NOT_FOUND", path);
  }
});
