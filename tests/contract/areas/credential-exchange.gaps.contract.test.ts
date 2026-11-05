import {portedTest} from '../ported.ts';
const test = portedTest("keys", "tests/credential-exchange.test.ts");
import assert from 'node:assert/strict';
import {createLocalJWKSet,jwtVerify,type JWTPayload} from 'jose';
import {z} from 'zod';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {listen,runtime,toolCall,toolResults,type T} from '../support.ts';

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };

const ISSUER = "https://runtime.test";

async function exchangeEndpoint(t: T, jwks: () => Promise<{ keys: any[] }>, options: { issuer?: string; audience?: () => string; tenant?: string } = {}) {
  const state = {
    requests: [] as { claims?: JWTPayload; body?: any; error?: string; contentType?: string }[],
    issued: [] as string[],
    /** What the next answers are, instead of a credential: a status and body, or a function of the request's count. */
    answer: undefined as undefined | ((count: number) => { status: number; body: string; delayMs?: number } | undefined),
    expiry: { expiresIn: 3600 } as { expiresIn?: number; expiresAt?: string },
  };
  let base = "";
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const token = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
    let claims: JWTPayload;
    try {
      ({ payload: claims } = await jwtVerify(token, createLocalJWKSet(await jwks()), { issuer: options.issuer ?? ISSUER, audience: options.audience?.() ?? `${base}/exchange`, algorithms: ["EdDSA"] }));
      if (claims.tenant !== (options.tenant ?? "alice")) throw new Error("another tenant's agent");
      if (!claims.exchange) throw new Error("not an exchange request");
    } catch (error) {
      state.requests.push({ error: String(error) });
      res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: `token refused: ${(error as Error).message}` }));
      return;
    }
    state.requests.push({ claims, body: JSON.parse(text), contentType: req.headers["content-type"] });
    const scripted = state.answer?.(state.requests.length);
    if (scripted?.delayMs) await new Promise(resolve => setTimeout(resolve, scripted.delayMs));
    if (scripted && scripted.status !== 200) { res.writeHead(scripted.status, { "Content-Type": "application/json" }).end(scripted.body); return; }
    if (scripted?.body) { res.writeHead(200, { "Content-Type": "application/json" }).end(scripted.body); return; }
    const credential = `ghs_${claims.agent}_${state.issued.length + 1}`;
    state.issued.push(credential);
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ token: credential, ...state.expiry }));
  });
  base = url;
  return { url: `${url}/exchange`, state, fetched: () => state.requests.filter(request => request.claims).length };
}

async function mcpServer(t: T) {
  const state = { accepts: (_token: string): boolean => true, authorizations: [] as (string | undefined)[], statuses: [] as number[], headers: [] as (string | string[] | undefined)[], calls: [] as string[] };
  const url = await listen(t, async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const authorization = req.headers.authorization;
    state.authorizations.push(authorization);
    state.headers.push(req.headers["x-team"]);
    if (!authorization?.startsWith("Bearer ") || !state.accepts(authorization.slice(7))) { state.statuses.push(401); res.writeHead(401).end(); return; }
    state.statuses.push(200);
    const server = new McpServer({ name: "github", version: "1.0.0" });
    server.registerTool("echo", { description: "Echo some text", inputSchema: { text: z.string() } }, async ({ text: value }) => { state.calls.push(value); return { content: [{ type: "text", text: `echo: ${value}` }] }; });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, text ? JSON.parse(text) : undefined);
  });
  return { url: `${url}/mcp`, state };
}

test("through the API: saving lists the server with a credential for the definition, agents get their own, and nothing shows the credential", async t => {
  let jwks = async (): Promise<{ keys: any[] }> => ({ keys: [] });
  let issuer = "";
  const exchange = await exchangeEndpoint(t, () => jwks(), { get issuer() { return issuer; } });
  const mcp = await mcpServer(t);
  const r = await runtime(t, (_body, index) => [toolCall("github__echo", { text: "hi" }), toolCall("github__echo", { text: "again" }), { role: "assistant", content: "done" }, toolCall("github__echo", { text: "more" })][index] ?? { role: "assistant", content: "done" }, { ...LOCAL, AGENT_PUBLIC_URL: "" });
  issuer = r.base;
  jwks = async () => await (await fetch(`${r.base}/.well-known/jwks.json`)).json() as { keys: any[] };
  const server = { name: "github", url: mcp.url, auth: { type: "exchange", url: exchange.url }, headers: { "X-Team": "triage" } };

  // What is not an exchange.
  const refused = async (body: object, pattern: RegExp, path = "/v1/definitions") => {
    const answer = await r.call(path, { body });
    assert.equal(answer.status, 400, answer.text);
    assert.match(answer.json.error, pattern);
  };
  await refused({ name: "No url", mcpServers: [{ ...server, auth: { type: "exchange" } }] }, /auth is .*\{ type: "exchange", url, audience\? \}/);
  await refused({ name: "A token", mcpServers: [{ ...server, auth: { type: "exchange", url: exchange.url, token: "x" } }] }, /auth: Unrecognized key: "token"/);
  await refused({ name: "Internal", mcpServers: [{ ...server, auth: { type: "exchange", url: "http://169.254.169.254/token" } }] }, /auth\.url: 169\.254\.169\.254 is a private, local or reserved address/);
  await refused({ name: "Not http", mcpServers: [{ ...server, auth: { type: "exchange", url: "ftp://example.com/token" } }] }, /auth\.url: Only https:\/\/ URLs are allowed/);
  await refused({ name: "Credentials", mcpServers: [{ ...server, auth: { type: "exchange", url: "https://user:pass@example.com/token" } }] }, /auth\.url: URLs may not carry credentials/);
  for (const audience of ["https://someone-else.example", "urn:camelrun:bob:exchange", mcp.url]) {
    await refused({ name: "Foreign", mcpServers: [{ ...server, auth: { type: "exchange", url: exchange.url, audience } }] }, /auth\.audience must be a URL on the exchange's own origin/);
  }
  await refused({ name: "Outside", mcpServers: [{ ...server, audience: "urn:camelrun:alice:x" }] }, /the audience goes in auth \(auth\.audience\)/);
  await refused({ name: "Both", mcpServers: [{ ...server, headers: { Authorization: "Bearer x" } }] }, /Give an Authorization header or auth, not both/);
  const spec = { openapi: "3.1.0", info: { title: "App", version: "1" }, paths: { "/whoami": { get: { operationId: "whoami" } } } };
  await refused({ name: "OpenAPI", openApi: [{ name: "api", spec, baseUrl: `${mcp.url}/api`, auth: { type: "exchange", url: exchange.url } }] }, /auth \{ type: "exchange" \} is for MCP servers/);
  await refused({ mcpServers: [{ name: "github", url: mcp.url, auth: { type: "exchange", url: exchange.url } }] }, /carry no credentials/, "/v1/agents");
  assert.equal(exchange.state.requests.length, 0, "nothing was asked of the endpoint for a definition that was not saved");

  // An endpoint that refuses, or answers wrongly, fails the save with what it said; one that is down does not.
  exchange.state.answer = () => ({ status: 403, body: JSON.stringify({ error: "unknown definition" }) });
  const denied = await r.call("/v1/definitions", { body: { name: "Denied", mcpServers: [server] } });
  assert.equal(denied.status, 400, denied.text);
  assert.match(denied.json.error, /^MCP server github's credential exchange \(http:\/\/127\.0\.0\.1:\d+\/exchange\) answered HTTP 403: unknown definition\. Saving lists the server's tools as the definition/);
  exchange.state.answer = () => ({ status: 200, body: JSON.stringify({ token: "ghs_malformed" }) });
  const malformed = await r.call("/v1/definitions", { body: { name: "Malformed", mcpServers: [server] } });
  assert.equal(malformed.status, 400, malformed.text);
  assert.match(malformed.json.error, /must say when the token expires/);
  assert.equal((await r.call("/v1/definitions")).json.length, 0, "neither was saved");
  exchange.state.answer = () => ({ status: 503, body: "" });
  const started = Date.now();
  const down = await r.call("/v1/definitions", { body: { name: "Down", mcpServers: [server] } });
  assert.equal(down.status, 201, down.text);
  assert.ok(Date.now() - started < 9_000, "a save never hangs on an endpoint that is down");
  assert.deepEqual([down.json.toolSources[0].status, down.json.toolSources[0].tools], ["error", []]);
  assert.match(down.json.toolSources[0].error, /credential exchange .* answered HTTP 503$/);

  // A working one: the save lists the server's tools with a credential fetched as the definition.
  exchange.state.answer = undefined;
  exchange.state.requests.length = 0;
  const saved = await r.call("/v1/definitions", { body: { name: "Triage", mcpServers: [server] } });
  assert.equal(saved.status, 201, saved.text);
  assert.deepEqual(saved.json.mcpServers, [{ name: "github", url: mcp.url, headerNames: ["X-Team"], auth: { type: "exchange", url: exchange.url } }], "the API shows where credentials come from, never one");
  assert.deepEqual([saved.json.toolSources[0].status, saved.json.toolSources[0].tools.map((tool: any) => tool.name)], ["listed", ["github__echo"]]);
  const atSave = exchange.state.requests[0];
  assert.deepEqual([atSave.claims!.agent, atSave.claims!.sub, atSave.claims!.definition, atSave.claims!.tenant, atSave.claims!.aud], [saved.json.id, saved.json.id, saved.json.id, "alice", exchange.url]);
  assert.deepEqual(atSave.body, { server: { name: "github", url: mcp.url }, tenant: "alice", definition: saved.json.id }, "no agent yet: the body names none");

  // Editing its filters keeps the exchange, as it keeps stored credentials.
  const edited = await r.call(`/v1/definitions/${saved.json.id}`, { method: "PATCH", body: { mcpServers: [{ name: "github", url: mcp.url, allowTools: ["echo"] }] } });
  assert.equal(edited.status, 200, edited.text);
  assert.deepEqual([edited.json.mcpServers[0].auth, edited.json.mcpServers[0].headerNames], [{ type: "exchange", url: exchange.url }, ["X-Team"]]);

  // An agent of it: its own credential, sent with the definition's static headers.
  const agent = (await r.call("/v1/agents", { body: { definition: saved.json.id, subject: "u_123", context: { org: "acme" } } })).json;
  const record = await r.prompt(agent.id, "echo twice", undefined, { actor: "u_456" });
  assert.equal(record.outcome.result.reply, "done");
  assert.match(toolResults(r.model.bodies[1]).at(-1), /echo: hi/);
  assert.deepEqual(mcp.state.calls, ["hi", "again"]);
  const forAgent = exchange.state.requests.filter(request => request.claims?.agent === agent.id);
  assert.equal(forAgent.length, 1, "one fetch for the agent's listing and both its calls");
  assert.deepEqual([forAgent[0].claims!.sub, forAgent[0].claims!.ctx, forAgent[0].claims!.act, forAgent[0].body.agent], ["u_123", { org: "acme" }, undefined, agent.id]);
  assert.deepEqual(forAgent[0].claims!.exchange, { server: "github", url: mcp.url });
  const credential = `ghs_${agent.id}_`;
  assert.ok(mcp.state.authorizations.some(value => value?.startsWith(`Bearer ${credential}`)), "the agent's requests carried the agent's credential");
  assert.ok(mcp.state.authorizations.every(value => value?.startsWith("Bearer ghs_")), "and never an identity token");
  assert.ok(mcp.state.headers.every(value => value === "triage"));

  // Nothing a caller, the model or an operator reads has a credential in it.
  const read = async (path: string) => (await r.call(path)).text;
  const visible = [
    await read(`/v1/agents/${agent.id}`), await read(`/v1/agents/${agent.id}?refresh=true&schemas=true`), await read(`/v1/agents/${agent.id}/history`),
    await read(`/v1/agents/${agent.id}/requests/${record.id}`), await read("/v1/definitions"), await read(`/v1/definitions/${saved.json.id}`),
    JSON.stringify(r.model.bodies), JSON.stringify(record), saved.text, edited.text, denied.text, malformed.text, down.text,
  ].join("\n");
  assert.doesNotMatch(visible, /ghs_/);
  assert.doesNotMatch(r.logs.join("\n"), /ghs_/);
  // The original suite additionally checks sealed definition rows and internal metrics.

  // The server stops taking what the exchange issues: the call fails as an unavailable source, and the turn goes on.
  mcp.state.accepts = () => false;
  const fetchedBefore = exchange.state.requests.length;
  const failed = await r.prompt(agent.id, "echo once more");
  assert.equal(failed.outcome.result.reply, "done", "the turn ended normally");
  const [toolError] = failed.outcome.result.toolErrors;
  assert.deepEqual([toolError.tool, toolError.code], ["github__echo", "source_unavailable"]);
  assert.match(toolError.message, /^MCP server github refused the credential from its exchange \(HTTP 401\), and a second one fetched after/);
  assert.match(toolResults(r.model.bodies.at(-1)).at(-1), /refused the credential from its exchange/, "the model reads why");
  assert.equal(exchange.state.requests.length - fetchedBefore, 1, "one refetch");
  assert.deepEqual(mcp.state.calls, ["hi", "again"]);
  assert.doesNotMatch(`${JSON.stringify(failed)}\n${JSON.stringify(r.model.bodies)}\n${r.logs.join("\n")}`, /ghs_/);
});
