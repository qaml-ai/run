import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { loadDocs } from "../../../src/docs.ts";
import { publicDocs } from "../src/public-docs.ts";

const directory = fileURLToPath(new URL("../../../docs/", import.meta.url));
const origin = "https://agents.example.test";
const requests: string[] = [];
const env = {
  AGENT_PUBLIC_URL: origin,
  DOCS: { fetch: (async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    requests.push(path);
    try { return new Response(await readFile(join(directory, path.slice(1)), "utf8")); }
    catch { return new Response(null, { status: 404 }); }
  }) as typeof fetch },
};

test("Workers serve every source document with the same body and public headers", async () => {
  const documents = loadDocs(directory, origin);
  assert.ok(documents.size > 50, "the complete documentation tree is available");
  for (const [path, expected] of documents) {
    const response = await publicDocs(new Request(origin + path), env);
    assert.equal(response?.status, 200, path);
    assert.equal(response.headers.get("content-type"), expected.type, path);
    assert.equal(response.headers.get("access-control-allow-origin"), "*", path);
    assert.equal(response.headers.get("x-robots-tag"), "noindex", path);
    assert.equal(await response.text(), expected.body, path);
  }
  const head = await publicDocs(new Request(origin + "/SKILL.md", { method: "HEAD" }), env);
  assert.equal(head?.headers.get("cache-control"), "no-cache");
  assert.equal(await head?.text(), "");
});

test("Workers refuse unknown documents and non-read methods without exposing other assets", async () => {
  for (const [path, method] of [
    ["/docs/package.json", "GET"],
    ["/docs/%52EADME.md", "GET"],
    ["/docs//README.md", "GET"],
    ["/docs/no-such-page.md", "GET"],
    ["/docs/README.md", "POST"],
    ["/llms.txt", "DELETE"],
  ]) {
    const before = requests.length;
    const response = await publicDocs(new Request(origin + path, { method }), env);
    assert.equal(response?.status, 404, path);
    assert.deepEqual(await response.json(), { type: "error", error: `Unknown document. The docs' index: ${origin}/llms.txt`, code: "NOT_FOUND" });
    if (path !== "/docs/no-such-page.md") assert.equal(requests.length, before, path);
  }
  assert.equal(await publicDocs(new Request(origin + "/v1/me"), env), undefined);
});
