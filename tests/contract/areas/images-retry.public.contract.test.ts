import assert from "node:assert/strict";
import sharp from "sharp";
import { imageHeader } from "../../../src/image-header.ts";
import { portedTest } from "../ported.ts";
import { createContractFixture, OPERATOR, until } from "../support.ts";

async function picture(width: number, height: number, format: "png" | "jpeg" | "webp" | "gif" = "png") {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = ((i % (width * 3)) * 7 + Math.floor(i / (width * 3)) * 3) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } })[format]().toBuffer();
}

const sides = (data: Buffer) => { const header = imageHeader(data)!; return [header.width, header.height]; };

portedTest("images", "tests/images.test.ts:187")("an image whose scaling failed for now (its parse job crashed) is tried again on the next request, not held as omitted", async t => {
  // The launcher's parse jobs, but the first one asked to scale an image dies before answering, as a crash would.
  const server = await createContractFixture(t, { respond: () => ({ role: "assistant", content: "seen" }), failImageResizeOnce: true });
  const agent = (await server.call("/v1/agents", { body: { name: "retry" } })).json.id;
  const uploaded = await (await fetch(`${server.base}/v1/agents/${agent}/uploads/turn-1/shot.png`, { method: "PUT", body: await picture(2400, 1800), headers: { Authorization: `Bearer ${OPERATOR}` } })).json();
  const sent = await server.call(`/v1/agents/${agent}/prompt`, { body: { text: "Look", requestId: "turn-1", files: [{ path: uploaded.path }] } });
  assert.equal(sent.status, 202, sent.text);
  await until(async () => (await server.call(`/v1/agents/${agent}/requests/turn-1`)).json.state === "completed", "the turn");
  const shown = () => server.model.bodies.at(-1).messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
  const dropped = await server.imageResizeFailureCount();
  assert.equal(dropped, 1);
  assert.ok(shown().some((part: any) => /image omitted: 2400×1800 px, could not be resized/.test(part.text ?? "")), "the first request names it instead");
  await server.prompt(agent, "Again");
  const images = shown().filter((part: any) => part.type === "image_url").map((part: any) => sides(Buffer.from(part.image_url.url.split(",")[1], "base64")));
  assert.deepEqual(images, [[1568, 1176]], "the next request scales it");
});


