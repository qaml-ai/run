import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { normalizeSvgRasterInput, recordSvgRenderUsage, resolveRenderFiles } from "../worker/src/svg-render.ts";
import { toolImageContent, toolImageKey, type ToolImageRef } from "../worker/src/tool-images.ts";
import { ApiError, type Env } from "../worker/src/types.ts";

test("toolImageContent detects image blocks and toolImageKey scopes R2 paths by tenant", () => {
  const ordinary = { content: [{ type: "text", text: "hello" }], info: 1 };
  assert.equal(toolImageContent(ordinary), undefined);

  const image = { type: "image", data: "abc", mimeType: "image/png" };
  const mixed = { content: [{ type: "text", text: "ok" }, image] };
  assert.deepEqual(toolImageContent(mixed), mixed.content);

  const ref: ToolImageRef = {
    digest: "deadbeef",
    contentType: "image/png",
    size: 42,
    width: 2,
    height: 1,
  };
  assert.equal(toolImageKey("t1", ref), "t1/tool-images/deadbeef");
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

  // Damaged WebP/GIF that causes IMAGES binding to throw returns 422 invalid_image (not 500).
  const throwingImages = {
    input: () => ({
      output: async () => {
        throw new Error("ERROR 9404: unable to decode image");
      },
    }),
  } as unknown as ImagesBinding;
  await assert.rejects(
    () => normalizeSvgRasterInput({ IMAGES: throwingImages }, webpBuf),
    (err: unknown) => err instanceof ApiError && err.status === 422 && err.code === "invalid_image",
  );
});

test("recordSvgRenderUsage logs image:resvg with skipLedger=true and $0 cost", async () => {
  const calls: Array<Record<string, unknown>> = [];
  await recordSvgRenderUsage(
    {
      async settleUsage(input) {
        calls.push(input);
      },
    },
    42.7,
    "POST /v2/images/render",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "image:resvg");
  assert.equal(calls[0]!.costUsd, 0);
  assert.equal(calls[0]!.vmMs, 43);
  assert.equal(calls[0]!.skipLedger, true);
  assert.equal(calls[0]!.note, "POST /v2/images/render");
});
