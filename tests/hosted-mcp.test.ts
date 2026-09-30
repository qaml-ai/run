import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { request, type IncomingMessage } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { REFRESH_GRACE_MS } from "../src/oauth.ts";
import { OPERATOR, OTHER_OPERATOR, lastUser, runtime } from "./runtime-server.ts";

const PUBLIC = "https://agents.example.test";
const REDIRECT = "http://127.0.0.1:43210/callback";

/** An MCP client of the hosted endpoint, authenticated with `token`; `call` gives each tool's JSON or text. */
async function connect(t: { after(fn: () => unknown): void }, base: string, token: string) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    const text = result.content[0].text;
    let json: any;
    try { json = JSON.parse(text); } catch { /* text */ }
    return { isError: !!result.isError, json, text };
  };
  return { client, call };
}

test("the hosted MCP endpoint runs the CLI's tools as the caller, and reads no files or environment", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  process.env.HOSTED_TEST_SECRET = "must-not-leak";
  t.after(() => { delete process.env.HOSTED_TEST_SECRET; });

  assert.equal((await fetch(`${r.base}/.well-known/openai-apps-challenge`)).status, 404, "no domain challenge unless one is set");
  const anonymous = await fetch(`${r.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate")!, new RegExp(`^Bearer resource_metadata="${PUBLIC}/\\.well-known/oauth-protected-resource/mcp"`));
  const wrong = await fetch(`${r.base}/mcp`, { method: "POST", headers: { Authorization: "Bearer art_nope" } });
  assert.equal(wrong.status, 401);
  assert.match(wrong.headers.get("www-authenticate")!, /error="invalid_token"/);

  // A body past the limit is refused from its length, before it is read.
  const huge = request(`${r.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json", "Content-Length": String(9 * 1024 * 1024) } });
  huge.write("{");
  const [tooLarge] = await once(huge, "response") as [IncomingMessage];
  assert.equal(tooLarge.statusCode, 413);
  huge.destroy();

  const { client, call } = await connect(t, r.base, OPERATOR);
  const listed = (await client.listTools()).tools;
  const names = listed.map(tool => tool.name);
  // Every tool says, for clients that confirm before acting, whether it changes, destroys or reaches beyond the account.
  for (const tool of listed) {
    assert.ok(tool.title && tool.description, tool.name);
    for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) assert.equal(typeof tool.annotations?.[hint], "boolean", `${tool.name} ${hint}`);
    if (tool.annotations!.readOnlyHint) assert.equal(tool.annotations!.destructiveHint, false, tool.name);
  }
  const hints = (name: string) => listed.find(tool => tool.name === name)!.annotations!;
  for (const name of ["delete_agent", "delete_definition", "delete_schedule", "deploy", "configure_agent", "create_agent", "abort_agent", "answer_input"]) assert.equal(hints(name).destructiveHint, true, name);
  for (const name of ["list_agents", "get_agent", "agent_history", "get_run", "read_docs", "whoami"]) assert.equal(hints(name).readOnlyHint, true, name);
  assert.deepEqual([hints("run_agent").readOnlyHint, hints("run_agent").openWorldHint], [false, true], "a run can reach the web and the agent's tool servers");
  assert.ok(names.includes("deploy") && names.includes("run_agent") && names.includes("read_docs"));
  const deployTool = (await client.listTools()).tools.find(tool => tool.name === "deploy")!;
  assert.deepEqual(Object.keys(deployTool.inputSchema.properties!).sort(), ["apply", "dryRun", "manifest"], "no file argument when hosted");

  assert.equal((await call("whoami")).json.tenant, "alice");
  assert.equal((await call("whoami")).json.url, PUBLIC, "tools show the public URL, not the loopback");
  const deployed = await call("deploy", { manifest: "key: hosted\nsystemPrompt: You help.\nagents: [{ key: hosted-1 }]\n" });
  assert.equal(deployed.isError, false, deployed.text);
  assert.equal(deployed.json[0].agents[0].status, "ready");
  const ran = await call("run_agent", { agent: "hosted-1", message: "ping" });
  assert.equal(ran.json.text, "echo: ping", ran.text);
  assert.match((await call("read_docs")).text, /^# camelRun/);
  assert.equal((await call("read_docs", { path: "../v1/me" })).isError, true);

  // Nothing of the server's: no files, no environment variables.
  const file = await call("deploy", { manifest: "key: sneaky\nsystemPromptFile: /etc/passwd\n" });
  assert.equal(file.isError, true);
  assert.match(file.text, /reads no files/);
  const variable = await call("deploy", { manifest: "key: sneaky\nsystemPrompt: \"${HOSTED_TEST_SECRET}\"\n" });
  assert.equal(variable.isError, true);
  assert.match(variable.text, /reads no environment variables/);
  assert.equal((await r.call("/v1/definitions")).json.some((definition: any) => definition.name === "sneaky"), false);

  // Another tenant's key sees only its own agents.
  const bob = await connect(t, r.base, OTHER_OPERATOR);
  assert.deepEqual((await bob.call("list_agents")).json, []);
  assert.equal((await bob.call("get_agent", { agent: ran.json.agent })).isError, true);
});

test("MCP clients sign in with OAuth: registration, consent, PKCE, rotating refresh tokens, revocation", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${r.base}${path}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });

  const resource = await (await fetch(`${r.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.deepEqual([resource.resource, resource.authorization_servers], [`${PUBLIC}/mcp`, [PUBLIC]]);
  const server = await (await fetch(`${r.base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(server.issuer, PUBLIC);
  assert.equal(server.jwks_uri, `${PUBLIC}/.well-known/jwks.json`, "identity tokens' keys are still named");
  assert.equal(server.token_endpoint, `${PUBLIC}/oauth/token`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);

  // Registration stores nothing, and refuses redirects to other sites over http.
  const refused = await fetch(`${r.base}/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error, "invalid_redirect_uri");
  const registered = await fetch(`${r.base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) });
  assert.equal(registered.status, 201);
  const client = await registered.json();
  assert.equal(client.client_secret, undefined, "a public client has no secret");

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s-1", resource: `${PUBLIC}/mcp` });

  // Not signed in: the page offers sign-in, and an API token signs in (same-origin only).
  const signInPage = await fetch(`${r.base}/oauth/authorize?${query}`);
  assert.equal(signInPage.status, 200);
  assert.equal(signInPage.headers.get("x-frame-options"), "DENY");
  assert.match(await signInPage.text(), /Test Agent[\s\S]*name="token"/);
  assert.equal((await post("/oauth/login", { token: OPERATOR, next: `/oauth/authorize?${query}` }, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post("/oauth/login", { token: OPERATOR, next: "https://evil.example/" }, { Origin: r.base })).status, 400, "only back to the consent page");
  const login = await post("/oauth/login", { token: OPERATOR, next: `/oauth/authorize?${query}` }, { Origin: r.base });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];

  const consent = await fetch(`${r.base}${login.headers.get("location")}`, { headers: { Cookie: cookie } });
  const consentHtml = await consent.text();
  assert.match(consentHtml, /Connect Test Agent\?[\s\S]*alice[\s\S]*127\.0\.0\.1:43210/);

  const decide = (decision: string, params = query, origin = r.base) => post("/oauth/authorize", { ...Object.fromEntries(params), decision }, { Cookie: cookie, Origin: origin });
  assert.equal((await decide("allow", query, "https://evil.example")).status, 403, "consent is same-origin");
  const denied = new URL((await decide("deny")).headers.get("location")!);
  assert.deepEqual([denied.searchParams.get("error"), denied.searchParams.get("state")], ["access_denied", "s-1"]);
  const allowed = await decide("allow");
  assert.equal(allowed.status, 302);
  const back = new URL(allowed.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  assert.equal(back.searchParams.get("state"), "s-1");
  assert.equal(back.searchParams.get("iss"), PUBLIC);
  const code = back.searchParams.get("code")!;

  // Unknown redirect URIs are never redirected to; PKCE is required.
  const elsewhere = new URLSearchParams(query); elsewhere.set("redirect_uri", "https://evil.example/cb");
  assert.equal((await fetch(`${r.base}/oauth/authorize?${elsewhere}`, { headers: { Cookie: cookie }, redirect: "manual" })).status, 400);
  const plain = new URLSearchParams(query); plain.delete("code_challenge_method");
  assert.equal(new URL((await fetch(`${r.base}/oauth/authorize?${plain}`, { headers: { Cookie: cookie }, redirect: "manual" })).headers.get("location")!).searchParams.get("error"), "invalid_request");

  const exchange = (body: Record<string, string>) => post("/oauth/token", { client_id: client.client_id, ...body });
  const wrongVerifier = await exchange({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: randomBytes(32).toString("base64url") });
  assert.equal((await wrongVerifier.json()).error, "invalid_grant");
  // The failed attempt used the code up: codes are single-use whatever happens. Get another.
  const code2 = new URL((await decide("allow")).headers.get("location")!).searchParams.get("code")!;
  const issued = await exchange({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("cache-control"), "no-store");
  const tokens = await issued.json();
  assert.match(tokens.access_token, /^aro_/);
  assert.equal(tokens.expires_in, 3600);
  assert.equal((await (await exchange({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: verifier })).json()).error, "invalid_grant", "a code works once");

  // The access token is the tenant at /mcp and /v1, but cannot mint API tokens that would outlive the grant.
  const mcp = await connect(t, r.base, tokens.access_token);
  assert.equal((await mcp.call("whoami")).json.tenant, "alice");
  assert.equal((await mcp.call("create_agent", { key: "via-oauth", systemPrompt: "Hi." })).isError, false);
  assert.equal((await mcp.call("run_agent", { agent: "via-oauth", message: "hello" })).json.text, "echo: hello");
  assert.equal((await r.call("/v1/me", { token: tokens.access_token })).json.via, "oauth");
  assert.equal((await r.call("/v1/tokens", { token: tokens.access_token, body: { name: "escape" } })).status, 403);
  for (const [path, method, body] of [
    ["/v1/billing/alerts", "PUT", { thresholdUsd: 5 }],
    ["/v1/billing/alerts/recipients", "POST", { email: "finance@example.test" }],
    ["/v1/billing/alerts/recipients/00000000-0000-4000-8000-000000000000", "DELETE", undefined],
    ["/v1/billing/checkout", "POST", { amountUsd: 20 }],
    ["/v1/billing/portal", "POST", { flow: "payment_method" }],
    ["/v1/billing/auto-topup/quote", "POST", { thresholdUsd: 5, amountUsd: 20, monthlyLimitUsd: 200 }],
    ["/v1/billing/auto-topup/disable", "POST", {}],
  ] as const) assert.equal((await r.call(path, { token: tokens.access_token, method, body })).status, 403, "agents OAuth scope cannot change billing");
  const grants = (await r.call("/v1/oauth/grants")).json;
  assert.deepEqual(grants.map((grant: any) => [grant.clientName, grant.login]), [["Test Agent", null]]);
  assert.equal((await r.call("/v1/oauth/grants", { token: OTHER_OPERATOR })).json.length, 0);

  // Refreshing rotates. Concurrent refreshes with one token, and a retry within the grace, get the same new tokens.
  const concurrent = await Promise.all([1, 2, 3].map(async () => (await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json()));
  const refreshed = concurrent[0];
  assert.match(refreshed.access_token, /^aro_/);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token);
  for (const other of concurrent) assert.deepEqual([other.access_token, other.refresh_token], [refreshed.access_token, refreshed.refresh_token], "one rotation, whoever won it");
  const retried = await (await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json();
  assert.equal(retried.refresh_token, refreshed.refresh_token, "a retry within the grace");
  assert.equal((await r.call("/v1/me", { token: refreshed.access_token })).status, 200);
  assert.equal((await r.db.query("select count(*)::int as n from oauth_tokens where kind = 'refresh' and grant_id is not null")).rows[0].n, 2, "the losers' tokens are gone");
  // Past the grace, presenting a used refresh token again revokes the grant.
  const hash = createHash("sha256").update(tokens.refresh_token).digest("hex");
  await r.db.query("update oauth_tokens set used_at = used_at - $2 where sha256 = $1", [hash, REFRESH_GRACE_MS + 1000]);
  assert.equal((await (await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).json()).error, "invalid_grant");
  assert.equal((await r.call("/v1/me", { token: refreshed.access_token })).status, 401, "reuse ended the grant");
  assert.equal((await r.call("/v1/oauth/grants")).json.length, 0);

  // A new grant, revoked from the API.
  const code3 = new URL((await decide("allow")).headers.get("location")!).searchParams.get("code")!;
  const third = await (await exchange({ grant_type: "authorization_code", code: code3, redirect_uri: REDIRECT, code_verifier: verifier })).json();
  const [grant] = (await r.call("/v1/oauth/grants")).json;
  assert.equal((await r.call(`/v1/oauth/grants/${grant.id}`, { method: "DELETE", token: OTHER_OPERATOR })).status, 404);
  assert.equal((await r.call(`/v1/oauth/grants/${grant.id}`, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(`${r.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${third.access_token}` } })).status, 401);
  assert.equal((await (await exchange({ grant_type: "refresh_token", refresh_token: third.refresh_token })).json()).error, "invalid_grant");

  // A confidential client must present its secret.
  const confidential = await (await fetch(`${r.base}/oauth/register`, { method: "POST", body: JSON.stringify({ client_name: "Server app", redirect_uris: ["https://app.example/cb"] }) })).json();
  assert.equal(confidential.token_endpoint_auth_method, "client_secret_basic");
  const noSecret = await post("/oauth/token", { client_id: confidential.client_id, grant_type: "refresh_token", refresh_token: "x" });
  assert.equal(noSecret.status, 401);
  assert.equal((await noSecret.json()).error, "invalid_client");
  const basic = `Basic ${Buffer.from(`${encodeURIComponent(confidential.client_id)}:${encodeURIComponent(confidential.client_secret)}`).toString("base64")}`;
  assert.equal((await (await post("/oauth/token", { grant_type: "refresh_token", refresh_token: "x" }, { Authorization: basic })).json()).error, "invalid_grant", "authenticated, with a bad token");
});

test("a tool's result is cut at MAX_RESULT characters, saying so", async () => {
  const { Client: McpClient } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { createServer, MAX_RESULT } = await import("../packages/cli/src/mcp.ts");
  const long = "x".repeat(MAX_RESULT + 10);
  const server = createServer(() => ({ text: async () => long }) as any);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const result: any = await client.callTool({ name: "read_docs", arguments: {} });
  assert.equal(result.content[0].text.startsWith("x".repeat(MAX_RESULT) + "\n\n[Cut at"), true);
  await client.close();
});

test("the OpenAI apps domain challenge is served as plain text from AGENT_OPENAI_APPS_CHALLENGE", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "hi" }), { AGENT_OPENAI_APPS_CHALLENGE: " challenge-token-123\n" });
  const response = await fetch(`${r.base}/.well-known/openai-apps-challenge`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /^text\/plain/);
  assert.equal(await response.text(), "challenge-token-123");
});
