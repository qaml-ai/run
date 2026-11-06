import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchWithoutRedirects } from "../src/core/no-redirect.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const SKIPPED = new Set(["node_modules", "dist", "dist-codemode", "vendor", "third-party", "target", "coverage", "build"]);
function* code(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIPPED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* code(path);
    else if (entry.isFile() && /\.(?:[cm]?[jt]sx?|svelte|vue)$/.test(entry.name)) yield path;
  }
}

// Workers' fetch throws on redirect mode "error" (the October 2026 sign-in outage); Node accepts it, so only
// a Workers run would notice. Our code asks through fetchWithoutRedirects instead, everywhere.
test("no code asks fetch for redirect mode \"error\": fetchWithoutRedirects does what it means on both runtimes", () => {
  const banned = /redirect["']?\s*:\s*["'`]error["'`]|\.redirect\s*=\s*["'`]error["'`]/;
  let files = 0;
  const found: string[] = [];
  for (const file of code(root)) {
    files++;
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (banned.test(line)) found.push(`${file.slice(root.length)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.ok(files > 1000, `only ${files} files scanned`);
  assert.deepEqual(found, [], "use fetchWithoutRedirects (src/core/no-redirect.ts): Workers' fetch throws on this");
});

test("fetchWithoutRedirects returns other answers and refuses redirects as Node's redirect mode \"error\" does", async t => {
  const server = createServer((request, response) => {
    const status = Number(request.url!.slice(1));
    if ([301, 302, 303, 307, 308].includes(status)) response.writeHead(status, { location: "/200" }).end("moved");
    else response.writeHead(status).end(status === 304 ? undefined : `answer ${status}`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const status of [200, 404, 500]) {
    const response = await fetchWithoutRedirects(fetch, `${base}/${status}`, { method: "POST", body: "x" });
    assert.deepEqual([response.status, await response.text()], [status, `answer ${status}`]);
  }
  assert.equal((await fetchWithoutRedirects(fetch, `${base}/304`)).status, 304);
  for (const status of [301, 302, 303, 307, 308]) {
    // What Node does with the mode itself, which Workers cannot: the same error, the same cause (with the status).
    const native = await fetch(`${base}/${status}`, { redirect: ["e", "rror"].join("") as RequestRedirect }).then(() => undefined, error => error);
    const ours = await fetchWithoutRedirects(fetch, `${base}/${status}`).then(() => undefined, error => error);
    assert.ok(native instanceof TypeError && ours instanceof TypeError, `HTTP ${status} is refused`);
    assert.equal(ours.message, native.message);
    assert.equal((ours.cause as Error).message, `${(native.cause as Error).message} (HTTP ${status})`);
  }
  // The mode asked of the underlying fetch is always "manual", and an opaque redirect (a browser's) is refused too.
  let asked: RequestInit | undefined;
  const opaque = Object.defineProperty(new Response(null, { status: 200 }), "type", { value: "opaqueredirect" });
  await assert.rejects(fetchWithoutRedirects(async (_input, init) => { asked = init; return opaque; }, "https://example.test/", { redirect: "follow", headers: { a: "b" } }), /fetch failed/);
  assert.deepEqual(asked, { redirect: "manual", headers: { a: "b" } });
});
