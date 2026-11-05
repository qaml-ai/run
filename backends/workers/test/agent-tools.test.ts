import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { AttachedTools } from "../src/attached-tools.ts";
import { prepareSources, sourceTools, sourceView, sourceUrl } from "../src/tool-sources.ts";
import { questionsInput } from "../src/input-policy.ts";
import { answerHuman } from "../src/human.ts";
import { isolatedSandboxRemote } from "../codemode/routing.ts";
import { compatibleFileTools } from "../src/fs-tools.ts";
import { FS_SHIM } from "../codemode/fs-shim.ts";
import { boundedExchange } from "../codemode/limits.ts";
import type { ToolRegistration } from "@earendil-works/pi-durable";

test("attached tools initialize on their connection and preserve a tool result", async () => {
  const attached = new AttachedTools(), frames: any[] = [];
  const handle = attached.attach(frame => {
    frames.push(frame);
    const message = (frame as any).message;
    if (message.id) queueMicrotask(() => attached.receive({ id: message.id, result: message.method === "initialize" ? {} : { content: [{ type: "text", text: "answer" }] } }, handle.id));
  });
  handle.start();
  const tool = attached.tools([{ name: "lookup", inputSchema: { type: "object" } }])[0];
  const result = await tool.execute({}, undefined as never, undefined as never);
  assert.deepEqual(result.output, [{ type: "text", text: "answer" }]);
  assert.equal(attached.connected, true);
  assert.deepEqual(frames.filter(frame => frame.message.id).map(frame => frame.message.method), ["initialize", "tools/call"]);
  assert.throws(() => attached.receive({ id: "old", result: {} }, "old"), /APPLICATION_REPLACED/);
  handle.close();
  assert.equal(attached.connected, false);
});

test("closing an attached connection fails in-flight calls without retrying them", async () => {
  const attached = new AttachedTools();
  let calls = 0;
  const handle = attached.attach(frame => {
    const message = (frame as any).message;
    if (message.method === "initialize") queueMicrotask(() => attached.receive({ id: message.id, result: {} }, handle.id));
    if (message.method === "tools/call") { calls++; queueMicrotask(handle.close); }
  });
  handle.start();
  await assert.rejects(attached.call("charge", {}), /connection lost/);
  assert.equal(calls, 1);
});

test("takeover drains calls on the previous connection before retiring it", async () => {
  const attached = new AttachedTools(), oldCalls: any[] = [];
  let retired = false;
  const old = attached.attach(frame => {
    const message = (frame as any).message;
    if (message.method === "initialize") queueMicrotask(() => attached.receive({ id: message.id, result: {} }, old.id));
    else if (message.method === "tools/call") oldCalls.push(message);
  }, undefined, false, () => { retired = true; });
  old.start(); await attached.waitUntilReady();
  const slow = attached.call("slow", {});
  await Promise.resolve();
  const replacement = attached.attach(frame => {
    const message = (frame as any).message;
    if (message.id) queueMicrotask(() => attached.receive({ id: message.id, result: message.method === "initialize" ? {} : { content: [{ type: "text", text: "new" }] } }, replacement.id));
  }, undefined, true);
  replacement.start(); await attached.waitUntilReady();
  assert.equal(retired, false);
  attached.receive({ id: oldCalls[0].id, result: { content: [{ type: "text", text: "old" }] } }, old.id);
  assert.deepEqual(await slow, { content: [{ type: "text", text: "old" }] });
  assert.equal(retired, true);
  assert.deepEqual(await attached.call("slow", {}), { content: [{ type: "text", text: "new" }] });
  attached.close();
});

test("attachment admission refuses a live owner before opening a replacement stream", async () => {
  const attached = new AttachedTools();
  const owner = attached.attach(frame => {
    const message = (frame as any).message;
    if (message.id) queueMicrotask(() => attached.receive({ id: message.id, result: {} }, owner.id));
  });
  owner.start(); await attached.waitUntilReady();
  await assert.rejects(attached.prepareAttach(), { code: "APPLICATION_CONNECTED" });
  await attached.prepareAttach(owner.id);
  await attached.prepareAttach(undefined, true);
  attached.close();
});

test("source validation seals definition credentials and rejects inline secrets/private URLs", async () => {
  const env = { API_TOKEN: "unit-test-key-with-32-characters-long", AGENT_SECRETS_KEY: "22".repeat(32), TEST_MODE: "1" };
  const sources = await prepareSources(env, "tenant", "definition", "mcpServers", [{ name: "shop", url: "https://example.com/mcp", auth: { type: "bearer", token: "test-value" } }]);
  assert.ok(sources[0].sealed);
  assert.equal(JSON.stringify(sources).includes("test-value"), false);
  assert.equal("sealed" in sourceView(sources[0]), false);
  assert.deepEqual(sourceView({ name: "legacy", url: "https://example.com/mcp", auth: { type: "bearer", token: "raw-secret" }, headers: { Authorization: "raw-secret" }, unknown: "raw-secret" } as never), { name: "legacy", url: "https://example.com/mcp", auth: { type: "bearer" } });
  const kept = await prepareSources(env, "tenant", "definition", "mcpServers", [{ name: "shop", url: "https://example.com/mcp", allowTools: ["read"] }], sources);
  assert.deepEqual(kept[0].sealed, sources[0].sealed);
  const moved = await prepareSources(env, "tenant", "definition", "mcpServers", [{ name: "shop", url: "https://other.example/mcp" }], sources);
  assert.equal(moved[0].sealed, undefined);
  await assert.rejects(prepareSources(env, "tenant", undefined, "mcpServers", [{ name: "shop", url: "https://example.com/mcp", headers: { Authorization: "secret" } }]), /no credentials/);
  for (const url of ["http://example.com", "https://127.0.0.1", "https://metadata.internal", "https://name:secret@example.com"]) assert.throws(() => sourceUrl(url, {}));
});

test("MCP sources page tool discovery and call only allowed names", async t => {
  const calls: any[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    calls.push(message);
    if (!message.id) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fixture", version: "1" } } : message.method === "tools/list" ? message.params.cursor ? { tools: [{ name: "second", inputSchema: { type: "object" } }] } : { tools: [{ name: "first", inputSchema: { type: "object" } }], nextCursor: "next" } : { content: [{ type: "text", text: JSON.stringify(message.params.arguments) }] };
    response.writeHead(200, { "Content-Type": "application/json", "Mcp-Session-Id": "fixture-session" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { API_TOKEN: "unit-test", TEST_MODE: "1" }, url = `http://127.0.0.1:${(server.address() as any).port}/mcp`;
  const mcpServers = await prepareSources(env, "tenant", undefined, "mcpServers", [{ name: "fixture", url, allowTools: ["second"] }]);
  const tools = await sourceTools(env, "tenant", undefined, { mcpServers });
  assert.deepEqual(tools.map(tool => tool.name), ["fixture__second"]);
  const result = await tools[0].execute({ key: 7 }, undefined as never, undefined as never);
  assert.deepEqual(result.output, [{ type: "text", text: '{"key":7}' }]);
  assert.equal(calls.filter(call => call.method === "tools/list").length, 2);
  assert.equal(calls.at(-1).params.name, "second");
});

test("MCP streamed responses settle at their matching JSON-RPC result", async t => {
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (!message.id) { response.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? {} : message.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "streamed" }] };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    const timer = setTimeout(() => response.end(), 2000);
    response.on("close", () => clearTimeout(timer));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const start = Date.now(), env = { API_TOKEN: "unit-test", TEST_MODE: "1" };
  const [tool] = await sourceTools(env, "tenant", undefined, { mcpServers: [{ name: "stream", url: `http://127.0.0.1:${(server.address() as any).port}/mcp` }] });
  assert.deepEqual((await tool.execute({}, undefined as never, undefined as never)).output, [{ type: "text", text: "streamed" }]);
  assert.ok(Date.now() - start < 1500, "must not wait for the long-lived SSE response to end");
});

test("remote code limits reject excessive calls and arguments and bound each result", async () => {
  const seen: any[] = [];
  const oversized = boundedExchange(async messages => { seen.push(...messages); return null; });
  assert.deepEqual(await oversized([{ type: "call", target: "tool", id: 1, name: "echo", args: "x".repeat(131073) }]), { type: "stop" });
  assert.match(seen[0].error.message, /arguments exceed/);
  assert.equal(seen.some(message => message.type === "call"), false);
  const limited = boundedExchange(async () => ({ type: "result", id: 1, ok: true, payload: "x".repeat(1024 * 1024) }));
  const result = await limited([{ type: "call", target: "tool", id: 1, name: "echo", args: "{}" }]);
  assert.equal(result?.type === "result" && result.ok, false);
  assert.match(result?.type === "result" ? result.payload! : "", /a script gets at most/);
  const counted = boundedExchange(async messages => messages[0]?.type === "call" ? { type: "result", id: messages[0].id, ok: true, payload: "null" } : null);
  for (let i = 1; i <= 256; i++) assert.equal((await counted([{ type: "call", target: "tool", id: i, name: "echo", args: "{}" }]))?.type, "result");
  assert.deepEqual(await counted([{ type: "call", target: "tool", id: 257, name: "echo", args: "{}" }]), { type: "stop" });
  const workflow = boundedExchange(async messages => messages[0]?.type === "call" ? { type: "result", id: messages[0].id, ok: true, payload: "null" } : null, true);
  for (let i = 1; i <= 257; i++) assert.equal((await workflow([{ type: "call", target: "tool", id: i, name: "delegate", args: "{}" }]))?.type, "result");
});

test("remote output preserves bounded UTF-8 text and limits image output", async () => {
  const seen: any[] = [], limited = boundedExchange(async messages => { seen.push(...messages); return null; });
  await limited([{ type: "output", item: { type: "text", text: "a".repeat(127999) + "€" } }]);
  assert.equal(seen[0].item.text, "a".repeat(127999));
  assert.match(seen[1].item.text, /Output stops here/);
  assert.equal(seen[0].item.text.includes("�"), false);
  await limited(Array.from({ length: 17 }, () => ({ type: "output" as const, item: { type: "image" as const, data: "AAAA", mimeType: "image/png" } })));
  assert.equal(seen.filter(message => message.item.type === "image").length, 16);
  assert.equal(seen.filter(message => /Images past/.test(message.item.text ?? "")).length, 1);
});

test("ask_user validates answers against the same question policy as src", () => {
  const questions = questionsInput([{ question: "Which region?", header: "Region", options: [{ label: "East" }, { label: "West" }] }]);
  const input = { question: "Which region?", kind: "question" as const, detail: { questions } };
  assert.equal(answerHuman(input, { action: "accept", content: { answers: { "Which region?": "West" } } }).answer, '{"answers":{"Which region?":"West"}}');
  assert.throws(() => answerHuman(input, { action: "accept", content: { answers: { "Which region?": "North" } } }), /Answer/);
});

test("sandbox routing shares the session and retains three slots until RPC completion", async () => {
  const releases: (() => void)[] = [], names: string[] = [];
  const remote = isolatedSandboxRemote({ agentKey: "session", getByName: name => { names.push(name); return { execute: () => new Promise<void>(resolve => releases.push(resolve)) }; } });
  const request = {} as never, exchange = async () => null;
  const active = [remote().execute(request, exchange), remote().execute(request, exchange), remote().execute(request, exchange)];
  await assert.rejects(remote().execute(request, exchange), /concurrency limit/);
  assert.deepEqual(names, ["session", "session", "session"]);
  releases.forEach(release => release());
  await Promise.all(active);
  assert.throws(() => isolatedSandboxRemote({ agentKey: "session", getByName: () => ({ execute: async () => {} }), maxConcurrent: 4 }), /Invalid/);
});

test("shared fs shim reads UTF-8 windows and round-trips typed bytes through file tools", async () => {
  const files = new Map<string, Uint8Array>();
  const original = [{ name: "read" }, { name: "write" }, { name: "ls", execute: async () => ({ output: [{ type: "text", text: JSON.stringify([...files.keys()].map(path => ({ path }))) }] }) }] as ToolRegistration[];
  const wrapped = compatibleFileTools(original, async (path, init) => {
    if (init.method === "PUT") { files.set(path, new Uint8Array(init.body as Uint8Array)); return Response.json({ path }); }
    return files.has(path) ? new Response(files.get(path)) : new Response(null, { status: 404 });
  });
  const tools = Object.fromEntries(wrapped.map(tool => [tool.name, async (args: unknown) => {
    const result = await tool.execute(args, undefined as never, undefined as never);
    return result.structuredOutput ?? result.output?.find(part => part.type === "text")?.text;
  }]));
  const run = new Function("tools", `return (async () => { ${FS_SHIM}\n const fs = require('node:fs'); await fs.writeFile('/workspace/unicode.txt', 'héllo'); await fs.writeFile('/workspace/bytes.bin', new Uint8Array([0,255,128])); return [await fs.readFile('/workspace/unicode.txt'), await fs.readFile('/workspace/bytes.bin','base64'), await fs.readdir('/workspace'), await fs.exists('/workspace/missing')]; })()`);
  assert.deepEqual(await run(tools), ["héllo", "AP+A", ["unicode.txt", "bytes.bin"], false]);
});
