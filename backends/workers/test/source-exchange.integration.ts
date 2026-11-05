import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { startFixture } from "./fixture.ts";
import { prepareSources, sourceTools } from "../src/tool-sources.ts";
import { runtimeJwks } from "../src/runtime-identity.ts";
import { verifyRuntimeToken } from "../../../clients/server.ts";

test("MCP exchanges verify runtime identity, cache per agent and refresh once on refusal", async t => {
  const secret = "33".repeat(32), fixture = await startFixture({ vars: { AGENT_SECRETS_KEY: secret } });
  t.after(() => fixture.stop());
  const env = { API_TOKEN: fixture.token, AGENT_SECRETS_KEY: secret, HYPERDRIVE: { connectionString: fixture.databaseUrl }, TEST_MODE: "1" };
  let exchanges = 0, accepted = 0, refused = false;
  const server = createServer(async (request, response) => {
    try {
      let text = ""; for await (const chunk of request) text += chunk;
      if (request.url === "/exchange") {
        const identity = await verifyRuntimeToken(String(request.headers.authorization).slice(7), { tenant: "tenant", runtime: "https://runtime.example", audience: `${base}/exchange`, fetch: async () => Response.json(await runtimeJwks(env)) });
        assert.equal(identity.agent, "agent");
        assert.equal(identity.actor, undefined);
        assert.deepEqual(identity.claims.exchange, { server: "store", url: `${base}/mcp` });
        assert.deepEqual(JSON.parse(text), { server: { name: "store", url: `${base}/mcp` }, tenant: "tenant", definition: "definition", agent: "agent" });
        exchanges++; response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ token: `fixture-token-${exchanges}`, expiresIn: 3600 })); return;
      }
      const message = JSON.parse(text);
      if (message.method === "tools/call" && !refused) { refused = true; response.writeHead(401).end(); return; }
      assert.equal(request.headers.authorization, `Bearer fixture-token-${exchanges}`);
      if (!message.id) { response.writeHead(202).end(); return; }
      if (message.method === "tools/call") accepted++;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? {} : message.method === "tools/list" ? { tools: [{ name: "read", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "value" }] } }));
    } catch (error) { response.writeHead(500).end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const sources = await prepareSources(env, "tenant", "definition", "mcpServers", [{ name: "store", url: `${base}/mcp`, auth: { type: "exchange", url: `${base}/exchange` } }]);
  const [tool] = await sourceTools(env, "tenant", "definition", { mcpServers: sources }, undefined, async () => ({ issuer: "https://runtime.example", claims: { tenant: "tenant", agent: "agent", definition: "definition", sub: "person", act: "actor" } }));
  assert.ok(tool, "exchange authenticated discovery");
  assert.equal(exchanges, 1);
  assert.deepEqual((await tool.execute({}, undefined as never, undefined as never)).output, [{ type: "text", text: "value" }]);
  assert.equal(exchanges, 2);
  assert.equal(accepted, 1);
});
