import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { attach, listen, runtime, sleep, toolCall, toolResults, type T } from "./runtime-server.ts";

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

const slow = { name: "slow", description: "Takes a while", inputSchema: { type: "object", properties: {} }, _meta: { "agent-runtime/exposure": "direct", "agent-runtime/timeoutMs": 1500 } };

test("an attached tool's own timeoutMs bounds its call; progress extends it; a timeout is an unknown outcome, in the run's outcome too", async t => {
  const r = await runtime(t, (_body, index) => index % 2 === 0 ? toolCall("slow", {}, `call_${index}`) : { role: "assistant", content: "done" });
  const created = (await r.call("/v1/agents", { body: { mcp: { tools: [slow] } } })).json;
  let progressing = false;
  await attach(t, r.base, created.id, created.token, async (_call, { reply, progress }) => {
    for (let elapsed = 0; elapsed < 3_000; elapsed += 500) {
      await sleep(500);
      if (progressing) await progress(elapsed);
    }
    await reply({ content: [{ type: "text", text: "finished" }] });
  });

  const timedOut = await r.prompt(created.id, "go");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /outcome is unknown/);
  assert.deepEqual(timedOut.outcome.result.toolErrors, [{ tool: "slow", toolCallId: "call_0", code: "timeout", outcomeUnknown: true, message: timedOut.outcome.result.toolErrors[0].message }]);
  assert.match(timedOut.outcome.result.toolErrors[0].message, /1500 ms/);

  progressing = true;
  const extended = await r.prompt(created.id, "again");
  assert.equal(toolResults(r.model.bodies[3]).at(-1), "finished", "progress kept it alive past 1.5 s");
  assert.equal(extended.outcome.result.toolErrors, undefined);
});

test("a tool source that cannot be listed is named in every run's outcome", async t => {
  const guarded = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the body */ }
    res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "down for maintenance" }));
  });
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }), LOCAL);
  const definition = (await r.call("/v1/definitions", { body: { name: "Tools", mcpServers: [{ name: "crm", url: `${guarded}/mcp` }] } })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id } })).json.id as string;
  const done = await r.prompt(agent, "go");
  assert.equal(done.outcome.result.reply, "done", "the run goes on without its tools");
  assert.equal(done.outcome.result.sourceErrors.length, 1);
  assert.deepEqual([done.outcome.result.sourceErrors[0].kind, done.outcome.result.sourceErrors[0].source], ["mcp", "crm"]);
  assert.match(done.outcome.result.sourceErrors[0].message, /down for maintenance/);
});

test("an MCP server is listed when its definition is saved: refused credentials are a 400 then, and what it lists or why it could not is in the answer", async t => {
  const refusing = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the body */ }
    res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" }).end(JSON.stringify({ error: "invalid token" }));
  });
  const down = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the body */ }
    res.writeHead(503).end("down");
  });
  const good = await mcpServer(t, { echo: () => ({ content: [] }), ping: () => ({ content: [] }) });
  const r = await runtime(t, () => ({ role: "assistant", content: "ok" }), LOCAL);
  const refused = await r.call("/v1/definitions", { body: { name: "Crm", mcpServers: [{ name: "crm", url: `${refusing}/mcp`, auth: { type: "bearer", token: "wrong" } }] } });
  assert.equal(refused.status, 400, refused.text);
  assert.match(refused.json.error, /crm[\s\S]*(401|credentials)/);

  const saved = await r.call("/v1/definitions", { body: { name: "Mixed", mcpServers: [{ name: "tools", url: good.url }, { name: "later", url: `${down}/mcp` }] } });
  assert.equal(saved.status, 201, saved.text);
  const status = Object.fromEntries(saved.json.toolSources.map((source: any) => [source.name, source]));
  assert.deepEqual([status.tools.status, status.tools.tools.map((tool: any) => tool.name)], ["listed", ["tools__echo", "tools__ping"]]);
  assert.equal(status.later.status, "error", "a server that is down is saved, and says so");
  const patched = await r.call(`/v1/definitions/${saved.json.id}`, { method: "PATCH", body: { mcpServers: [{ name: "tools", url: `${refusing}/mcp` }] } });
  assert.equal(patched.status, 400, "an edit is checked too");
});
