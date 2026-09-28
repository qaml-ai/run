import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { listen, runtime, toolCall, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

/** A stateless MCP server answering in JSON: each tool is (arguments, params) => result. It records each call's params. */
export async function mcpServer(t: T, tools: Record<string, (args: any, params: any) => object | Promise<object>>) {
  const calls: any[] = [];
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    const message = JSON.parse(text);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    const reply = (result: object) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    if (message.method === "initialize") return reply({ protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
    if (message.method === "tools/list") return reply({ tools: Object.keys(tools).map(name => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) });
    if (message.method === "tools/call") { calls.push(message.params); return reply(await tools[message.params.name](message.params.arguments, message.params)); }
    reply({});
  });
  return { url: `${url}/mcp`, calls };
}

const key = (agent: string, toolCallId: string, innerCallId?: string) => createHash("sha256").update(`${agent}:${toolCallId}:${innerCallId ?? ""}`).digest("hex").slice(0, 32);

test("every tool call carries a stable idempotency key: MCP servers in _meta, OpenAPI operations as an Idempotency-Key header", async t => {
  const server = await mcpServer(t, { echo: () => ({ content: [{ type: "text", text: "echoed" }] }) });
  const headers: (string | undefined)[] = [];
  const api = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the body */ }
    const path = new URL(req.url!, "http://x").pathname;
    if (path === "/openapi.json") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ openapi: "3.0.3", info: { title: "Notes", version: "1" }, servers: [{ url: `http://${req.headers.host}/v1` }],
        paths: { "/notes": { post: { operationId: "addNote", responses: { 200: { description: "ok" } } } } } }));
      return;
    }
    headers.push(req.headers["idempotency-key"] as string | undefined);
    res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  const r = await runtime(t, (_body, index) => [
    toolCall("tools__echo", {}, "call_direct"),
    toolCall("js_exec", { code: "await tools.tools__echo({}); await tools.notes__addNote({}); return 1" }, "call_code"),
    { role: "assistant", content: "done" },
  ][index], LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Tools", mcpServers: [{ name: "tools", url: server.url, exposure: "both" }], openApi: [{ name: "notes", spec: `${api}/openapi.json` }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id as string;
  await r.prompt(agent, "go");
  assert.deepEqual(server.calls.map(call => call._meta["agent-runtime/idempotencyKey"]), [key(agent, "call_direct"), key(agent, "call_code", "call_code:1")]);
  assert.deepEqual(headers, [key(agent, "call_code", "call_code:2")]);
});
