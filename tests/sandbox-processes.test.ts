// The processes untrusted code and files run in (src/sandbox.ts): v8-exec for js_exec, parse-job.ts for
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
import { checkSandbox, executeCode } from "../src/codemode.ts";
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
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A v8.sock whose "process" behaves however the test says: the runtime must survive anything it sends. */
async function fakeGuest(t: { after: (fn: () => unknown) => void }, behave: (message: any, send: (message: unknown) => void, socket: Socket) => void) {
  await fakeLauncher(t, (kind, socket) => {
    socket.resume();
    const send = frames(socket, message => behave(message, send, socket));
    return true;
  });
  return new V8Exec();
}

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

test("through the launcher's socket: js_exec end to end, cancelled, killed and reported, pre-spawned processes used once", { skip, timeout: 60_000 }, async t => {
  const launcher = await fakeLauncher(t);
  const pool = new V8Exec({ prespawn: 2 });
  t.after(() => pool.close());
  assert.equal(pool.pids.size, 0, "Its processes are the launcher's, not this one's");
  const events: unknown[] = [];
  const result = await executeCode({
    code: 'const value: number = 20; console.log("start"); return (await tools.echo({ n: value })).n + 22;',
    bridge: echo, pool, onEvent: event => events.push(event),
  }).then(({ cpuMs: _cpuMs, ...rest }) => rest);
  assert.deepEqual(result, { output: ["start", "42"], truncated: false, returned: { index: 1, json: true, truncated: false } });
  assert.deepEqual(events, [{ type: "output", text: "start" }, { type: "output", text: "42" }]);
  await assert.rejects(executeCode({ code: "return await tools.nope({})", bridge: echo, pool }), /tools\.nope is not a tool/);
  for (let i = 0; i < 3; i++) assert.deepEqual((await executeCode({ code: "globalThis.n = (globalThis.n ?? 0) + 1; return n", bridge: echo, pool })).output, ["1"], "Nothing carries over");

  let entered = Promise.withResolvers<void>();
  const hang: ToolBridge = {
    definitions: [{ name: "hang", description: "", parameters: { type: "object" } }],
    call: (_name, _args, signal) => { entered.resolve(); return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })); },
  };
  // Cancelled: closing the connection ends the execution at once.
  const controller = new AbortController();
  const spinning = executeCode({ code: "while (true) {}", bridge: hang, pool, signal: controller.signal, timeoutMs: 60_000 });
  await sleep(200);
  controller.abort();
  await assert.rejects(spinning, /aborted/);
  await assert.rejects(executeCode({ code: "await tools.hang({})", bridge: hang, pool, timeoutMs: 2_000 }), /timed out after 2000ms while tools\.hang was still running/);
  assert.equal(pool.running, 0);

  // Killed by something else: the launcher's last frame says how.
  entered = Promise.withResolvers<void>();
  const running = executeCode({ code: "await tools.hang({})", bridge: hang, pool });
  await entered.promise;
  // The one running the execution, and the pre-spawned ones waiting for theirs.
  for (const pid of launcher.pids) if (alive(pid)) process.kill(pid, "SIGKILL");
  await assert.rejects(running, /Codemode sandbox process exited \(SIGKILL: a resource limit\)/);
  // The next execution passes the dead pre-spawned ones over.
  await sleep(100);
  assert.deepEqual((await executeCode({ code: "return 1", bridge: echo, pool })).output, ["1"]);
});

test("the runtime treats everything a v8-exec process sends as untrusted", async t => {
  const run = (pool: V8Exec, bridge = echo) => executeCode({ code: "return 1", bridge, pool, timeoutMs: 5_000, maxOutputCharacters: 10 });
  const answer = (result: unknown) => (message: any, send: (message: unknown) => void) => {
    if (message.method === "execute") send({ type: "response", id: message.id, result });
  };

  await assert.rejects(run(await fakeGuest(t, (message, send) => send({ type: "request", id: "x", method: "shell", params: {} }))), /sent an invalid message/);
  await assert.rejects(run(await fakeGuest(t, (message, send) => send({ type: "event", event: { type: "exec", command: "id" } }))), /sent an invalid message/);
  await assert.rejects(run(await fakeGuest(t, (message, send) => send("hello"))), /sent an invalid message/);
  await assert.rejects(run(await fakeGuest(t, (message, send, socket) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1);
    socket.write(header);
  })), /sandbox process exited/);
  await assert.rejects(run(await fakeGuest(t, (message, send, socket) => socket.destroy())), /sandbox process exited \(no status\)/);
  // A forged exit frame only changes how the end reads.
  await assert.rejects(run(await fakeGuest(t, (message, send, socket) => socket.end(frame({ type: "exit", signal: "SIGSYS" })))), /SIGSYS: a system call outside its seccomp allowlist/);
  await assert.rejects(run(await fakeGuest(t, (message, send) => {
    for (let i = 0; i < 2_000; i++) send({ type: "event", event: { type: "output", text: "" } });
  })), /sent too many messages/);
  await assert.rejects(run(await fakeGuest(t, answer({ output: ["x".repeat(11)], truncated: false }))), /returned an invalid result/);
  await assert.rejects(run(await fakeGuest(t, answer({ output: [{ toString: 1 }], truncated: false }))), /returned an invalid result/);
  await assert.rejects(run(await fakeGuest(t, answer("owned"))), /returned an invalid result/);
  assert.deepEqual(await run(await fakeGuest(t, answer({ output: ["ok"], truncated: false, extra: "dropped" }))), { output: ["ok"], truncated: false });

  // Output events are held to the caller's limit on this side too.
  const events: unknown[] = [];
  const loud = await fakeGuest(t, (message, send) => {
    if (message.method !== "execute") return;
    send({ type: "event", event: { type: "output", text: "0123456789abcdef" } });
    send({ type: "event", event: { type: "output", text: "more" } });
    send({ type: "response", id: message.id, result: { output: [], truncated: true } });
  });
  await executeCode({ code: "return 1", bridge: echo, pool: loud, maxOutputCharacters: 10, onEvent: event => events.push(event) });
  assert.deepEqual(events, [{ type: "output", text: "0123456789" }]);

  // Tool calls a guest makes up are held to the same policy and quotas as real ones.
  let calls = 0;
  const counted: ToolBridge = { ...echo, call: async args => { calls++; return args; } };
  const replies: any[] = [];
  const flooding = await fakeGuest(t, (message, send) => {
    if (message.method === "execute") {
      send({ type: "request", id: "unknown", method: "tool", params: { name: "rm", args: {} } });
      for (let i = 0; i < 300; i++) send({ type: "request", id: `call-${i}`, method: "tool", params: { name: "echo", args: {} } });
    } else if (message.type === "response") {
      replies.push(message);
      if (replies.length === 301) send({ type: "response", id: "late", result: null });
    }
  });
  const flood = executeCode({ code: "return 1", bridge: counted, pool: flooding, timeoutMs: 2_000 });
  await assert.rejects(flood, /timed out/);
  assert.equal(replies.find(reply => reply.id === "unknown").error, "Unknown tool");
  assert.ok(calls <= 256, `${calls} tool calls ran`);
  assert.ok(replies.some(reply => /tool call limit exceeded|Too many concurrent/.test(reply.error ?? "")));
});

test("a launcher that cannot be reached fails the execution and the parse clearly", async t => {
  const directory = await mkdtemp(join(tmpdir(), "sbx-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  process.env.AGENT_SANDBOX_DIR = directory;
  t.after(() => { delete process.env.AGENT_SANDBOX_DIR; });
  await assert.rejects(executeCode({ code: "return 1", bridge: echo, pool: new V8Exec() }), /Codemode sandbox process could not start \(ENOENT\)/);
  await assert.rejects(parse(PNG, false), /the parser could not start \(ENOENT\)/);
});

test("without the launcher js_exec and parsing run in processes of this one's own, unless isolation is required", { skip }, async () => {
  assert.equal(process.env.AGENT_SANDBOX_DIR, undefined);
  assert.equal((await checkSandbox()).mode, "in-process");
  process.env.AGENT_SANDBOX_REQUIRED = "1";
  try { await assert.rejects(checkSandbox(), /AGENT_SANDBOX_REQUIRED=1, but no agent-launcher/); }
  finally { delete process.env.AGENT_SANDBOX_REQUIRED; }
  assert.deepEqual((await executeCode({ code: "return 1", bridge: echo })).output, ["1"]);
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
