import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import sharp from "sharp";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor } from "../src/supervisor.ts";
import { FILE_LIMITS } from "../src/limits.ts";
import { IMAGE_PAST_BUDGET } from "../src/files.ts";
import { supervisorMessages } from "./fixtures/journal-messages.ts";

/** A PNG of noise, which no encoder can make small: about 2.4 MB, within what a request carries unscaled. */
const noise = () => sharp(randomBytes(1000 * 800 * 3), { raw: { width: 1000, height: 800, channels: 3 } }).png().toBuffer();

/** OpenRouter's limit on the image content of one request: past it, a 413 within milliseconds. */
const PROVIDER_IMAGE_BYTES = 30 * 1000 * 1000;

test("a history whose images exceed the request's image budget sends the newest within it, placeholders for the rest, and every turn succeeds", { timeout: 120_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "image-budget-"));
  const bodies: any[] = [];
  const images = (body: any): string[] => body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : [])
    .filter((part: any) => part.type === "image_url").map((part: any) => part.image_url.url.split(",")[1]);
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    if (images(body).reduce((sum, data) => sum + data.length, 0) > PROVIDER_IMAGE_BYTES) {
      response.writeHead(413, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Downloaded image content cannot exceed 30MB", code: 413 } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[{ role: "assistant", content: `seen ${bodies.length}` }, null], [{}, "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: `response-${bodies.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const model = {
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openrouter", reasoning: false,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1024,
  } as Model<Api>;
  const bridge = { definitions: [], call: async () => { throw new Error("No application tools"); } };
  const supervisor = new AgentSupervisor(root, { hosting: "inline" });
  t.after(async () => {
    await supervisor.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  await supervisor.start("bot", { model, apiKey: "fixture", codeMode: false }, bridge);

  // Five messages of two screenshots each: about 32 MB of base64 in all, past what the provider takes in one request.
  const sent: string[] = [];
  for (let turn = 1; turn <= 5; turn++) {
    const pair = await Promise.all([noise(), noise()]).then(buffers => buffers.map(buffer => buffer.toString("base64")));
    sent.push(...pair);
    const result = await supervisor.request("bot", "prompt", { requestId: `turn-${turn}`, message: { role: "user", content: [{ type: "text", text: `screens ${turn}` }, ...pair.map(data => ({ type: "image", data, mimeType: "image/png" }))], timestamp: turn } });
    assert.equal(result.error ?? null, null, `turn ${turn}`);
    assert.equal(result.reply, `seen ${turn}`);
  }
  assert.ok(sent.reduce((sum, data) => sum + data.length, 0) > PROVIDER_IMAGE_BYTES, "the history's images exceed the provider's limit");
  assert.equal(bodies.length, 5, "no request was refused and retried");

  // The last request: the newest images that fit the budget, in order, and a placeholder for each older one.
  const last = bodies.at(-1);
  const shown = images(last);
  const kept = Math.floor(FILE_LIMITS.requestImageBase64Bytes / sent[0].length);
  assert.ok(kept >= 2 && kept < sent.length, `${kept} images fit`);
  assert.deepEqual(shown, sent.slice(-shown.length), "the newest images, none skipped among them");
  assert.ok(shown.reduce((sum, data) => sum + data.length, 0) <= FILE_LIMITS.requestImageBase64Bytes);
  assert.ok(Math.abs(shown.length - kept) <= 1, `${shown.length} shown, about ${kept} expected`);
  const placeholders = JSON.stringify(last.messages).split(IMAGE_PAST_BUDGET).length - 1;
  assert.equal(placeholders, sent.length - shown.length);

  // The next turn succeeds, with the same images: the cached prefix holds.
  const next = await supervisor.request("bot", "prompt", { requestId: "turn-6", text: "And now?" });
  assert.equal(next.reply, "seen 6");
  assert.deepEqual(images(bodies.at(-1)), shown);

  // The stored history keeps every image as it was sent: only requests leave them out.
  const history = await supervisorMessages(supervisor, "bot") as any[];
  const stored = history.flatMap(message => Array.isArray(message.content) ? message.content : []).filter((part: any) => part.type === "image").map((part: any) => part.data);
  assert.deepEqual(stored, sent);
});
