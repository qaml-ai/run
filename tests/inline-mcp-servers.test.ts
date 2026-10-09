import { test } from "node:test";
import assert from "node:assert/strict";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { listen, runtime, toolCall, toolResults, until, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_PUBLIC_URL: "" };

/** An MCP server that answers only requests carrying the runtime's identity token for its URL, and records their claims. */
async function toolServer(t: T, runtimeBase: () => string) {
  const seen: { claims?: JWTPayload; error?: string }[] = [];
  let base = "";
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const authorization = req.headers.authorization ?? "";
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(authorization.slice("Bearer ".length), createRemoteJWKSet(new URL(`${runtimeBase()}/.well-known/jwks.json`)), { issuer: runtimeBase(), audience: `${base}/mcp`, algorithms: ["EdDSA"] }));
    } catch (error) { seen.push({ error: String(error) }); res.writeHead(401).end(); return; }
    seen.push({ claims });
    const server = new McpServer({ name: "app", version: "1.0.0" });
    server.registerTool("whoami", { description: "Who is asking" }, async () => ({ content: [{ type: "text", text: `you are ${claims.sub} in ${(claims.ctx as any)?.org} as ${claims.agent}` }] }));
    server.registerTool("other", { description: "Another tool" }, async () => ({ content: [{ type: "text", text: "other" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  });
  base = url;
  return { url: `${url}/mcp`, seen };
}

/** A model that calls app__whoami when it has it, then answers with what it said. */
const respond = (body: any) => {
  const last = body.messages.at(-1);
  if (last?.role === "tool") return { role: "assistant", content: `done: ${toolResults(body).at(-1)}` };
  return body.tools?.some((tool: any) => tool.function?.name === "app__whoami") ? toolCall("app__whoami", {}) : { role: "assistant", content: "no tools" };
};

test("an agent without a definition has MCP servers of its own, called with identity tokens that name it and no definition", async t => {
  let base = "";
  const app = await toolServer(t, () => base);
  const r = await runtime(t, respond, LOCAL);
  base = r.base;
  const server = { name: "app", url: app.url, auth: { type: "runtime" } };

  const created = await r.call("/v1/agents", { body: { mcpServers: [server], subject: "u_1", context: { org: "acme" } } });
  assert.equal(created.status, 201, created.text);
  const agent = created.json;
  const record = await r.prompt(agent.id, "who am i?");
  assert.equal(record.outcome.result.reply, `done: you are u_1 in acme as ${agent.id}`);
  assert.deepEqual(app.seen.filter(entry => entry.error), [], "every request carried a valid token");
  const claims = app.seen.at(-1)!.claims!;
  assert.deepEqual([claims.agent, claims.tenant, claims.sub, "definition" in claims], [agent.id, "alice", "u_1", false]);

  const detail = (await r.call(`/v1/agents/${agent.id}`)).json;
  assert.deepEqual(detail.mcpServers, [{ name: "app", url: app.url, auth: { type: "runtime" } }]);
  assert.ok(detail.toolSources.some((source: any) => source.kind === "mcp" && source.name === "app"));

  // PATCH replaces the list: a filter takes effect, and null removes them.
  const filtered = await r.call(`/v1/agents/${agent.id}/configuration`, { method: "PATCH", body: { mcpServers: [{ ...server, denyTools: ["whoami"] }] } });
  assert.equal(filtered.status, 202, filtered.text);
  await until(async () => (await r.call(`/v1/agents/${agent.id}/requests/${filtered.json.id}`)).json.state === "completed", "the configure");
  assert.deepEqual((await r.call(`/v1/agents/${agent.id}`)).json.mcpServers[0].denyTools, ["whoami"]);
  assert.equal((await r.prompt(agent.id, "again")).outcome.result.reply, "no tools");
  const removed = await r.call(`/v1/agents/${agent.id}/configuration`, { method: "PATCH", body: { mcpServers: null } });
  assert.equal(removed.status, 202, removed.text);
  await until(async () => (await r.call(`/v1/agents/${agent.id}/requests/${removed.json.id}`)).json.state === "completed", "the removal");
  assert.deepEqual((await r.call(`/v1/agents/${agent.id}`)).json.mcpServers, []);
  const restored = await r.call(`/v1/agents/${agent.id}/configuration`, { method: "PATCH", body: { mcpServers: [server] } });
  await until(async () => (await r.call(`/v1/agents/${agent.id}/requests/${restored.json.id}`)).json.state === "completed", "the restore");
  assert.match((await r.prompt(agent.id, "once more")).outcome.result.reply, /^done: you are u_1/);

  // A fork has the same servers.
  const fork = await r.call(`/v1/agents/${agent.id}/fork`, { body: {} });
  assert.equal(fork.status, 201, fork.text);
  assert.deepEqual((await r.call(`/v1/agents/${fork.json.id}`)).json.mcpServers, [{ name: "app", url: app.url, auth: { type: "runtime" } }]);

  // Only the tenant changes them: never the agent's own token.
  const own = await fetch(`${r.base}/clients/${agent.id}/requests`, { method: "POST", headers: { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ id: "sneaky", method: "configure", params: { mcpServers: [] } }) });
  assert.equal(own.status, 403);

  // A server that cannot be listed is not refused when saved: a run says so in its sourceErrors.
  const down = await r.call("/v1/agents", { body: { mcpServers: [{ name: "down", url: "http://127.0.0.1:9/mcp" }] } });
  assert.equal(down.status, 201, down.text);
  const result = (await r.prompt(down.json.id, "hello")).outcome.result;
  assert.equal(result.reply, "no tools");
  assert.deepEqual(result.sourceErrors.map((error: any) => [error.kind, error.source]), [["mcp", "down"]]);
});

test("an agent's or run's own MCP servers take no credentials, and an agent from a definition takes none of its own", async t => {
  const r = await runtime(t, respond, LOCAL);
  const url = "https://tools.example.com/mcp";
  const credentials = [
    { name: "app", url, headers: { "X-Api-Key": "secret" } },
    { name: "app", url, auth: { type: "bearer", token: "secret" } },
    { name: "app", url, auth: { type: "runtime", token: "secret" } },
  ];
  for (const server of credentials) {
    const agent = await r.call("/v1/agents", { body: { mcpServers: [server] } });
    assert.equal(agent.status, 400, agent.text);
    assert.match(agent.json.error, /no credentials[\s\S]*definition/);
    const run = await r.call("/v1/runs", { body: { input: "hi", mcpServers: [server] } });
    assert.equal(run.status, 400, run.text);
    assert.match(run.json.error, /no credentials[\s\S]*definition/);
  }
  // Checked as a definition's servers are: the outbound guard, names, audiences on the server's own origin.
  assert.equal((await r.call("/v1/agents", { body: { mcpServers: [{ name: "app", url: "http://169.254.169.254/mcp" }] } })).status, 400);
  assert.equal((await r.call("/v1/agents", { body: { mcpServers: [{ name: "bad name", url }] } })).status, 400);
  assert.equal((await r.call("/v1/agents", { body: { mcpServers: [{ name: "app", url, auth: { type: "runtime" }, audience: "https://other.example.com" }] } })).status, 400);

  const agent = (await r.call("/v1/agents", { body: {} })).json;
  for (const server of credentials) {
    const patched = await r.call(`/v1/agents/${agent.id}/configuration`, { method: "PATCH", body: { mcpServers: [server] } });
    assert.equal(patched.status, 400, patched.text);
    assert.match(patched.json.error, /no credentials[\s\S]*definition/);
  }

  const definition = (await r.call("/v1/definitions", { body: { name: "Plain" } })).json;
  const fromDefinition = await r.call("/v1/agents", { body: { definition: definition.id, mcpServers: [{ name: "app", url }] } });
  assert.equal(fromDefinition.status, 400, fromDefinition.text);
  assert.match(fromDefinition.json.error, /definition/);
  const made = (await r.call("/v1/agents", { body: { definition: definition.id } })).json;
  const patched = await r.call(`/v1/agents/${made.id}/configuration`, { method: "PATCH", body: { mcpServers: [{ name: "app", url }] } });
  assert.equal(patched.status, 400, patched.text);
  assert.match(patched.json.error, /MCP servers come from its definition/);
});

test("an upsert's mcpServers are part of its configuration and configHash", async t => {
  let base = "";
  const app = await toolServer(t, () => base);
  const r = await runtime(t, respond, LOCAL);
  base = r.base;
  const upsert = (body: object) => r.call("/v1/agents", { body, headers: { "Idempotency-Key": "inline-mcp" } });
  const server = { name: "app", url: app.url, auth: { type: "runtime" } };

  const first = await upsert({ mcpServers: [server] });
  assert.equal(first.status, 201, first.text);
  const again = await upsert({ mcpServers: [server] });
  assert.equal(again.json.configHash, first.json.configHash, "the same servers: the same configuration");
  assert.equal(again.json.reconfigured?.outcome?.result?.changed ?? false, false);
  const without = (await upsert({})).json.configHash;
  assert.notEqual(without, first.json.configHash);

  const changed = await upsert({ mcpServers: [{ ...server, allowTools: ["whoami"] }] });
  assert.notEqual(changed.json.configHash, first.json.configHash);
  await until(async () => (await r.call(`/v1/agents/${first.json.id}`)).json.mcpServers[0]?.allowTools?.[0] === "whoami", "the upsert to apply");
  assert.match((await r.prompt(first.json.id, "who?")).outcome.result.reply, /^done: you are client_/);

  // An upsert without them leaves the agent none.
  await upsert({});
  await until(async () => (await r.call(`/v1/agents/${first.json.id}`)).json.mcpServers.length === 0, "the servers to go");
  assert.equal((await r.prompt(first.json.id, "who now?")).outcome.result.reply, "no tools");
});

test("a stateless run calls its own MCP servers", async t => {
  let base = "";
  const app = await toolServer(t, () => base);
  const r = await runtime(t, respond, LOCAL);
  base = r.base;
  const run = await r.call("/v1/runs", { body: { input: "who am i?", mcpServers: [{ name: "app", url: app.url, auth: { type: "runtime" } }], subject: "u_7", context: { org: "beta" }, wait: true } });
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.status, "completed");
  assert.match(run.json.text, /^done: you are u_7 in beta as client_/);
  assert.deepEqual(run.json.toolCalls.map((call: any) => [call.tool, call.ok]), [["app__whoami", true]]);
  assert.equal("definition" in app.seen.at(-1)!.claims!, false);
});
