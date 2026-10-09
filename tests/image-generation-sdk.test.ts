import { test } from "node:test";
import assert from "node:assert/strict";
import { Agents } from "../clients/node.ts";
import { OPS, PAYG, PHOTO, png, start } from "./image-generation-fixture.ts";

test("the TypeScript SDK: images.generate and images.edit from bytes, a Blob or a URL, answered as base64 or saved to a volume", async t => {
  const { r, openai } = await start(t);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const agents = new Agents({ url: r.base, apiKey: PAYG });
  t.after(() => agents.close());

  const made = await agents.images.generate("a camel at dawn", { size: "1536x1024", quality: "low", context: { org: "o1" } });
  assert.deepEqual(made, { images: [{ contentType: "image/png", width: 1536, height: 1024, data: png(1536, 1024).toString("base64") }], model: "openai/gpt-image-2.5-flare", usage: { inputTokens: 10, outputTokens: 1000 }, costUsd: 0.1 });
  assert.deepEqual([openai.requests.at(-1)!.path, openai.requests.at(-1)!.fields.quality], ["/images/generations", "low"]);

  const edited = await agents.images.edit("make it blue", [new Uint8Array(PHOTO), new Blob([PHOTO], { type: "image/png" }), { url: `${openai.base}/photo.png` }], { mask: new Uint8Array(PHOTO) });
  assert.equal(edited.costUsd, 0.13);
  assert.deepEqual([openai.requests.at(-1)!.path, openai.requests.at(-1)!.images.length, openai.requests.at(-1)!.mask], ["/images/edits", 3, "image/png"]);
  assert.throws(() => agents.images.edit("x", []), /images to edit/);
  await assert.rejects(agents.images.generate("x", { quality: "max" as never }), (error: any) => error.status === 400);

  const volume = await agents.runtime.createVolume();
  const saved = await agents.images.generate("two camels", { n: 2, volumeId: volume.id, path: "/art" });
  assert.deepEqual(saved.images.map(image => [image.volumeId, image.path?.startsWith("/art/image-"), image.data]), [[volume.id, true, undefined], [volume.id, true, undefined]]);
  assert.equal(agents.runtime.images, agents.images);
});
