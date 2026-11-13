import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { camelfsConfigured, importTree, uploadTimeoutMs, volumeLineage } from "../src/jobs/camelfs.ts";

const env = { CAMELFS: { fetch: async () => { throw new Error("unexpected binding call"); } }, CAMELFS_API_TOKEN: "unit-test-private-token" };
const tree = "a".repeat(40), lineage = volumeLineage("tenant", "volume");
const file = (path: string, text: string) => ({ path, key: `files/${path}`, size: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") });
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });

test("blob upload timeouts scale with size and stop at thirty minutes", () => {
  assert.equal(uploadTimeoutMs(0), 60_000);
  assert.equal(uploadTimeoutMs(2 * 2 ** 20), 61_000);
  assert.equal(uploadTimeoutMs(10 * 2 ** 30), 30 * 60_000);
});

test("imports missing blobs once, then only a changed blob with its parent tree", async () => {
  assert.equal(camelfsConfigured(env), true);
  assert.equal(camelfsConfigured({}), false);
  assert.equal(camelfsConfigured({ CAMELFS: env.CAMELFS }), false);
  assert.equal(camelfsConfigured({ ...env, CAMELFS_API_TOKEN: "" }), false);
  assert.equal(camelfsConfigured({ CAMELFS_API_TOKEN: "x" }), false);
  const stored = new Set<string>(), puts: string[] = [], posts: unknown[] = [];
  const bytes = new Map([["/a", "hello"], ["/b", "world"]]);
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${env.CAMELFS_API_TOKEN}`);
    assert.ok(init?.signal);
    if (init?.method === "POST") {
      assert.equal(String(url), "http://camelfs/v0/trees");
      const input = JSON.parse(init.body as string); posts.push(input);
      assert.equal(input.lineage, lineage);
      const missing = Object.values(input.files as Record<string, { sha256: string }>).map(f => f.sha256).filter(hash => !stored.has(hash));
      return missing.length ? json(409, { missing: [...missing, missing[0]] }) : json(200, { tree });
    }
    const parsed = new URL(String(url)), hash = parsed.pathname.split("/").at(-1)!;
    assert.equal(parsed.origin, "http://camelfs");
    assert.equal(parsed.pathname, `/v0/blobs/${hash}`);
    assert.equal(parsed.searchParams.get("lineage"), lineage);
    assert.equal(new Headers(init?.headers).get("content-type"), "application/octet-stream");
    assert.equal(new Headers(init?.headers).get("content-length"), String((init?.body as Uint8Array).byteLength));
    assert.equal(createHash("sha256").update(init?.body as Uint8Array).digest("hex"), hash);
    puts.push(hash); stored.add(hash);
    return new Response(null, { status: 201 });
  };
  const read = async (f: { path: string }) => { const body = Buffer.from(bytes.get(f.path)!); return { body, size: body.length }; };
  const files = [...bytes].map(([path, text]) => file(path, text));
  const binding = { fetch(input: Request | string, init?: RequestInit) {
    assert.equal(this, binding);
    return fetcher(input, init);
  } };
  assert.deepEqual(await importTree({ ...env, CAMELFS: binding }, { lineage, files, read }), { tree, uploaded: 2 });
  bytes.set("/b", "changed");
  const changed = file("/b", "changed");
  assert.deepEqual(await importTree(env, { lineage, parentTree: tree, files: [files[0], changed], read }, fetcher), { tree, uploaded: 1 });
  assert.deepEqual(puts, [files[0].sha256, files[1].sha256, changed.sha256]);
  assert.equal((posts[2] as { parentTree: string }).parentTree, tree);
});

test("rejects repeated conflicts, invalid hashes, unknown blobs, bad trees and errors without credentials", async () => {
  const f = file("a", "a"), input = { lineage, files: [f], read: async () => ({ body: Buffer.from("a"), size: 1 }) };
  let posts = 0;
  await assert.rejects(importTree(env, input, async (_url, init) => {
    if (init?.method === "PUT") return new Response(null, { status: 200 });
    posts++; return json(409, { missing: [f.sha256] });
  }), /409/);
  assert.equal(posts, 3);
  for (const [status, value] of [[409, { missing: ["not-hex"] }], [409, { missing: ["0".repeat(64)] }], [409, {}], [200, { tree: "bad" }], [200, null], [500, { error: env.CAMELFS_API_TOKEN }]] as const) {
    await assert.rejects(importTree(env, input, async () => json(status, value)), error => {
      assert.match((error as Error).message, new RegExp(String(status)));
      assert.ok(!(error as Error).message.includes(env.CAMELFS_API_TOKEN)); return true;
    });
  }
  await assert.rejects(importTree(env, input, async () => new Response("bad json")), /200/);
  await assert.rejects(importTree(env, input, async () => new Response('"' + "x".repeat(1024 * 1024) + '"')), /200/);
  await assert.rejects(importTree(env, input, async (_url, init) => init?.method === "POST" ? json(409, { missing: [f.sha256] }) : new Response(null, { status: 500 })), /500/);
});

test("at most eight uploads are in flight", async () => {
  const files = Array.from({ length: 25 }, (_, i) => file(String(i), String(i)));
  let active = 0, peak = 0, posts = 0;
  const result = await importTree(env, { lineage, files, read: async f => ({ body: Buffer.from(f.path), size: Buffer.byteLength(f.path) }) }, async (_url, init) => {
    if (init?.method === "POST") return ++posts === 1 ? json(409, { missing: files.map(f => f.sha256) }) : json(200, { tree });
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 2)); active--;
    return new Response(null, { status: 200 });
  });
  assert.equal(peak, 8);
  assert.equal(result.uploaded, 25);
});

test("streams missing blobs with their known content length and Node duplex", async () => {
  const f = file("/stream", "streamed bytes"), bytes = Buffer.from("streamed bytes");
  let posts = 0, puts = 0;
  let putSignal: AbortSignal | null | undefined;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
  const result = await importTree(env, { lineage, files: [f], read: async entry => {
    assert.equal(entry.key, f.key);
    return { body: stream, size: bytes.length };
  } }, async (url, init) => {
    if (init?.method === "POST") return ++posts === 1 ? json(409, { missing: [f.sha256] }) : json(200, { tree });
    puts++;
    putSignal = init?.signal;
    assert.equal(init?.body, stream, "the body reaches fetch without being buffered");
    assert.equal(stream.locked, false);
    assert.equal(new Headers(init?.headers).get("content-length"), String(bytes.length));
    assert.equal((init as RequestInit & { duplex?: string }).duplex, "half");
    // Node validates duplex when constructing a Request with a streamed body.
    const request = new Request(url, init);
    assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
    return new Response(null, { status: 201 });
  });
  assert.deepEqual(result, { tree, uploaded: 1 });
  assert.equal(puts, 1);
  assert.ok(putSignal instanceof AbortSignal);
  assert.equal(putSignal.aborted, false);
});

test("Volume paths are sent relative, and a refusal carries the daemon's error and detail", async () => {
  const f = { ...file("/src/a.txt", "a"), key: "k" };
  let sent: Record<string, unknown> | undefined;
  await importTree(env, { lineage, files: [f], read: async () => ({ body: Buffer.from("a"), size: 1 }) }, async (_url, init) => {
    sent = JSON.parse(init!.body as string).files; return json(200, { tree });
  });
  assert.deepEqual(Object.keys(sent!), ["src/a.txt"]);
  await assert.rejects(importTree(env, { lineage, files: [f], read: async () => ({ body: Buffer.from("a"), size: 1 }) }, async () => json(400, { error: "invalid-request", detail: "invalid path" })),
    /camelFS status 400: invalid-request: invalid path/);
});

test("a refused blob upload carries the daemon's reason", async () => {
  const f = { ...file("a.txt", "a"), key: "k" };
  await assert.rejects(importTree(env, { lineage, files: [f], read: async () => ({ body: Buffer.from("a"), size: 1 }) }, async (_url, init) =>
    init?.method === "POST" ? json(409, { missing: [f.sha256] }) : json(400, { error: "invalid-request", detail: "invalid missing content length" })),
    /camelFS status 400: blob upload failed: invalid-request: invalid missing content length/);
});
