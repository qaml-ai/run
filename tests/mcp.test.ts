import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { listen, runtime, sleep, toolCall, toolResults, until, type T } from "./runtime-server.ts";
import { PNG as FIXTURE_PNG } from "./file-fixtures.ts";

const PNG = FIXTURE_PNG.toString("base64");
const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

/** A Streamable HTTP MCP server with a few tools, which wants a bearer token. */
async function mcpServer(t: T, token = "s3cret") {
  const seen = { requests: 0, authorizations: new Set<string | undefined>(), calls: [] as string[] };
  const servers: McpServer[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const later = { added: false };
  const addLater = (server: McpServer) => server.registerTool("later", { description: "Added later", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "late" }] }));
  const build = () => {
    const server = new McpServer({ name: "kb", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
    const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
    server.registerTool("echo", { description: "Echo some text", inputSchema: { text: z.string() } }, async ({ text: value }) => { seen.calls.push(`echo:${value}`); return text(`echo: ${value}`); });
    server.registerTool("picture", { description: "A tiny picture" }, async () => ({ content: [{ type: "text", text: "a dot" }, { type: "image", data: PNG, mimeType: "image/png" }] }));
    server.registerTool("fail", { description: "Always fails" }, async () => ({ isError: true, content: [{ type: "text", text: "it broke" }, { type: "image", data: PNG, mimeType: "image/png" }], structuredContent: { reason: "broken" } }));
    server.registerTool("hidden.tool", { description: "Denied by the definition" }, async () => text("should not be called"));
    if (later.added) addLater(server);
    servers.push(server);
    return server;
  };
  const url = await listen(t, async (req, res) => {
    seen.requests++;
    seen.authorizations.add(req.headers.authorization);
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    let body: unknown;
    if (req.method === "POST") {
      let text = "";
      for await (const chunk of req) text += chunk;
      body = JSON.parse(text);
    }
    const id = req.headers["mcp-session-id"] as string | undefined;
    let transport = id ? sessions.get(id) : undefined;
    if (!transport) {
      if (id || !isInitializeRequest(body)) { res.writeHead(404).end(); return; }
      const created = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, onsessioninitialized: session => { sessions.set(session, created); } });
      await build().connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, body);
  });
  t.after(async () => { for (const server of servers) await server.close().catch(() => {}); });
  return {
    url: `${url}/mcp`, seen,
    /** Add a tool on every live session: each tells its client that the list changed. */
    addTool() { later.added = true; for (const server of servers) addLater(server); },
  };
}

test("an MCP server's tools reach the model and js_exec; its credentials are sealed and go only to it", async t => {
  const mcp = await mcpServer(t);
  const r = await runtime(t, (_body, index) => [
    toolCall("kb__echo", { text: "hi" }),
    // Code gets the tool's data, not the MCP envelope: here its one text block.
    toolCall("js_exec", { code: "const r = await tools.kb__echo({ text: 'from code' }); return r.toUpperCase();" }),
    toolCall("kb__picture", {}),
    toolCall("kb__fail", {}),
    toolCall("kb__echo", { words: "no text" }),
  ][index] ?? { role: "assistant", content: "done" }, LOCAL);
  const created = await r.call("/v1/definitions", { body: { name: "Knowledge", mcpServers: [{ name: "kb", url: mcp.url, auth: { type: "bearer", token: "s3cret" }, exposure: "both", denyTools: ["hidden.tool"] }] } });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.mcpServers, [{ name: "kb", url: mcp.url, auth: { type: "bearer" }, exposure: "both", denyTools: ["hidden.tool"] }]);
  for (const text of [created.text, (await r.call(`/v1/definitions/${created.json.id}`)).text, (await r.call("/v1/definitions")).text, JSON.stringify((await r.db.query("select * from definitions")).rows)]) {
    assert.equal(text.includes("s3cret"), false);
  }

  const agent = (await r.call("/v1/agents", { body: { definition: created.json.id } })).json;
  assert.equal(JSON.stringify((await r.db.query("select header from agents where id = $1", [agent.id])).rows).includes("s3cret"), false, "the agent's copy is sealed too");
  const outcome = await r.prompt(agent.id, "use the knowledge base");
  assert.equal(outcome.outcome.result.reply, "done");
  const offered = r.model.bodies[0].tools.map((tool: any) => tool.function.name);
  assert.deepEqual(offered.filter((name: string) => name.startsWith("kb__")).sort(), ["kb__echo", "kb__fail", "kb__picture"]);
  assert.ok(offered.includes("js_exec"));
  assert.match(toolResults(r.model.bodies[1]).at(-1), /echo: hi/);
  assert.match(toolResults(r.model.bodies[2]).at(-1), /ECHO: FROM CODE/);
  assert.match(toolResults(r.model.bodies[3]).at(-1), /a dot/);
  assert.ok(JSON.stringify(r.model.bodies[4].messages).includes(`data:image/png;base64,${PNG}`), "the image reaches the model");
  assert.match(toolResults(r.model.bodies[4]).at(-2), /\[File \/workspace\/tool-outputs\/kb__picture\/[a-f0-9]{8}\/image-1\.png \(image\/png/, "and is saved to the workspace");
  assert.match(toolResults(r.model.bodies[4]).at(-1), /it broke/);
  // A failed call returned, not thrown, is an error result that keeps what the tool gave: its image and structured content.
  const failed = (await r.call(`/v1/agents/${agent.id}/history`)).json.messages.find((message: any) => message.role === "toolResult" && message.toolName === "kb__fail");
  assert.equal(failed.isError, true);
  assert.deepEqual(failed.details, { reason: "broken" });
  assert.ok(failed.content.some((part: any) => part.type === "file" && part.contentType === "image/png") || failed.content.some((part: any) => part.type === "image"), JSON.stringify(failed.content));
  assert.match(toolResults(r.model.bodies[5]).at(-1), /Validation failed[\s\S]*required properties text/, "arguments are checked against the server's schema before it is called");
  assert.deepEqual(mcp.seen.calls, ["echo:hi", "echo:from code"]);
  assert.deepEqual([...mcp.seen.authorizations], ["Bearer s3cret"]);
});

test("tool lists refresh when the server says they changed, and edits keep sealed credentials", async t => {
  const mcp = await mcpServer(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "KB", mcpServers: [{ name: "kb", url: mcp.url, headers: { Authorization: "Bearer s3cret", "X-Team": "blue" } }] } })).json;
  assert.deepEqual(definition.mcpServers[0].headerNames, ["Authorization", "X-Team"]);
  const tools = (index: number) => r.model.bodies[index].tools.map((tool: any) => tool.function.name).filter((name: string) => name.startsWith("kb__")).sort();
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "hi");
  assert.deepEqual(tools(0), ["kb__echo", "kb__fail", "kb__hidden_tool", "kb__picture"], "a server of a few tools is declared to the model as well, by default");
  const codemode = (await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { mcpServers: [{ name: "kb", url: mcp.url, exposure: "codemode" }] } })).json;
  await r.prompt((await r.call("/v1/agents", { body: { definition: codemode.id, name: "codemode" } })).json.id, "hi");
  assert.deepEqual(tools(1), [], "codemode tools are reached through js_exec, not declared to the model");
  const inCode = r.model.bodies[1].tools.find((tool: any) => tool.function.name === "js_exec");
  assert.ok(inCode);

  mcp.addTool();
  await sleep(500);
  // Direct exposure shows the list the model gets; the new tool is in it without waiting out the cache.
  const direct = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { mcpServers: [{ name: "kb", url: mcp.url, exposure: "direct" }] } });
  assert.deepEqual(direct.json.mcpServers[0].headerNames, ["Authorization", "X-Team"], "credentials were kept");
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "hi");
  assert.deepEqual(tools(2), ["kb__echo", "kb__fail", "kb__hidden_tool", "kb__later", "kb__picture"]);

  // Moving the server to another origin drops its credentials: they belong to the old one.
  const other = await listen(t, (_req, res) => res.writeHead(503).end());
  const moved = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { mcpServers: [{ name: "kb", url: `${other}/mcp`, exposure: "direct" }] } });
  assert.equal(moved.json.mcpServers[0].headerNames, undefined);
  assert.deepEqual([...mcp.seen.authorizations], ["Bearer s3cret"]);
});

test("applying a definition lists its servers afresh: a tool added without a list_changed notice reaches the agent at once", async t => {
  // A bare JSON-RPC server whose tools change quietly (no notification), as many servers' do across a deploy.
  const tools = [{ name: "first", description: "First", inputSchema: { type: "object" } }];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const message = text ? JSON.parse(text) : {};
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "quiet", version: "1" } }
      : message.method === "tools/list" ? { tools } : {};
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Quiet", mcpServers: [{ name: "quiet", url: `${url}/mcp`, exposure: "direct" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const offered = (index: number) => r.model.bodies[index].tools.map((tool: any) => tool.function.name).filter((name: string) => name.startsWith("quiet__")).sort();
  await r.prompt(agent, "hi");
  assert.deepEqual(offered(0), ["quiet__first"]);
  tools.push({ name: "second", description: "Second", inputSchema: { type: "object" } });
  const applied = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { systemPrompt: "Use quiet's tools.", apply: "all" } });
  assert.equal(applied.json.applied[0].status !== "failed", true, JSON.stringify(applied.json));
  await until(async () => (await r.call(`/v1/definitions/${definition.id}/agents`)).json[0].revision === 2, "the agent to take revision 2");
  await r.prompt(agent, "again");
  assert.deepEqual(offered(1), ["quiet__first", "quiet__second"], "listed afresh, not from the 5-minute cache");
});

test("an agent shows every tool source and what its model gets, connecting to MCP servers only when asked", async t => {
  const mcp = await mcpServer(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { ...LOCAL, AGENT_IDLE_MS: "1000" });
  const definition = (await r.call("/v1/definitions", { body: { name: "KB", builtins: ["web_fetch"], mcpServers: [
    { name: "kb", url: mcp.url, auth: { type: "bearer", token: "s3cret" }, denyTools: ["hidden.tool"] },
    { name: "gone", url: "http://127.0.0.1:1/mcp" },
  ] } })).json;
  const tools = [{ name: "web_fetch", description: "The application's own fetch", inputSchema: { type: "object", properties: {} } }];
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id, mcp: { tools } } })).json.id;
  const byName = (sources: any[]) => Object.fromEntries(sources.map(source => [source.name, source]));

  // The agent starts once it is made: its sources then show what its tools were built from.
  await until(async () => (await r.call(`/v1/agents/${agent}`)).json.running, "the agent to start");
  let requests = mcp.seen.requests;
  const detail = (await r.call(`/v1/agents/${agent}`)).json;
  let sources = byName(detail.toolSources);
  assert.deepEqual(detail.toolSources.map((source: any) => `${source.kind}:${source.name}`), ["application:application", "files:files", "builtin:web_fetch", "mcp:kb", "mcp:gone"]);
  assert.deepEqual(sources.application, { kind: "application", name: "application", status: "listed", connected: false, tools: [{ name: "web_fetch", description: "The application's own fetch", exposure: "both" }] });
  assert.equal(sources.web_fetch.tools[0].excluded, "an earlier source has a tool of this name", "the application's tool of the same name wins");
  assert.equal(sources.files.tools.every((tool: any) => !tool.excluded && !tool.parameters), true, "schemas only when asked");
  assert.equal(sources.kb.status, "listed");
  assert.equal(typeof sources.kb.listedAt, "number");
  assert.deepEqual(sources.kb.tools.map((tool: any) => tool.name).sort(), ["kb__echo", "kb__fail", "kb__picture"], "denied tools are not offered");
  assert.equal(sources.gone.status, "error");
  assert.match(sources.gone.error, /Could not connect to MCP server 127\.0\.0\.1:1/);
  assert.deepEqual(sources.gone.tools, []);
  assert.equal(JSON.stringify(detail).includes("s3cret"), false);
  assert.equal(mcp.seen.requests, requests, "reading an agent connects to nothing");

  // Stopped, it shows what this node last listed for each server, or that it has not listed one.
  await until(async () => !(await r.call(`/v1/agents/${agent}`)).json.running, "the agent to go idle");
  sources = byName((await r.call(`/v1/agents/${agent}`)).json.toolSources);
  assert.equal(sources.kb.status, "listed");
  assert.equal(sources.kb.tools.length, 3);
  assert.deepEqual([sources.gone.status, sources.gone.tools], ["unlisted", []]);
  assert.equal(mcp.seen.requests, requests);

  const refreshed = byName((await r.call(`/v1/agents/${agent}?refresh=true&schemas=true`)).json.toolSources);
  assert.equal(refreshed.gone.status, "error");
  assert.equal(refreshed.kb.tools.find((tool: any) => tool.name === "kb__echo").parameters.required[0], "text");
  assert.deepEqual(refreshed.files.tools.every((tool: any) => tool.parameters), true);

  // What the sources say the model gets is what it gets.
  await r.prompt(agent, "hi", undefined, { allowDisconnected: true });
  sources = byName((await r.call(`/v1/agents/${agent}`)).json.toolSources);
  const offered = r.model.bodies[0].tools.map((tool: any) => tool.function.name);
  const direct = Object.values(sources).flatMap((source: any) => source.tools).filter((tool: any) => !tool.excluded && tool.exposure !== "codemode").map((tool: any) => tool.name);
  assert.deepEqual(offered.filter((name: string) => name !== "js_exec").sort(), direct.sort());
});

test("MCP servers must be on public addresses, checked when saved and again when connecting", async t => {
  const mcp = await mcpServer(t);
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), { AGENT_OUTBOUND_ALLOW_HTTP: "true" });
  const port = new URL(mcp.url).port;
  for (const url of [mcp.url, `http://169.254.169.254/mcp`, `http://[::1]:${port}/mcp`, `http://2130706433:${port}/mcp`, `ftp://example.com/mcp`, `http://user:pw@example.com/mcp`]) {
    const saved = await r.call("/v1/definitions", { body: { name: "Bad", mcpServers: [{ name: "kb", url }] } });
    assert.equal(saved.status, 400, url);
  }
  // A name is only resolved when connecting; localhost resolves to loopback, so nothing connects.
  const named = await r.call("/v1/definitions", { body: { name: "Sneaky", mcpServers: [{ name: "kb", url: `http://localhost:${port}/mcp`, auth: { type: "bearer", token: "s3cret" }, exposure: "direct" }] } });
  assert.equal(named.status, 201);
  await r.prompt((await r.call("/v1/agents", { body: { definition: named.json.id } })).json.id, "hi");
  assert.equal(r.model.bodies[0].tools.some((tool: any) => tool.function.name.startsWith("kb__")), false);
  assert.equal(mcp.seen.requests, 0);
  const invalid = [{ name: "a__b", url: "https://example.com" }, { name: "x", url: "https://example.com", headers: { Host: "internal" } }, { name: "x", url: "https://example.com", auth: { type: "oauth" } }];
  for (const server of invalid) assert.equal((await r.call("/v1/definitions", { body: { name: "Bad", mcpServers: [server] } })).status, 400, JSON.stringify(server));
});

test("a server that only speaks the older SSE transport is reached through it", async t => {
  const transports = new Map<string, SSEServerTransport>();
  const url = await listen(t, async (req, res) => {
    const path = new URL(req.url!, "http://x").pathname;
    if (req.method === "GET" && path === "/sse") {
      const transport = new SSEServerTransport("/messages", res);
      transports.set(transport.sessionId, transport);
      const server = new McpServer({ name: "legacy", version: "1.0.0" });
      server.registerTool("ping", { description: "Ping" }, async () => ({ content: [{ type: "text", text: "pong" }] }));
      await server.connect(transport);
      return;
    }
    const transport = transports.get(new URL(req.url!, "http://x").searchParams.get("sessionId") ?? "");
    if (req.method === "POST" && path === "/messages" && transport) return transport.handlePostMessage(req, res);
    res.writeHead(405).end();
  });
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("old__ping", {}) : { role: "assistant", content: "done" }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Legacy", mcpServers: [{ name: "old", url: `${url}/sse`, exposure: "direct" }] } })).json;
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "ping it");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /pong/);
});

/** A stateless MCP server whose `deploy` reports progress (twice, by default) before answering; `metas` collects each call's _meta. */
async function progressServer(t: T, delayMs = 0, steps: (readonly [number, string])[] = [[1, "Building"], [2, "Uploading"]]) {
  const metas: any[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const server = new McpServer({ name: "camel", version: "1.0.0" });
    server.registerTool("deploy", { description: "Deploy the app" }, async extra => {
      metas.push(extra._meta);
      for (const [progress, message] of steps) {
        await sleep(delayMs);
        await extra.sendNotification({ method: "notifications/progress", params: { progressToken: extra._meta!.progressToken!, progress, total: 3, message } });
      }
      await sleep(delayMs);
      return { content: [{ type: "text", text: "deployed" }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  });
  return { url: `${url}/mcp`, metas };
}

test("tool servers get the model's call id, js_exec's too, and the actor; their progress reaches the event stream", async t => {
  const server = await progressServer(t);
  const r = await runtime(t, (_body, index) => [
    toolCall("camel__deploy", {}, "call_direct"),
    toolCall("js_exec", { code: "return await tools.camel__deploy({});" }, "call_code"),
  ][index] ?? { role: "assistant", content: "done" }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Camel", mcpServers: [{ name: "camel", url: server.url, exposure: "both" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  const accepted = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "deploy", actor: "u_7" } });
  await until(async () => (await r.call(`/v1/agents/${agent}/requests/${accepted.json.id}`)).json.state === "completed", "the turn");
  assert.match(toolResults(r.model.bodies[2]).at(-1), /deployed/);

  const ids = (meta: any) => ({ toolCallId: meta["agent-runtime/toolCallId"], innerCallId: meta["agent-runtime/innerCallId"], actor: meta["agent-runtime/actor"], progress: meta.progressToken !== undefined });
  assert.deepEqual(server.metas.map(ids), [
    { toolCallId: "call_direct", innerCallId: undefined, actor: "u_7", progress: true },
    { toolCallId: "call_code", innerCallId: "call_code:1", actor: "u_7", progress: true },
  ]);
  const updates = (await r.call(`/v1/agents/${agent}`)).json.events.map((entry: any) => entry.data)
    .filter((data: any) => data.event?.type === "tool_execution_update" && data.event.partialResult.details?.type === "progress").map((data: any) => data.event);
  assert.deepEqual(updates.map((event: any) => [event.toolCallId, event.toolName, event.partialResult.content[0].text, event.partialResult.details]), [
    ["call_direct", "camel__deploy", "Building", { type: "progress", tool: "camel__deploy", progress: 1, total: 3, message: "Building" }],
    ["call_direct", "camel__deploy", "Uploading", { type: "progress", tool: "camel__deploy", progress: 2, total: 3, message: "Uploading" }],
    ["call_code", "js_exec", "Building", { type: "progress", tool: "camel__deploy", innerCallId: "call_code:1", progress: 1, total: 3, message: "Building" }],
    ["call_code", "js_exec", "Uploading", { type: "progress", tool: "camel__deploy", innerCallId: "call_code:1", progress: 2, total: 3, message: "Uploading" }],
  ]);
});

test("a burst of progress is coalesced per call: the stream gets the first, then the latest of each window, and the last before the result", async t => {
  const server = await progressServer(t, 0, Array.from({ length: 40 }, (_, index) => [index + 1, `step ${index + 1}`] as const));
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("camel__deploy", {}) : { role: "assistant", content: "done" }, LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Camel", mcpServers: [{ name: "camel", url: server.url, exposure: "direct" }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id;
  await r.prompt(agent, "deploy");
  const events = (await r.call(`/v1/agents/${agent}`)).json.events.map((entry: any) => entry.data.event).filter(Boolean);
  const progress = events.filter((event: any) => event.type === "tool_execution_update").map((event: any) => event.partialResult.details.progress);
  assert.ok(progress.length < 10, `coalesced (${progress.length} of 40)`);
  assert.equal(progress.at(-1), 40, "the latest progress is not lost");
  assert.deepEqual(progress, [...progress].sort((a: number, b: number) => a - b));
  const end = events.findIndex((event: any) => event.type === "tool_execution_end");
  assert.ok(events.findLastIndex((event: any) => event.type === "tool_execution_update") < end, "every update comes before the call's end");
});

test("a call that keeps reporting progress outlasts its timeout, which limits only silence", async t => {
  // Each step takes longer than half the timeout; together they take over twice it.
  const server = await progressServer(t, 700);
  const r = await runtime(t, (_body, index) => index === 0 ? toolCall("camel__deploy", {}) : { role: "assistant", content: "done" }, LOCAL);
  assert.equal((await r.call("/v1/definitions", { body: { name: "Too long", mcpServers: [{ name: "camel", url: server.url, timeoutMs: 1_200_001 }] } })).status, 400);
  const definition = (await r.call("/v1/definitions", { body: { name: "Camel", mcpServers: [{ name: "camel", url: server.url, exposure: "direct", timeoutMs: 1_000 }] } })).json;
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "deploy");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /deployed/);
});
