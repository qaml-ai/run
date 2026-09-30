import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgentError, AgentRuntime } from "../clients/node.ts";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { CHUNK_BYTES, VolumeService } from "../src/volumes.ts";
import { declaredType, downloadHeaders, fileResponse, sniffContentType } from "../src/files.ts";
import { testDatabase } from "./database.ts";
import { bombPdf, pdfBytes, PNG } from "./file-fixtures.ts";
import { contextTokens } from "../src/compaction.ts";
import { messageChars } from "../src/history.ts";
import { inspect, inspection } from "../src/inspect.ts";
import { contentResult } from "../src/mcp-results.ts";
import { OPERATOR, runtime, toolCall, until } from "./runtime-server.ts";

type Context = { after(fn: () => Promise<void> | void): void };

async function service(t: Context) {
  const { db } = await testDatabase();
  const volumes = new VolumeService({ db, storage: memoryStorage(postgresTail(db, { unfenced: true })) });
  t.after(() => volumes.close());
  return volumes;
}

test("content types come from the upload, else magic bytes, the name, or whether it reads as text", () => {
  assert.equal(sniffContentType(PNG, "/x.bin"), "image/png", "magic bytes win over the name");
  assert.equal(sniffContentType(Buffer.from("%PDF-1.7\n"), "/report"), "application/pdf");
  assert.equal(sniffContentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "/a"), "image/jpeg");
  assert.equal(sniffContentType(Buffer.from("RIFF\0\0\0\0WEBPVP8 "), "/a"), "image/webp");
  assert.equal(sniffContentType(Buffer.from("PK\x03\x04"), "/deck.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
  assert.equal(sniffContentType(Buffer.from("<html>"), "/page.html"), "text/html");
  assert.equal(sniffContentType(Buffer.from("plain words, é"), "/notes"), "text/plain");
  assert.equal(sniffContentType(Buffer.from([1, 2, 0, 3]), "/blob"), "application/octet-stream");
  assert.equal(declaredType("Text/CSV; charset=utf-8"), "text/csv");
  for (const generic of ["application/octet-stream", "application/x-www-form-urlencoded", "not a type", "", undefined]) assert.equal(declaredType(generic), undefined);
});

test("downloads never run as the runtime's origin: nosniff, and active types are sandboxed attachments", () => {
  for (const type of ["text/html", "image/svg+xml", "application/xml", "text/javascript", "application/x-unknown"]) {
    const headers = downloadHeaders(type, "evil.html");
    assert.equal(headers["X-Content-Type-Options"], "nosniff");
    assert.match(headers["Content-Disposition"], /^attachment; filename\*=UTF-8''evil\.html$/);
    assert.equal(headers["Content-Security-Policy"], "sandbox; default-src 'none'");
  }
  const image = downloadHeaders("image/png", "a b.png");
  assert.equal(image["Content-Disposition"], "inline; filename*=UTF-8''a%20b.png");
  assert.equal(image["Content-Security-Policy"], "sandbox; default-src 'none'");
  assert.equal(downloadHeaders("text/plain", "n.txt")["Content-Type"], "text/plain; charset=utf-8");
  // Browsers' PDF viewers refuse a sandboxed document; they isolate a PDF's script themselves.
  const pdf = downloadHeaders("application/pdf", "r.pdf");
  assert.equal(pdf["Content-Security-Policy"], undefined);
  assert.match(pdf["Content-Disposition"], /^inline/);
});

test("files record their content type; files from before types were recorded are sniffed when downloaded", async t => {
  const volumes = await service(t);
  const { id } = await volumes.create("acme");
  assert.equal((await volumes.put("acme", id, "/pic", PNG)).contentType, "image/png");
  assert.equal((await volumes.put("acme", id, "/data.csv", Buffer.from("a,b\n"), { contentType: "text/csv; charset=utf-8" })).contentType, "text/csv");
  // A generic declared type says nothing: the bytes do.
  assert.equal((await volumes.put("acme", id, "/doc", (async function* () { yield Buffer.from("%PD"); yield Buffer.from("F-1.4 rest"); })(), { contentType: "application/octet-stream" })).contentType, "application/pdf");
  await assert.rejects(volumes.call(id, "acme", "commit", { path: "/bad", ...await volumes.store("acme", PNG), contentType: "image/png; x=1" }), /Invalid content type/);
  // Written before content types were recorded.
  await volumes.call(id, "acme", "commit", { path: "/old", ...await volumes.store("acme", PNG) });
  const old = await volumes.call(id, "acme", "stat", { path: "/old" });
  assert.equal(old.contentType, undefined);
  const response = await fileResponse(volumes, "acme", old);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
  const listed = await volumes.call(id, "acme", "list", {});
  assert.deepEqual(listed.files.map((file: any) => [file.path, file.contentType]), [["/data.csv", "text/csv"], ["/doc", "application/pdf"], ["/old", "application/octet-stream"], ["/pic", "image/png"]]);
  assert.deepEqual((await volumes.call(id, "acme", "ls", { path: "/" })).entries.map((entry: any) => entry.contentType), ["text/csv", "application/pdf", "application/octet-stream", "image/png"]);
});

test("the REST API stores the upload's type and serves downloads with safe headers", async t => {
  const server = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const volume = (await server.call("/v1/volumes", { body: { name: "files" } })).json.id;
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  const put = (path: string, body: Uint8Array | string, type?: string) => fetch(`${server.base}/v1/volumes/${volume}/files/${path}`, { method: "PUT", body: body as BodyInit, headers: { ...auth, ...(type ? { "Content-Type": type } : {}) } }).then(response => response.json());
  assert.equal((await put("page.html", "<script>alert(1)</script>", "text/html")).contentType, "text/html");
  assert.equal((await put("pic", PNG)).contentType, "image/png");
  const html = await fetch(`${server.base}/v1/volumes/${volume}/files/page.html`, { headers: auth });
  assert.equal(html.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(html.headers.get("x-content-type-options"), "nosniff");
  assert.equal(html.headers.get("content-security-policy"), "sandbox; default-src 'none'");
  assert.match(html.headers.get("content-disposition")!, /^attachment/);
  // Proxies may weaken or drop the ETag (Cloudflare's gzip makes it W/"n"); the version has a header of its own.
  assert.equal(html.headers.get("x-file-version"), html.headers.get("etag")!.replaceAll('"', ""));
  const pic = await fetch(`${server.base}/v1/volumes/${volume}/files/pic`, { headers: { ...auth, Range: "bytes=0-7" } });
  assert.equal(pic.status, 206);
  assert.equal(pic.headers.get("content-type"), "image/png");
  assert.match(pic.headers.get("content-disposition")!, /^inline/);
  const listing = (await server.call(`/v1/volumes/${volume}/files`)).json;
  assert.deepEqual(listing.files.map((file: any) => file.contentType), ["text/html", "image/png"]);
});

test("signed links: bound to tenant, volume, path, method, expiry, size and content type; tampering fails", async t => {
  const server = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const volume = (await server.call("/v1/volumes", { body: { name: "links" } })).json.id;
  await fetch(`${server.base}/v1/volumes/${volume}/files/docs/a.txt`, { method: "PUT", body: "hello", headers: { Authorization: `Bearer ${OPERATOR}` } });
  const link = async (body: object, token?: string) => server.call(`/v1/volumes/${volume}/links`, { body, token });
  const local = (url: string) => url.replace("https://agents.example.test", server.base);

  const get = (await link({ path: "/docs/a.txt" })).json;
  assert.match(get.url, /^https:\/\/agents\.example\.test\/v1\/links\/[\w-]+\.[\w-]+\/a\.txt$/);
  assert.ok(get.expiresAt > Date.now() + 14 * 60_000 && get.expiresAt <= Date.now() + 15 * 60_000, "15 minutes by default");
  const fetched = await fetch(local(get.url));
  assert.equal(await fetched.text(), "hello");
  assert.equal(fetched.headers.get("x-content-type-options"), "nosniff");
  assert.equal(fetched.headers.get("content-type"), "text/plain; charset=utf-8");
  // The name segment is only for browsers; the grant names the file.
  assert.equal(await (await fetch(local(get.url).replace(/a\.txt$/, "other.txt"))).text(), "hello");
  assert.equal((await fetch(local(get.url), { method: "PUT", body: "x" })).status, 405, "a download link cannot upload");

  // Tampering with the grant or the signature fails.
  const [prefix, token] = [local(get.url).split("/v1/links/")[0], local(get.url).split("/v1/links/")[1].split("/")[0]];
  const [payload, mac] = token.split(".");
  const grant = JSON.parse(Buffer.from(payload, "base64url").toString());
  const forged = Buffer.from(JSON.stringify({ ...grant, path: "/docs/secret.txt" })).toString("base64url");
  // The signature's first character always changes the MAC (its last carries only 4 bits, and may already be what a swap writes).
  const otherMac = `${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`;
  for (const bad of [`${forged}.${mac}`, `${payload}.${otherMac}`, payload, `${payload}.${mac}.x`]) {
    const response = await fetch(`${prefix}/v1/links/${bad}/a.txt`);
    assert.equal(response.status, 403, bad);
  }
  assert.equal((await link({ path: "/docs/a.txt", expiresIn: 90_000 })).status, 400, "lifetimes are capped");
  assert.equal((await link({ path: "/docs/a.txt" }, "other-operator-token-at-least-24-chars")).status, 404, "another tenant cannot sign for this volume");

  // Upload links: size and content type are part of the grant.
  const put = (await link({ path: "/in/photo.png", method: "PUT", maxBytes: PNG.length, contentType: "image/png" })).json;
  assert.equal((await fetch(local(put.url), { method: "PUT", body: Buffer.concat([PNG, Buffer.from("x")]) })).status, 413);
  assert.equal((await fetch(local(put.url), { method: "PUT", body: PNG, headers: { "Content-Type": "text/html" } })).status, 415);
  const uploaded = await fetch(local(put.url), { method: "PUT", body: PNG });
  assert.equal(uploaded.status, 201);
  assert.deepEqual(await uploaded.json().then(({ path, size, contentType, by }) => ({ path, size, contentType, by })), { path: "/in/photo.png", size: PNG.length, contentType: "image/png", by: "link" });
  assert.equal((await fetch(local(put.url))).status, 405, "an upload link cannot download");

  const brief = (await link({ path: "/docs/a.txt", expiresIn: 1 })).json;
  await new Promise(resolve => setTimeout(resolve, 1100));
  const expired = await fetch(local(brief.url));
  assert.equal(expired.status, 403);
  assert.match((await expired.json()).error, /expired/);
  // A deleted volume's links stop working.
  await server.call(`/v1/volumes/${volume}`, { method: "DELETE" });
  assert.equal((await fetch(local(get.url))).status, 404);
});

test("an upload streams to storage a chunk at a time: the source is never more than a few chunks ahead of storage", async t => {
  // Structural, not process memory (which load makes noisy): every byte the source yields is
  // counted, as is every byte storage has taken, and the gap between them is what is held.
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  let produced = 0, stored = 0, ahead = 0;
  const writeBlob = storage.writeBlob.bind(storage);
  storage.writeBlob = async (key, data) => { await new Promise(resolve => setImmediate(resolve)); await writeBlob(key, data); stored += data.length; };
  const volumes = new VolumeService({ db, storage });
  t.after(() => volumes.close());
  const { id } = await volumes.create("acme");
  const size = 64 * 1024 * 1024;
  const piece = Buffer.alloc(64 * 1024, 7);
  const source = (async function* () {
    while (produced < size) {
      produced += piece.length;
      ahead = Math.max(ahead, produced - stored);
      yield piece;
    }
  })();
  const file = await volumes.put("acme", id, "/big.bin", source);
  assert.equal(file.size, size);
  assert.equal(file.chunks.length, size / CHUNK_BYTES);
  // At most four chunk writes in flight, plus the chunk being filled.
  assert.ok(ahead <= 6 * CHUNK_BYTES, `the source got ${Math.round(ahead / CHUNK_BYTES)} MiB ahead of storage for a ${size / CHUNK_BYTES} MiB file`);

  // The same stream end to end over HTTP, through an upload link.
  const server = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const volume = (await server.call("/v1/volumes", { body: { name: "big" } })).json.id;
  const put = (await server.call(`/v1/volumes/${volume}/links`, { body: { path: "/big.bin", method: "PUT" } })).json;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= size) return controller.close();
      sent += piece.length;
      controller.enqueue(piece);
    },
  });
  const response = await fetch(put.url.replace("https://agents.example.test", server.base), { method: "PUT", body, duplex: "half" } as RequestInit);
  const uploaded = await response.json();
  assert.equal(response.status, 201, JSON.stringify(uploaded));
  assert.equal(uploaded.size, size);
  const tail = await fetch(`${server.base}/v1/volumes/${volume}/files/big.bin`, { headers: { Authorization: `Bearer ${OPERATOR}`, Range: "bytes=-3" } });
  assert.deepEqual([...Buffer.from(await tail.arrayBuffer())], [7, 7, 7]);
});

test("attachments over REST land in the workspace, the transcript keeps references, and the model sees them natively", async t => {
  const server = await runtime(t, () => ({ role: "assistant", content: "seen", usage: { prompt_tokens: 5000, completion_tokens: 7 } }));
  const agent = (await server.call("/v1/agents", { body: { name: "reader" } })).json.id;
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  const PDF = pdfBytes(["Quarterly report"]);
  const uploaded = await (await fetch(`${server.base}/v1/agents/${agent}/uploads/turn-1/report.pdf`, { method: "PUT", body: PDF, headers: auth })).json();
  assert.equal(uploaded.path, "/workspace/uploads/turn-1/report.pdf");
  assert.equal(uploaded.contentType, "application/pdf");
  const bad = async (files: unknown, pattern: RegExp) => {
    const response = await server.call(`/v1/agents/${agent}/prompt`, { body: { text: "x", files } });
    assert.ok(response.status === 400 || response.status === 413, `${response.status} ${response.text}`);
    assert.match(response.json.error, pattern);
  };
  await bad(Array.from({ length: 21 }, () => ({ path: uploaded.path })), /At most 20 files/);
  await bad([{ name: "a", data: "not base64!" }], /\{path\}.*\{name, data/);
  await bad([{ path: "/etc/passwd" }], /not inside a mount/);
  await bad([{ path: "/workspace/missing.png" }], /does not exist/);
  await bad([{ name: "big.bin", data: Buffer.alloc(4 * 1024 * 1024 + 3).toString("base64") }], /Inline files are limited/);

  const accepted = await server.call(`/v1/agents/${agent}/prompt`, { body: { text: "What are these?", requestId: "turn-1", files: [{ path: uploaded.path }, { name: "../../etc/shot.png", data: PNG.toString("base64") }, { name: "shot.png", data: PNG.toString("base64") }] } });
  assert.equal(accepted.status, 202, accepted.text);
  await until(async () => (await server.call(`/v1/agents/${agent}/requests/turn-1`)).json.state === "completed", "the turn");
  // Names are sanitized, and collide only within a request.
  const listed = (await server.call(`/v1/volumes/${(await server.call(`/v1/agents/${agent}/mounts`)).json[0].volumeId}/files?prefix=/uploads/turn-1`)).json.files;
  assert.deepEqual(listed.map((file: any) => [file.path, file.contentType]), [["/uploads/turn-1/report.pdf", "application/pdf"], ["/uploads/turn-1/shot-2.png", "image/png"], ["/uploads/turn-1/shot.png", "image/png"]]);

  // The model got the text, a line per file, and native blocks: the image, and the PDF as a document (OpenRouter takes files).
  const user = server.model.bodies.at(-1).messages.find((message: any) => message.role === "user");
  assert.equal(user.content[0].text, "What are these?");
  assert.match(user.content[1].text, /^\[File \/workspace\/uploads\/turn-1\/report\.pdf \(application\/pdf, 1 KB\)\]$/);
  assert.deepEqual(user.content[2], { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${PDF.toString("base64")}` } });
  assert.match(user.content[3].text, /shot\.png \(image\/png/);
  assert.deepEqual(user.content[4], { type: "image_url", image_url: { url: `data:image/png;base64,${PNG.toString("base64")}` } });

  // The transcript holds references (volume, path, version, type and chunks), never the bytes.
  const history = (await server.call(`/v1/agents/${agent}/history`)).json;
  const stored = history.messages.find((message: any) => message.role === "user").content;
  assert.deepEqual(stored.slice(1).map((block: any) => [block.type, block.path, block.contentType, block.media]), [
    ["file", "/workspace/uploads/turn-1/report.pdf", "application/pdf", { kind: "pdf", pages: 1 }],
    ["file", "/workspace/uploads/turn-1/shot.png", "image/png", { kind: "image", mimeType: "image/png", width: 2, height: 3 }],
    ["file", "/workspace/uploads/turn-1/shot-2.png", "image/png", { kind: "image", mimeType: "image/png", width: 2, height: 3 }],
  ]);
  assert.ok(stored.every((block: any) => block.type === "text" || (block.version > 0 && block.chunks.length === 1 && block.volume.startsWith("vol_"))));
  assert.ok(!JSON.stringify(history).includes(PNG.toString("base64")) && !JSON.stringify(history).includes(PDF.toString("base64").slice(0, 40)), "no base64 in the transcript");
  const requests = (await server.call(`/v1/agents/${agent}`)).json.requests;
  assert.ok(!JSON.stringify(requests).includes(PNG.toString("base64")));
  // Billing is what the provider reported for the one request: files add no model calls and no usage of their own.
  assert.equal(server.model.bodies.length, 1);
  const { totals } = (await server.call("/v1/usage")).json;
  assert.deepEqual([totals.responses, totals.input, totals.output], [1, 5000, 7]);
});

test("context estimates count what file references stand for, not their JSON", () => {
  const ref = (media: object, size = 1000) => ({ type: "file", path: "/workspace/a", volume: `vol_${"a".repeat(24)}`, version: 1, size, contentType: "application/pdf", chunks: Array.from({ length: 40 }, () => "b".repeat(64)), media });
  const message = (block: object) => ({ role: "user", content: [{ type: "text", text: "see" }, block], timestamp: 0 }) as any;
  const pdf = message(ref({ kind: "pdf", pages: 10 }));
  assert.ok(contextTokens([pdf]) >= 30_000, "ten pages at about 3,000 tokens each");
  assert.ok(messageChars(pdf) >= 120_000 && messageChars(pdf) < 121_000, "and not the chunk list");
  assert.ok(contextTokens([message(ref({ kind: "image", mimeType: "image/png", width: 1, height: 1 }))]) >= 1200);
  assert.ok(contextTokens([message(ref({ kind: "none", reason: "x" }, 10_000_000))]) < 200, "a file that is only named costs its line");
  // After a response that reported usage, only later messages' files are added.
  const answered = { role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 40_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 40_010 }, stopReason: "stop", timestamp: 0 } as any;
  const tokens = contextTokens([pdf, answered]);
  assert.ok(tokens >= 40_010 && tokens < 41_000, String(tokens));
  assert.ok(contextTokens([pdf, answered, pdf]) >= 70_000);
});

test("the TypeScript SDK attaches bytes, Blobs, local paths and workspace files; a file deleted or replaced after attaching still reads as attached", async t => {
  const server = await runtime(t, () => ({ role: "assistant", content: "seen" }));
  const client = new AgentRuntime({ url: server.base, apiKey: OPERATOR });
  const agent = await client.createAgent({ tools: {} });
  t.after(() => agent.close());
  const local = join(server.root, "notes.txt");
  writeFileSync(local, "local notes");
  const pdf = pdfBytes(["Invoice 42"]);
  await agent.files.upload("/workspace/in/earlier.png", PNG);
  const result = await agent.prompt("Look", { idempotencyKey: "with-files", files: [PNG, new Blob([pdf], { type: "application/pdf" }), local, { path: "/workspace/in/earlier.png" }, { name: "data.csv", data: new TextEncoder().encode("a,b"), contentType: "text/csv" }] });
  assert.equal(result.reply, "seen");
  const listing = await agent.files.list({ path: "/workspace/uploads/with-files" });
  assert.deepEqual(listing.files.map(file => [file.path, file.contentType]), [
    ["/workspace/uploads/with-files/attachment-1", "image/png"], ["/workspace/uploads/with-files/attachment-2", "application/pdf"],
    ["/workspace/uploads/with-files/data.csv", "text/csv"], ["/workspace/uploads/with-files/notes.txt", "text/plain"],
  ]);
  const first = server.model.bodies.at(-1).messages.find((message: any) => message.role === "user").content;
  assert.equal(first.filter((part: any) => part.type === "image_url").length, 2);
  assert.equal(first.filter((part: any) => part.type === "file").length, 1);
  assert.ok(first.some((part: any) => part.text?.startsWith("[File /workspace/uploads/with-files/notes.txt (text/plain")));
  assert.ok(first.some((part: any) => part.text === "[File /workspace/uploads/with-files/data.csv (text/csv, 1 KB), beginning:\na,b]"), "a text file comes with its first lines");

  // The attached files change afterwards: the earlier message still carries what was attached.
  const volume = (await client.mounts(agent.session.id))[0].volumeId;
  await client.volume(volume).remove("/uploads/with-files/attachment-1");
  await agent.files.upload("/workspace/in/earlier.png", Buffer.concat([PNG, Buffer.from("changed")]));
  await agent.prompt("Again");
  const replayed = server.model.bodies.at(-1).messages.find((message: any) => message.role === "user").content.filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url);
  assert.deepEqual(replayed, [`data:image/png;base64,${PNG.toString("base64")}`, `data:image/png;base64,${PNG.toString("base64")}`]);
  assert.deepEqual(JSON.stringify(server.model.bodies.at(-2).messages.slice(0, 2)), JSON.stringify(server.model.bodies.at(-1).messages.slice(0, 2)), "the same references give the same request: the cached prefix holds");

  // Files out: download and a signed link, with the agent's token only.
  const downloaded = await agent.files.download("/workspace/uploads/with-files/data.csv");
  assert.deepEqual([new TextDecoder().decode(downloaded.data), downloaded.contentType], ["a,b", "text/csv"]);
  const link = await agent.files.link("/workspace/uploads/with-files/data.csv");
  assert.equal(link.path, "/workspace/uploads/with-files/data.csv");
  assert.equal(await (await fetch(link.url.replace("https://agents.example.test", server.base))).text(), "a,b");
  await assert.rejects(agent.files.link("/elsewhere/x"), (error: AgentError) => error.status === 400);
  await assert.rejects(agent.prompt("x", { files: [{ path: "/workspace/nope" }] }), (error: AgentError) => error.status === 400 && /does not exist/.test(error.message));
});

test("parsing a hostile file stops at its limits on a worker: the runtime's thread neither crashes nor stalls", async () => {
  const bomb = await bombPdf();
  let ticks = 0;
  const ticker = setInterval(() => ticks++, 10);
  const started = Date.now();
  const found = await inspect(bomb, true);
  clearInterval(ticker);
  assert.deepEqual(found, { media: { kind: "none", reason: "could not be read (it needs too much memory)" } });
  assert.ok(ticks >= (Date.now() - started) / 10 / 3, `the event loop kept running (${ticks} ticks in ${Date.now() - started} ms)`);
  // Garbage is only unreadable, and whatever a worker answers is checked.
  assert.equal((await inspect(Buffer.from("%PDF-1.4 but nothing else"))).media.kind, "none");
  assert.deepEqual(inspection({ media: { kind: "image", mimeType: "text/html", width: 1, height: 1 } }), { media: { kind: "none", reason: "could not be read" } });
  assert.deepEqual(inspection({ media: { kind: "pdf", pages: -1 } }).media.kind, "none");
  const text = await inspect(pdfBytes(["First page", "Second page"]), true);
  assert.deepEqual(text, { media: { kind: "pdf", pages: 2 }, text: "--- Page 1 ---\nFirst page\n\n--- Page 2 ---\nSecond page" });
});

test("only the runtime's own file tools may return file references: anyone else's are described, never hydrated", () => {
  const ref = { type: "file", path: "/workspace/a.png", volume: `vol_${"a".repeat(24)}`, version: 1, size: 3, contentType: "image/png", chunks: ["c".repeat(64)] };
  assert.deepEqual(contentResult({ content: [ref] }).content, [{ type: "text", text: "[file content omitted]" }]);
  assert.deepEqual(contentResult({ content: [ref] }, true).content, [ref]);
});

test("a run's outcome lists the files it wrote and presented, and a presented file is an event with a download link", async t => {
  const server = await runtime(t, (_body, index) => [
    toolCall("write", { path: "/workspace/out/summary.md", content: "# Summary" }),
    toolCall("js_exec", { code: 'await fs.writeFile("/workspace/out/chart.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))' }),
    toolCall("present_file", { path: "/workspace/out/chart.png", caption: "Q3 chart" }),
    { role: "assistant", content: "Here is your chart." },
  ][index] ?? { role: "assistant", content: "ok" });
  const events: any[] = [];
  const client = new AgentRuntime({ url: server.base, apiKey: OPERATOR });
  const agent = await client.createAgent({ tools: {}, onEvent: event => { if (event.type === "file_presented") events.push(event); } });
  t.after(() => agent.close());
  const result = await agent.prompt("Make me a chart");
  assert.equal(result.reply, "Here is your chart.");
  assert.deepEqual(result.files.map((file: any) => [file.path, file.contentType]), [["/workspace/out/summary.md", "text/markdown"], ["/workspace/out/chart.png", "image/png"]]);
  assert.deepEqual(result.presented.map((file: any) => [file.type, file.path, file.caption, file.contentType, file.size]), [["file", "/workspace/out/chart.png", "Q3 chart", "image/png", 8]]);
  await until(() => events.length, "the file_presented event");
  assert.equal(events[0].file.path, "/workspace/out/chart.png");
  const fetched = await fetch(events[0].url.replace("https://agents.example.test", server.base));
  assert.equal(fetched.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await fetched.arrayBuffer()).length, 8);
  // Each run has its own list; a code execution is a run too.
  await agent.prompt("Thanks");
  const later = (await agent.outcomes()).requests.at(-1)!.outcome!.result as any;
  assert.equal(later.files, undefined);
  const executed = await agent.execute('await tools.present_file({ path: "/workspace/out/summary.md" })');
  assert.deepEqual(executed.presented.map((file: any) => file.path), ["/workspace/out/summary.md"]);
});
