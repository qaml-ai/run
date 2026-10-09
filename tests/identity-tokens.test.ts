import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AgentRuntime } from "../clients/typescript.ts";
import { listen, OPERATOR, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

/**
 * A tool server that trusts only the runtime's identity tokens, as an application's would: every
 * request's bearer token is verified against the runtime's published keys, for this server's URL.
 * It serves MCP at /mcp and one OpenAPI operation at /api/whoami, and records what each saw.
 */
async function toolServer(t: T, runtimeBase: () => string) {
  const seen: { path: string; claims?: JWTPayload; error?: string }[] = [];
  let base = "";
  const verify = async (authorization: string | undefined, audience: string) => {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    // Without AGENT_PUBLIC_URL the runtime's issuer is the address it listens on.
    const { payload } = await jwtVerify(token, createRemoteJWKSet(new URL(`${runtimeBase()}/.well-known/jwks.json`)), { issuer: runtimeBase(), audience, algorithms: ["EdDSA"] });
    return payload;
  };
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const path = new URL(req.url!, "http://x").pathname;
    // The MCP server knows itself by a stable name of its tenant's (as it would across a move); the OpenAPI source by a URL on its origin.
    const audience = path === "/mcp" ? "urn:camelrun:alice:app" : `${base}/api-audience`;
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
  const app = await toolServer(t, () => base);
  const r = await runtime(t, (_body, index) => [toolCall("app__whoami", {}), toolCall("api__whoami", {})][index] ?? { role: "assistant", content: "done" }, { ...LOCAL, AGENT_PUBLIC_URL: "" });
  base = r.base;

  const jwks = await fetch(`${r.base}/.well-known/jwks.json`);
  assert.equal(jwks.status, 200);
  const { keys } = await jwks.json() as { keys: any[] };
  assert.equal(keys.length, 1);
  assert.deepEqual([keys[0].kty, keys[0].crv, keys[0].alg, "d" in keys[0]], ["OKP", "Ed25519", "EdDSA", false], "only the public key is published");

  // Through the SDK's definition helpers.
  const sdk = new AgentRuntime({ url: r.base, apiKey: OPERATOR });
  const definition = await sdk.createDefinition({ name: "App", mcpServers: [{ name: "app", url: `${app.url}/mcp`, auth: { type: "runtime" }, audience: "urn:camelrun:alice:app" }], openApi: [{ name: "api", spec, baseUrl: `${app.url}/api`, auth: { type: "runtime" }, audience: `${app.url}/api-audience` }] });
  assert.deepEqual(definition.mcpServers![0].auth, { type: "runtime" });
  assert.equal((await sdk.definitions()).length, 1);
  const created = { json: definition };
  const bearerAudience = await r.call("/v1/definitions", { body: { name: "Bad", openApi: [{ name: "api", spec, baseUrl: `${app.url}/api`, audience: `${app.url}/api-audience` }] } });
  assert.equal(bearerAudience.status, 400, "an audience is only for the runtime's own tokens");
  // A token names the server it goes to: no tenant can mint one for another server, which might trust this runtime's tokens.
  // A stable name must be in the tenant's own namespace (urn:camelrun:<tenant>:<name>), never another tenant's.
  for (const audience of ["https://someone-else.example", "urn:app-api", `${app.url.replace("127.0.0.1", "localhost")}/api`, "urn:camelrun:bob:app", "urn:camelrun:alice:", "urn:camelrun:alice:a b"]) {
    for (const source of [{ mcpServers: [{ name: "app", url: `${app.url}/mcp`, auth: { type: "runtime" }, audience }] }, { openApi: [{ name: "api", spec, baseUrl: `${app.url}/api`, auth: { type: "runtime" }, audience }] }]) {
      const foreign = await r.call("/v1/definitions", { body: { name: "Foreign", ...source } });
      assert.equal(foreign.status, 400, `${audience}: ${foreign.text}`);
      assert.match(foreign.json.error, /audience[\s\S]*own origin/);
    }
  }
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
  assert.equal(call.iss, r.base);
  assert.equal(call.aud, "urn:camelrun:alice:app");
  assert.equal(call.sub, "u_123");
  assert.equal(call.act, "u_456");
  assert.deepEqual(call.ctx, { org: "acme", thread: "t_1" });
  assert.equal(call.agent, agent.id);
  assert.equal(call.tenant, "alice");
  assert.equal(call.exp! - call.iat!, 120);
  assert.equal(call.req, accepted.json.id, "the run it was made in");
  assert.equal(typeof call.tcid, "string", "the model's tool call it is for");
  const listing = app.seen.find(entry => entry.path === "/mcp" && !entry.claims?.act);
  assert.ok(listing, "requests outside a turn (listing tools) carry the agent's identity without an actor");
  assert.equal(listing!.claims!.req, undefined, "nor a run");
  const api = app.seen.find(entry => entry.path === "/api/whoami")!.claims!;
  assert.deepEqual([api.aud, api.sub, api.act], [`${app.url}/api-audience`, "u_123", "u_456"]);
  assert.equal(new Set(app.seen.map(entry => entry.claims?.jti)).size, app.seen.length, "every request has its own token");

  // Identity is the tenant's to set: the agent's own token cannot change it, and actor is only for runs.
  const scoped = async (body: object) => (await fetch(`${r.base}/clients/${agent.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status;
  assert.equal(await scoped({ id: "sneaky", method: "configure", params: { subject: "u_999" } }), 400);
  assert.equal(await scoped({ id: "odd", method: "status", params: { actor: "u_999" } }), 400);
});

test("a child's run's identity tokens name its parent (par) and its chain's first agent (root), from the signed chain", async t => {
  let base = "";
  const app = await toolServer(t, () => base);
  const lastUser = (body: any) => JSON.stringify(body.messages.findLast((message: any) => message.role === "user")?.content ?? "");
  // The root delegates (level 1), its child spawns in the background (level 2), and that grandchild calls the app.
  const r = await runtime(t, body => {
    if (body.messages.at(-1).role === "tool") return { role: "assistant", content: "done" };
    if (lastUser(body).includes("level 2")) return toolCall("app__whoami", {});
    if (lastUser(body).includes("level 1")) return toolCall("spawn_agent", { agent: "app", task: "level 2" });
    return toolCall("delegate", { agent: "app", task: "level 1" });
  }, { ...LOCAL, AGENT_PUBLIC_URL: "" });
  base = r.base;
  const saved = await r.call("/v1/definitions", { headers: { "Idempotency-Key": "app" }, body: { name: "App", builtins: ["delegate", "agents"], delegate: { agents: ["app"] },
    mcpServers: [{ name: "app", url: `${app.url}/mcp`, auth: { type: "runtime" }, audience: "urn:camelrun:alice:app" }] } });
  assert.equal(saved.status, 201, saved.text);
  const root = (await r.call("/v1/agents", { body: { definition: saved.json.id } })).json.id;
  const record = await r.prompt(root, "start");
  const child = record.outcome.result.toolCalls.find((call: any) => call.tool === "delegate").agentId;
  const call = await until(() => app.seen.find(entry => entry.claims?.tcid), "the grandchild's call");
  assert.deepEqual(app.seen.filter(entry => entry.error), []);
  assert.notEqual(call.claims!.agent, child, "made by the grandchild");
  assert.equal(call.claims!.par, child);
  assert.equal(call.claims!.root, root);
  // Outside a delegated run (the root's own listing), neither.
  assert.ok(app.seen.filter(entry => entry.claims?.agent === root).every(entry => entry.claims!.par === undefined && entry.claims!.root === undefined));
  // The grandchild's ending reaches the child.
  await until(async () => (await r.call(`/v1/agents/${child}`)).json.requests.some((request: any) => request.id.startsWith("child_") && request.state === "completed"), "the child's notification");
});
