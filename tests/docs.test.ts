import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runtime } from "./runtime-server.ts";

test("the docs are served without credentials: llms.txt, llms-full.txt and every page, the operators' too, pointing at this runtime", async t => {
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

test("coding agents' setup skill is at /SKILL.md (and /skill.md), uncached; /docs sends people to the docs site", async t => {
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

test("an unknown path is a 404 that says where to start, and a known one without credentials a 401 that says how to get them", async t => {
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

test("the SDK packages ship this version's skill and SDK reference, with links that work outside the repository", async t => {
  const out = await mkdtemp(join(tmpdir(), "package-docs-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/package-docs.mjs", import.meta.url)), out]);
  const skill = await readFile(join(out, "SKILL.md"), "utf8");
  assert.equal(skill, await readFile(new URL("../docs/SKILL.md", import.meta.url), "utf8"));
  const sdk = await readFile(join(out, "sdk.md"), "utf8");
  assert.match(sdk, /\]\(https:\/\/run\.camelai\.com\/docs\/guides\/tools\.md\)/);
  assert.match(sdk, /\]\(https:\/\/github\.com\/qaml-ai\/run\/blob\/main\/examples\//);
  assert.doesNotMatch(sdk, /\]\((?!https?:|#|mailto:)[^)\s]+\)/, "no relative links");
  // Both packages build them in: npm's from its build script, PyPI's before `python -m build`.
  const npm = JSON.parse(await readFile(new URL("../sdk/package.json", import.meta.url), "utf8"));
  assert.ok(npm.files.includes("docs"));
  assert.match(npm.scripts.build, /package-docs\.mjs docs/);
  assert.match(await readFile(new URL("../clients/python/pyproject.toml", import.meta.url), "utf8"), /camelai_run = \["\*\.md", "py\.typed"\]/);
  assert.match(await readFile(new URL("../.github/workflows/publish-python.yml", import.meta.url), "utf8"), /package-docs\.mjs clients\/python\/camelai_run/);
});

test("llms.txt and llms-full.txt are current (npm run docs), llms-full.txt's links are absolute, and every relative link in the docs resolves", async () => {
  const { brokenLinks, llmsFullTxt, llmsTxt } = await import("../scripts/docs.ts");
  assert.equal(await readFile(new URL("../docs/llms.txt", import.meta.url), "utf8"), llmsTxt(), "run npm run docs");
  const full = llmsFullTxt();
  assert.equal(await readFile(new URL("../docs/llms-full.txt", import.meta.url), "utf8"), full, "run npm run docs");
  assert.doesNotMatch(full, /\]\((?!https?:|mailto:)[^)\s]+\)/, "no relative links");
  assert.match(full, /\]\(https:\/\/run\.camelai\.com\/docs\/operations\/self-host\.md#networking\)/);
  assert.deepEqual(brokenLinks(), []);
});

test("the self-host Compose file runs the newest release in the release notes, and self-host.md names it", async () => {
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const newest = /^## (\d+\.\d+\.\d+) \(runtime-v\1, \d{4}-\d\d-\d\d\)$/m.exec(await read("docs/operations/release-notes.md"))?.[1];
  assert.ok(newest, "release notes have version headings: ## <version> (runtime-v<version>, <date>)");
  const images = [...(await read("deploy/selfhost/docker-compose.yml")).matchAll(/AGENT_RUNTIME_IMAGE:-ghcr\.io\/qaml-ai\/run:([^}]+)\}/g)].map(match => match[1]);
  assert.deepEqual([...new Set(images)], [newest]);
  assert.match(await read("docs/operations/self-host.md"), new RegExp(`ghcr\\.io/qaml-ai/run:${newest.replaceAll(".", "\\.")}\``));
});

