import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { runtime } from "./runtime-server.ts";

test("the UI registry's JSON is served at /r/<name>.json without credentials, pointing at this runtime", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_REGISTRY_DIR: fileURLToPath(new URL("./fixtures/registry", import.meta.url)) });
  const index = await fetch(`${r.base}/r/registry.json`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type")!, /^application\/json/);
  assert.equal(index.headers.get("cache-control"), "public, max-age=300");
  assert.equal(index.headers.get("access-control-allow-origin"), "*");
  assert.equal((await index.json() as any).items[0].name, "agent-chat");
  const item = await (await fetch(`${r.base}/r/agent-chat.json`)).json() as any;
  assert.deepEqual(item.registryDependencies, ["https://agents.example.test/r/agent-markdown.json"], "links to this runtime's registry");
  assert.equal(item.$schema, "https://ui.shadcn.com/schema/registry-item.json", "other origins are left alone");

  const raw = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const { hostname, port } = new URL(r.base);
    request({ hostname, port, path, method: "GET" }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    }).on("error", reject).end();
  });
  for (const path of ["/r/missing.json", "/r/../package.json", "/r/%2e%2e/tests/registry.test.ts", "/r/agent-chat", "/r/", "/r"]) {
    const refused = await raw(path);
    assert.equal(refused.status, 404, `${path}: ${refused.status}`);
    assert.equal(JSON.parse(refused.body).code, "NOT_FOUND", path);
  }
});
