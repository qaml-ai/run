import { test } from "node:test";
import assert from "node:assert/strict";
import { imageHeader } from "../src/image-header.ts";
import { checkedImage, imageOptions, openaiImages, OUTPUT_TOKENS } from "../src/images.ts";
import { Outbound } from "../src/outbound.ts";

// One real low-quality image, then an edit of it: about $0.02. Runs only with OPENAI_API_KEY set.
const key = process.env.OPENAI_API_KEY;

test("OpenAI makes and edits an image with gpt-image-2.5-flare, billing the tokens the runtime estimates", { skip: !key && "OPENAI_API_KEY is not set" }, async () => {
  const provider = openaiImages({ outbound: new Outbound() });
  const signal = AbortSignal.timeout(180_000);
  const options = imageOptions({ quality: "low", format: "png" });
  const made = await provider.generate({ prompt: "A small flat icon of a camel", images: [], options }, { apiKey: key! }, signal);
  assert.equal(made.images.length, 1);
  assert.deepEqual(imageHeader(Buffer.from(made.images[0]!.bytes)), { mimeType: "image/png", width: 1024, height: 1024 });
  assert.equal(made.tokens.output, OUTPUT_TOKENS["1024x1024"].low, "the estimate is what OpenAI bills");
  assert.ok(made.tokens.textInput > 0 && made.tokens.imageInput === 0);
  const edited = await provider.generate({ prompt: "Make the camel blue", images: [checkedImage(made.images[0]!.bytes)], options }, { apiKey: key! }, signal);
  assert.equal(edited.images.length, 1);
  assert.equal(edited.tokens.imageInput, 1024, "a square image given is 1,024 tokens");
});
