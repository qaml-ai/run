import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { OPERATOR, lastUser, passwordSession, runtime } from "./runtime-server.ts";

const PUBLIC = "https://agents.example.test";
const REDIRECT = "http://127.0.0.1:43210/callback";
const TOOLS = ["signups_daily", "accounts", "activation", "agents", "usage_daily", "usage_models", "spend", "balances", "storage", "oauth_grants", "trend", "health"];

/** An MCP client of /v1/ops/mcp with `token`, and a call that gives each tool's JSON. */
async function connect(t: { after(fn: () => unknown): void }, base: string, token: string) {
  const client = new Client({ name: "ops-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/ops/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    return { isError: !!result.isError, json: result.structuredContent as any, text: String(result.content[0]?.text ?? "") };
  };
}

/** A registered client and alice's console session, for the consent page of `resource`. */
async function session(r: { base: string }, resource: string) {
  const registered = await fetch(`${r.base}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Ops dashboard", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }) });
  const client = await registered.json() as { client_id: string };
  const cookie = await passwordSession(r.base, OPERATOR, "alice", "alice@example.test");
  const verifier = randomBytes(32).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", state: "s-1", resource,
  });
  const post = (path: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${r.base}${path}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body) });
  return { client, cookie, verifier, query, post };
}

test("the operations endpoint names its own protected resource, and answers nobody who is not signed in", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  const metadata = await (await fetch(`${r.base}/.well-known/oauth-protected-resource/v1/ops/mcp`)).json() as any;
  assert.deepEqual([metadata.resource, metadata.authorization_servers, metadata.scopes_supported, metadata.resource_name],
    [`${PUBLIC}/v1/ops/mcp`, [PUBLIC], ["ops"], "camelRun operations"]);
  assert.equal(metadata.resource_documentation, `${PUBLIC}/docs/operations/ops-mcp.md`);
  const server = await (await fetch(`${r.base}/.well-known/oauth-authorization-server`)).json() as any;
  assert.deepEqual(server.scopes_supported, ["agents", "ops"]);
  // /mcp's own metadata is untouched.
  const hosted = await (await fetch(`${r.base}/.well-known/oauth-protected-resource/mcp`)).json() as any;
  assert.deepEqual([hosted.resource, hosted.scopes_supported, hosted.resource_name], [`${PUBLIC}/mcp`, ["agents"], "camelRun"]);

  // Without a token it says where to sign in, for its own resource and scope.
  const anonymous = await fetch(`${r.base}/v1/ops/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get("www-authenticate")!, new RegExp(`^Bearer resource_metadata="${PUBLIC}/\\.well-known/oauth-protected-resource/v1/ops/mcp".*scope="ops"`));
  // An API token is no OAuth token: this endpoint takes the team's sign-in only.
  const api = await fetch(`${r.base}/v1/ops/mcp`, { method: "POST", headers: { Authorization: `Bearer ${OPERATOR}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(api.status, 401);
});

test("only the tenants on AGENT_OPS_ADMINS connect: anyone else is refused at consent, and /mcp is untouched", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }));
  const { cookie, query, post, client, verifier } = await session(r, `${PUBLIC}/v1/ops/mcp`);
  // No AGENT_OPS_ADMINS: alice is a tenant like any other, and the team's endpoint says so, without granting a code.
  const consent = await fetch(`${r.base}/oauth/authorize?${query}`, { headers: { Cookie: cookie } });
  assert.equal(consent.status, 403);
  const page = await consent.text();
  assert.match(page, /camelRun operations is for the camelRun team only[\s\S]*AGENT_OPS_ADMINS/);
  const forged = await post("/oauth/authorize", { ...Object.fromEntries(query), decision: "allow" }, { Cookie: cookie, Origin: r.base });
  assert.equal(forged.status, 403);
  assert.equal(forged.headers.get("location"), null, "no code was issued");
  // /mcp still connects the same account: the two resources are separate.
  const hosted = new URLSearchParams({
    response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256", resource: `${PUBLIC}/mcp`,
  });
  assert.equal((await fetch(`${r.base}/oauth/authorize?${hosted}`, { headers: { Cookie: cookie }, redirect: "manual" })).status, 200);

  // A token that exists anyway (granted while the account was on the list, say) is refused on every request there:
  // the endpoint checks the list itself, not only the consent that issued the token.
  await r.db.query("insert into oauth_grants (id, tenant, client_id, client_name, login, scope, resource, created_at) values ('grt_ops', 'alice', 'mcp_x', 'Ops dashboard', 'alice@example.test', 'ops', 'ops', $1)", [Date.now()]);
  await r.db.query("insert into oauth_tokens (sha256, kind, grant_id, expires_at) values ($1, 'access', 'grt_ops', $2)", [createHash("sha256").update("aro_off-list").digest("hex"), Date.now() + 3_600_000]);
  const offList = await fetch(`${r.base}/v1/ops/mcp`, { method: "POST", headers: { Authorization: "Bearer aro_off-list", "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(offList.status, 403);
  assert.equal((await offList.json() as any).code, "NOT_TEAM");
});

test("the tools: read-only rows a dashboard charts, and a token that works here works nowhere else", async t => {
  const r = await runtime(t, body => ({ role: "assistant", content: `echo: ${lastUser(body)}` }), { AGENT_OPS_ADMINS: "alice" });
  const { cookie, query, post, client, verifier } = await session(r, `${PUBLIC}/v1/ops/mcp`);
  const consent = await fetch(`${r.base}/oauth/authorize?${query}`, { headers: { Cookie: cookie } });
  assert.equal(consent.status, 200);
  assert.match(await consent.text(), /production operations data[\s\S]*read-only/);
  const allowed = await post("/oauth/authorize", { ...Object.fromEntries(query), decision: "allow" }, { Cookie: cookie, Origin: r.base });
  assert.equal(allowed.status, 302);
  const code = new URL(allowed.headers.get("location")!).searchParams.get("code")!;
  const exchange = await post("/oauth/token", { client_id: client.client_id, grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier });
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json() as any;
  assert.match(tokens.access_token, /^aro_/);
  assert.equal(tokens.scope, "ops");

  // It reaches /v1/ops/mcp and nothing else that an /mcp token reaches.
  assert.equal((await r.call("/v1/me", { token: tokens.access_token })).status, 401);
  const crossed = await fetch(`${r.base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(crossed.status, 401, "an ops token is no token at /mcp");

  const call = await connect(t, r.base, tokens.access_token);
  const list = await fetch(`${r.base}/v1/ops/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const tools = (await list.json() as any).result.tools as any[];
  assert.deepEqual(tools.map(tool => tool.name), TOOLS);
  for (const tool of tools) {
    assert.ok(tool.title && tool.description, tool.name);
    assert.equal(tool.annotations?.readOnlyHint, true, tool.name);
    assert.equal(tool.annotations?.destructiveHint, false, tool.name);
    assert.equal(tool.inputSchema.type, "object", tool.name);
  }

  // An agent, so the platform has something to count; the tools answer it as rows.
  assert.equal((await r.call("/v1/agents", { body: { systemPrompt: "Hi." } })).status, 201);
  const signups = await call("signups_daily", { days: 7 });
  assert.equal(signups.isError, false);
  assert.equal(signups.json.rows.length, 7);
  assert.deepEqual(Object.keys(signups.json.rows[0]).sort(), ["day", "email", "github", "google", "signups"]);
  // alice is an admin tenant (the tenants file), not a sign-up: operator-made accounts are not counted.
  assert.equal(signups.json.rows.at(-1).signups, 0);
  const accounts = await call("accounts", { days: 7, limit: 5 });
  assert.deepEqual(accounts.json.rows, [], "no account was made in the tenants table");
  assert.equal((await call("activation")).json.rows[0].with_agent, 0);
  assert.equal((await call("agents")).json.totals.live, 1);
  const usage = await call("usage_daily", { days: 3 });
  assert.equal(usage.json.rows.length, 3);
  assert.equal(usage.json.rows.at(-1).responses, 0);
  assert.equal((await call("spend", { days: 2 })).json.rows.length, 12, "six kinds a day");
  assert.deepEqual(Object.keys((await call("balances")).json.totals).sort(), ["accounts", "balance_usd", "purchased_usd"]);
  assert.deepEqual((await call("storage")).json.rows, [], "nothing in Storage yet");
  const grants = await call("oauth_grants", { days: 3 });
  assert.equal(grants.json.totals.find((row: any) => row.resource === "ops").grants, 1);
  assert.equal(grants.json.clients[0].client_name, "Ops dashboard");
  assert.equal((await call("trend", { days: 5 })).json.rows.length, 5);
  assert.equal((await call("health")).json.rows[0].ops_grants, 1);
  // Arguments are checked: too many days, or a day count that is not a whole number, is an error a client sees.
  assert.equal((await call("signups_daily", { days: 366 })).isError, true);
  assert.equal((await call("accounts", { days: 1.5 })).isError, true);

  // Nothing here answers a token, a secret or a session.
  for (const result of [signups, accounts, usage, grants, await call("health"), await call("balances"), await call("storage")]) {
    assert.doesNotMatch(result.text, /aro_|arc_|arr_|art_|correct-horse/, result.text.slice(0, 200));
  }

  // Stateless: only POST answers.
  assert.equal((await fetch(`${r.base}/v1/ops/mcp`, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405);
  assert.equal((await fetch(`${r.base}/v1/ops/mcp`, { method: "DELETE", headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405);
});
