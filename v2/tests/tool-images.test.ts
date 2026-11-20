import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { FILE_LIMITS } from "../../src/limits.ts";
import { storeToolImages } from "../worker/src/tool-images.ts";

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
