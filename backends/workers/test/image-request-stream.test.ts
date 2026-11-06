import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { makeMarker, parseMarker, type ImageReference } from "../src/image-request-marker.ts";
import { prepareBody, streamingFetch, type ImageBucket } from "../src/image-request-stream.ts";

function fixture(bytes: Uint8Array, chunkSize = 7) {
  const ref: ImageReference = {
    key: "derivative/test.png", size: bytes.length, mimeType: "image/png",
    nonce: randomUUID(),
  };
  const stats = { gets: 0, heads: 0, cancels: 0 };
  const bucket: ImageBucket = {
    async head(key) { stats.heads++; return key === ref.key ? { size: bytes.length } : null; },
    async get(key) {
      stats.gets++;
      if (key !== ref.key) return null;
      let offset = 0;
      return { size: bytes.length, body: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) controller.close();
          else { controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += Math.min(chunkSize, bytes.length - offset); }
        },
        cancel() { stats.cancels++; },
      }, { highWaterMark: 0 }) };
    },
  };
  return { ref, bucket, stats };
}

function fixed(length: number) {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(bytes, controller) { seen += bytes.length; assert.ok(seen <= length); controller.enqueue(bytes); },
    flush() { assert.equal(seen, length); },
  });
}

const openai = (marker: string) => JSON.stringify({ messages: [{ role: "user", content: [
  { type: "text", text: "Accents: été. Emoji: 🐪" },
  { type: "image_url", image_url: { url: `data:image/png;base64,${marker}` } },
] }] });

test("marker is canonical base64 and invalid arbitrary strings are not references", () => {
  const { ref } = fixture(randomBytes(11));
  assert.deepEqual(parseMarker(makeMarker(ref)), ref);
  assert.equal(parseMarker(Buffer.from("ref:some-key").toString("base64")), null);
  assert.equal(parseMarker("not an image"), null);
  assert.deepEqual(parseMarker(makeMarker(ref).replace(/=+$/, "")), makeMarker(ref).endsWith("=") ? null : ref);
});

test("marker is a decodable 1x1 transparent PNG and rejects corrupted metadata", () => {
  const { ref } = fixture(randomBytes(3));
  const marker = makeMarker({ ...ref, key: "derivative/été-🐪.png" });
  const png = Buffer.from(marker, "base64");
  assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.readUInt32BE(16), 1);
  assert.equal(png.readUInt32BE(20), 1);
  let offset = 8;
  let idat = Buffer.alloc(0);
  while (offset < png.length) {
    const size = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") idat = Buffer.concat([idat, png.subarray(offset + 8, offset + 8 + size)]);
    offset += size + 12;
  }
  assert.deepEqual(inflateSync(idat), Buffer.alloc(5));
  assert.equal(parseMarker(marker)?.key, "derivative/été-🐪.png");
  png[png.length - 20] ^= 1;
  assert.equal(parseMarker(png.toString("base64")), null);
});

test("base64 carry and final padding survive every length and small R2 chunk boundary", async () => {
  for (const length of [0, 1, 2, 3, 4, 47, 49151, 49152, 49153, 131073]) {
    for (const chunkSize of [1, 2, 3, 7, 65536]) {
      const bytes = randomBytes(length);
      const { ref, bucket } = fixture(bytes, chunkSize);
      const prepared = await prepareBody(openai(makeMarker(ref)), bucket, { createFixedLengthStream: fixed });
      const body = await new Response(prepared.body).text();
      await prepared.done;
      assert.equal(Buffer.byteLength(body), prepared.length);
      const url = JSON.parse(body).messages[0].content[1].image_url.url;
      assert.deepEqual(Buffer.from(url.split(",")[1], "base64"), bytes);
    }
  }
});

test("provider image shapes expand while identical marker text stays untouched", async () => {
  const bytes = randomBytes(101);
  const { ref, bucket, stats } = fixture(bytes);
  const marker = makeMarker(ref);
  const input = JSON.stringify({ text: marker, content: [
    { type: "image", source: { type: "base64", media_type: "image/png", data: marker } },
    { type: "input_image", image_url: `data:image/png;base64,${marker}` },
    { inlineData: { mimeType: "image/png", data: marker } },
    { inline_data: { mime_type: "image/png", data: marker } },
    { image: { format: "png", source: { bytes: marker } } },
  ] });
  const prepared = await prepareBody(input, bucket, { createFixedLengthStream: fixed });
  const output = JSON.parse(await new Response(prepared.body).text());
  await prepared.done;
  assert.equal(output.text, marker);
  assert.equal(output.content[0].source.data, Buffer.from(bytes).toString("base64"));
  assert.equal(output.content[1].image_url, `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
  assert.equal(prepared.images, 5);
  assert.equal(stats.heads, 1);
  assert.equal(stats.gets, 5);
});

test("missing and changed objects fail before any body read; scope is checked first", async () => {
  const { ref, bucket, stats } = fixture(randomBytes(30));
  await assert.rejects(prepareBody(openai(makeMarker({ ...ref, key: "missing" })), bucket, { createFixedLengthStream: fixed }), /Missing image/);
  await assert.rejects(prepareBody(openai(makeMarker({ ...ref, size: 31 })), bucket, { createFixedLengthStream: fixed }), /size changed/);
  await assert.rejects(prepareBody(openai(makeMarker(ref)), bucket, { createFixedLengthStream: fixed, allowReference: () => false }), /outside request scope/);
  assert.equal(stats.gets, 0);
});

test("a marker for the same key with another nonce cannot reuse request authorization", async () => {
  const { ref, bucket, stats } = fixture(randomBytes(30));
  const allowed = new Set([JSON.stringify(ref)]);
  await assert.rejects(prepareBody(openai(makeMarker({ ...ref, nonce: randomUUID() })), bucket, {
    createFixedLengthStream: fixed, allowReference: candidate => allowed.has(JSON.stringify(candidate)),
  }), /outside request scope/);
  assert.deepEqual(stats, { gets: 0, heads: 0, cancels: 0 });
});

test("PNG markers restore JPEG and WebP MIME metadata in every supported JSON shape", async () => {
  for (const mimeType of ["image/jpeg", "image/webp"]) {
    const bytes = randomBytes(17);
    const { ref: original, bucket } = fixture(bytes);
    const marker = makeMarker({ ...original, mimeType });
    const body = JSON.stringify({ content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: marker } },
      { type: "image_url", image_url: { url: `data:image/png;base64,${marker}` } },
      { type: "input_image", image_url: `data:image/png;base64,${marker}` },
      { inlineData: { mimeType: "image/png", data: marker } },
      { inline_data: { mime_type: "image/png", data: marker } },
      { image: { format: "png", source: { bytes: marker } } },
    ] });
    const prepared = await prepareBody(body, bucket, { createFixedLengthStream: fixed });
    const output = JSON.parse(await new Response(prepared.body).text()).content;
    await prepared.done;
    assert.equal(output[0].source.media_type, mimeType);
    assert.ok(output[1].image_url.url.startsWith(`data:${mimeType};base64,`));
    assert.ok(output[2].image_url.startsWith(`data:${mimeType};base64,`));
    assert.equal(output[3].inlineData.mimeType, mimeType);
    assert.equal(output[4].inline_data.mime_type, mimeType);
    assert.equal(output[5].image.format, mimeType.slice(6));
  }
});

test("retry after mid-stream failure reopens R2 and never reuses a consumed request", async () => {
  const bytes = randomBytes(10000);
  const { ref, bucket, stats } = fixture(bytes, 29);
  let attempt = 0;
  const received: string[] = [];
  const fetcher: typeof fetch = async (_input, init) => {
    const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
    if (attempt++ === 0) {
      await reader.read(); // JSON prefix
      await reader.read(); // first image bytes
      await reader.cancel("simulated disconnect");
      throw new Error("simulated disconnect");
    }
    reader.releaseLock();
    received.push(await new Response(init!.body).text());
    assert.equal(Buffer.byteLength(received[0]), Number(new Headers(init!.headers).get("content-length")));
    return new Response("ok");
  };
  const wrapped = streamingFetch(fetcher, bucket, { createFixedLengthStream: fixed });
  await assert.rejects(wrapped("https://fake-provider.invalid", { body: openai(makeMarker(ref)), method: "POST" }), /simulated disconnect/);
  assert.equal(await (await wrapped("https://fake-provider.invalid", { body: openai(makeMarker(ref)), method: "POST" })).text(), "ok");
  assert.equal(stats.gets, 2);
  assert.deepEqual(Buffer.from(JSON.parse(received[0]).messages[0].content[1].image_url.url.split(",")[1], "base64"), bytes);
});

test("abort interrupts an active object stream and stops subsequent images", async () => {
  const { ref, bucket, stats } = fixture(randomBytes(10000), 10);
  const controller = new AbortController();
  const prepared = await prepareBody(openai(makeMarker(ref)), bucket, { createFixedLengthStream: fixed, signal: controller.signal });
  const reader = prepared.body.getReader();
  await reader.read();
  await reader.read();
  controller.abort(new Error("stop now"));
  await assert.rejects(async () => { while (!(await reader.read()).done) {} }, /stop now/);
  await assert.rejects(prepared.done, /stop now/);
  assert.equal(stats.cancels, 1);
});

test("early HTTP 503 stops upload and next attempt opens a fresh stream", async () => {
  const bytes = randomBytes(10000);
  const { ref, bucket, stats } = fixture(bytes, 13);
  let attempt = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    if (attempt++ === 0) {
      const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      await reader.read();
      // Server rejects while the body is active, without consuming the rest.
      reader.releaseLock();
      return new Response("busy", { status: 503 });
    }
    const payload = await new Response(init!.body).json() as { messages: {content: {image_url?: {url: string}}[]}[] };
    const base64 = payload.messages[0].content[1].image_url!.url.split(",")[1];
    assert.deepEqual(Buffer.from(base64, "base64"), bytes);
    return new Response("ok");
  };
  const wrapped = streamingFetch(fetcher, bucket, { createFixedLengthStream: fixed });
  assert.equal((await wrapped("https://fake-provider.invalid", { body: openai(makeMarker(ref)), method: "POST" })).status, 503);
  assert.equal(stats.cancels, 1);
  assert.equal((await wrapped("https://fake-provider.invalid", { body: openai(makeMarker(ref)), method: "POST" })).status, 200);
  assert.equal(stats.gets, 2);
});

test("an already signed AWS request is rejected rather than silently invalidated", async () => {
  const { ref, bucket, stats } = fixture(randomBytes(3));
  const wrapped = streamingFetch(fetch, bucket, { createFixedLengthStream: fixed });
  await assert.rejects(wrapped("https://bedrock.invalid", {
    headers: { authorization: "AWS4-HMAC-SHA256 Credential=test" }, body: openai(makeMarker(ref)),
  }), /before Bedrock SigV4/);
  assert.equal(stats.heads, 0);
});
