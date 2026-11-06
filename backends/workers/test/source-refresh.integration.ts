import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";

test("source refresh retries unavailable MCP discovery and controls schema output", { timeout: 90000 }, async t => {
  const fixture = await startFixture();
  t.after(() => fixture.stop());
  let available = false, listings = 0;
  const server = createServer(async (request, response) => {
    if (!available) { response.writeHead(503).end(); return; }
    let text = ""; for await (const chunk of request) text += chunk;
    const message = JSON.parse(text);
    if (!message.id) { response.writeHead(202).end(); return; }
    if (message.method === "tools/list") listings++;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "tools/list" ? { tools: [{ name: "lookup", description: "Look up a record", inputSchema: { type: "object", properties: { id: { type: "string" } } } }] } : {} }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const headers = { Authorization: `Bearer ${fixture.token}`, "content-type": "application/json" };
  const created = await fetch(fixture.url + "/v1/agents", { method: "POST", headers, body: JSON.stringify({ fileTools: false, codeMode: false, mcpServers: [{ name: "records", url: `http://127.0.0.1:${(server.address() as any).port}/mcp` }] }) });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  const read = async (query = "") => {
    const response = await fetch(`${fixture.url}/v1/agents/${id}${query}`, { headers });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ toolSources: { name: string; status: string; tools: { name: string; parameters?: unknown }[] }[] }>;
  };
  assert.equal((await read()).toolSources.find(source => source.name === "records")?.status, "error");
  available = true;
  const refreshed = (await read("?refresh=true&schemas=true")).toolSources.find(source => source.name === "records")!;
  assert.equal(refreshed.status, "listed");
  assert.equal(refreshed.tools[0].name, "records__lookup");
  assert.deepEqual(refreshed.tools[0].parameters, { type: "object", properties: { id: { type: "string" } } });
  assert.equal((await read()).toolSources.find(source => source.name === "records")!.tools[0].parameters, undefined);
  assert.equal(listings, 1);
  assert.equal((await fetch(`${fixture.url}/v1/agents/${id}?refresh=yes`, { headers })).status, 400);
});
