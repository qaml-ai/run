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

test("source validation seals definition credentials and rejects inline secrets/private URLs", async () => {
  const env = { API_TOKEN: "unit-test-key-with-32-characters-long", AGENT_SECRETS_KEY: "22".repeat(32), TEST_MODE: "1" };
  const sources = await prepareSources(env, "tenant", "definition", "mcpServers", [{ name: "shop", url: "https://example.com/mcp", auth: { type: "bearer", token: "test-value" } }]);
  assert.ok(sources[0].sealed);
  assert.equal(JSON.stringify(sources).includes("test-value"), false);
  assert.equal("sealed" in sourceView(sources[0]), false);
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
