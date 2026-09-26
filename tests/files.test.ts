import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { memoryStorage } from "../shared/storage.ts";
import { postgresTail } from "../src/log-tail.ts";
import { VolumeService } from "../src/volumes.ts";
import { declaredType, downloadHeaders, fileResponse, sniffContentType } from "../src/files.ts";
import { testDatabase } from "./database.ts";
import { OPERATOR, runtime } from "./runtime-server.ts";

type Context = { after(fn: () => Promise<void> | void): void };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 2, 0, 0, 0, 3, 8, 2, 0, 0, 0])]);

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
  for (const bad of [`${forged}.${mac}`, `${payload}.${mac.slice(0, -2)}AA`, payload, `${payload}.${mac}.x`]) {
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

test("an upload streams to storage a chunk at a time: a file far larger than the memory it uses", async t => {
  const server = await runtime(t, () => ({ role: "assistant", content: "ok" }));
  const volume = (await server.call("/v1/volumes", { body: { name: "big" } })).json.id;
  const put = (await server.call(`/v1/volumes/${volume}/links`, { body: { path: "/big.bin", method: "PUT" } })).json;
  const rss = async () => Number((await new Promise<string>((resolve, reject) => execFile("ps", ["-o", "rss=", "-p", String(server.child.pid)], (error, out) => error ? reject(error) : resolve(out)))).trim()) * 1024;
  const before = await rss();
  let peak = before;
  const sampling = setInterval(() => void rss().then(value => { peak = Math.max(peak, value); }, () => {}), 25);
  const size = 240 * 1024 * 1024;
  const piece = Buffer.alloc(64 * 1024, 7);
  const body = new ReadableStream<Uint8Array>({
    sent: 0,
    pull(controller) {
      if ((this as any).sent >= size) return controller.close();
      (this as any).sent += piece.length;
      controller.enqueue(piece);
    },
  } as UnderlyingDefaultSource<Uint8Array> & { sent: number });
  const response = await fetch(put.url.replace("https://agents.example.test", server.base), { method: "PUT", body, duplex: "half" } as RequestInit);
  clearInterval(sampling);
  const file = await response.json();
  assert.equal(response.status, 201, JSON.stringify(file));
  assert.equal(file.size, size);
  assert.equal(file.chunks, undefined);
  assert.ok(peak - before < 96 * 1024 * 1024, `the server grew by ${Math.round((peak - before) / 1024 / 1024)} MiB for a ${size / 1024 / 1024} MiB upload`);
  const head = await fetch(`${server.base}/v1/volumes/${volume}/files/big.bin`, { headers: { Authorization: `Bearer ${OPERATOR}`, Range: "bytes=-3" } });
  assert.deepEqual([...Buffer.from(await head.arrayBuffer())], [7, 7, 7]);
});
