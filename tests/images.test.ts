import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { FILE_LIMITS } from "../src/limits.ts";
import { fitImage } from "../src/inspect.ts";
import { imageHeader } from "../src/image-header.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createAgentHost, type HostIO } from "../src/agent-host.ts";
import { Transcript, type TranscriptRecord } from "../src/transcript.ts";
import { fileAppendLog } from "../shared/append-log.ts";
import { OPERATOR, runtime, until } from "./runtime-server.ts";
import { fakeLauncher } from "./fake-launcher.ts";

/** A real image with some detail, so encoders cannot make it trivially small. */
async function picture(width: number, height: number, format: "png" | "jpeg" | "webp" | "gif" = "png") {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = ((i % (width * 3)) * 7 + Math.floor(i / (width * 3)) * 3) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } })[format]().toBuffer();
}

/** A PNG header that claims `width`×`height`, with an IDAT of zeros that inflates to that many pixels: a decompression bomb when large. */
function bombPng(width: number, height: number, rows = height) {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * rows))), chunk("IEND", Buffer.alloc(0))]);
}

const sides = (data: Buffer) => { const header = imageHeader(data)!; return [header.width, header.height]; };
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");

test("an image within the request limits passes through as it is; a larger one is scaled down, keeping its shape and format", async () => {
  const small = await picture(1200, 800);
  const kept = await fitImage(small);
  assert.ok("data" in kept && kept.data === small, "the same bytes, not a copy re-encoded");

  const screenshot = await fitImage(await picture(2400, 1800));
  assert.ok("data" in screenshot);
  assert.deepEqual([screenshot.mimeType, screenshot.width, screenshot.height], ["image/png", 1568, 1176]);
  assert.deepEqual(sides(screenshot.data), [1568, 1176]);

  const photo = await fitImage(await picture(3000, 6000, "jpeg"));
  assert.ok("data" in photo);
  assert.deepEqual([photo.mimeType, ...sides(photo.data)], ["image/jpeg", 784, 1568]);

  // A single huge image (within the 8,000 px a side any provider takes) is shown too, scaled down.
  const huge = await fitImage(await picture(7900, 5000, "jpeg"));
  assert.ok("data" in huge && Math.max(...sides(huge.data)) === 1568, JSON.stringify("omitted" in huge && huge));

  for (const format of ["webp", "gif"] as const) {
    const fitted = await fitImage(await picture(2000, 1000, format));
    assert.ok("data" in fitted, format);
    assert.deepEqual([fitted.mimeType, ...sides(fitted.data)], ["image/png", 1568, 784], format);
  }
});

test("scaling down is deterministic: the same bytes give the same output, so a provider's cached prefix holds across turns", async () => {
  const input = await picture(2400, 1800);
  const outputs = await Promise.all([fitImage(input), fitImage(input), fitImage(Buffer.from(input))]);
  const hashes = outputs.map(output => "data" in output ? sha(output.data) : output.omitted);
  assert.equal(new Set(hashes).size, 1, hashes.join(" "));
  const jpeg = await picture(2400, 1800, "jpeg");
  assert.equal(...(await Promise.all([fitImage(jpeg), fitImage(jpeg)])).map(output => "data" in output ? sha(output.data) : output.omitted) as [string, string]);
});

test("an image that cannot be scaled down is omitted with its size and why, never sent as it is", async () => {
  // Corrupt: a JPEG's header, then noise.
  const real = await picture(2400, 1800, "jpeg");
  const corrupt = Buffer.concat([real.subarray(0, 600), Buffer.alloc(20_000, 0x55)]);
  const broken = await fitImage(corrupt);
  assert.ok("omitted" in broken);
  assert.match(broken.omitted, /^2400×1800 px, could not be resized/);
  // A decompression bomb past the pixel cap is refused from its header, before decoding.
  const bomb = await fitImage(bombPng(20_000, 20_000, 1));
  assert.deepEqual(bomb, { omitted: "20000×20000 px, too many pixels to scale down" });
  // Not an image a model takes.
  assert.deepEqual(await fitImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")), { omitted: "not an image the model can view" });
  // Too many bytes to decode at all.
  assert.match(JSON.stringify(await fitImage(Buffer.concat([await picture(2400, 10), Buffer.alloc(FILE_LIMITS.inspectBytes)]))), /"omitted":"2400×10 px, larger than/);
});

test("a decompression bomb within the pixel cap decodes in a worker without stalling the thread that asked", async () => {
  // 8,000×8,000 grey pixels from a 63 KB file, and a large photo-like JPEG, scaled down while timers here keep running.
  const bomb = bombPng(8000, 8000);
  assert.ok(bomb.length < 100_000);
  const photo = await picture(7000, 5000, "jpeg");
  let longest = 0;
  let last = performance.now();
  const ticker = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 5);
  try {
    const [fromBomb, fromPhoto] = await Promise.all([fitImage(bomb), fitImage(photo)]);
    assert.ok("data" in fromBomb && Math.max(...sides(fromBomb.data)) === 1568, JSON.stringify("omitted" in fromBomb && fromBomb));
    assert.ok("data" in fromPhoto && Math.max(...sides(fromPhoto.data)) === 1568);
  } finally { clearInterval(ticker); }
  assert.ok(longest < 150, `the event loop stalled for ${Math.round(longest)} ms`);
});

test("a thread with over 20 images, one of them 2,400 px, gets a request where every image is at most 1,568 px; the stored history is unchanged", async t => {
  const server = await runtime(t, () => ({ role: "assistant", content: "seen" }));
  const auth = { Authorization: `Bearer ${OPERATOR}` };
  const big = await picture(2400, 1800);
  const fine = (await picture(400, 300)).toString("base64");
  // History as an earlier runtime stored it, before images were scaled down: 21 inline images, one too large for a request of many.
  const user = (text: string, images: string[]) => ({ role: "user", content: [{ type: "text", text }, ...images.map(data => ({ type: "image", data, mimeType: "image/png" }))], timestamp: 1 });
  const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "openrouter", model: "openai/gpt-4o-mini", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  const corrupt = Buffer.concat([big.subarray(0, 100), Buffer.alloc(1000, 1)]).toString("base64");
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
  assert.ok(texts.includes("[image omitted: 2400×1800 px, could not be resized"), "the broken image is a placeholder");

  // The stored history is as it was: the request healed, not the transcript. The attached file is the original too.
  const history = (await server.call(`/v1/agents/${agent}/history`)).json.messages;
  assert.equal(history[0].content[20].data, big.toString("base64"));
  const volume = (await server.call(`/v1/agents/${agent}/mounts`)).json[0].volumeId;
  const download = Buffer.from(await (await fetch(`${server.base}/v1/volumes/${volume}/files/uploads/turn-1/shot.png`, { headers: auth })).arrayBuffer());
  assert.equal(sha(download), sha(big));

  // The next turn carries the same images, byte for byte: the cached prefix holds.
  await server.prompt(agent, "And now?");
  assert.deepEqual(images(server.model.bodies.at(-1)).map(sha), shown.map(sha));
});

test("inline images enter the transcript scaled down: a user message's, and an MCP tool's result", async t => {
  const directory = await mkdtemp(join(tmpdir(), "agent-images-"));
  const faux = registerFauxProvider({ tokensPerSecond: 1_000_000 });
  t.after(async () => { faux.unregister(); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "transcript.jsonl");
  const screenshot = (await picture(2560, 1440)).toString("base64");
  const io: HostIO = {
    emit: () => {}, cancelTools: async () => null, runLimit: async () => undefined, transcript: fileAppendLog<TranscriptRecord>(path),
    tool: async () => ({ content: [{ type: "text", text: "the page" }, { type: "image", data: screenshot, mimeType: "image/png" }] }),
    file: async () => { throw new Error("no files"); }, modelAuth: async () => { throw new Error("no per-call credentials"); }, fs: async () => { throw new Error("no files"); },
  };
  const host = createAgentHost(io);
  t.after(() => host.dispose(0));
  await host.handle("init", { id: "agent", directory, model: faux.getModel(), apiKey: "fixture", tools: [{ name: "screenshot", description: "A browser screenshot", parameters: { type: "object" }, exposure: "direct", resultFormat: "content" }] });
  const sent: unknown[] = [];
  faux.setResponses([
    context => { sent.push(context.messages); return fauxAssistantMessage(fauxToolCall("screenshot", {}, { id: "call_1" }), { stopReason: "toolUse" }); },
    context => { sent.push(context.messages); return fauxAssistantMessage("Seen."); },
  ]);
  const photo = (await picture(4000, 3000, "jpeg")).toString("base64");
  const run = await host.handle("prompt", { message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: photo, mimeType: "image/jpeg" }], timestamp: 1 } });
  assert.equal(run.error, null);
  const transcript = new Transcript(fileAppendLog<TranscriptRecord>(path));
  await transcript.load();
  await transcript.log.close();
  const stored = transcript.context as AgentMessage[];
  const image = (message: AgentMessage) => ((message as { content: any[] }).content.find(part => part.type === "image"));
  const user = image(stored.find(message => message.role === "user")!);
  assert.deepEqual([user.mimeType, ...sides(Buffer.from(user.data, "base64"))], ["image/jpeg", 1568, 1176]);
  const result = image(stored.find(message => message.role === "toolResult")!);
  assert.deepEqual([result.mimeType, ...sides(Buffer.from(result.data, "base64"))], ["image/png", 1568, 882]);
  // And the model got them as stored.
  assert.ok(JSON.stringify(sent.at(-1)).includes(result.data));
});

test("an image whose scaling failed for now (its parse job crashed) is tried again on the next request, not held as omitted", async t => {
  // The launcher's parse jobs, but the first one asked to scale an image dies before answering, as a crash would.
  let dropped = 0;
  const launcher = await fakeLauncher(t, (kind, client) => {
    if (kind !== "parse") return false;
    client.resume();
    let head = Buffer.alloc(0);
    const first = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      if (head.length < 4 || head.length < 4 + head.readUInt32BE(0)) return;
      client.off("data", first);
      if (head.subarray(4, 4 + head.readUInt32BE(0)).toString().includes('"fit":true') && !dropped++) return void client.destroy();
      const job = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/parse-job.ts", import.meta.url))], { stdio: ["pipe", "pipe", "inherit"], env: {} });
      client.on("close", () => job.kill("SIGKILL"));
      job.stdin.on("error", () => {});
      job.stdin.write(head);
      client.pipe(job.stdin);
      job.stdout.pipe(client);
    };
    client.on("data", first);
    return true;
  });

  const server = await runtime(t, () => ({ role: "assistant", content: "seen" }), { AGENT_SANDBOX_DIR: launcher.dir });
  const agent = (await server.call("/v1/agents", { body: { name: "retry" } })).json.id;
  const uploaded = await (await fetch(`${server.base}/v1/agents/${agent}/uploads/turn-1/shot.png`, { method: "PUT", body: await picture(2400, 1800), headers: { Authorization: `Bearer ${OPERATOR}` } })).json();
  const sent = await server.call(`/v1/agents/${agent}/prompt`, { body: { text: "Look", requestId: "turn-1", files: [{ path: uploaded.path }] } });
  assert.equal(sent.status, 202, sent.text);
  await until(async () => (await server.call(`/v1/agents/${agent}/requests/turn-1`)).json.state === "completed", "the turn");
  const shown = () => server.model.bodies.at(-1).messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
  assert.equal(dropped, 1);
  assert.ok(shown().some((part: any) => /image omitted: 2400×1800 px, could not be resized/.test(part.text ?? "")), "the first request names it instead");
  await server.prompt(agent, "Again");
  const images = shown().filter((part: any) => part.type === "image_url").map((part: any) => sides(Buffer.from(part.image_url.url.split(",")[1], "base64")));
  assert.deepEqual(images, [[1568, 1176]], "the next request scales it");
});
