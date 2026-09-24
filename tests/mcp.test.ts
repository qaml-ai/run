import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { listen, runtime, sleep, toolCall, toolResults, type T } from "./runtime-server.ts";

const PNG = "iVBORw0KGgo=";
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
    server.registerTool("fail", { description: "Always fails" }, async () => ({ isError: true, content: [{ type: "text", text: "it broke" }] }));
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
    toolCall("js_exec", { code: "const r = await tools.kb__echo({ text: 'from code' }); return r.content[0].text;" }),
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
  assert.match(toolResults(r.model.bodies[2]).at(-1), /from code/);
  assert.match(toolResults(r.model.bodies[3]).at(-1), /a dot/);
  assert.match(JSON.stringify(r.model.bodies[4].messages), /data:image\/png;base64,iVBORw0KGgo=/, "the image reaches the model");
  assert.match(toolResults(r.model.bodies[4]).at(-1), /it broke/);
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
  assert.deepEqual(tools(0), [], "codemode tools are reached through js_exec, not declared to the model");
  const inCode = r.model.bodies[0].tools.find((tool: any) => tool.function.name === "js_exec");
  assert.ok(inCode);

  mcp.addTool();
  await sleep(500);
  // Direct exposure shows the list the model gets; the new tool is in it without waiting out the cache.
  const direct = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { mcpServers: [{ name: "kb", url: mcp.url, exposure: "direct" }] } });
  assert.deepEqual(direct.json.mcpServers[0].headerNames, ["Authorization", "X-Team"], "credentials were kept");
  await r.prompt((await r.call("/v1/agents", { body: { definition: definition.id } })).json.id, "hi");
  assert.deepEqual(tools(1), ["kb__echo", "kb__fail", "kb__hidden_tool", "kb__later", "kb__picture"]);

  // Moving the server to another origin drops its credentials: they belong to the old one.
  const other = await listen(t, (_req, res) => res.writeHead(401).end());
  const moved = await r.call(`/v1/definitions/${definition.id}`, { method: "PATCH", body: { mcpServers: [{ name: "kb", url: `${other}/mcp`, exposure: "direct" }] } });
  assert.equal(moved.json.mcpServers[0].headerNames, undefined);
  assert.deepEqual([...mcp.seen.authorizations], ["Bearer s3cret"]);
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
