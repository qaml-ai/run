import { runPi } from "./pi-sandbox.ts";
// The processes untrusted code and files run in (src/sandbox.ts): v8-exec for codemode, parse-job.ts for
// files, started by this process without agent-launcher, or through the launcher's sockets with it
// (tests/fake-launcher.ts stands in for it here; tests/image-isolation.ts runs the real one, confined).
import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import sharp from "sharp";
import { checkSandbox } from "../src/codemode.ts";
import { frames, MAX_FRAME_BYTES } from "../src/sandbox-wire.ts";
import type { ToolBridge } from "../src/protocol.ts";
import { fitImage, inspect, inspection, parse } from "../src/inspect.ts";
import { imageHeader } from "../src/image-header.ts";
import { V8Exec, v8ExecBinary } from "../src/v8-exec.ts";
import { bombPdf, pdfBytes, PNG } from "./file-fixtures.ts";
import { fakeLauncher, frame } from "./fake-launcher.ts";

const skip = !existsSync(v8ExecBinary()) && "v8-exec is not built (npm run build:v8-exec)";
const echo: ToolBridge = {
  definitions: [{ name: "echo", description: "Returns its arguments", parameters: { type: "object" } }],
  call: async (_name, args) => args,
};

test("frames survive arbitrary chunking and refuse oversized or malformed input", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sbx-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "s.sock");
  const received: unknown[] = [];
  const server = createServer(socket => {
    socket.on("error", () => {});
    frames(socket, message => received.push(message));
  });
  server.listen(path);
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));

  const body = Buffer.from(JSON.stringify({ text: "héllo".repeat(1000) }));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  const client = connect(path);
  await once(client, "connect");
  for (const byte of Buffer.concat([header, body, header, body])) { client.write(Buffer.from([byte])); }
  for (let i = 0; i < 200 && received.length < 2; i++) await sleep(10);
  assert.deepEqual(received, [{ text: "héllo".repeat(1000) }, { text: "héllo".repeat(1000) }]);
  client.destroy();

  for (const bad of [Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("{{{")])]) {
    const socket = connect(path);
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(bad);
    await once(socket, "close");
  }
  assert.equal(received.length, 2);

  const sender = connect(path);
  await once(sender, "connect");
  const send = frames(sender, () => {});
  assert.throws(() => send({ text: "x".repeat(MAX_FRAME_BYTES) }), /exceeds size limit/);
  sender.destroy();
});

test("Pi through the launcher's socket: fresh guests, cancellation and process death", { skip, timeout: 30_000 }, async t => {
  const launcher = await fakeLauncher(t);
  const pool = new V8Exec({ prespawn: 2 });
  t.after(() => pool.close());
  assert.equal(pool.pids.size, 0, "The processes belong to the launcher");
  const run = (code: string, options: Partial<Parameters<typeof runPi>[0]> = {}) => runPi({ code, bridge: echo, pool, ...options });
  assert.equal(await run('const n: number = 20; return (await tools.echo({ n })).n + 22;'), 42);
  for (let i = 0; i < 3; i++) assert.equal(await run("globalThis.n = (globalThis.n ?? 0) + 1; return n;"), 1);

  const controller = new AbortController();
  const spinning = run("while (true) {}", { signal: controller.signal, cpuMs: 5_000 });
  await sleep(100);
  controller.abort();
  await assert.rejects(spinning, /abort/i);
  let entered = Promise.withResolvers<void>();
  const hang: ToolBridge = {
    definitions: [{ name: "hang", description: "Waits", parameters: { type: "object" } }],
    call: (_name, _args, signal) => { entered.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); },
  };
  await assert.rejects(run("await tools.hang({});", { bridge: hang, timeoutMs: 200 }), /200/);
  assert.equal(pool.running, 0);
  entered = Promise.withResolvers<void>();
  const running = run("await tools.hang({});", { bridge: hang });
  await entered.promise;
  for (const pid of launcher.pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await assert.rejects(running, /SIGKILL/);
  await sleep(100);
  assert.equal(await run("return 1;"), 1);
});

test("a launcher that cannot be reached fails the execution and the parse clearly", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sbx-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  process.env.AGENT_SANDBOX_DIR = directory;
  t.after(() => { delete process.env.AGENT_SANDBOX_DIR; });
  await assert.rejects(runPi({ code: "return 1", bridge: echo, pool: new V8Exec() }), /Codemode sandbox process could not start \(ENOENT\)/);
  await assert.rejects(parse(PNG, false), /the parser could not start \(ENOENT\)/);
});

test("without the launcher codemode and parsing run in processes of this one's own, unless isolation is required", { skip }, async () => {
  assert.equal(process.env.AGENT_SANDBOX_DIR, undefined);
  assert.equal((await checkSandbox()).mode, "in-process");
  await assert.rejects(checkSandbox({ required: true }), /AGENT_SANDBOX_REQUIRED=1, but no agent-launcher/);
  assert.equal(await runPi({ code: "return 1", bridge: echo }), 1);
});

for (const where of ["in a process of this one's own", "through the launcher's socket"]) {
  test(`a parse job ${where}: bytes in frames, a hostile file stopped there, a scaled image back in frames`, { timeout: 60_000 }, async t => {
    const launcher = where.includes("launcher") ? await fakeLauncher(t) : undefined;
    // Larger than a frame: the bytes cross in several. (inspect reads an image's header without a parse job.)
    const large = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024, 1)]);
    assert.deepEqual(inspection(await parse(large, false)), { media: { kind: "image", mimeType: "image/png", width: 2, height: 3 } });
    assert.deepEqual(await inspect(large), { media: { kind: "image", mimeType: "image/png", width: 2, height: 3 } });
    assert.deepEqual(await inspect(Buffer.from("plain text")), { media: { kind: "none", reason: "not an image or PDF the model can view" } });
    assert.deepEqual(await inspect(pdfBytes(["Parsed in a parse job"]), true), { media: { kind: "pdf", pages: 1 }, text: "--- Page 1 ---\nParsed in a parse job" });
    assert.deepEqual(await inspect(await bombPdf(), true), { media: { kind: "none", reason: "could not be read (it needs too much memory)" } });
    // An image scaled down for a model request: its bytes come back in frames before the response.
    const noise = Buffer.alloc(2400 * 1800 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const scaled = await fitImage(await sharp(noise, { raw: { width: 2400, height: 1800, channels: 3 } }).png().toBuffer());
    assert.ok(!("omitted" in scaled), JSON.stringify(scaled));
    assert.deepEqual([scaled.mimeType, scaled.width, scaled.height, imageHeader(scaled.data)], ["image/jpeg", 1568, 1176, { mimeType: "image/jpeg", width: 1568, height: 1176 }], "noise too large as a PNG goes as a JPEG");
    if (launcher) assert.equal(launcher.started.parse, 4, "One process per file parsed: the image's header was read here");
  });
}

test("whatever a parse job answers is checked, and one that dies reads as could not be read", async t => {
  let behave: (message: any, send: (message: unknown) => void, socket: Socket) => void = () => {};
  await fakeLauncher(t, (kind, socket) => {
    socket.resume();
    const send = frames(socket, message => behave(message, send, socket));
    return true;
  });
  behave = (message, send) => { if (message.type === "request") send({ type: "response", id: message.id, result: { media: { kind: "image", mimeType: "image/png", width: "huge", height: 1 } } }); };
  assert.equal(inspection(await parse(PNG, false)).media.kind, "none");
  behave = (message, send, socket) => socket.end(frame({ type: "exit", signal: "SIGSEGV" }));
  assert.deepEqual(await inspect(pdfBytes(["x"])), { media: { kind: "none", reason: "could not be read (the parser exited (SIGSEGV))" } });
  behave = (message, send) => { if (message.type === "request") for (let i = 0; i < 3; i++) send({ type: "data", data: Buffer.alloc(2 * 1024 * 1024).toString("base64") }); };
  const big = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: "#3366aa" } }).png().toBuffer();
  const fitted = await fitImage(big);
  assert.ok("omitted" in fitted && fitted.transient && /the parser sent too much/.test(fitted.omitted), JSON.stringify(fitted));
});
