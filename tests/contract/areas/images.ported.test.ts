import { portedTest } from '../ported.ts';
const test = portedTest("images", "tests/images.test.ts");

import assert from "node:assert/strict";

import { createHash } from "node:crypto";

import sharp from "sharp";

import { imageHeader, IMAGE_DAMAGED } from "../../../src/image-header.ts";

import { join } from "node:path";

import { OPERATOR, runtime, until } from "../support.ts";

async function picture(width: number, height: number, format: "png" | "jpeg" | "webp" | "gif" = "png") {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = ((i % (width * 3)) * 7 + Math.floor(i / (width * 3)) * 3) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } })[format]().toBuffer();
}

const sides = (data: Buffer) => { const header = imageHeader(data)!; return [header.width, header.height]; };

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("a thread with over 20 images, one of them 2,400 px, gets a request where every image is at most 1,568 px; the stored history is unchanged", async t => {
  const server = await runtime(t, () => ({ role: "assistant", content: "seen" }));
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  const big = await picture(2400, 1800);
  const fine = (await picture(400, 300)).toString("base64");
  // History as an earlier runtime stored it, before images were scaled down: 21 inline images, one too large for a request of many.
  const user = (text: string, images: string[]) => ({ role: "user", content: [{ type: "text", text }, ...images.map(data => ({ type: "image", data, mimeType: "image/png" }))], timestamp: 1 });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "openrouter", model: "openai/gpt-4o-mini", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  const corrupt = big.subarray(0, 24).toString("base64");
  const initialMessages = [
    user("screens", [...Array.from({ length: 19 }, () => fine), big.toString("base64")]), assistant("ok"),
    user("one more, and a broken one", [fine, corrupt]), assistant("ok"),
  ];
  const agent = (await server.call("/v1/agents", { body: { name: "many-images", initialMessages } })).json.id;
  // And a large screenshot in the workspace, attached as a file.
  const uploaded = await (await fetch(`${server.base}/v1/agents/${agent}/uploads/turn-1/shot.png`, { method: "PUT", body: big, headers: auth })).json();
  const sent = await server.call(`/v1/agents/${agent}/prompt`, { body: { text: "What changed?", requestId: "turn-1", files: [{ path: uploaded.path }] } });
  assert.equal(sent.status, 202, sent.text);
  await until(async () => (await server.call(`/v1/agents/${agent}/requests/turn-1`)).json.state === "completed", "the turn");

  const images = (body: any) => body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((part: any) => part.type === "image_url").map((part: any) => Buffer.from(part.image_url.url.split(",")[1], "base64"));
  const request = server.model.bodies.at(-1);
  const shown = images(request);
  assert.equal(shown.length, 22, "every image but the broken one is shown");
  for (const image of shown) assert.ok(Math.max(...sides(image)) <= 1568, `an image of ${sides(image).join("×")} px`);
  assert.equal(shown.filter((image: Buffer) => sides(image)[0] === 1568).length, 2, "the inline one and the attached file, scaled down");
  const texts = JSON.stringify(request.messages);
  assert.ok(texts.includes(`[image omitted: ${IMAGE_DAMAGED}]`), "the broken image is a placeholder");

  // The stored history is as it was: the request healed, not the transcript. The attached file is the original too.
  const history = (await server.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(history[0].content[20].data, big.toString("base64"));
  assert.equal(history[2].content[2].data, corrupt, "the damaged image remains in the journal");
  const volume = (await server.call(`/v1/agents/${agent}/mounts`)).json[0].volumeId;
  const download = Buffer.from(await (await fetch(`${server.base}/v1/volumes/${volume}/files/uploads/turn-1/shot.png`, { headers: auth })).arrayBuffer());
  assert.equal(sha(download), sha(big));

  // The next turn carries the same images, byte for byte: the cached prefix holds.
  await server.prompt(agent, "And now?");
  assert.deepEqual(images(server.model.bodies.at(-1)).map(sha), shown.map(sha));
});
