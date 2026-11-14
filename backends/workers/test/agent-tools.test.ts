import { Outbound } from "../src/security-outbound.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { toolSourceViews } from "../src/tool-sources.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { AttachedTools, resolveSpawnDirective } from "../src/attached-tools.ts";
import { prepareSources, sourceTools, sourceView, sourceUrl } from "../src/tool-sources.ts";
import { questionsInput } from "../src/input-policy.ts";
import { answerHuman } from "../src/human.ts";
import { isolatedSandboxRemote } from "../codemode/routing.ts";
import { compatibleFileTools } from "../src/fs-tools.ts";
import { FS_SHIM } from "../codemode/fs-shim.ts";
import { boundedExchange } from "../codemode/limits.ts";
import { CODE_MODE_EXCHANGE } from "../codemode/exchange.ts";
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

test("attached progress notifications preserve their message and final result", async () => {
  const attached = new AttachedTools(), updates: unknown[] = [];
  const handle = attached.attach(frame => {
    const message = (frame as any).message;
    if (!message.id) return;
    queueMicrotask(() => {
      if (message.method === 'tools/call') attached.receive({ method: 'notifications/progress', params: { progressToken: message.params._meta.progressToken, progress: 1, total: 2, message: 'halfway' } }, handle.id);
      attached.receive({ id: message.id, result: message.method === 'initialize' ? {} : { content: [{ type: 'text', text: 'done' }] } }, handle.id);
    });
  });
  await handle.start();
  const answer = await attached.call('lookup', {}, 1000, undefined, { onProgress: value => updates.push(value) });
  assert.deepEqual(updates, [{ progress: 1, total: 2, message: 'halfway' }]);
  assert.deepEqual(answer.content, [{ type: 'text', text: 'done' }]);
  handle.close();
});

test("failed tool discovery is unlisted when the agent is idle and refresh exposes the error", () => {
  const config = { mcpServers: [{ name: "gone", url: "https://gone.example/mcp" }] };
  const failures = [{ kind: "mcp" as const, source: "gone", message: "Could not connect" }];
  const [idle] = toolSourceViews(config, [], false, failures, false);
  assert.equal(idle.status, "unlisted");
  assert.deepEqual(idle.tools, []);
  assert.equal(idle.error, undefined);
  const [active] = toolSourceViews(config, [], false, failures, true);
  assert.equal(active.status, "error");
  assert.equal(active.error, "Could not connect");
});

test("tool spawn directives require trusted runtime auth and direct model calls", async () => {
  const directive = { agent: "client_" + "a".repeat(40), task: "work" };
  const result = { _meta: { "camelrun/spawn": directive }, content: [{ type: "text", text: "starting" }] };
  const direct = { taskId: 1, callId: "call", getTask: async () => ({ input: { kind: "model", callId: "call", assistant: 2 } }) } as never;
  const context = {} as never;
  await assert.rejects(resolveSpawnDirective(result, "sneak", direct, context), /only a tool server with auth "runtime" may/);
  let called = 0;
  const spawn = async (name: string, value: unknown) => { called++; assert.equal(name, "trusted__work"); assert.deepEqual(value, directive); return { structuredContent: { agentId: directive.agent } }; };
  assert.deepEqual(await resolveSpawnDirective(result, "trusted__work", direct, context, spawn), { structuredContent: { agentId: directive.agent } });
  const nested = { taskId: 1, callId: "inner", getTask: async (id: number) => ({ input: id === 1 ? { kind: "nested", parent: 2, key: "c1" } : { kind: "model", callId: "call", assistant: 2 } }) } as never;
  await assert.rejects(resolveSpawnDirective(result, "trusted__work", nested, context, spawn), /call it directly, not from code/);
  assert.equal(called, 1);
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
  await assert.rejects(attached.call("charge", {}), { code: "connection_lost", outcomeUnknown: true });
  assert.equal(calls, 1);
});

test("hibernation restores an initialized application connection with its existing SDK identity", async () => {
  const attached = new AttachedTools();
  const frames: any[] = [];
  attached.restore("persisted-connection", frame => {
    const message = (frame as any).message;
    frames.push(message);
    queueMicrotask(() => attached.receive({ id: message.id, result: { content: [{ type: "text", text: "restored" }] } }, "persisted-connection"));
  });
  assert.equal(await attached.waitUntilReady(), true);
  assert.deepEqual(await attached.call("echo", {}), { content: [{ type: "text", text: "restored" }] });
  assert.deepEqual(frames.map(message => message.method), ["tools/call"]);
  attached.close("persisted-connection");
  assert.equal(attached.connected, false);
});

test("application admission waits for a reconnect and its initialization", async () => {
  const attached = new AttachedTools();
  const ready = attached.waitUntilReady();
  await new Promise(resolve => setTimeout(resolve, 20));
  const connection = attached.attach(frame => {
    const message = (frame as any).message;
    if (message.method === "initialize")
      queueMicrotask(() => attached.receive({ id: message.id, result: {} }, connection.id));
  });
  await connection.start();
  assert.equal(await ready, true);
  connection.close();
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

test("reconnecting a lost stream reports its in-flight call as unknown without replay", async () => {
  const attached = new AttachedTools();
  let calls = 0;
  const owner = attached.attach(frame => {
    const message = (frame as any).message;
    if (message.method === "initialize") queueMicrotask(() => attached.receive({ id: message.id, result: {} }, owner.id));
    if (message.method === "tools/call") calls++;
  });
  owner.start(); await attached.waitUntilReady();
  const pending = attached.call("save", {}), rejected = assert.rejects(pending, error => (error as any).code === "connection_lost" && (error as any).outcomeUnknown === true);
  await Promise.resolve();
  const replacement = attached.attach(() => {}, owner.id);
  await rejected;
  assert.equal(calls, 1);
  assert.throws(() => attached.receive({ id: "late", result: {} }, owner.id), { code: "APPLICATION_REPLACED" });
  replacement.close();
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
  for (const url of ["http://example.com", "https://127.0.0.1", "https://name:secret@example.com"]) assert.throws(() => sourceUrl(url, {}));
  const outbound = new Outbound({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
  await assert.rejects(outbound.reachable(sourceUrl("https://metadata.internal", {})), /resolves to.*private, local or reserved/);
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
  const oversized = boundedExchange(async messages => { seen.push(...messages); return null; }, CODE_MODE_EXCHANGE);
  assert.deepEqual(await oversized([{ type: "call", target: "tool", id: 1, name: "echo", args: "x".repeat(131073) }]), { type: "stop" });
  assert.match(seen[0].error.message, /arguments exceed/);
  assert.equal(seen.some(message => message.type === "call"), false);
  const limited = boundedExchange(async () => ({ type: "result", id: 1, ok: true, payload: "x".repeat(1024 * 1024) }), CODE_MODE_EXCHANGE);
  const result = await limited([{ type: "call", target: "tool", id: 1, name: "echo", args: "{}" }]);
  assert.equal(result?.type === "result" && result.ok, false);
  assert.match(result?.type === "result" ? result.payload! : "", /a script gets at most/);
  const counted = boundedExchange(async messages => messages[0]?.type === "call" ? { type: "result", id: messages[0].id, ok: true, payload: "null" } : null, CODE_MODE_EXCHANGE);
  for (let i = 1; i <= 256; i++) assert.equal((await counted([{ type: "call", target: "tool", id: i, name: "echo", args: "{}" }]))?.type, "result");
  assert.deepEqual(await counted([{ type: "call", target: "tool", id: 257, name: "echo", args: "{}" }]), { type: "stop" });
});

test("remote output preserves bounded UTF-8 text and limits image output", async () => {
  const seen: any[] = [], limited = boundedExchange(async messages => { seen.push(...messages); return null; }, CODE_MODE_EXCHANGE);
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
  const remote = isolatedSandboxRemote({ agentKey: "session", exchange: CODE_MODE_EXCHANGE, getByName: name => { names.push(name); return { execute: () => new Promise<void>(resolve => releases.push(resolve)) }; } });
  const request = {} as never, exchange = async () => null;
  const active = [remote().execute(request, exchange), remote().execute(request, exchange), remote().execute(request, exchange)];
  await assert.rejects(remote().execute(request, exchange), /concurrency limit/);
  assert.deepEqual(names, ["session", "session", "session"]);
  releases.forEach(release => release());
  await Promise.all(active);
  assert.throws(() => isolatedSandboxRemote({ agentKey: "session", exchange: CODE_MODE_EXCHANGE, getByName: () => ({ execute: async () => {} }), maxConcurrent: 4 }), /Invalid/);
});

test("shared fs shim reads UTF-8 windows and round-trips typed bytes through file tools", async () => {
  const files = new Map<string, Uint8Array>();
  let reads = 0, writes = 0;
  const original = [
    { name: "read", execute: async ({ path, offset = 0, length = 131072, encoding }: any) => {
      reads++;
      const bytes = files.get(path);
      if (!bytes) throw Object.assign(new Error("Missing file"), { status: 404 });
      const value = encoding === "base64" ? { data: Buffer.from(bytes.subarray(offset, offset + length)).toString("base64"), ...(offset + length < bytes.length ? { nextOffset: offset + length } : {}) } : new TextDecoder().decode(bytes);
      return { output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
    } },
    { name: "write", execute: async ({ path, content, encoding }: any) => {
      writes++;
      files.set(path, encoding === "base64" ? Buffer.from(content, "base64") : new TextEncoder().encode(content));
      return { output: [{ type: "text", text: JSON.stringify({ path }) }] };
    } },
    { name: "ls", execute: async () => ({ output: [{ type: "text", text: JSON.stringify([...files.keys()].map(path => ({ path }))) }] }) },
  ] as ToolRegistration[];
  const wrapped = compatibleFileTools(original);
  const tools = Object.fromEntries(wrapped.map(tool => [tool.name, async (args: unknown) => {
    const result = await tool.execute(args, undefined as never, undefined as never);
    return result.structuredOutput ?? result.output?.find(part => part.type === "text")?.text;
  }]));
  const run = new Function("tools", `return (async () => { ${FS_SHIM}\n const fs = require('node:fs'); await fs.writeFile('/workspace/unicode.txt', 'héllo'); await fs.writeFile('/workspace/bytes.bin', new Uint8Array([0,255,128])); return [await fs.readFile('/workspace/unicode.txt'), await fs.readFile('/workspace/bytes.bin','base64'), await fs.readdir('/workspace'), await fs.exists('/workspace/missing')]; })()`);
  assert.deepEqual(await run(tools), ["héllo", "AP+A", ["unicode.txt", "bytes.bin"], false]);
  assert.equal(writes, 2, "writes retain the native version guards and output callback");
  assert.equal(reads, 3, "reads retain the native size limit and remembered version");
  const direct = await wrapped[0].execute({ path: "/workspace/unicode.txt" }, undefined as never, undefined as never);
  assert.equal(direct.output?.[0]?.type === "text" && direct.output[0].text, "héllo", "direct model reads remain plain text");
  assert.deepEqual(direct.structuredOutput, { path: "/workspace/unicode.txt", content: "héllo" });
});

test("direct file reads expose source-compatible content without changing native output or line windows", async () => {
  const output = [{ type: "text" as const, text: '{"changed":true}' }];
  const diagnostics = [{ severity: "info" as const, message: "native diagnostic" }];
  const args = { path: "/docs/readme.md", offset: 2, limit: 1 };
  let reads = 0;
  const [read] = compatibleFileTools([{
    name: "read",
    execute: async input => {
      reads++;
      assert.strictEqual(input, args, "native read retains its line window and version callback");
      return { output, diagnostics };
    },
  } as ToolRegistration]);
  const result = await read.execute(args, undefined as never, undefined as never);
  assert.deepEqual(result.structuredOutput, { path: "/docs/readme.md", content: '{"changed":true}' });
  assert.strictEqual(result.output, output);
  assert.strictEqual(result.diagnostics, diagnostics);
  assert.equal(reads, 1);
});

test('repo file tools preserve the existing model descriptions byte for byte',async()=>{
  const {readFile}=await import('node:fs/promises');
  const old=JSON.parse(await readFile(new URL('./fixtures/file-tool-descriptions.json',import.meta.url),'utf8'));
  const repo=await readFile(new URL('../src/repos/tools.ts',import.meta.url),'utf8');
  for(const name of ['read','write','ls','present_file','edit','glob','grep']) {
    const pattern=new RegExp('name: "'+name+'",\\s+description:\\s*("(?:\\\\.|[^"\\\\])*")');
    assert.equal(JSON.parse(repo.match(pattern)![1]),old[name],name);
    assert.ok(repo.match(pattern),name);
  }
  const copy=/description:\s*("Copy or move[^\n]+")/;
  assert.equal(JSON.parse(repo.match(copy)![1]),old.cp);
});
