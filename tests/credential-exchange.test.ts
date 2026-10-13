import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Accounts } from "../src/accounts.ts";
import { CredentialExchange, CredentialExchangeError } from "../src/credential-exchange.ts";
import type { Db } from "../src/db.ts";
import { RuntimeSigner } from "../src/identity.ts";
import { McpConnections } from "../src/mcp.ts";
import { setMetricSink } from "../src/metrics.ts";
import { Outbound } from "../src/outbound.ts";
import { ToolFailure } from "../src/tool-servers.ts";
import { ToolSources, type McpServerSpec, type SourceContext } from "../src/tool-sources.ts";
import { listen, runtime, toolCall, toolResults, type T } from "./runtime-server.ts";

const LOCAL = { AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32" };
const ISSUER = "https://runtime.test";

/** The runtime's signer over a table and a secrets key of its own, in memory: real tokens, verified against its published keys. */
function signer() {
  const rows: Record<string, unknown>[] = [];
  const db = { query: async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("insert")) rows.push({ kid: params[0], public_jwk: JSON.parse(params[1] as string), private_sealed: JSON.parse(params[2] as string), retired_at: null });
    return { rows, rowCount: rows.length };
  } } as unknown as Db;
  const accounts = { canStoreKeys: true, seal: (_aad: string, text: string) => ({ text }), unseal: (_aad: string, sealed: { text: string }) => sealed.text } as unknown as Accounts;
  return new RuntimeSigner({ db, accounts, issuer: ISSUER });
}

/**
 * A tenant's exchange endpoint, as the tools guide tells one to be written: it verifies the runtime's token (signature,
 * issuer, audience, tenant, and the `exchange` claim naming the server), then answers a credential. Each credential
 * names the agent it was issued to and counts up, so a test can tell whose a request carried.
 */
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

/** A third party's MCP server (GitHub's, say): it takes the credentials in `accepts` and answers 401 to any other. */
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

/** Tool sources over the fakes, as a node has them; every metric and log line they write is kept. */
async function fixture(t: TestContext, endpoint: Parameters<typeof exchangeEndpoint>[2] = {}) {
  const signing = signer();
  const outbound = new Outbound({ allowHttp: true, allow: ["127.0.0.1/32"] });
  const connections = new McpConnections({ outbound });
  t.after(() => connections.close());
  const lines: string[] = [];
  setMetricSink(line => lines.push(line));
  const logged = t.mock.method(console, "error", (...values: unknown[]) => { lines.push(values.map(String).join(" ")); });
  t.after(() => { setMetricSink(); logged.mock.restore(); });
  const exchange = await exchangeEndpoint(t, () => signing.jwks(), endpoint);
  const mcp = await mcpServer(t);
  const sources = new ToolSources({ mcp: connections, outbound, signer: signing });
  const spec: McpServerSpec = { name: "github", url: mcp.url, auth: { type: "exchange", url: exchange.url } };
  const context = (agent: string, identity?: SourceContext["identity"]): SourceContext => ({ tenant: "alice", agent, definition: "def_1", ...(identity ? { identity } : {}) });
  const echo = async (from: SourceContext, text: string, server = spec) => {
    const result = await sources.server(from, { mcpServers: [server] }).call({ name: "github__echo", args: { text }, signal: new AbortController().signal } as never);
    return (result.content as { text: string }[])[0].text;
  };
  const metrics = () => lines.flatMap(line => { try { const parsed = JSON.parse(line); return parsed.type === "tool_credential_exchange" ? [parsed] : []; } catch { return []; } });
  return { exchange, mcp, sources, spec, context, echo, lines, metrics, signing, outbound };
}

test("a server with auth \"exchange\" is called with a credential the runtime fetched once, with an identity token naming the agent and the server", async t => {
  const f = await fixture(t);
  const agent = f.context("client_a", { subject: "u_1", context: { org: "acme" } });
  for (const text of ["one", "two", "three"]) assert.equal(await f.echo(agent, text), `echo: ${text}`);
  assert.equal(f.exchange.fetched(), 1, "one fetch for every call");
  assert.deepEqual([...new Set(f.mcp.state.authorizations)], ["Bearer ghs_client_a_1"], "every request to the server carried the credential, and never an identity token");

  const { claims, body, contentType } = f.exchange.state.requests[0];
  assert.equal(claims!.aud, f.exchange.url, "by default the audience is the exchange's own URL");
  assert.notEqual(claims!.aud, f.mcp.url, "never the tool server's");
  assert.deepEqual([claims!.iss, claims!.tenant, claims!.agent, claims!.definition, claims!.sub, claims!.ctx], [ISSUER, "alice", "client_a", "def_1", "u_1", { org: "acme" }]);
  assert.deepEqual(claims!.exchange, { server: "github", url: f.mcp.url }, "the signed token names the server the credential is for");
  assert.deepEqual([claims!.act, claims!.req, claims!.tcid, claims!.origin], [undefined, undefined, undefined, undefined], "a credential outlives the turn: its request names no turn");
  assert.equal(claims!.exp! - claims!.iat!, 120);
  assert.deepEqual(body, { server: { name: "github", url: f.mcp.url }, tenant: "alice", definition: "def_1", agent: "client_a" });
  assert.equal(contentType, "application/json");

  // The tools are listed with it too, and the model's view of them has nothing of it.
  const server = f.sources.server(agent, { mcpServers: [f.spec] });
  const tools = await server.tools();
  assert.deepEqual(tools.map(tool => tool.name), ["github__echo"]);
  assert.equal(f.exchange.fetched(), 1);
  assert.doesNotMatch(JSON.stringify([tools, await server.sources!({})]), /ghs_/);

  const [line] = f.metrics();
  assert.deepEqual([line.type, line.Outcome, line.Tenant, line.server, line.agent, line.attempts, line.lifeSeconds, line.CredentialExchanges], ["tool_credential_exchange", "fetched", "alice", "github", "client_a", 1, 3600, 1]);
  assert.equal(f.metrics().length, 1);
  assert.doesNotMatch(f.lines.join("\n"), /ghs_|eyJ/, "no credential and no identity token in a log or metric line");
});

test("calls made at once share one fetch of the credential", async t => {
  const f = await fixture(t);
  f.exchange.state.answer = () => ({ status: 200, body: "", delayMs: 150 });
  const agent = f.context("client_a");
  const answers = await Promise.all(["a", "b", "c", "d", "e"].map(text => f.echo(agent, text)));
  assert.deepEqual(answers, ["a", "b", "c", "d", "e"].map(text => `echo: ${text}`));
  assert.equal(f.exchange.fetched(), 1);
  assert.deepEqual([...new Set(f.mcp.state.authorizations)], ["Bearer ghs_client_a_1"]);
});

test("a credential is fetched again before it expires, not after", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 13, 12) });
  const f = await fixture(t);
  const agent = f.context("client_a");
  // An hour, as a GitHub App installation token's, given as a time.
  f.exchange.state.expiry = { expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  await f.echo(agent, "first");
  t.mock.timers.tick(54 * 60_000);
  await f.echo(agent, "at 54 minutes");
  assert.equal(f.exchange.fetched(), 1, "still fresh five minutes and more before its expiry");
  t.mock.timers.tick(90_000);
  await f.echo(agent, "at 55 and a half");
  assert.equal(f.exchange.fetched(), 2, "fetched again within five minutes of its expiry");
  assert.equal(f.mcp.state.authorizations.at(-1), "Bearer ghs_client_a_2");
  assert.ok(f.mcp.state.statuses.every(status => status === 200), "the server never saw an expired one");

  // A short-lived one is refreshed a fifth of its life before its end; one that says it lasts forever, within a day.
  f.exchange.state.expiry = { expiresIn: 100 };
  t.mock.timers.tick(3600_000);
  await f.echo(agent, "short");
  assert.equal(f.exchange.fetched(), 3);
  t.mock.timers.tick(79_000);
  await f.echo(agent, "at 79 s");
  assert.equal(f.exchange.fetched(), 3);
  f.exchange.state.expiry = { expiresIn: 10 * 365 * 86_400 };
  t.mock.timers.tick(2_000);
  await f.echo(agent, "at 81 s");
  assert.equal(f.exchange.fetched(), 4);
  t.mock.timers.tick(24 * 3600_000 - 6 * 60_000);
  await f.echo(agent, "almost a day");
  assert.equal(f.exchange.fetched(), 4);
  t.mock.timers.tick(2 * 60_000);
  await f.echo(agent, "a day");
  assert.equal(f.exchange.fetched(), 5, "kept a day at most");

  // One that expires at once is still used for a few seconds: a fetch for every request would spin.
  f.exchange.state.expiry = { expiresIn: 1 };
  t.mock.timers.tick(48 * 3600_000);
  await f.echo(agent, "one second");
  t.mock.timers.tick(4_000);
  await f.echo(agent, "four seconds on");
  assert.equal(f.exchange.fetched(), 6);
  t.mock.timers.tick(2_000);
  await f.echo(agent, "six seconds on");
  assert.equal(f.exchange.fetched(), 7);
});

test("a credential the server refuses is dropped and fetched once more; refused again, the call fails saying so", async t => {
  const f = await fixture(t);
  const agent = f.context("client_a");
  assert.equal(await f.echo(agent, "before"), "echo: before");
  // The first credential is revoked (or expired early): the next request is refused, then sent again with a new one.
  f.mcp.state.accepts = token => token !== "ghs_client_a_1";
  assert.equal(await f.echo(agent, "after"), "echo: after");
  assert.equal(f.exchange.fetched(), 2, "one refetch");
  assert.deepEqual(f.mcp.state.calls, ["before", "after"], "the refused request never ran, so it ran once");
  assert.equal(f.mcp.state.statuses.filter(status => status === 401).length, 1);
  assert.equal(await f.echo(agent, "again"), "echo: again");
  assert.equal(f.exchange.fetched(), 2, "and the new one is kept");

  // The server refuses whatever the exchange issues: one refetch, then an error the model and the tenant can read.
  f.mcp.state.accepts = () => false;
  const refusedBefore = f.mcp.state.statuses.filter(status => status === 401).length;
  const failure = await f.echo(agent, "never").then(() => undefined, error => error);
  assert.ok(failure instanceof CredentialExchangeError && failure instanceof ToolFailure, String(failure));
  assert.deepEqual([failure.code, failure.reason, failure.status], ["source_unavailable", "rejected", 401]);
  assert.match(failure.message, /^MCP server github refused the credential from its exchange \(HTTP 401\), and a second one fetched after: check what http:\/\/127\.0\.0\.1:\d+\/exchange issues for it$/);
  assert.equal(f.exchange.fetched(), 3, "exactly one refetch for the failed call");
  assert.equal(f.mcp.state.statuses.filter(status => status === 401).length - refusedBefore, 2, "the request was sent twice, no more");
  assert.deepEqual(f.mcp.state.calls, ["before", "after", "again"]);
  assert.deepEqual(f.metrics().map(line => line.Outcome), ["fetched", "rejected", "fetched", "rejected", "fetched", "rejected"]);
  assert.doesNotMatch(`${failure.message}\n${f.lines.join("\n")}`, /ghs_/);

  // It recovers when the server takes its credentials again.
  f.mcp.state.accepts = () => true;
  assert.equal(await f.echo(agent, "recovered"), "echo: recovered");
});

test("a credential fetched for one agent is never used for another", async t => {
  const f = await fixture(t);
  const a = f.context("client_a", { subject: "u_1" }), b = f.context("client_b", { subject: "u_2" });
  await f.echo(a, "from a");
  await f.echo(b, "from b");
  await f.echo(a, "a again");
  assert.equal(f.exchange.fetched(), 2, "one each");
  assert.deepEqual(f.exchange.state.requests.map(request => [request.claims!.agent, request.claims!.sub, request.body.agent]), [["client_a", "u_1", "client_a"], ["client_b", "u_2", "client_b"]]);
  // The fake server answers each request statelessly: the credential of every request made for an agent is that agent's.
  const used = (from: number, to?: number) => [...new Set(f.mcp.state.authorizations.slice(from, to))];
  const afterA = f.mcp.state.authorizations.findIndex(value => value === "Bearer ghs_client_b_2");
  assert.deepEqual(used(0, afterA), ["Bearer ghs_client_a_1"]);
  assert.deepEqual([...new Set(f.mcp.state.authorizations)].sort(), ["Bearer ghs_client_a_1", "Bearer ghs_client_b_2"]);
  assert.equal(f.mcp.state.authorizations.at(-1), "Bearer ghs_client_a_1", "a's later call still carries a's");

  // The same agent acting for someone else, another definition, another tenant, another server or endpoint: each its own.
  const base = { tenant: "alice", agent: "client_a", definition: "def_1", identity: { subject: "u_1" } };
  const target = { name: "github", url: f.mcp.url, exchange: f.exchange.url, audience: f.exchange.url };
  const keys = [
    f.sources.exchange.key(base, target),
    f.sources.exchange.key({ ...base, identity: { subject: "u_9" } }, target),
    f.sources.exchange.key({ ...base, identity: { subject: "u_1", context: { org: "other" } } }, target),
    f.sources.exchange.key({ ...base, definition: "def_2" }, target),
    f.sources.exchange.key({ ...base, tenant: "bob" }, target),
    f.sources.exchange.key({ ...base, agent: "client_b" }, target),
    f.sources.exchange.key(base, { ...target, name: "other" }),
    f.sources.exchange.key(base, { ...target, url: `${f.mcp.url}/v2` }),
    f.sources.exchange.key(base, { ...target, exchange: `${f.exchange.url}/v2` }),
    f.sources.exchange.key(base, { ...target, audience: "urn:camelrun:alice:exchange" }),
  ];
  assert.equal(new Set(keys).size, keys.length);
  await f.echo(f.context("client_a", { subject: "u_9" }), "for someone else");
  assert.equal(f.exchange.fetched(), 3);
  assert.equal(f.sources.exchange.size, 3, "kept in this process only");
});

test("an exchange that is down, slow or answers wrongly makes its source unavailable for the call, with an error that says why and no secret", async t => {
  const f = await fixture(t);
  const agent = f.context("client_a");
  const fails = async (work: Promise<unknown> = f.echo(agent, "x")) => {
    const failure = await work.then(() => undefined, error => error);
    assert.ok(failure instanceof CredentialExchangeError, String(failure));
    assert.equal(failure.code, "source_unavailable");
    return failure;
  };
  const where = `MCP server github's credential exchange (${f.exchange.url})`;

  // 5xx: three attempts with a wait between, then the error.
  f.exchange.state.answer = () => ({ status: 503, body: "{\"error\":\"database is down\"}" });
  const down = await fails();
  assert.deepEqual([down.reason, down.status, down.transient, down.message], ["unavailable", 503, true, `${where} answered HTTP 503: database is down`]);
  assert.equal(f.exchange.fetched(), 3, "bounded retries");
  assert.deepEqual([f.metrics().at(-1).Outcome, f.metrics().at(-1).attempts, f.metrics().at(-1).status], ["unavailable", 3, 503]);
  assert.equal(f.mcp.state.authorizations.length, 0, "the server is not called without a credential");

  // One bad answer, then a good one: the retry is invisible.
  f.exchange.state.answer = count => count === 4 ? { status: 502, body: "" } : undefined;
  assert.equal(await f.echo(agent, "retried"), "echo: retried");
  assert.equal(f.exchange.fetched(), 5);

  // What it answers wrongly is never quoted: a body with a token in it may be anything.
  const wrong: [string, { status: number; body: string }, string, RegExp][] = [
    ["not JSON", { status: 200, body: "<html>s3cret-in-html</html>" }, "invalid_response", /did not answer with JSON$/],
    ["no token", { status: 200, body: JSON.stringify({ access_token: "s3cret-elsewhere", expiresIn: 60 }) }, "invalid_response", /answered without a usable token/],
    ["a token with a space", { status: 200, body: JSON.stringify({ token: "s3cret with spaces", expiresIn: 60 }) }, "invalid_response", /answered without a usable token/],
    ["no expiry", { status: 200, body: JSON.stringify({ token: "s3cret-no-expiry" }) }, "invalid_response", /must say when the token expires: expiresAt \(an RFC 3339 time\) or expiresIn \(seconds\)$/],
    ["an expiry that is no time", { status: 200, body: JSON.stringify({ token: "s3cret-bad-expiry", expiresAt: "soon" }) }, "invalid_response", /must say when the token expires/],
    ["already expired", { status: 200, body: JSON.stringify({ token: "s3cret-expired", expiresAt: new Date(Date.now() - 1000).toISOString() }) }, "expired", /answered a token that has already expired$/],
    ["expires in 0 seconds", { status: 200, body: JSON.stringify({ token: "s3cret-zero", expiresIn: 0 }) }, "expired", /already expired$/],
    ["a list", { status: 200, body: "[]" }, "invalid_response", /must answer a JSON object/],
    ["a refusal", { status: 403, body: JSON.stringify({ error: "this agent may not use GitHub", token: "s3cret-in-refusal" }) }, "refused", /answered HTTP 403: this agent may not use GitHub$/],
  ];
  const other = f.context("client_b");
  for (const [what, answer, reason, message] of wrong) {
    const before = f.exchange.fetched();
    f.exchange.state.answer = () => answer;
    // The agent that was retried has its credential: one without is asked for.
    const failure = await fails(f.echo(other, "x"));
    assert.deepEqual([failure.reason, failure.transient], [reason, false], what);
    assert.match(failure.message, message, what);
    assert.doesNotMatch(failure.message, /s3cret/, what);
    assert.equal(f.exchange.fetched(), before + 1, `${what}: an answer that will not change is not asked for again`);
  }
  assert.equal(f.sources.exchange.size, 1, "nothing wrong is kept: only the first agent's");

  // Listing the agent's tools: the source shows as an error and the others are unaffected.
  const server = f.sources.server(other, { builtins: ["web_fetch"], mcpServers: [f.spec] });
  assert.deepEqual((await server.tools()).map(tool => tool.name), ["web_fetch"]);
  const [, listed] = await server.sources!({});
  assert.deepEqual([listed.name, listed.status], ["github", "error"]);
  assert.match(listed.error!, /answered HTTP 403: this agent may not use GitHub$/);
  assert.match(f.lines.join("\n"), /"type":"mcp_tools_unavailable"/);

  // Nothing listens there, and an address the guard refuses.
  const closed = await fails(f.echo(other, "x", { ...f.spec, auth: { type: "exchange", url: "http://127.0.0.1:9/exchange" } }));
  assert.deepEqual([closed.reason, closed.transient, closed.message], ["unreachable", true, "MCP server github's credential exchange (http://127.0.0.1:9/exchange) could not be reached"]);
  const internal = await fails(f.echo(other, "x", { ...f.spec, auth: { type: "exchange", url: "http://169.254.169.254/latest/meta-data?key=s3cret-query" } }));
  assert.deepEqual([internal.reason, internal.transient], ["blocked", false]);
  assert.match(internal.message, /cannot be used: 169\.254\.169\.254 is a private, local or reserved address$/);

  // One that never answers is given up on (here with a short deadline of its own).
  const slow = new CredentialExchange({ outbound: f.outbound, signer: f.signing, limits: { attemptMs: 150, totalMs: 400, backoffMs: 20 } });
  f.exchange.state.answer = () => ({ status: 200, body: "", delayMs: 2_000 });
  const started = Date.now();
  const timeout = await fails(slow.token({ tenant: "alice", agent: "client_a" }, { name: "github", url: f.mcp.url, exchange: f.exchange.url, audience: f.exchange.url }));
  assert.deepEqual([timeout.reason, timeout.transient], ["timeout", true]);
  assert.match(timeout.message, /did not answer within \d+ ms$/);
  assert.ok(Date.now() - started < 1_500, "bounded by its total deadline");

  assert.doesNotMatch(f.lines.join("\n"), /s3cret|ghs_|eyJ/, "no credential, identity token or endpoint answer in a log or metric line");
  assert.ok(f.metrics().every(line => !("url" in line) && !("token" in line) && !("error" in line)));
});

test("an endpoint that checks the audience refuses a token minted for another, and the error says what it said", async t => {
  // The endpoint knows itself by a stable name; the definition's default audience (the endpoint's URL) is then wrong.
  const f = await fixture(t, { audience: () => "urn:camelrun:alice:github-credentials" });
  const agent = f.context("client_a");
  const failure = await f.echo(agent, "x").then(() => undefined, error => error);
  assert.ok(failure instanceof CredentialExchangeError);
  assert.deepEqual([failure.reason, failure.status], ["refused", 401]);
  assert.match(failure.message, /answered HTTP 401: token refused: unexpected "aud" claim value$/);
  assert.equal(f.exchange.state.requests.length, 1, "a refusal is not retried");
  assert.equal(f.mcp.state.authorizations.length, 0);

  // With the audience the endpoint expects, in auth.audience, it answers.
  const named: McpServerSpec = { ...f.spec, auth: { type: "exchange", url: f.exchange.url, audience: "urn:camelrun:alice:github-credentials" } };
  assert.equal(await f.echo(agent, "named", named), "echo: named");
  assert.equal(f.exchange.state.requests.at(-1)!.claims!.aud, "urn:camelrun:alice:github-credentials");
  // A stored audience that is not the tenant's own (saved before a rule, say) is never minted: the URL is used instead.
  const foreign: McpServerSpec = { ...f.spec, auth: { type: "exchange", url: f.exchange.url, audience: "urn:camelrun:bob:github-credentials" } };
  await f.echo(agent, "foreign", foreign).catch(() => {});
  assert.match(f.exchange.state.requests.at(-1)!.error!, /unexpected "aud" claim value/);

  // A token for a tool call (auth "runtime") is no exchange request, even for this audience: it has no `exchange` claim.
  const toolToken = await f.signing.token("urn:camelrun:alice:github-credentials", { tenant: "alice", agent: "client_a" });
  const replayed = await fetch(f.exchange.url, { method: "POST", headers: { Authorization: `Bearer ${toolToken}`, "Content-Type": "application/json" }, body: "{}" });
  assert.deepEqual([replayed.status, (await replayed.json()).error], [401, "token refused: not an exchange request"]);
});

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
  const stored = await r.db.query("select spec::text as spec from definitions");
  assert.doesNotMatch(stored.rows.map(row => row.spec).join("\n"), /ghs_/, "never persisted");
  const logged = r.logs.flatMap(line => { try { const parsed = JSON.parse(line); return parsed.type === "tool_credential_exchange" ? [parsed] : []; } catch { return []; } });
  assert.ok(logged.some(line => line.Outcome === "fetched" && line.agent === agent.id && line.server === "github" && line.Tenant === "alice"), "a log line and metric for the fetch");
  assert.ok(logged.some(line => line.Outcome === "refused" && line.status === 403));

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
