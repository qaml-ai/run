import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { CamelRun } from "../sdk/src/index.ts";
import { makeMarker, parseMarker, type ImageReference } from "../worker/src/pi/image-request-marker.ts";
import { prepareBody, streamingFetch, type ImageBucket } from "../worker/src/pi/image-request-stream.ts";
import type { ModelImageProbe, PiEntryImage, ProbeAdapter } from "./fixtures/pi-image-stream-worker.ts";

const providerUrl = "https://provider.invalid/v1/chat/completions";

function imageFixture(bytes: Buffer, chunkSize = 7) {
  const ref: ImageReference = {
    key: "tenant/tool-images/sample", size: bytes.length, mimeType: "image/jpeg", nonce: crypto.randomUUID(),
  };
  const stats = { heads: 0, gets: 0, cancels: 0 };
  const bucket: ImageBucket = {
    async head(key) {
      stats.heads++;
      return key === ref.key ? { size: bytes.length } : null;
    },
    async get(key) {
      stats.gets++;
      if (key !== ref.key) return null;
      let offset = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.subarray(offset, offset + chunkSize));
          offset += chunkSize;
        },
        cancel() { stats.cancels++; },
      }, { highWaterMark: 0 });
      return { size: bytes.length, body };
    },
  };
  return { ref, bucket, stats };
}

function fixed(length: number) {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) {
      seen += bytes.length;
      assert.ok(seen <= length);
      controller.enqueue(bytes);
    },
    flush() { assert.equal(seen, length); },
  });
}

function authorized(ref: ImageReference) {
  return {
    createFixedLengthStream: fixed,
    allowReference: (candidate: ImageReference) => JSON.stringify(candidate) === JSON.stringify(ref),
  };
}

const chatImage = (mimeType: string, data: string) => ({
  type: "image_url",
  image_url: { url: `data:${mimeType};base64,${data}` },
});
const chatBody = (marker: string) => JSON.stringify({ messages: [{ role: "user", content: [
  { type: "text", text: "Accents: été. Emoji: 🐪" },
  chatImage("image/png", marker),
] }] });

test("request marker is a transparent 1×1 PNG and rejects a damaged CRC or length", () => {
  const { ref } = imageFixture(Buffer.from([1, 2, 3]));
  const expected = { ...ref, key: "tenant/tool-images/été-🐪" };
  const marker = makeMarker(expected);
  assert.deepEqual(parseMarker(marker), expected);
  assert.equal(parseMarker("not an image"), null);
  const png = Buffer.from(marker, "base64");
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);
  const idat = png.indexOf("IDAT");
  assert.deepEqual(inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4))), Buffer.alloc(5));

  const textChunk = png.indexOf("iTXt");
  const textLength = png.readUInt32BE(textChunk - 4);
  const badCrc = Buffer.from(png);
  badCrc[textChunk + 4 + textLength] ^= 1;
  assert.equal(parseMarker(badCrc.toString("base64")), null);
  const badLength = Buffer.from(png);
  badLength.writeUInt32BE(textLength + 1, textChunk - 4);
  assert.equal(parseMarker(badLength.toString("base64")), null);
  const tampered = Buffer.from(png);
  tampered[tampered.indexOf("tenant", textChunk)] = "T".charCodeAt(0);
  assert.equal(parseMarker(tampered.toString("base64")), null);
  assert.equal(parseMarker(png.subarray(0, -1).toString("base64")), null);
});

test("streaming fetch restores every provider image shape and exact UTF-8 Content-Length", async () => {
  const bytes = randomBytes(49157);
  const { ref, bucket, stats } = imageFixture(bytes, 49153);
  const marker = makeMarker(ref);
  const shapes = (mime: string, data: string) => [
    { type: "image", source: { type: "base64", media_type: mime, data } },
    chatImage(mime, data),
    { type: "input_image", image_url: `data:${mime};base64,${data}`, detail: "auto" },
    { inlineData: { mimeType: mime, data } },
    { inline_data: { mime_type: mime, data } },
    { image: { format: mime.slice(6), source: { bytes: data } } },
  ];
  const unrelated = { type: "text", text: `été 🐪 ${marker}` };
  const input = JSON.stringify({ content: [...shapes("image/png", marker), unrelated] });
  const fetcher: typeof fetch = async (_input, init) => {
    assert.ok(init?.body instanceof ReadableStream);
    assert.equal(stats.gets, 0, "R2 should stay unopened until the body is pulled");
    const raw = await new Response(init.body).text();
    assert.equal(new Headers(init.headers).get("content-length"), String(Buffer.byteLength(raw)));
    assert.equal(new Headers(init.headers).get("transfer-encoding"), null);
    assert.deepEqual(JSON.parse(raw), { content: [...shapes(ref.mimeType, bytes.toString("base64")), unrelated] });
    return new Response("ok");
  };
  const result = await streamingFetch(fetcher, bucket, authorized(ref))(providerUrl, {
    method: "POST", body: input, headers: { "Transfer-Encoding": "chunked", "Content-Length": "1" },
  });
  assert.equal(await result.text(), "ok");
  assert.deepEqual(stats, { heads: 1, gets: 6, cancels: 0 });
});

test("request image base64 keeps carry bytes and pads only at the end", async () => {
  for (const size of [1, 2, 3, 4, 47, 49151, 49152, 49153]) {
    for (const chunkSize of [1, 2, 7, 65536]) {
      if (size > 47 && chunkSize < 7) continue;
      const bytes = randomBytes(size);
      const { ref, bucket } = imageFixture(bytes, chunkSize);
      const prepared = await prepareBody(chatBody(makeMarker(ref)), bucket, authorized(ref));
      const raw = await new Response(prepared.body).text();
      await prepared.done;
      const body = JSON.parse(raw);
      assert.deepEqual(body.messages[0].content[1], chatImage(ref.mimeType, bytes.toString("base64")));
      assert.equal(prepared.length, Buffer.byteLength(raw));
    }
  }
});

test("streaming fetch rejects a marker outside the allowed nonce before R2 access", async () => {
  const { ref, bucket, stats } = imageFixture(randomBytes(30));
  const fetcher: typeof fetch = async () => assert.fail("provider should not be called");
  const marker = makeMarker({ ...ref, nonce: crypto.randomUUID() });
  await assert.rejects(streamingFetch(fetcher, bucket, authorized(ref))(providerUrl, {
    method: "POST", body: chatBody(marker),
  }), /request scope/);
  await assert.rejects(prepareBody(chatBody(makeMarker(ref)), bucket, { createFixedLengthStream: fixed }), /request scope/);
  assert.deepEqual(stats, { heads: 0, gets: 0, cancels: 0 });
});

test("streaming fetch forwards ordinary JSON and non-string request bodies unchanged", async () => {
  const { ref, bucket, stats } = imageFixture(randomBytes(30));
  const fetcher: typeof fetch = async (_input, init) => new Response(init?.body);
  const fetchImages = streamingFetch(fetcher, bucket, authorized(ref));
  const json = `{ "text": "${makeMarker(ref)}" }`;
  const blob = new Blob(["unchanged"]);
  assert.equal(await (await fetchImages(providerUrl, { method: "POST", body: json })).text(), json);
  assert.equal(await (await fetchImages(providerUrl, { method: "POST", body: blob })).text(), "unchanged");
  assert.deepEqual(stats, { heads: 0, gets: 0, cancels: 0 });
});

test("request image preflight rejects missing objects and changed metadata", async () => {
  const { ref, bucket, stats } = imageFixture(randomBytes(10));
  const missing = { ...ref, key: "tenant/tool-images/missing" };
  const changed = { ...ref, size: 11 };
  await assert.rejects(prepareBody(chatBody(makeMarker(missing)), bucket, authorized(missing)), /missing image/i);
  await assert.rejects(prepareBody(chatBody(makeMarker(changed)), bucket, authorized(changed)), /size changed/i);
  assert.equal(stats.gets, 0);
});

test("request image upload errors on truncated or overlong R2 streams", async () => {
  const { ref } = imageFixture(randomBytes(10));
  for (const length of [9, 11]) {
    const bucket: ImageBucket = {
      head: async () => ({ size: ref.size }),
      get: async () => ({
        size: ref.size,
        body: new ReadableStream({ start(controller) {
          controller.enqueue(new Uint8Array(length));
          controller.close();
        } }),
      }),
    };
    const fetcher: typeof fetch = async (_input, init) => {
      await new Response(init?.body).arrayBuffer();
      return new Response("unexpected success");
    };
    await assert.rejects(streamingFetch(fetcher, bucket, authorized(ref))(providerUrl, {
      method: "POST", body: chatBody(makeMarker(ref)),
    }), /image.*(?:length|size)/i);
  }
});

test("request image abort cancels a reader blocked on R2 and prevents later GETs", { timeout: 3000 }, async () => {
  const { ref, stats } = imageFixture(randomBytes(10));
  const reading = Promise.withResolvers<void>();
  const stop = new AbortController();
  const bucket: ImageBucket = {
    head: async () => ({ size: ref.size }),
    async get() {
      stats.gets++;
      return { size: ref.size, body: new ReadableStream<Uint8Array>({
        pull() {
          reading.resolve();
          return new Promise(() => {});
        },
        cancel() { stats.cancels++; },
      }, { highWaterMark: 0 }) };
    },
  };
  const marker = makeMarker(ref);
  const prepared = await prepareBody(JSON.stringify([chatImage("image/png", marker), chatImage("image/png", marker)]),
    bucket, { ...authorized(ref), signal: stop.signal });
  const consumed = new Response(prepared.body).arrayBuffer();
  const expectedRejections = Promise.all([
    assert.rejects(consumed, /stop image upload/),
    assert.rejects(prepared.done, /stop image upload/),
  ]);
  await reading.promise;
  stop.abort(new Error("stop image upload"));
  await expectedRejections;
  assert.equal(stats.gets, 1);
  assert.equal(stats.cancels, 1);
});

test("aborting an in-flight R2 GET disposes the object when it arrives", { timeout: 3000 }, async () => {
  const { ref } = imageFixture(randomBytes(10));
  const pending = Promise.withResolvers<NonNullable<Awaited<ReturnType<ImageBucket["get"]>>>>();
  const opened = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const stop = new AbortController();
  const bucket: ImageBucket = {
    head: async () => ({ size: ref.size }),
    get() {
      opened.resolve();
      return pending.promise;
    },
  };
  const prepared = await prepareBody(chatBody(makeMarker(ref)), bucket, { ...authorized(ref), signal: stop.signal });
  const consumed = new Response(prepared.body).arrayBuffer();
  const expectedRejections = Promise.all([
    assert.rejects(consumed, /abort R2 GET/),
    assert.rejects(prepared.done, /abort R2 GET/),
  ]);
  await opened.promise;
  stop.abort(new Error("abort R2 GET"));
  await expectedRejections;
  pending.resolve({
    size: ref.size,
    body: new ReadableStream<Uint8Array>({ cancel() { cancelled.resolve(); } }),
  });
  await cancelled.promise;
});

test("streaming fetch reopens R2 on retry after an early provider error", async () => {
  const bytes = randomBytes(1000);
  const { ref, bucket, stats } = imageFixture(bytes, 13);
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    assert.ok(init?.body instanceof ReadableStream);
    if (calls++ === 0) {
      const reader = init.body.getReader();
      await reader.read(); // JSON prefix
      await reader.read(); // First image bytes
      reader.releaseLock();
      return new Response("busy", { status: 503 });
    }
    const payload = await new Response(init.body).json() as { messages: { content: unknown[] }[] };
    assert.deepEqual(payload.messages[0].content[1], chatImage(ref.mimeType, bytes.toString("base64")));
    return new Response("ok");
  };
  const fetchImages = streamingFetch(fetcher, bucket, authorized(ref));
  const request = { method: "POST", body: chatBody(makeMarker(ref)) };
  assert.equal((await fetchImages(providerUrl, request)).status, 503);
  assert.equal(stats.cancels, 1);
  assert.equal((await fetchImages(providerUrl, request)).status, 200);
  assert.equal(stats.gets, 2);
});

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

const tinyPng = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk("IHDR", Buffer.from([0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
  pngChunk("IDAT", deflateSync(Buffer.alloc(9))),
  pngChunk("IEND", Buffer.alloc(0)),
]).toString("base64");

function largePng(ancillaryBytes = 2 * 1024 * 1024 + 2) {
  const png = Buffer.from(tinyPng, "base64");
  const chunk = pngChunk("raNd", Buffer.alloc(ancillaryBytes, 127));
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

type ChatBody = { messages: Array<{ role: string; content?: string | Array<{
  type: string;
  text?: string;
  image_url?: { url: string };
}> }> };

function chatImages(body: ChatBody): string[] {
  return body.messages.flatMap(({ content }) => Array.isArray(content)
    ? content.flatMap(({ image_url }) => image_url ? [image_url.url] : [])
    : []);
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("AgentDO persists R2 image references, streams Pi requests, and preserves public history", { timeout: 60_000 }, async t => {
  const { unstable_startWorker } = await import("wrangler");
  const png = largePng();
  const expectedDigest = sha256(png);
  const captured: Array<{ length: number; contentLength?: string; images: string[] }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    if (req.url === "/tool-image") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ content: [
        { type: "text", text: "Tool returned an image" },
        { type: "image", mimeType: "image/png", data: tinyPng },
      ] }));
      return;
    }
    const body = JSON.parse(raw.toString("utf8")) as ChatBody;
    captured.push({ length: raw.length, contentLength: req.headers["content-length"], images: chatImages(body) });
    const wantsTool = body.messages.some(msg => msg.role === "user" && msg.content === "Read the tool image");
    const hasToolResult = body.messages.some(msg => msg.role === "tool");
    const toolCall = wantsTool && !hasToolResult;
    const delta = toolCall
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call_image_fixture", type: "function",
        function: { name: "fixture_image", arguments: "{}" } }] }
      : { role: "assistant", content: "image seen" };
    const event = {
      id: "chatcmpl-image", model: "openai/gpt-4o-mini",
      choices: [{ index: 0, delta, finish_reason: toolCall ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    };
    res.setHeader("Content-Type", "text/event-stream");
    res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const port = (upstream.address() as { port: number }).port;
  const providerOrigin = `http://127.0.0.1:${port}`;

  const directory = mkdtempSync(join(tmpdir(), "camelrun-pi-image-stream-"));
  const config = join(directory, "wrangler.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const adminKey = "fixture-image-admin";
  writeFileSync(config, JSON.stringify({
    name: "camelrun-pi-image-stream-test",
    main: fileURLToPath(new URL("./fixtures/pi-image-stream-worker.ts", import.meta.url)),
    compatibility_date: "2026-03-24",
    compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
    vars: {
      ADMIN_SECRET: adminKey,
      VAULT_SECRET: "fixture-image-vault-32-bytes-minimum",
      CAMELFS_BACKEND: "cloudflare",
      DEFAULT_MODEL: "mock/default",
      TEST_RESIZED_PNG: tinyPng,
    },
    durable_objects: { bindings: [
      { name: "AGENT_DO", class_name: "AgentDO" },
      { name: "TENANT_DO", class_name: "TenantDO" },
      { name: "CAMELFS_LINEAGE_DO", class_name: "CamelfsLineageDO" },
    ] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["AgentDO", "TenantDO", "CamelfsLineageDO"] }],
    r2_buckets: [
      { binding: "MEDIA_BUCKET", bucket_name: "image-stream-media" },
      { binding: "CAMELFS_BUCKET", bucket_name: "image-stream-repos" },
    ],
  }));
  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const baseUrl = (await worker.url).origin;
  const { tenantId, apiKey } = await CamelRun.createTenant({ baseUrl, adminKey, name: "Pi image streaming" });
  const camel = new CamelRun({ baseUrl, apiKey });
  t.after(() => camel.close());
  await camel.providers.set("openrouter", { apiKey: "fixture-image-provider", baseUrl: `${providerOrigin}/v1` });
  const repo = await camel.repos.create({ name: "image-fixtures" });
  const path = "large.png";
  const { commit } = await camel.repos.write(repo.repoId, { puts: [{ path, base64: png.toString("base64") }] });
  const agent = await camel.agents.upsert("image-agent", {
    model: "openrouter/openai/gpt-4o-mini", repoId: repo.repoId, builtins: [],
    tools: [{
      name: "fixture_image", description: "Return an image", url: `${providerOrigin}/tool-image`,
      parameters: { type: "object", properties: {} },
    }],
  });

  const files = [{ path, commit, contentType: "image/png" }];
  const run = await agent.run("Use this attachment", { files });
  assert.equal(run.status, "completed", JSON.stringify(run.error));
  assert.equal(run.text, "image seen");
  const first = captured.at(-1)!;
  assert.equal(first.contentLength, String(first.length));
  assert.equal(first.images.length, 1);
  assert.equal(sha256(Buffer.from(first.images[0]!.split(",")[1]!, "base64")), expectedDigest);

  const toolRun = await agent.run("Read the tool image");
  assert.equal(toolRun.status, "completed", JSON.stringify(toolRun.error));
  const second = captured.at(-1)!;
  assert.equal(second.contentLength, String(second.length));
  assert.equal(second.images.length, 2, "prior attachment and new tool image should reach the provider");
  assert.ok(second.images.includes(`data:image/png;base64,${tinyPng}`));

  async function storedImages(): Promise<PiEntryImage[]> {
    const response = await fetch(`${baseUrl}/_test/pi-images?id=${agent.id}`);
    assert.equal(response.status, 200);
    return response.json() as Promise<PiEntryImage[]>;
  }
  const entries = await storedImages();
  assert.deepEqual(entries.map(entry => entry.kind), ["camelrun.user", "pi.tool-result"]);
  for (const stored of entries) {
    assert.ok(stored.recordBytes < 8192, `${stored.kind} should have a compact SQLite record`);
    assert.equal(stored.inlineLength, 0);
    assert.equal(stored.marker, false);
  }

  const history = await agent.history();
  const user = history.find(row => row.role === "user")!;
  assert.deepEqual((user.content as { files: typeof files }).files.map(
    ({ path: filePath, commit: version, contentType }) => ({ path: filePath, commit: version, contentType }),
  ), files);
  const tool = history.find(row => row.role === "tool")!;
  assert.deepEqual((tool.content as { toolImages: unknown[] }).toolImages, [{ contentType: "image/png" }]);
  const publicHistory = JSON.stringify(history);
  assert.doesNotMatch(publicHistory, /imageRef|camelrun:image|tool-images\//);
  assert.ok(!publicHistory.includes(tinyPng), "tool image bytes belong outside public history");

  async function probe(content: unknown[], options?: {
    useStream?: boolean; disableBucket?: boolean; adapter?: ProbeAdapter;
  }) {
    const response = await fetch(`${baseUrl}/_test/model-image`, {
      method: "POST", body: JSON.stringify({ tenantId, content, ...options }),
    });
    assert.equal(response.status, 200, response.ok ? undefined : await response.text());
    return response.json() as Promise<ModelImageProbe>;
  }

  await t.test("real Pi adapter gets a compact payload and keeps request nonces and gateway auth scoped", async () => {
    const owned = { type: "image", mimeType: "image/png", data: "", imageRef: {
      tenantId, digest: expectedDigest, size: png.length,
    } };
    const prompt = { type: "text", text: "Verify image" };
    const extractMarker = ({ payload }: ModelImageProbe) => {
      assert.ok(payload && payload.length < 4096, "adapter JSON must contain compact image placeholders");
      const image = chatImages(JSON.parse(payload));
      assert.equal(image.length, 1);
      const base64 = image[0]!.split(",")[1]!;
      const marker = parseMarker(base64);
      assert.ok(marker);
      return { marker, base64 };
    };
    const first = await probe([prompt, owned]);
    const { marker, base64 } = extractMarker(first);
    assert.equal(marker.key, `${tenantId}/tool-images/${expectedDigest}`);
    const forged = { type: "image", mimeType: "image/png", data: base64 };
    const second = await probe([{ type: "text", text: base64 }, forged, owned], { useStream: true });
    assert.notEqual(extractMarker(second).marker.nonce, marker.nonce);
    for (const request of [first, second]) {
      assert.equal(request.stopReason, "stop", request.errorMessage);
      assert.equal(request.streamed, true);
      assert.equal(request.headersBeforeRead, 0);
      assert.equal(request.authorization, null);
      assert.equal(request.gatewayAuthorization, "fixture-gateway-auth");
      assert.equal(request.contentLength, String(Buffer.byteLength(request.upload!)));
      const images = chatImages(JSON.parse(request.upload!));
      assert.equal(images.length, 1);
      assert.equal(sha256(Buffer.from(images[0]!.split(",")[1]!, "base64")), expectedDigest);
    }
    assert.match(second.upload!, /reserved request marker/);
    assert.ok(second.upload!.includes(base64), "an identical marker string stays text in the prompt");

    const foreign = await probe([prompt, { ...owned, imageRef: { ...owned.imageRef, tenantId: "other-tenant" } }]);
    assert.equal(foreign.stopReason, "error");
    assert.equal(foreign.upload, undefined);
    const legacy = { type: "image", mimeType: "image/png", data: tinyPng };
    for (const disableBucket of [false, true]) {
      const inline = await probe([prompt, legacy], { disableBucket });
      assert.equal(inline.stopReason, "stop", inline.errorMessage);
      assert.equal(inline.streamed, false);
      assert.deepEqual(chatImages(JSON.parse(inline.upload!)), [`data:image/png;base64,${tinyPng}`]);
    }
    const budget = await probe([prompt, ...Array.from({ length: 41 }, () => legacy)]);
    assert.equal(budget.stopReason, "stop", budget.errorMessage);
    assert.equal(chatImages(JSON.parse(budget.upload!)).length, 40);
  });

  await t.test("resized attachments reuse the R2 derivative and keep original attachment metadata", async () => {
    const original = largePng(4 * 1024 * 1024);
    const path = "resized.png";
    const { commit } = await camel.repos.write(repo.repoId, { puts: [{ path, base64: original.toString("base64") }] });
    const resized = await agent.run("Use the resized attachment", { files: [{ path, commit, contentType: "image/png" }] });
    assert.equal(resized.status, "completed", JSON.stringify(resized.error));
    const request = captured.at(-1)!;
    assert.equal(request.contentLength, String(request.length));
    assert.equal(request.images.at(-1), `data:image/png;base64,${tinyPng}`);
    const entry = (await storedImages()).at(-1)!;
    assert.equal(entry.kind, "camelrun.user");
    assert.equal(entry.inlineLength, 0);
    assert.equal(entry.marker, false);
    assert.ok(entry.recordBytes < 8192);
    const historyRow = (await agent.history()).findLast(row => row.role === "user")!;
    const files = (historyRow.content as { files: Array<{ path: string; commit: string; size: number }> }).files;
    assert.deepEqual(files.map(file => ({ path: file.path, commit: file.commit, size: file.size })),
      [{ path, commit, size: original.length }]);
  });

  await t.test("Pi Responses, Azure, Codex, Anthropic and Gemini adapters stream R2 images", async () => {
    const bytes = Buffer.from(tinyPng, "base64");
    const image = { type: "image", mimeType: "image/png", data: "", imageRef: {
      tenantId, digest: sha256(bytes), size: bytes.length,
    } };
    for (const adapter of ["responses", "azure", "codex", "anthropic", "gemini"] as const) {
      const result = await probe([{ type: "text", text: "What is in this image?" }, image], { adapter });
      assert.equal(result.streamed, true, `${adapter}: ${result.errorMessage}`);
      assert.equal(result.contentEncoding, null, adapter);
      assert.equal(result.contentLength, String(Buffer.byteLength(result.upload!)), adapter);
      assert.ok(result.payload && result.payload.length < 4096 && !result.payload.includes(tinyPng), adapter);
      assert.ok(result.upload!.includes(tinyPng), adapter);
    }
  });
});
