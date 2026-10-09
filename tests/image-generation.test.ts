import { test } from "node:test";
import assert from "node:assert/strict";
import { checkedImage, imageOptions, Imager, openaiImages, OUTPUT_TOKENS, type ImageProvider } from "../src/images.ts";
import { Outbound } from "../src/outbound.ts";
import { DEFAULT_PRICING, micros, pricingFromEnvironment } from "../src/pricing.ts";
import { usageEvent } from "../src/webhooks.ts";
import { listen } from "./runtime-server.ts";
import { png } from "./image-generation-fixture.ts";

test("image options default to one medium-quality square PNG, and take only the sizes, qualities and formats offered", () => {
  assert.deepEqual(imageOptions({}), { size: "1024x1024", quality: "medium", format: "png", count: 1 });
  assert.deepEqual(imageOptions({ size: "1024x1536", quality: "high", format: "webp", background: "transparent", n: "3" }), { size: "1024x1536", quality: "high", format: "webp", background: "transparent", count: 3 });
  for (const asked of [{ quality: "max" }, { quality: "auto" }, { quality: "xhigh" }, { size: "2048x2048" }, { size: "auto" }, { format: "gif" }, { n: 0 }, { n: 5 }, { n: 1.5 }, { background: "auto" }, { format: "jpeg", background: "transparent" }]) {
    assert.throws(() => imageOptions(asked), (error: any) => error.status === 400, JSON.stringify(asked));
  }
  assert.throws(() => imageOptions({ n: 2 }, 1), /n is a whole number from 1 to 1/);
});

test("an image to edit is PNG, JPEG or WebP within the limits, read from its header", () => {
  assert.deepEqual(checkedImage(png(800, 600)), { bytes: png(800, 600), contentType: "image/png", width: 800, height: 600 });
  assert.throws(() => checkedImage(Buffer.from("GIF89a\x01\x00\x01\x00", "latin1")), (error: any) => error.status === 415 && error.code === "UNSUPPORTED_IMAGE");
  assert.throws(() => checkedImage(Buffer.from("not an image")), (error: any) => error.status === 415);
  assert.throws(() => checkedImage(png(100, 8001)), (error: any) => error.status === 413 && error.code === "IMAGE_TOO_LARGE");
});

/** OpenAI's images endpoint answering `answer()` (status, body) to each request, recording the requests. */
async function fakeOpenAI(t: { after(fn: () => void): void }, answer: () => { status?: number; body: unknown }) {
  const requests: { path: string; key: string; type: string }[] = [];
  const base = await listen(t, async (req, res) => {
    for await (const _ of req);
    requests.push({ path: req.url!, key: String(req.headers.authorization), type: String(req.headers["content-type"]) });
    const { status = 200, body } = answer();
    res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  return { base, requests };
}

test("OpenAI's images API: generations, edits as multipart, the tokens it bills, and its errors as the runtime answers them", async t => {
  let answer: { status?: number; body: unknown } = { body: { data: [{ b64_json: png(1024, 1024).toString("base64") }], usage: { input_tokens: 1044, input_tokens_details: { text_tokens: 20, image_tokens: 1024 }, output_tokens: 196 } } };
  const openai = await fakeOpenAI(t, () => answer);
  const provider = openaiImages({ outbound: new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] }), baseUrl: openai.base });
  const signal = new AbortController().signal;
  const options = imageOptions({ quality: "low" });
  const made = await provider.generate({ prompt: "a camel", images: [], options }, { apiKey: "sk-test" }, signal);
  assert.deepEqual([made.images[0]!.contentType, made.tokens, made.model], ["image/png", { textInput: 20, imageInput: 1024, output: 196 }, "gpt-image-2.5-flare"]);
  assert.deepEqual(openai.requests.at(-1), { path: "/images/generations", key: "Bearer sk-test", type: "application/json" });
  await provider.generate({ prompt: "make it blue", images: [checkedImage(png(1024, 1024))], options }, { apiKey: "sk-test" }, signal);
  assert.equal(openai.requests.at(-1)!.path, "/images/edits");
  assert.match(openai.requests.at(-1)!.type, /^multipart\/form-data; boundary=/);

  // Without usage, the estimate for what was made.
  answer = { body: { data: [{ b64_json: png(1024, 1024).toString("base64") }] } };
  assert.deepEqual((await provider.generate({ prompt: "a camel", images: [], options }, { apiKey: "k" }, signal)).tokens, { textInput: 0, imageInput: 0, output: OUTPUT_TOKENS["1024x1024"].low });

  const fails = async (status: number, body: unknown, check: (error: any) => boolean) => {
    answer = { status, body };
    await assert.rejects(provider.generate({ prompt: "a camel", images: [], options }, { apiKey: "k" }, signal), check);
  };
  await fails(400, { error: { code: "moderation_blocked", message: "rejected", moderation_details: { moderation_stage: "output", categories: ["sexual"] } } },
    error => error.status === 400 && error.code === "IMAGE_REFUSED" && /refused the image it made \(sexual\)/.test(error.message) && error.details.stage === "output");
  await fails(400, { error: { message: "Invalid size" } }, error => error.status === 400 && /HTTP 400: Invalid size/.test(error.message));
  await fails(401, { error: { message: "bad key" } }, error => error.status === 502 && /rejected the API key/.test(error.message));
  await fails(500, {}, error => error.status === 502 && error.code === "IMAGE_FAILED");
  await fails(200, { data: [] }, error => error.status === 502 && /without an image/.test(error.message));
});

test("images are priced per token, refused when their estimate passes the budget, and need a key", async () => {
  const seen: { tenant: string; keyScope?: string }[] = [];
  const provider: ImageProvider = {
    id: "openai", model: "gpt-image-2.5-flare",
    generate: async ({ options }) => ({ images: Array.from({ length: options.count }, () => ({ bytes: png(1024, 1024), contentType: "image/png" })), tokens: { textInput: 13, imageInput: 0, output: 439 * options.count }, model: "gpt-image-2.5-flare" }),
  };
  const imager = new Imager({
    provider, price: () => DEFAULT_PRICING.image,
    key: async (tenant, keyScope) => { seen.push({ tenant, ...(keyScope ? { keyScope } : {}) }); return tenant === "nokey" ? undefined : { apiKey: "k", platform: tenant === "payg" }; },
  });
  const signal = new AbortController().signal;
  const request = { prompt: "a camel", images: [], options: imageOptions({ n: 2 }) };
  const done = await imager.generate({ tenant: "payg", keyScope: "org_1" }, request, signal);
  assert.deepEqual(done.usage, { provider: "openai", model: "gpt-image-2.5-flare", platform: true, kind: "image", images: 2, timestamp: done.usage.timestamp, usage: { input: 13, output: 878, cost: { total: done.usage.usage.cost.total } } });
  assert.ok(Math.abs(done.usage.usage.cost.total - (13 * 5 + 878 * 30) / 1e6) < 1e-12);
  assert.deepEqual(seen.at(-1), { tenant: "payg", keyScope: "org_1" });
  assert.equal((await imager.generate({ tenant: "own" }, request, signal)).usage.platform, false, "on the tenant's own key");
  // A medium square image is about $0.013, a high one $0.053; an image given to edit adds its tokens.
  assert.ok(Math.abs(imager.estimate("", 0, imageOptions({})) - 0.01317) < 1e-9);
  assert.ok(Math.abs(imager.estimate("", 0, imageOptions({ quality: "high" })) - 0.05268) < 1e-9);
  assert.ok(Math.abs(imager.estimate("", 1, imageOptions({ quality: "low" })) - (196 * 30 + 2048 * 8) / 1e6) < 1e-9);
  await assert.rejects(imager.generate({ tenant: "payg", budget: 0.01 }, request, signal), (error: any) => error.status === 402 && error.code === "SPEND_LIMIT");
  await assert.rejects(imager.generate({ tenant: "nokey" }, request, signal), (error: any) => error.status === 400 && error.code === "IMAGE_UNAVAILABLE" && /PUT \/v1\/providers\/openai\/key/.test(error.message));
});

test("the image price is the runtime's, per million tokens, set by the operator", () => {
  assert.deepEqual(DEFAULT_PRICING.image, { textInput: micros(5), imageInput: micros(8), output: micros(30) });
  assert.deepEqual(pricingFromEnvironment({ AGENT_PRICE_IMAGE_OUTPUT_USD: "40" }).image, { textInput: micros(5), imageInput: micros(8), output: micros(40) });
  assert.throws(() => pricingFromEnvironment({ AGENT_PRICE_IMAGE_INPUT_USD: "-1" }));
});

test("images' usage.recorded event says so: their count and tokens, and no agent when none made them", () => {
  const usage = { provider: "openai", model: "gpt-image-2.5-flare", usage: { input: 13, output: 439, cost: { total: 0.0132 } }, platform: true, kind: "image" as const, images: 1, timestamp: 1 };
  const alone = usageEvent("acme", "", { ...usage, identity: { subject: "user_1", context: { org: "o1" } }, actor: "user_2" })!;
  assert.deepEqual(alone.data, {
    agentId: null, requestId: null, subject: "user_1", actor: "user_2", context: { org: "o1" }, keyScope: null, provider: "openai", model: "gpt-image-2.5-flare", kind: "image",
    input: 13, output: 439, cacheRead: 0, cacheWrite: 0, images: 1, cost: { usd: 0.0132, source: "catalog" }, at: 1,
  });
  assert.equal(alone.legacy, undefined, "the older usage webhook carries model responses only");
});
