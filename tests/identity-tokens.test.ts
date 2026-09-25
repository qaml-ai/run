import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { listen, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const ISSUER = "https://agents.example.test";

/**
 * A tool server that trusts only the runtime's identity tokens, as an application's would: every
 * request's bearer token is verified against the runtime's published keys, for this server's URL.
 * It serves MCP at /mcp and one OpenAPI operation at /api/whoami, and records what each saw.
 */
async function toolServer(t: T, jwksUrl: () => string) {
  const seen: { path: string; claims?: JWTPayload; error?: string }[] = [];
  let base = "";
  const verify = async (authorization: string | undefined, audience: string) => {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(jwksUrl())), { issuer: ISSUER, audience, algorithms: ["EdDSA"] });
    return payload;
  };
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const path = new URL(req.url!, "http://x").pathname;
    const audience = path === "/mcp" ? `${base}/mcp` : `${base}/api`;
    let claims: JWTPayload;
    try { claims = await verify(req.headers.authorization, audience); }
    catch (error) { seen.push({ path, error: String(error) }); res.writeHead(401).end(); return; }
    seen.push({ path, claims });
    if (path === "/api/whoami") { res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ user: claims.act ?? claims.sub, org: (claims.ctx as any)?.org })); return; }
    const server = new McpServer({ name: "app", version: "1.0.0" });
    server.registerTool("whoami", { description: "Who is asking" }, async () => ({ content: [{ type: "text", text: `you are ${claims.act ?? claims.sub} in ${(claims.ctx as any)?.org}` }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  });
  base = url;
  return { url, seen };
}

const spec = { openapi: "3.1.0", info: { title: "App", version: "1" }, paths: { "/whoami": { get: { operationId: "whoami", summary: "Who is asking" } } } };

test("tool servers with auth \"runtime\" get a short-lived token the runtime signs, naming the agent's subject, context and the turn's actor", async t => {
  let base = "";
  const app = await toolServer(t, () => `${base}/.well-known/jwks.json`);
  const r = await runtime(t, (_body, index) => [toolCall("app__whoami", {}), toolCall("api__whoami", {})][index] ?? { role: "assistant", content: "done" }, LOCAL);
  base = r.base;

  const jwks = await fetch(`${r.base}/.well-known/jwks.json`);
  assert.equal(jwks.status, 200);
  const { keys } = await jwks.json() as { keys: any[] };
  assert.equal(keys.length, 1);
  assert.deepEqual([keys[0].kty, keys[0].crv, keys[0].alg, "d" in keys[0]], ["OKP", "Ed25519", "EdDSA", false], "only the public key is published");

  const created = await r.call("/v1/definitions", { body: { name: "App", mcpServers: [{ name: "app", url: `${app.url}/mcp`, auth: { type: "runtime" }, exposure: "direct" }], openApi: [{ name: "api", spec, baseUrl: `${app.url}/api`, auth: { type: "runtime" }, exposure: "direct" }] } });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(created.json.mcpServers[0].auth, { type: "runtime" });
  const clash = await r.call("/v1/definitions", { body: { name: "Clash", mcpServers: [{ name: "app", url: `${app.url}/mcp`, auth: { type: "runtime" }, headers: { Authorization: "Bearer x" } }] } });
  assert.equal(clash.status, 400, "the runtime's token is the Authorization");

  const agent = (await r.call("/v1/agents", { body: { definition: created.json.id, subject: "u_123", context: { org: "acme", thread: "t_1" } } })).json;
  assert.equal((await r.call("/v1/agents", { body: { subject: 42 } })).status, 400);
  const accepted = await r.call(`/v1/agents/${agent.id}/prompt`, { body: { text: "who am i?", actor: "u_456" } });
  assert.equal(accepted.status, 202, accepted.text);
  const record = await until(async () => { const found = (await r.call(`/v1/agents/${agent.id}/requests/${accepted.json.id}`)).json; return found.state === "completed" && found; }, "the turn");
  assert.equal(record.outcome.result.reply, "done");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /you are u_456 in acme/);
  assert.match(toolResults(r.model.bodies[2]).at(-1), /"user":"u_456","org":"acme"/);

  assert.deepEqual(app.seen.filter(entry => entry.error), [], "every request carried a valid token");
  const call = app.seen.find(entry => entry.path === "/mcp" && entry.claims?.act)!.claims!;
  assert.equal(call.iss, ISSUER);
  assert.equal(call.aud, `${app.url}/mcp`);
  assert.equal(call.sub, "u_123");
  assert.equal(call.act, "u_456");
  assert.deepEqual(call.ctx, { org: "acme", thread: "t_1" });
  assert.equal(call.agent, agent.id);
  assert.equal(call.tenant, "alice");
  assert.equal(call.exp! - call.iat!, 120);
  const listing = app.seen.find(entry => entry.path === "/mcp" && !entry.claims?.act);
  assert.ok(listing, "requests outside a turn (listing tools) carry the agent's identity without an actor");
  const api = app.seen.find(entry => entry.path === "/api/whoami")!.claims!;
  assert.deepEqual([api.aud, api.sub, api.act], [`${app.url}/api`, "u_123", "u_456"]);
  assert.equal(new Set(app.seen.map(entry => entry.claims?.jti)).size, app.seen.length, "every request has its own token");

  // Identity is the tenant's to set: the agent's own token cannot change it, and actor is only for runs.
  const scoped = async (body: object) => (await fetch(`${r.base}/clients/${agent.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
  assert.equal(await scoped({ id: "sneaky", method: "configure", params: { subject: "u_999" } }), 400);
  assert.equal(await scoped({ id: "odd", method: "status", params: { actor: "u_999" } }), 400);
});
