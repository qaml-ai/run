import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { FILE_LIMITS } from "../worker/src/lib/limits.ts";
import { loadConversationImages } from "../worker/src/run-files.ts";
import { normalizeSvgRasterInput, resolveRenderFiles } from "../worker/src/svg-render.ts";
import { storeToolImages, toolImageKey, type ToolImageRef } from "../worker/src/tool-images.ts";
import type { CamelFsClient } from "../worker/src/camelfs.ts";
import type { Env } from "../worker/src/types.ts";

const png = (width: number) => sharp({ create: { width, height: 1, channels: 3, background: "red" } }).png().toBuffer();
const imageBlock = (data: Buffer) => ({ type: "image", data: data.toString("base64"), mimeType: "image/png" });

test("image tools validate all blocks before writing and preserve ordinary results", async () => {
  const writes = new Map<string, Uint8Array>();
  const bucket = { put: async (key: string, data: Uint8Array) => { writes.set(key, data); } } as unknown as R2Bucket;
  const env = { MEDIA_BUCKET: bucket };
  const ordinary = { content: [{ type: "text", text: "hello" }], info: 1 };
  assert.equal((await storeToolImages(env, "tenant", ordinary)).result, ordinary);

  const image = imageBlock(await png(2));
  const damaged = { ...image, data: image.data.slice(0, -12) };
  await assert.rejects(storeToolImages(env, "tenant", { content: [image, damaged] }), /invalid or unsupported/);
  await assert.rejects(storeToolImages(env, "tenant", { content: Array(FILE_LIMITS.requestImages + 1).fill(image) }), /too many/);
  assert.equal(writes.size, 0);

  const saved = await storeToolImages(env, "tenant", { content: [image, image] });
  assert.equal(saved.result, "[image 2×1]\n[image 2×1]");
  assert.equal(saved.images?.length, 2);
  assert.equal(writes.size, 1);
  assert.ok([...writes.keys()][0]?.startsWith("tenant/tool-images/"));
});

test("large raster tool images are resized by the Images binding before storage", async () => {
  const oversized = imageBlock(await png(FILE_LIMITS.requestImageSide + 1));
  const fitted = await png(FILE_LIMITS.requestImageSide);
  const writes: Uint8Array[] = [];
  const bucket = { put: async (_: string, data: Uint8Array) => { writes.push(data); } } as unknown as R2Bucket;
  await assert.rejects(storeToolImages({ MEDIA_BUCKET: bucket }, "tenant", { content: [oversized] }), /resizing is unavailable/);
  const images = {
    input: () => ({
      transform: (options: ImageTransform) => {
        assert.deepEqual(options, { width: FILE_LIMITS.requestImageSide, height: FILE_LIMITS.requestImageSide, fit: "scale-down" });
        return { output: async () => ({ response: () => new Response(new Uint8Array(fitted)) }) };
      },
    }),
  } as unknown as ImagesBinding;
  const saved = await storeToolImages({ MEDIA_BUCKET: bucket, IMAGES: images }, "tenant", { content: [oversized] });
  assert.equal(saved.images?.[0]?.width, FILE_LIMITS.requestImageSide);
  assert.deepEqual(writes.map(data => Buffer.from(data)), [fitted]);
});

test("loadConversationImages gracefully skips missing or corrupted R2 tool images without throwing 502", async () => {
  const validBuf = await png(4);
  const validRef: ToolImageRef = {
    digest: "valid-digest",
    contentType: "image/png",
    size: validBuf.length,
    width: 4,
    height: 1,
  };
  const missingRef: ToolImageRef = {
    digest: "deleted-digest",
    contentType: "image/png",
    size: 123,
    width: 100,
    height: 50,
  };
  const wrongSizeRef: ToolImageRef = {
    digest: "wrong-size-digest",
    contentType: "image/png",
    size: 999,
    width: 10,
    height: 10,
  };

  const store = new Map<string, Buffer>([
    [toolImageKey("t1", validRef), validBuf],
    [toolImageKey("t1", wrongSizeRef), validBuf],
  ]);
  const bucket = {
    get: async (key: string) => {
      const data = store.get(key);
      if (!data) return null;
      return {
        size: data.length,
        arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      };
    },
  } as unknown as R2Bucket;

  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
  try {
    const loaded = await loadConversationImages(
      {} as CamelFsClient,
      [
        { toolImages: [validRef] },
        { toolImages: [missingRef, wrongSizeRef] },
      ],
      FILE_LIMITS.requestImages,
      { tenantId: "t1", bucket },
    );
    assert.equal(loaded.get(1), undefined, "missing/corrupt images on message 1 are skipped");
    assert.equal(loaded.get(0)?.length, 1, "older valid tool images still load cleanly");
    assert.equal(loaded.get(0)?.[0]?.base64, validBuf.toString("base64"));
    assert.equal(warnings.length, 2);
    assert.match(warnings[0]!, /tool_image_missing/);
  } finally {
    console.warn = origWarn;
  }
});

test("normalizeSvgRasterInput and resolveRenderFiles auto-convert WebP and GIF inputs to PNG via IMAGES binding", async () => {
  const webpBuf = await sharp({ create: { width: 8, height: 6, channels: 3, background: "blue" } }).webp().toBuffer();
  const gifBuf = await sharp({ create: { width: 6, height: 4, channels: 3, background: "green" } }).gif().toBuffer();
  const convertedPng = await sharp({ create: { width: 8, height: 6, channels: 3, background: "blue" } }).png().toBuffer();

  let conversions = 0;
  const mockImages = {
    input: () => ({
      output: async (opts: { format: string; anim?: boolean }) => {
        conversions++;
        assert.equal(opts.format, "image/png");
        assert.equal(opts.anim, false);
        return { response: () => new Response(new Uint8Array(convertedPng)) };
      },
    }),
  } as unknown as ImagesBinding;

  const normWebp = await normalizeSvgRasterInput({ IMAGES: mockImages }, webpBuf);
  assert.equal(normWebp.contentType, "image/png");
  assert.equal(normWebp.width, 8);
  assert.equal(normWebp.height, 6);

  const normGif = await normalizeSvgRasterInput({ IMAGES: mockImages }, gifBuf);
  assert.equal(normGif.contentType, "image/png");
  assert.equal(conversions, 2);

  // resolveRenderFiles converts both inline WebP and R2-stored GIF to PNG base64.
  const bucket = {
    get: async (key: string) => key === "images/img_gif1" ? {
      size: gifBuf.length,
      customMetadata: { tenantId: "t1" },
      arrayBuffer: async () => gifBuf.buffer.slice(gifBuf.byteOffset, gifBuf.byteOffset + gifBuf.byteLength),
    } : null,
  } as unknown as R2Bucket;
  const resolved = await resolveRenderFiles(
    { MEDIA_BUCKET: bucket, IMAGES: mockImages } as unknown as Env,
    "t1",
    {
      avatar: { data: webpBuf.toString("base64") },
      badge: "img_gif1",
    },
  );
  assert.equal(resolved?.avatar?.data, convertedPng.toString("base64"));
  assert.equal(resolved?.badge?.data, convertedPng.toString("base64"));
  assert.equal(conversions, 4);
});
