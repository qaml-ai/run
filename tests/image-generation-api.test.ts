import { test } from "node:test";
import assert from "node:assert/strict";
import { until } from "./runtime-server.ts";
import { CAPPED, OPS, OWN, PAYG, PHOTO, png, start } from "./image-generation-fixture.ts";

test("POST /v1/images makes images on the platform's OpenAI key for a prepaid tenant, edits images given as base64, multipart or a URL, and is billed per token", async t => {
  const { r, openai } = await start(t);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const endpoint = await r.call("/v1/webhooks", { body: { url: "https://hooks.example.test/usage", events: ["usage.recorded"] }, token: PAYG });
  assert.equal(endpoint.status, 201, endpoint.text);

  const made = await r.call("/v1/images", { body: { prompt: "a camel at dawn", subject: "user_1", context: { org: "o1" }, actor: "user_2" }, token: PAYG });
  assert.equal(made.status, 200, made.text);
  assert.deepEqual(made.json, {
    images: [{ contentType: "image/png", width: 1024, height: 1024, data: png(1024, 1024).toString("base64") }],
    model: "openai/gpt-image-2.5-flare", usage: { inputTokens: 10, outputTokens: 1000 }, costUsd: 0.1,
  });
  // Medium quality, a square PNG, one image: the defaults.
  assert.deepEqual(openai.requests.at(-1), {
    key: "Bearer platform-openai-key", path: "/images/generations", images: [],
    fields: { model: "gpt-image-2.5-flare", prompt: "a camel at dawn", size: "1024x1024", quality: "medium", output_format: "png", n: "1" },
  });

  // Two landscape WebP images with a transparent background.
  const two = await r.call("/v1/images", { body: { prompt: "a camel icon", n: 2, size: "1536x1024", quality: "low", format: "webp", background: "transparent" }, token: PAYG });
  assert.equal(two.status, 200, two.text);
  assert.deepEqual(two.json.images.map((image: any) => [image.width, image.height]), [[1536, 1024], [1536, 1024]]);
  assert.deepEqual(openai.requests.at(-1)!.fields, { model: "gpt-image-2.5-flare", prompt: "a camel icon", size: "1536x1024", quality: "low", output_format: "webp", n: "2", background: "transparent" });

  // An edit: images to change as base64 and by URL go to the edits endpoint, each a part.
  const edited = await r.call("/v1/images", { body: { prompt: "make it blue", images: [{ data: PHOTO.toString("base64") }, { url: `${openai.base}/photo.png` }] }, token: PAYG });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.costUsd, 0.12);
  assert.deepEqual(openai.requests.at(-1)!.images, [{ name: "image-1.png", type: "image/png", bytes: PHOTO.length }, { name: "image-2.png", type: "image/png", bytes: PHOTO.length }]);
  assert.equal(openai.requests.at(-1)!.path, "/images/edits");

  // Multipart, with a mask.
  const form = new FormData();
  form.set("prompt", "add a hat");
  form.set("quality", "high");
  form.append("image", new Blob([PHOTO], { type: "image/png" }), "photo.png");
  form.set("mask", new Blob([PHOTO], { type: "image/png" }), "mask.png");
  const multipart = await fetch(`${r.base}/v1/images`, { method: "POST", headers: { Authorization: `Bearer ${PAYG}` }, body: form });
  assert.equal(multipart.status, 200);
  assert.equal((await multipart.json()).costUsd, 0.11);
  assert.equal(openai.requests.at(-1)!.mask, "image/png");
  assert.equal(openai.requests.at(-1)!.fields.quality, "high");

  // Refused before anything is sent.
  const sent = openai.requests.length;
  const refused = async (body: object, status: number, code?: string) => {
    const response = await r.call("/v1/images", { body, token: PAYG });
    assert.equal(response.status, status, `${JSON.stringify(body).slice(0, 120)}: ${response.text}`);
    if (code) assert.equal(response.json.code, code);
  };
  await refused({ prompt: "" }, 400);
  await refused({ prompt: "x", quality: "max" }, 400);
  await refused({ prompt: "x", size: "512x512" }, 400);
  await refused({ prompt: "x", n: 5 }, 400);
  await refused({ prompt: "x", format: "jpeg", background: "transparent" }, 400);
  await refused({ prompt: "x", images: [{ data: Buffer.from("plain text, not an image").toString("base64") }] }, 415, "UNSUPPORTED_IMAGE");
  await refused({ prompt: "x", images: [{ data: png(9000, 100).toString("base64") }] }, 413, "IMAGE_TOO_LARGE");
  await refused({ prompt: "x", images: Array.from({ length: 5 }, () => ({ data: PHOTO.toString("base64") })) }, 400);
  await refused({ prompt: "x", mask: { data: PHOTO.toString("base64") } }, 400);
  await refused({ prompt: "x", images: [{ data: PHOTO.toString("base64") }], mask: { data: png(512, 512).toString("base64") } }, 400);
  await refused({ prompt: "x", images: [{ url: "http://10.0.0.1/a.png" }] }, 400);
  await refused({ prompt: "x", path: "/out" }, 400);
  await refused({ prompt: "x", volumeId: "vol_000000000000000000000000" }, 404);
  assert.equal(openai.requests.length, sent);

  // OpenAI's safety system refusing: IMAGE_REFUSED with the stage and categories, and nothing charged.
  const blocked = await r.call("/v1/images", { body: { prompt: "something forbidden" }, token: PAYG });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.code, "IMAGE_REFUSED");
  assert.match(blocked.json.error, /safety system refused this request \(violence\)/);
  assert.deepEqual([blocked.json.stage, blocked.json.categories], ["input", ["violence"]]);
  assert.ok(!blocked.json.error.includes("forbidden"), "never the prompt");

  // Five images in four requests: $0.10 each, and $0.02 and $0.01 for the images given. A usage row of their own, an event each.
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 1_000_000 - 530_000, "the images' charge");
  const usage = (await r.call("/v1/usage", { token: PAYG })).json.days;
  assert.deepEqual(usage.filter((day: any) => day.kind === "image").map((day: any) => [day.model, day.responses, Math.round(day.platformCost * 1e6)]), [["openai/gpt-image-2.5-flare", 5, 530_000]]);
  const ledger = (await r.call("/v1/billing/ledger", { token: PAYG })).json.entries.find((entry: any) => entry.kind === "usage");
  assert.deepEqual([ledger.metadata.image, ledger.metadata.images], [530_000, 5]);
  const { rows } = await r.db.query("select body from webhook_deliveries where tenant = 'payg' order by created_at");
  const events = rows.map(row => row.body.data).filter((data: any) => data.kind === "image");
  assert.equal(events.length, 4);
  assert.deepEqual(events.find((data: any) => data.subject === "user_1"), {
    agentId: null, requestId: null, subject: "user_1", actor: "user_2", context: { org: "o1" }, keyScope: null, provider: "openai", model: "gpt-image-2.5-flare", kind: "image",
    input: 10, output: 1000, cacheRead: 0, cacheWrite: 0, images: 1, cost: { usd: 0.1, source: "catalog" }, at: events.find((data: any) => data.subject === "user_1").at,
  });
  assert.deepEqual((await r.call("/v1/billing", { token: PAYG })).json.rates.image, { textInput: 0, imageInput: 10_000_000, output: 100_000_000 });
  // Nothing of the prompts is logged.
  assert.ok(r.logs.some(line => line.includes('"type":"images_generated"')));
  assert.ok(!r.logs.some(line => line.includes("a camel at dawn")), "no prompt in the logs");
});

test("POST /v1/images with volumeId saves the images to the volume and answers their paths", async t => {
  const { r } = await start(t);
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const volume = await r.call("/v1/volumes", { body: {}, token: PAYG });
  assert.equal(volume.status, 201, volume.text);
  const saved = await r.call("/v1/images", { body: { prompt: "two camels", n: 2, volumeId: volume.json.id, path: "/renders/camels" }, token: PAYG });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.images.length, 2);
  for (const image of saved.json.images) {
    assert.equal(image.volumeId, volume.json.id);
    assert.match(image.path, /^\/renders\/camels\/image-\d{8}T\d{6}-[0-9a-f]{6}-[12]\.png$/);
    assert.equal(image.data, undefined);
    const file = await fetch(`${r.base}/v1/volumes/${volume.json.id}/files${image.path}`, { headers: { Authorization: `Bearer ${PAYG}` } });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), png(1024, 1024));
  }
  // The default directory is /images.
  const one = await r.call("/v1/images", { body: { prompt: "a camel", volumeId: volume.json.id }, token: PAYG });
  assert.match(one.json.images[0].path, /^\/images\/image-\d{8}T\d{6}-[0-9a-f]{6}\.png$/);
  // Another tenant's volume is unknown.
  const other = await r.call("/v1/images", { body: { prompt: "a camel", volumeId: volume.json.id }, token: OPS });
  assert.equal(other.status, 404);
});

test("POST /v1/images needs an OpenAI key, and a monthly cap refuses it", async t => {
  const { r, openai } = await start(t);
  const alone = await r.call("/v1/images", { body: { prompt: "a camel" }, token: OWN });
  assert.equal(alone.status, 400);
  assert.equal(alone.json.code, "IMAGE_UNAVAILABLE");
  assert.match(alone.json.error, /PUT \/v1\/providers\/openai\/key/);
  const capped = await r.call("/v1/images", { body: { prompt: "a camel" }, token: CAPPED });
  assert.equal(capped.status, 402);
  assert.equal(openai.requests.length, 0);
});
