import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runBuiltin, builtinDefinitions, builtinsInput, type BuiltinServices } from "../src/builtins.ts";
import { FileLinks } from "../src/files.ts";
import { Outbound } from "../src/outbound.ts";
import { MCP_INLINE_BYTES, savedContent, ToolFiles } from "../src/tool-files.ts";
import { VolumeService, VOLUME_LIMITS, type Mount } from "../src/volumes.ts";
import { TOOL_FILE_LIMITS } from "../src/limits.ts";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { api } from "../src/api.ts";
import { ToolSources } from "../src/tool-sources.ts";
import { testDatabase } from "./database.ts";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const signal = new AbortController().signal;
async function fixture(t: { after(fn: () => void): void }) {
  const { db } = await testDatabase();
  let quota: { used: number; limit: number } | undefined;
  const volumes = new VolumeService({ db, storage: memoryStorage(postgresTail(db, { unfenced: true })), quota: async () => quota });
  t.after(() => volumes.close());
  const { id } = await volumes.create("alice");
  const mounts: Mount[] = [{ volumeId: id, path: "/workspace", mode: "rw", subpath: "/root" }];
  const writes: unknown[] = [];
  const makeFiles = (run = { left: TOOL_FILE_LIMITS.runBytes }) => new ToolFiles({ volumes, tenant: "alice", agent: "a", mounts, tool: "test", run, onWrite: file => writes.push(file) });
  const files = makeFiles();
  const links = new FileLinks("test-secret", "https://runtime.example");
  const seen: { url: string; init: any }[] = [];
  let respond = () => new Response(Buffer.from([0, 255, 1]), { headers: { "Content-Type": "application/pdf" } });
  const outbound = {
    allowHttp: false, withoutOrigins() { return this; },
    async fetch(url: string, init: any) { seen.push({ url, init }); return respond(); },
  } as unknown as Outbound;
  const services: BuiltinServices = { links, outbound };
  const context = { tenant: "alice", agent: "a", files };
  const call = async (name: string, args: Record<string, unknown>) => (await runBuiltin(services, context, name, args, signal)).structuredContent as any;
  return { volumes, id, mounts, files, makeFiles, links, services, context, call, seen, writes, outbound,
    respond: (fn: typeof respond) => respond = fn, quota: (value: typeof quota) => quota = value,
    read: async (path: string) => { const entry = await volumes.call(id, "alice", "stat", { path: `/root/${path}` }); return volumes.readRange("alice", entry, 0, entry.size); },
  };
}

test("file_link offers minimal builtins and binds a visible file with shorter lifetimes", async t => {
  const f = await fixture(t);
  assert.deepEqual(builtinsInput(["file_link", "file_import"]), ["file_link", "file_import"]);
  assert.deepEqual(builtinDefinitions(["file_link", "file_import"]).map(tool => tool.name), ["file_link", "file_import"]);
  await f.volumes.put("alice", f.id, "/root/source", Buffer.from("hello"));
  f.mounts[0].mode = "ro";
  const value = await f.call("file_link", { path: "source", method: "GET" });
  assert.deepEqual(Object.keys(value).sort(), ["expiresAt", "method", "path", "url"]);
  const grant = f.links.verify(new URL(value.url).pathname.split("/")[3]);
  assert.equal(grant.path, "/root/source"); assert.equal(value.path, "/workspace/source");
  assert.ok(value.expiresAt > Date.now() + 299000 && value.expiresAt <= Date.now() + 300000);
  for (const expiresIn of [0, 901, 1.5]) await assert.rejects(f.call("file_link", { path: "source", method: "GET", expiresIn }), /expiresIn/);
  await assert.rejects(f.call("file_link", { path: "missing", method: "GET" }), /does not exist/);
  await assert.rejects(f.call("file_link", { path: "/workspace", method: "GET" }), /directory/);
  await assert.rejects(f.call("file_link", { path: "/elsewhere", method: "GET" }), /not inside a mount/);
  await assert.rejects(f.call("file_link", { path: "new", method: "PUT", maxBytes: 10 }), /read-only/);
  f.mounts[0].mode = "rw";
  for (const maxBytes of [undefined, -1, 0.5, VOLUME_LIMITS.fileBytes + 1]) await assert.rejects(f.call("file_link", { path: "new", method: "PUT", maxBytes }), /maxBytes/);
  await assert.rejects(f.call("file_link", { path: "new", method: "PUT", maxBytes: 1, contentType: "not-a-type" }), /contentType/);
  const upload = await f.call("file_link", { path: "new", method: "PUT", maxBytes: 4, contentType: "text/plain", expiresIn: 900 });
  const app = api({ links: f.links, volumes: f.volumes } as any);
  assert.equal((await app.fetch(new Request(upload.url, { method: "PUT", body: "large" }))).status, 413);
  assert.equal((await app.fetch(new Request(upload.url, { method: "PUT", body: "ok", headers: { "Content-Type": "image/png" } }))).status, 415);
  assert.equal((await app.fetch(new Request(upload.url, { method: "PUT", body: "okay", headers: { "Content-Type": "text/plain" } }))).status, 201);
  assert.equal((await f.read("new")).toString(), "okay");
});

test("file_import streams to an explicit writable path and returns metadata only", async t => {
  const f = await fixture(t);
  const bytes = Buffer.from([0, 255, 1]);
  const result = await f.call("file_import", { url: "http://public.example/file", to: "report.pdf" });
  assert.deepEqual(result, { path: "/workspace/report.pdf", size: bytes.length, sha256: sha(bytes), contentType: "application/pdf" });
  assert.deepEqual(await f.read("report.pdf"), bytes);
  assert.equal(f.writes.length, 1);
  assert.equal(f.seen[0].url, "https://public.example/file");
  assert.equal(f.seen[0].init.maxBytes, VOLUME_LIMITS.fileBytes);
  assert.equal(f.seen[0].init.maxRedirects, 5);
  assert.equal(f.seen[0].init.timeoutMs, 20000);
  f.mounts[0].mode = "ro";
  await assert.rejects(f.call("file_import", { url: "https://public.example/file", to: "blocked" }), /read-only/);
  assert.equal(f.seen.length, 1, "permissions checked before fetch");
  f.mounts[0].mode = "rw";
  f.respond(() => new Response("missing", { status: 404 }));
  await assert.rejects(f.call("file_import", { url: "https://public.example/file", to: "report.pdf" }), /HTTP 404/);
  f.respond(() => new Response("replacement"));
  f.quota({ used: 1, limit: 1 });
  await assert.rejects(f.call("file_import", { url: "https://public.example/file", to: "report.pdf" }), /quota|storage/i);
  assert.deepEqual(await f.read("report.pdf"), bytes);
});

test("file_import cancels oversized streams and preserves the prior version", async t => {
  const f = await fixture(t);
  await f.volumes.put("alice", f.id, "/root/dest", Buffer.from("original"));
  let left = VOLUME_LIMITS.fileBytes + 1, cancelled = false;
  const chunk = Buffer.alloc(1024 * 1024);
  f.respond(() => new Response(new ReadableStream({
    pull(c) { const bytes = chunk.subarray(0, Math.min(chunk.length, left)); left -= bytes.length; c.enqueue(bytes); if (!left) c.close(); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(f.call("file_import", { url: "https://public.example/large", to: "dest" }), /larger|limit/i);
  assert.deepEqual(await f.read("dest"), Buffer.from("original"));
  assert.ok(cancelled || left === 0);
});

test("file_import uses the public outbound guard, including for configured private origins", async t => {
  const f = await fixture(t);
  f.services.outbound = new Outbound({ origins: ["https://127.0.0.1"], resolve: async () => [{ address: "10.0.0.1", family: 4 }] });
  for (const url of ["https://127.0.0.1/file", "https://169.254.169.254/file", "https://private.example/file", "file:///etc/passwd"]) {
    await assert.rejects(f.call("file_import", { url, to: "blocked" }), /blocked|private|not allowed|https|internal/i);
  }
});

test("MCP saves blobs and large media once by sha, keeps text and small images, and leaves links", async t => {
  const f = await fixture(t);
  const blob = Buffer.from("pdf bytes"), large = Buffer.alloc(MCP_INLINE_BYTES + 1, 42);
  const text = { type: "text", text: "unchanged" };
  const resource = { type: "resource", resource: { uri: "file:///long.txt", text: "x".repeat(TOOL_FILE_LIMITS.textBytes + 1) } };
  const image = { type: "image", data: Buffer.from("small").toString("base64"), mimeType: "image/png" };
  const link = { type: "resource_link", uri: "https://public.example/file", name: "file" };
  const parts = [text, resource, image, { type: "resource", resource: { uri: "file:///../../bad.pdf", blob: blob.toString("base64"), mimeType: "application/pdf" } },
    { type: "image", data: large.toString("base64"), mimeType: "image/png" }, { type: "audio", data: large.toString("base64"), mimeType: "audio/wav" }, link];
  assert.deepEqual((await savedContent({ content: [resource] }, f.files, "attached", false)).content, [resource], "attached text is unchanged");
  const result = await savedContent({ content: parts }, f.files, "../../server");
  assert.deepEqual([result.content![0], result.content![2]], [parts[0], parts[2]]);
  assert.equal(result.content![1].type, "file", "long text keeps its existing file reference behavior");
  assert.ok(result.content!.includes(link));
  assert.match(result.content!.at(-1).text, /file_import/);
  assert.match(result.content![3].text, /File: \/workspace\/mcp\/server\/[a-f0-9]{64} \(9 bytes, application\/pdf\)/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(large.toString("base64")));
  assert.equal(f.writes.length, 3, "same bytes are saved once, even across content kinds");
  await savedContent({ content: [parts[3]] }, f.makeFiles(), "../../server");
  assert.equal(f.writes.length, 3, "repeated calls reuse the file");
  assert.deepEqual(await f.read(`mcp/server/${sha(blob)}`), blob);
  const without = await savedContent({ content: parts }, undefined, "server");
  assert.deepEqual(without.content, parts);
  f.mounts[0].path = "/data";
  assert.deepEqual((await savedContent({ content: parts }, f.makeFiles(), "server")).content, parts, "no workspace keeps the existing content");
});

test("MCP failed writes do not send large media back to the model", async t => {
  const f = await fixture(t);
  const part = { type: "image", data: Buffer.alloc(MCP_INLINE_BYTES + 1).toString("base64"), mimeType: "image/png" };
  const result = await savedContent({ content: [part] }, f.makeFiles({ left: 1 }), "server");
  assert.match(result.content![0].text, /not saved/);
  assert.equal(JSON.stringify(result).includes(part.data), false);
});

test("ToolSources wires file links and MCP metadata through the normal tool path", async t => {
  const f = await fixture(t);
  const sources = new ToolSources({ volumes: f.volumes, links: f.links, outbound: f.outbound, mcp: {
    async tools() { return [{ name: "blob", inputSchema: { type: "object" } }]; },
    async call() { return { content: [{ type: "resource", resource: { uri: "file:///test", blob: Buffer.from("blob").toString("base64") } }] }; },
  } as any });
  const server = sources.server({ tenant: "alice", agent: "a", mounts: () => f.mounts }, {
    builtins: ["file_link", "file_import"], mcpServers: [{ name: "vm", url: "https://public.example/mcp" }],
  });
  await f.volumes.put("alice", f.id, "/root/source", Buffer.from("hi"));
  const link = await server.call({ name: "file_link", args: { path: "source", method: "GET" }, signal });
  assert.equal((link as any).structuredContent.path, "/workspace/source");
  const result = await server.call({ name: "vm__blob", args: {}, signal });
  assert.match((result as any).content[0].text, /\/workspace\/mcp\/vm\//);
});
