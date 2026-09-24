import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { checkSandbox, executeCode, SandboxProcess, SandboxProcesses } from "../src/codemode.ts";
import { frames, MAX_FRAME_BYTES } from "../src/sandbox-wire.ts";
import type { ToolBridge } from "../src/protocol.ts";

type Context = { after: (fn: () => unknown) => void };

async function socketPath(t: Context) {
  // Short: unix socket paths are limited to about 100 bytes.
  const directory = await mkdtemp(join(tmpdir(), "sbx-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return join(directory, "s.sock");
}

/** A real sandbox process, as agent-launcher runs it but on a path and without confinement. */
async function sandboxProcess(t: Context, path?: string) {
  path ??= await socketPath(t);
  const child = spawn(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning",
    fileURLToPath(new URL("../src/sandbox-server.ts", import.meta.url)), `--socket=${path}`, "--workers-min=1", "--workers-max=2"], { stdio: ["ignore", "inherit", "inherit"] });
  t.after(() => { child.kill("SIGKILL"); });
  for (let i = 0; i < 200; i++) {
    const socket = connect(path);
    const connected = await new Promise(resolve => { socket.once("connect", () => resolve(true)); socket.once("error", () => resolve(false)); });
    socket.destroy();
    if (connected) return { child, path };
    await sleep(25);
  }
  throw new Error("Sandbox process did not start");
}

/** A sandbox that behaves however the test says: the runtime must survive anything it sends. */
async function fakeSandbox(t: Context, behave: (message: any, send: (message: unknown) => void, socket: Socket) => void) {
  const path = await socketPath(t);
  const server = createServer(socket => {
    socket.on("error", () => {});
    const send = frames(socket, message => behave(message, send, socket));
  });
  server.listen(path);
  await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  return new SandboxProcess(path);
}

const echo: ToolBridge = {
  definitions: [{ name: "echo", description: "Returns its arguments", parameters: { type: "object" } }],
  call: async (_name, args) => args,
};

test("frames survive arbitrary chunking and refuse oversized or malformed input", async t => {
  const path = await socketPath(t);
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

test("js_exec runs end to end through a sandbox process, tool calls included", async t => {
  const { path } = await sandboxProcess(t);
  const sandbox = new SandboxProcesses([path]);
  const events: unknown[] = [];
  const result = await executeCode({
    code: 'const value: number = 20; console.log("start"); return (await tools.echo({ n: value })).n + 22;',
    bridge: echo, pool: sandbox, onEvent: event => events.push(event),
  });
  assert.deepEqual(result, { output: ["start", "42"], truncated: false });
  assert.deepEqual(events, [{ type: "output", text: "start" }, { type: "output", text: "42" }]);
  await assert.rejects(executeCode({ code: "return await tools.nope({})", bridge: echo, pool: sandbox }), /not a function/);
  // Arguments are still validated here, whatever the sandbox forwards.
  const strict: ToolBridge = { definitions: [{ name: "strict", description: "", parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] } }], call: async () => 1 };
  await assert.rejects(executeCode({ code: 'return await tools.strict({ n: "x" })', bridge: strict, pool: sandbox }), /Invalid arguments for tool: strict/);
  assert.equal(sandbox.processes[0].load, 0);
});

test("timeouts and aborts cancel the execution in the sandbox process, which keeps serving", async t => {
  const { path } = await sandboxProcess(t);
  const sandbox = new SandboxProcesses([path]);
  let aborted = 0;
  const hang: ToolBridge = {
    definitions: [{ name: "hang", description: "", parameters: { type: "object" } }],
    call: (_name, _args, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted++; reject(new Error("aborted")); }, { once: true })),
  };
  await assert.rejects(executeCode({ code: "await tools.hang({})", bridge: hang, pool: sandbox, timeoutMs: 300 }), /timed out after 300ms;/);
  const controller = new AbortController();
  const spinning = executeCode({ code: "while (true) {}", bridge: hang, pool: sandbox, signal: controller.signal, timeoutMs: 60_000 });
  await sleep(200);
  controller.abort();
  await assert.rejects(spinning, /aborted/);
  assert.equal(aborted, 1);
  assert.deepEqual((await executeCode({ code: "return 7", bridge: hang, pool: sandbox })).output, ["7"]);
});

test("guests stuck where the interrupt handler cannot reach cost a sandbox process none of its workers", async t => {
  const { path } = await sandboxProcess(t);
  const sandbox = new SandboxProcesses([path]);
  // More than --workers-max: each stuck guest's worker is terminated and its slot refilled.
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController();
    // Aborted once inside one long native call (see tests/sandbox.test.ts, stuck()).
    await assert.rejects(executeCode({
      code: 'const digits = "9".repeat(300000); text("parsing"); return BigInt(digits).toString().length;',
      bridge: echo, pool: sandbox, signal: controller.signal, timeoutMs: 60_000, onEvent: () => controller.abort(),
    }), /aborted/);
    assert.deepEqual((await executeCode({ code: "return 1", bridge: echo, pool: sandbox, timeoutMs: 10_000 })).output, ["1"]);
  }
});

test("a sandbox process that dies fails its executions clearly, and one that comes back serves again", async t => {
  const first = await sandboxProcess(t);
  const sandbox = new SandboxProcesses([first.path]);
  const entered = Promise.withResolvers<void>();
  const bridge: ToolBridge = {
    definitions: [{ name: "hang", description: "", parameters: { type: "object" } }],
    call: () => { entered.resolve(); return new Promise(() => {}); },
  };
  const running = executeCode({ code: "await tools.hang({})", bridge, pool: sandbox });
  await entered.promise;
  first.child.kill("SIGKILL");
  await assert.rejects(running, /Codemode sandbox process exited/);
  await rm(first.path, { force: true });
  await sandboxProcess(t, first.path);
  assert.deepEqual((await executeCode({ code: "return 1", bridge, pool: sandbox })).output, ["1"]);
});

test("the runtime treats everything a sandbox sends as untrusted", async t => {
  const run = (sandbox: SandboxProcess, bridge = echo) => executeCode({ code: "return 1", bridge, pool: sandbox, timeoutMs: 5_000, maxOutputCharacters: 10 });
  const answer = (result: unknown) => (message: any, send: (message: unknown) => void) => {
    if (message.method === "execute") { send({ type: "dispatched" }); send({ type: "response", id: message.id, result }); }
  };

  await assert.rejects(run(await fakeSandbox(t, (message, send) => send({ type: "request", id: "x", method: "shell", params: {} }))), /sent an invalid message/);
  await assert.rejects(run(await fakeSandbox(t, (message, send) => send({ type: "event", event: { type: "exec", command: "id" } }))), /sent an invalid message/);
  await assert.rejects(run(await fakeSandbox(t, (message, send) => send("hello"))), /sent an invalid message/);
  await assert.rejects(run(await fakeSandbox(t, (message, send, socket) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1);
    socket.write(header);
  })), /sandbox process exited \(Sandbox frame exceeds size limit\)/);
  await assert.rejects(run(await fakeSandbox(t, (message, send, socket) => socket.destroy())), /sandbox process exited/);
  await assert.rejects(run(await fakeSandbox(t, (message, send) => {
    for (let i = 0; i < 2_000; i++) send({ type: "event", event: { type: "output", text: "" } });
  })), /sent too many messages/);
  await assert.rejects(run(await fakeSandbox(t, answer({ output: ["x".repeat(11)], truncated: false }))), /returned an invalid result/);
  await assert.rejects(run(await fakeSandbox(t, answer({ output: [{ toString: 1 }], truncated: false }))), /returned an invalid result/);
  await assert.rejects(run(await fakeSandbox(t, answer("owned"))), /returned an invalid result/);
  assert.deepEqual(await run(await fakeSandbox(t, answer({ output: ["ok"], truncated: false, extra: "dropped" }))), { output: ["ok"], truncated: false });

  // Output events are held to the caller's limit on this side too.
  const events: unknown[] = [];
  const loud = await fakeSandbox(t, (message, send) => {
    if (message.method !== "execute") return;
    send({ type: "dispatched" });
    send({ type: "event", event: { type: "output", text: "0123456789abcdef" } });
    send({ type: "event", event: { type: "output", text: "more" } });
    send({ type: "response", id: message.id, result: { output: [], truncated: true } });
  });
  await executeCode({ code: "return 1", bridge: echo, pool: loud, maxOutputCharacters: 10, onEvent: event => events.push(event) });
  assert.deepEqual(events, [{ type: "output", text: "0123456789" }]);

  // Tool calls a sandbox makes up are held to the same policy and quotas as real ones.
  let calls = 0;
  const counted: ToolBridge = { ...echo, call: async args => { calls++; return args; } };
  const replies: any[] = [];
  const flooding = await fakeSandbox(t, (message, send) => {
    if (message.method === "execute") {
      send({ type: "dispatched" });
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

test("executions go to the least-loaded sandbox process, ties round-robin", async t => {
  const connections = [0, 0];
  const held: Socket[] = [];
  const processes = await Promise.all([0, 1].map(async index => {
    const path = await socketPath(t);
    const server = createServer(socket => { connections[index]++; held.push(socket); socket.on("error", () => {}); });
    server.listen(path);
    await once(server, "listening");
    t.after(() => { for (const socket of held) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
    return path;
  }));
  const sandbox = new SandboxProcesses(processes);
  const guests = Array.from({ length: 4 }, () => sandbox.open());
  assert.deepEqual(sandbox.processes.map(process => process.load), [2, 2]);
  guests[1].end(false);
  guests[3].end(false);
  assert.deepEqual(sandbox.processes.map(process => process.load), [2, 0]);
  const next = [sandbox.open(), sandbox.open()];
  assert.deepEqual(sandbox.processes.map(process => process.load), [2, 2], "Both went to the process with fewer open");
  for (const guest of [guests[0], guests[2], ...next]) guest.end(false);
  assert.deepEqual(sandbox.processes.map(process => process.load), [0, 0]);
});

test("without sandbox processes js_exec runs in-process, unless they are required", async () => {
  assert.equal(process.env.AGENT_SANDBOX_SOCKETS, undefined);
  assert.equal((await checkSandbox()).mode, "in-process");
  process.env.AGENT_SANDBOX_REQUIRED = "1";
  try { await assert.rejects(checkSandbox(), /AGENT_SANDBOX_REQUIRED=1, but no sandbox processes/); }
  finally { delete process.env.AGENT_SANDBOX_REQUIRED; }
  assert.deepEqual((await executeCode({ code: "return 1", bridge: echo })).output, ["1"]);
});
