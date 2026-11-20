import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { legacyBotsImageAuthorization, legacyBotsImageGeneration } from "../src/legacy-bots-image-request.ts";

const authorization = "Bearer synthetic-camel-bots-operator";
const expected = createHash("sha256").update(authorization).digest("hex");
const bot = "b0123456789abcdef0";
const body = { prompt: "Draw a small camel", context: { bot }, subject: "1234567890", bucket: `bot:${bot}` };
function request(value: unknown, url = "https://run.camelai.com/v1/images", auth = authorization) {
  return new Request(url, { method: "POST", headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(value) });
}

test("the existing Camel Bots credential selects only the two image endpoints", async () => {
  for (const host of ["run.camelai.com", "agents.camelai.dev"]) {
    const original = request(body, `https://${host}/v1/images`);
    assert.equal(legacyBotsImageAuthorization(original, expected), authorization);
    assert.equal(await legacyBotsImageGeneration(original), true);
    assert.deepEqual(await original.json(), body);
  }
  for (const url of ["https://other.invalid/v1/images", "http://run.camelai.com/v1/images",
    "https://run.camelai.com/v1/transcriptions", "https://run.camelai.com/v1/images?x=1"]) {
    assert.equal(legacyBotsImageAuthorization(request(body, url), expected), undefined);
  }
  assert.equal(legacyBotsImageAuthorization(request(body), undefined), undefined);
  assert.equal(legacyBotsImageAuthorization(request(body, undefined, "Bearer a-different-token"), expected), undefined);
});

test("supported SDK generation keeps the bot, preview, or scoped heal payer", async () => {
  assert.equal(await legacyBotsImageGeneration(request({ ...body, size: "1536x1024", quality: "high" })), true);
  assert.equal(await legacyBotsImageGeneration(request({ ...body, bucket: "builder" })), true);
  assert.equal(await legacyBotsImageGeneration(request({ prompt: body.prompt, context: body.context })), true);
});

test("unsupported edits, storage, extra payers and oversized bodies remain untouched", async () => {
  for (const extra of [{ images: [{ url: "https://fixture.invalid/image" }] }, { mask: {} }, { volumeId: "original" },
    { repo: "original" }, { keyScope: "custom" }, { n: 2 }, { bucket: "bot:another" }, { subject: "" },
    { quality: "auto" }, { context: { bot, another: true } }, { prompt: "x".repeat(300_000) }]) {
    const unsupported = { ...body, ...extra };
    const original = request(unsupported);
    assert.equal(await legacyBotsImageGeneration(original), false);
    assert.deepEqual(await original.json(), unsupported);
  }
});
