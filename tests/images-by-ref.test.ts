// Inline images kept by reference (AGENT_PI_IMAGE_REFS_TENANTS): written to the journal as files on the agent's volume, loaded
// into each request by `hydrate`, so Pi's context holds a few hundred bytes per image instead of megabytes of base64.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { once } from "node:events";
import sharp from "sharp";
import type { Api, Model } from "@earendil-works/pi-ai";
import { AgentSupervisor } from "../src/supervisor.ts";
import { FILE_LIMITS } from "../src/limits.ts";
import { IMAGE_PAST_BUDGET, type FileRef } from "../src/files.ts";
import { imageHeader, IMAGE_DAMAGED } from "../src/image-header.ts";
import { VolumeService } from "../src/volumes.ts";
import { saveImage, type ToolsContext } from "../src/client-sessions/tools.ts";
import type { Session } from "../src/client-sessions/state.ts";
import { postgresTail } from "../src/log-tail.ts";
import { memoryStorage } from "../shared/storage.ts";
import { testDatabase } from "./database.ts";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const WORKSPACE = [{ path: "/workspace", mode: "rw" as const, workspace: true }];
/** The line `hydrate` names a referenced image with, ahead of its bytes: the one difference a reference makes to a request. */
const DESCRIBED = /^\[File \/workspace\/attachments\/[0-9a-f]{64}\.(png|jpeg) \((image\/(png|jpeg)), [0-9.]+ [KM]B\)(: (.*))?\]$/;

/** A real image with some detail, so encoders cannot make it trivially small. */
async function picture(width: number, height: number, format: "png" | "jpeg" = "png") {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = ((i % (width * 3)) * 7 + Math.floor(i / (width * 3)) * 3 + width) & 0xff;
  return sharp(raw, { raw: { width, height, channels: 3 } })[format]().toBuffer();
}
/** A PNG of noise, which no encoder can make small: about 2.4 MB, within what a request carries unscaled. */
const noise = () => sharp(randomBytes(1000 * 800 * 3), { raw: { width: 1000, height: 800, channels: 3 } }).png().toBuffer();

/** An OpenAI-style provider recording each request body; `respond` answers one (a delta, or `{ status, message }` to refuse it). */
async function provider(t: TestContext, respond: (body: any, index: number) => any) {
  const bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    const answer = respond(body, bodies.length - 1);
    if (answer.status) { response.writeHead(answer.status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: answer.message, type: "invalid_request_error" } })); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [delta, finish_reason] of [[answer, null], [{}, answer.tool_calls ? "tool_calls" : "stop"]]) {
      response.write(`data: ${JSON.stringify({ id: `response-${bodies.length}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const model = {
    id: "fixture", name: "Fixture", api: "openai-completions", provider: "openrouter", reasoning: false,
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 1024,
  } as Model<Api>;
  return { bodies, model };
}

/**
 * A bridge whose files are a map, as the runtime's volumes would keep them: `saveImage` names each image by its content
 * under attachments/, as the runtime does (client-sessions/tools.ts `saveImage`), and `file` reads it back.
 */
function bridge(screenshot?: () => string, failSaves = false) {
  const files = new Map<string, string>();
  const saves: string[] = [];
  return {
    files, saves,
    definitions: screenshot ? [{ name: "screenshot", description: "A browser screenshot", parameters: { type: "object" }, exposure: "direct" as const, resultFormat: "content" as const }] : [],
    call: async () => ({ content: [{ type: "text", text: "the page" }, { type: "image", data: screenshot!(), mimeType: "image/png" }] }),
    saveImage: async (image: any): Promise<FileRef> => {
      if (failSaves) throw new Error("volume unavailable");
      const bytes = Buffer.from(image.data, "base64"), hash = sha(bytes), header = imageHeader(bytes)!;
      files.set(hash, image.data);
      saves.push(hash);
      return { type: "file", path: `/workspace/attachments/${hash}.${image.mimeType.slice("image/".length)}`, volume: "vol_000000000000000000000000", version: saves.length, size: bytes.length, contentType: image.mimeType, chunks: [hash], media: { kind: "image", mimeType: header.mimeType, width: header.width, height: header.height } };
    },
    file: async (ref: any) => {
      const data = files.get(ref.chunks[0]);
      if (data === undefined) throw new Error("no such file");
      return data;
    },
  };
}

async function supervisorFor(t: TestContext, imageRefsTenants?: string[]) {
  const root = await mkdtemp(join(tmpdir(), "images-by-ref-"));
  const supervisor = new AgentSupervisor(root, { hosting: (process.env.AGENT_HOSTING as "inline" | "process" | undefined) ?? "inline", ...(imageRefsTenants ? { imageRefsTenants } : {}) });
  t.after(async () => { await supervisor.close(); await rm(root, { recursive: true, force: true }); });
  return supervisor;
}

/** A request's content parts, every message's. */
const parts = (body: any): any[] => body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []);
const images = (body: any): string[] => parts(body).filter(part => part.type === "image_url").map(part => part.image_url.url.split(",")[1]);
/**
 * A request with the lines naming referenced images taken out, and those lines: what it is without references. Chat
 * completions carry a tool result's text as one string (its parts joined by newlines) and its images in a user message after.
 */
function unreferenced(body: any) {
  const lines: string[] = [];
  const messages = body.messages.map((message: any) => {
    if (typeof message.content === "string") {
      const kept = message.content.split("\n").filter((line: string) => !DESCRIBED.test(line) || !lines.push(line));
      return { ...message, content: kept.join("\n") };
    }
    if (!Array.isArray(message.content)) return message;
    const content = message.content.filter((part: any, at: number) => {
      if (part.type !== "text" || !DESCRIBED.test(part.text)) return true;
      lines.push(part.text);
      return false;
    });
    return { ...message, content };
  });
  return { body: { ...body, messages }, lines };
}

test("payload shadow: with references, a turn with a prompt image and a screenshot tool's sends the same request bytes, plus one line naming each image's file", { timeout: 120_000 }, async t => {
  const prompt = (await picture(2400, 1800, "jpeg")).toString("base64");
  const screen = (await picture(1200, 800)).toString("base64");
  const runs: Record<string, { bodies: any[]; history: any[]; bridge: ReturnType<typeof bridge> }> = {};
  for (const [name, tenants] of [["off", undefined], ["on", ["alice"]], ["other tenant", ["bob"]], ["everyone", ["*"]]] as const) {
    const { bodies, model } = await provider(t, (_body, index) => index === 0 ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "screenshot", arguments: "{}" } }] } : { role: "assistant", content: `seen ${index}` });
    const supervisor = await supervisorFor(t, tenants ? [...tenants] : undefined);
    const tools = bridge(() => screen);
    await supervisor.start("agent", { model, apiKey: "fixture", codeMode: false, tenant: "alice", mounts: WORKSPACE }, tools);
    const result = await supervisor.request("agent", "prompt", { requestId: "turn-1", message: { role: "user", content: [{ type: "text", text: "What is on screen?" }, { type: "image", data: prompt, mimeType: "image/jpeg" }], timestamp: 1 } });
    assert.equal(result.error ?? null, null, name);
    // A later turn sends the images again, from the files: the cached prefix holds.
    assert.equal((await supervisor.request("agent", "prompt", { requestId: "turn-2", text: "And now?" })).error ?? null, null, name);
    runs[name] = { bodies, history: await supervisor.history("agent") as any[], bridge: tools };
  }
  // Off, or for another tenant: exactly as before, images inline in the journal and nothing saved.
  for (const name of ["off", "other tenant"]) {
    assert.deepEqual(runs[name].bodies, runs.off.bodies);
    assert.equal(runs[name].bridge.saves.length, 0);
    assert.equal(parts({ messages: runs[name].history }).filter(part => part.type === "image").length, 2);
  }
  assert.equal(runs.off.bodies.length, 3);
  for (const name of ["on", "everyone"]) {
    const { bodies, history, bridge: tools } = runs[name];
    assert.equal(bodies.length, 3, name);
    for (const [index, body] of bodies.entries()) {
      const { body: without, lines } = unreferenced(body);
      // The documented difference, and only it: each referenced image follows a line naming its file.
      assert.deepEqual(without, runs.off.bodies[index], `${name}: request ${index + 1}`);
      assert.equal(lines.length, images(body).length, `${name}: one line per image`);
      for (const line of lines) assert.equal(DESCRIBED.exec(line)![5], undefined, "shown, with no reason it is not");
      // A prompt's image follows its line in the same message.
      const order = parts(body).map(part => part.type === "text" && DESCRIBED.test(part.text) ? "line" : part.type);
      for (const [at, kind] of order.entries()) if (kind === "line") assert.equal(order[at + 1], "image_url");
    }
    // The journal keeps references, no base64: one file per image, its bytes those sent (the prompt's scaled down first).
    const stored = parts({ messages: history });
    assert.equal(stored.filter(part => part.type === "image").length, 0, name);
    const refs = stored.filter(part => part.type === "file");
    assert.equal(refs.length, 2);
    assert.deepEqual(refs.map(ref => ref.path), tools.saves.map((hash, index) => `/workspace/attachments/${hash}.${index === 0 ? "jpeg" : "png"}`));
    assert.deepEqual(tools.saves.map(hash => tools.files.get(hash)), images(runs.off.bodies[2]));
    assert.equal(tools.files.get(tools.saves[1]), screen, "a screenshot that fits is saved as it came");
    assert.ok(JSON.stringify(history).length < 10_000, `${JSON.stringify(history).length} bytes of history`);
  }
});

test("past the request's image budget, older referenced images are named but not shown, and every turn succeeds", { timeout: 120_000 }, async t => {
  const { bodies, model } = await provider(t, (body, index) => images(body).reduce((sum, data) => sum + data.length, 0) > 30_000_000 ? { status: 413, message: "Downloaded image content cannot exceed 30MB" } : { role: "assistant", content: `seen ${index + 1}` });
  const supervisor = await supervisorFor(t, ["*"]);
  const tools = bridge();
  await supervisor.start("bot", { model, apiKey: "fixture", codeMode: false, tenant: "alice", mounts: WORKSPACE }, tools);
  // Five messages of two screenshots each: about 24 MB of base64 in all, past the request's 20 MB of images.
  const sent: string[] = [];
  for (let turn = 1; turn <= 5; turn++) {
    const pair = await Promise.all([noise(), noise()]).then(buffers => buffers.map(buffer => buffer.toString("base64")));
    sent.push(...pair);
    const result = await supervisor.request("bot", "prompt", { requestId: `turn-${turn}`, message: { role: "user", content: [{ type: "text", text: `screens ${turn}` }, ...pair.map(data => ({ type: "image", data, mimeType: "image/png" }))], timestamp: turn } });
    assert.equal(result.error ?? null, null, `turn ${turn}`);
  }
  assert.equal(bodies.length, 5, "no request was refused and retried");
  const last = bodies.at(-1);
  const shown = images(last);
  assert.ok(shown.length >= 2 && shown.length < sent.length, `${shown.length} shown`);
  assert.deepEqual(shown, sent.slice(-shown.length), "the newest images, none skipped among them");
  assert.ok(shown.reduce((sum, data) => sum + data.length, 0) <= FILE_LIMITS.requestImageBase64Bytes);
  const lines = parts(last).filter(part => part.type === "text" && DESCRIBED.test(part.text)).map(part => DESCRIBED.exec(part.text)![5]);
  assert.equal(lines.length, sent.length, "every image is named");
  assert.deepEqual(lines.slice(0, sent.length - shown.length), Array(sent.length - shown.length).fill("not shown, as this request holds too many images; read it to view it"));
  assert.deepEqual(lines.slice(sent.length - shown.length), Array(shown.length).fill(undefined));
  assert.ok(!JSON.stringify(last).includes(IMAGE_PAST_BUDGET), "no inline image was left to drop");
  // Pi's context holds the references: the stored history is small, every image a file.
  const history = await supervisor.history("bot") as any[];
  assert.equal(parts({ messages: history }).filter(part => part.type === "file").length, sent.length);
  assert.ok(JSON.stringify(history).length < 20_000);
});

test("an agent without a writable mount, or whose save fails, keeps its images inline and its turn succeeds", { timeout: 120_000 }, async t => {
  const screen = (await picture(800, 600)).toString("base64");
  const logs: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { logs.push(args.join(" ")); };
  t.after(() => { console.log = log; console.error = error; });
  for (const [name, mounts, failSaves] of [["no mount", undefined, false], ["read-only", [{ path: "/data", mode: "ro" as const }], false], ["save fails", WORKSPACE, true]] as const) {
    const { bodies, model } = await provider(t, () => ({ role: "assistant", content: "seen" }));
    const supervisor = await supervisorFor(t, ["alice"]);
    const tools = bridge(undefined, failSaves);
    await supervisor.start("agent", { model, apiKey: "fixture", codeMode: false, tenant: "alice", ...(mounts ? { mounts: [...mounts] } : {}) }, tools);
    const result = await supervisor.request("agent", "prompt", { message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: screen, mimeType: "image/png" }], timestamp: 1 } });
    assert.equal(result.error ?? null, null, name);
    assert.deepEqual(images(bodies[0]), [screen], name);
    assert.ok(!parts(bodies[0]).some(part => part.type === "text" && DESCRIBED.test(part.text)), name);
    const history = await supervisor.history("agent") as any[];
    assert.deepEqual(parts({ messages: history }).filter(part => part.type === "image").map(part => part.data), [screen], name);
    assert.equal(tools.files.size, 0, name);
  }
  if ((process.env.AGENT_HOSTING ?? "inline") === "inline") {
    assert.equal(logs.filter(line => line.includes('"image_kept_inline"')).length, 2, "said once per agent without a mount");
    assert.ok(logs.some(line => line.includes('"image_save_failed"') && line.includes("volume unavailable")));
  }
});

for (const rejection of ["Failed to load image: cannot identify image file", "Exceeded maximum number of images (50) allowed in the request."])
test(`a provider rejecting referenced images (${rejection}) gets one request naming them without their bytes, and the journal keeps the references`, { timeout: 120_000 }, async t => {
  const screen = (await picture(640, 480)).toString("base64");
  const { bodies, model } = await provider(t, body => images(body).length ? { status: 400, message: rejection } : { role: "assistant", content: "Seen." });
  const supervisor = await supervisorFor(t, ["alice"]);
  const tools = bridge();
  await supervisor.start("agent", { model, apiKey: "fixture", codeMode: false, tenant: "alice", mounts: WORKSPACE }, tools);
  const result = await supervisor.request("agent", "prompt", { message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: screen, mimeType: "image/png" }], timestamp: 1 } });
  assert.equal(result.error ?? null, null);
  assert.equal(bodies.length, 2, "one fallback request");
  assert.equal(images(bodies[1]).length, 0);
  const named = parts(bodies[1]).filter(part => part.type === "text" && DESCRIBED.test(part.text)).map(part => DESCRIBED.exec(part.text)![5]);
  assert.deepEqual(named, [`image omitted: ${IMAGE_DAMAGED}`]);
  const history = await supervisor.history("agent") as any[];
  assert.ok(!JSON.stringify(history).includes(rejection), "the refused response left no trace");
  assert.deepEqual(parts({ messages: history }).filter(part => part.type === "file").map(part => part.chunks[0]), [sha(Buffer.from(screen, "base64"))]);
  // The next turn tries the image again.
  assert.equal((await supervisor.request("agent", "prompt", { text: "again" })).error ?? null, null);
  assert.deepEqual(bodies.slice(2).map(body => images(body).length), [1, 0]);
});

test("the runtime saves an image as attachments/<sha256>.<ext> in the agent's workspace, whatever its tenant's storage limit, and refers to it as the transcript does", async t => {
  const { db } = await testDatabase();
  const storage = memoryStorage(postgresTail(db, { unfenced: true }));
  const volumes = new VolumeService({ db, storage, quota: async () => ({ limit: 1000, used: 1000 }) });
  t.after(() => volumes.close());
  const { id } = await volumes.create("acme", { name: "workspace" });
  const ctx = { options: { volumes } } as unknown as ToolsContext;
  const session = (mounts: unknown[]) => ({ header: { id: "client_" + "a".repeat(40), tenant: "acme", mounts } }) as unknown as Session;
  const data = await picture(64, 48);
  // A tenant at its limit is refused other writes, not this one: the image is in the agent's context already.
  await assert.rejects(volumes.put("acme", id, "/other.png", data), (error: any) => error.status === 507);
  const ref = await saveImage(ctx, session([{ path: "/workspace", mode: "rw", volumeId: id }]), { data: data.toString("base64"), mimeType: "image/png" });
  assert.equal(ref.path, `/workspace/attachments/${sha(data)}.png`);
  assert.deepEqual([ref.volume, ref.size, ref.contentType, ref.media], [id, data.length, "image/png", { kind: "image", mimeType: "image/png", width: 64, height: 48 }]);
  assert.equal(sha(await volumes.readRange("acme", ref, 0, ref.size)), sha(data));
  // The same image again is the same file.
  const again = await saveImage(ctx, session([{ path: "/workspace", mode: "rw", volumeId: id }]), { data: data.toString("base64"), mimeType: "image/png" });
  assert.deepEqual([again.path, again.chunks], [ref.path, ref.chunks]);
  await assert.rejects(saveImage(ctx, session([{ path: "/data", mode: "ro", volumeId: id }]), { data: data.toString("base64"), mimeType: "image/png" }), /no writable mount/);
  await assert.rejects(saveImage(ctx, session([{ path: "/workspace", mode: "rw", volumeId: id }]), { data: "", mimeType: "image/png" }), /Invalid image/);
  await assert.rejects(saveImage(ctx, session([{ path: "/workspace", mode: "rw", volumeId: id }]), { data: data.toString("base64"), mimeType: "application/pdf" }), /Invalid image/);
});
