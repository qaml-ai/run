import { portedTest } from "../ported.ts";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runtime } from "../support.ts";

portedTest("http", "tests/docs.test.ts:11")("the docs are served without credentials: llms.txt, llms-full.txt and every page, the operators' too, pointing at this runtime", async t => {
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

  // The guides link to the operators' pages (self-hosting, configuration): those are served too.
  for (const path of ["/docs/operations/self-host.md", "/docs/operations/billing.md", "/docs/operations/README.md"]) assert.equal((await get(path)).status, 200, path);

  // Sent as written (fetch would fold dot segments first): nothing outside docs/ is served.
  const raw = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const { hostname, port } = new URL(r.base);
    request({ hostname, port, path, method: "GET" }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode!, body }));
    }).on("error", reject).end();
  });
  for (const path of ["/docs/../package.json", "/docs/%2e%2e/package.json", "/docs/..%2fsrc%2fserver.ts", "/docs/guides/../../README.md", "/docs/quickstart", "/SKILL.md/../package.json"]) {
    const refused = await raw(path);
    assert.equal(refused.status, 404, `${path}: ${refused.status}`);
    assert.equal(JSON.parse(refused.body).code, "NOT_FOUND", path);
  }
});

portedTest("http", "tests/docs.test.ts:49")("coding agents' setup skill is at /SKILL.md (and /skill.md), uncached; /docs sends people to the docs site", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  for (const path of ["/SKILL.md", "/skill.md"]) {
    const skill = await fetch(`${r.base}${path}`);
    assert.equal(skill.status, 200, path);
    assert.match(skill.headers.get("content-type")!, /^text\/markdown/);
    assert.equal(skill.headers.get("cache-control"), "no-cache");
    const text = await skill.text();
    assert.match(text, /^---\nname: camelrun\ndescription: /, "a skill's frontmatter");
    assert.match(text, /https:\/\/agents\.example\.test\/console\/tokens/, "pointing at this runtime");
    assert.match(text, /Never ask for a key in chat/);
  }
  assert.equal((await fetch(`${r.base}/SKILL.md`, { method: "POST" })).status, 404);
  for (const path of ["/docs", "/docs/"]) {
    const docs = await fetch(`${r.base}${path}`, { redirect: "manual" });
    assert.equal(docs.status, 302, path);
    assert.equal(docs.headers.get("location"), "https://camelai.com/docs/camelrun/overview");
  }
});

portedTest("http", "tests/docs.test.ts:69")("search engines may crawl everything but list neither the console nor the docs' Markdown copies; the API and MCP answer as before", async t => {
  const consoleDir = await mkdtemp(join(tmpdir(), "console-fixture-"));
  t.after(() => rm(consoleDir, { recursive: true, force: true }));
  await writeFile(join(consoleDir, "index.html"), "<!doctype html><title>Console fixture</title>");
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_CONSOLE_DIR: consoleDir });
  // robots.txt blocks nothing: a crawler sees a page's noindex only on a page it may fetch.
  const robots = await fetch(`${r.base}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type")!, /^text\/plain/);
  assert.equal(await robots.text(), "User-agent: *\nAllow: /\n");
  // The console with its sign-in and billing routes, OAuth's sign-in page, and / (which sends people to the console).
  for (const path of ["/", "/console", "/console/", "/console/billing", "/console/agents/client_" + "0".repeat(40), "/console/auth/github", "/console/auth/methods", "/oauth/authorize"]) {
    for (const method of ["GET", "HEAD"]) {
      const page = await fetch(`${r.base}${path}`, { method, redirect: "manual" });
      assert.equal(page.headers.get("x-robots-tag"), "noindex", `${method} ${path}: ${page.status}`);
    }
  }
  const billing = await fetch(`${r.base}/console/billing`);
  assert.equal(billing.status, 200);
  assert.match(await billing.text(), /Console fixture/);
  // The docs' copies for agents: still served, and never listed.
  for (const path of ["/llms.txt", "/llms-full.txt", "/SKILL.md", "/skill.md", "/docs/quickstart.md", "/docs/guides/tools.md"]) {
    for (const method of ["GET", "HEAD"]) {
      const doc = await fetch(`${r.base}${path}`, { method });
      assert.equal(doc.status, 200, `${method} ${path}`);
      assert.equal(doc.headers.get("x-robots-tag"), "noindex", `${method} ${path}`);
    }
  }
  // The API, MCP and the runtime's own endpoints carry no such header.
  assert.equal((await fetch(`${r.base}/v1/openapi.json`)).status, 200);
  for (const path of ["/v1/me", "/v1/openapi.json", "/mcp", "/healthz", "/.well-known/jwks.json", "/does-not-exist"]) {
    assert.equal((await fetch(`${r.base}${path}`)).headers.get("x-robots-tag"), null, path);
  }
});

portedTest("http", "tests/docs.test.ts:104")("an unknown path is a 404 that says where to start, and a known one without credentials a 401 that says how to get them", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  for (const path of ["/does-not-exist", "/auth.md", "/AGENTS.md", "/v2/agents"]) {
    const missing = await fetch(`${r.base}${path}`);
    assert.equal(missing.status, 404, path);
    const body = await missing.json();
    assert.equal(body.code, "NOT_FOUND");
    assert.match(body.error, /\/llms\.txt/);
    assert.match(body.error, /\/SKILL\.md/);
  }
  // Still authenticated: the API, the operator's registry, and an agent's own routes.
  for (const path of ["/v1/me", "/v1/agents", "/registry", "/registry/client_" + "0".repeat(40)]) {
    const refused = await fetch(`${r.base}${path}`);
    assert.equal(refused.status, 401, path);
    const { error, code } = await refused.json();
    assert.equal(code, "UNAUTHORIZED", path);
    assert.match(error, /\/console\/tokens/, path);
    assert.match(error, /camelrun login/, path);
    assert.match(error, /\/SKILL\.md/, path);
  }
  assert.equal((await fetch(`${r.base}/clients/client_${"0".repeat(40)}/state`)).status, 401);
  const wrong = await fetch(`${r.base}/v1/me`, { headers: { Authorization: "Bearer art_wrong" } });
  assert.equal(wrong.status, 401);
  assert.match((await wrong.json()).error, /revoked.*\/console\/tokens/);
});
