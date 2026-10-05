import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * The plugin's path end to end against a running camelRun, as ChatGPT takes it: discovery from the 401, dynamic
 * client registration with ChatGPT's redirect URI, sign-in on the consent page with an email and password (the
 * reviewer's way in), consent, the code exchange with PKCE, /v1/me and the MCP tools the review cases use, a refresh,
 * and revocation. Everything it makes is deleted, and the grant is revoked, even when a step fails.
 *
 *   CAMELRUN_EMAIL=reviewer@example.com CAMELRUN_PASSWORD_FILE=~/.config/camelrun/password-chatgpt-review \
 *     node --experimental-strip-types plugins/chatgpt/e2e.ts [https://run.camelai.com]
 *
 * The password is read from CAMELRUN_PASSWORD_FILE (as `infra/tenant.sh set-password` writes it) or CAMELRUN_PASSWORD,
 * and never printed.
 */
const base = (process.argv[2] ?? "https://run.camelai.com").replace(/\/$/, "");
const email = process.env.CAMELRUN_EMAIL;
const password = process.env.CAMELRUN_PASSWORD_FILE ? readFileSync(process.env.CAMELRUN_PASSWORD_FILE, "utf8").replace(/\r?\n$/, "") : process.env.CAMELRUN_PASSWORD;
if (!email || !password) { console.error("Set CAMELRUN_EMAIL, and CAMELRUN_PASSWORD_FILE or CAMELRUN_PASSWORD, to the sign-in of the account to test with"); process.exit(2); }
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const suffix = randomBytes(3).toString("hex");
const agentKey = `chatgpt-e2e-${suffix}`, definitionKey = `chatgpt-e2e-def-${suffix}`;

const step = (name: string) => console.log(`- ${name}`);
function check(ok: unknown, what: string): asserts ok { if (!ok) throw new Error(`Failed: ${what}`); }
const form = (body: Record<string, string>) => new URLSearchParams(body);

// Discovery, as a client with nothing but the URL finds it.
const challenge = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
const resourceUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate") ?? "")?.[1];
check(challenge.status === 401 && resourceUrl, "an unauthenticated /mcp answers 401 naming its resource metadata");
const resource = await (await fetch(resourceUrl)).json();
check(resource.resource === `${base}/mcp`, `the resource is the URL reached (${resource.resource})`);
const issuer = resource.authorization_servers[0];
const server = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
check(server.issuer === issuer, "the authorization server's issuer is the one the resource names");
check(server.code_challenge_methods_supported?.includes("S256"), "PKCE S256 is advertised");
check(server.authorization_response_iss_parameter_supported === true, "iss is returned (so ChatGPT uses its stable redirect URI)");
// The sign-in and consent pages are the authorization endpoint's site, which can differ from the issuer's.
const pages = new URL(server.authorization_endpoint).origin;
step(`discovery: resource ${resource.resource}, issuer ${issuer}, pages on ${pages}, scopes ${resource.scopes_supported}`);

// Registration, as ChatGPT registers: a confidential client posting its secret.
const registered = await fetch(server.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
  client_name: "ChatGPT (camelRun plugin e2e)", redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "client_secret_post",
}) });
check(registered.status === 201, `registration answers 201 (got ${registered.status})`);
const client = await registered.json();
step("dynamic client registration with ChatGPT's redirect URI");

const verifier = randomBytes(32).toString("base64url");
const state = randomBytes(8).toString("hex");
const query = new URLSearchParams({
  response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, scope: resource.scopes_supported.join(" "), state,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: resource.resource,
});
const authorize = `${server.authorization_endpoint}?${query}`;
const signIn = await fetch(authorize);
const signInPage = await signIn.text();
check(signIn.status === 200 && /action="\/oauth\/password"[\s\S]*name="email"[\s\S]*name="password"/.test(signInPage), "the sign-in page offers email and password sign-in");
check(!/name="token"/.test(signInPage), "and no token sign-in");
const login = await fetch(`${pages}/oauth/password`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: pages }, body: form({ next: `/oauth/authorize?${query}`, email, password }) });
check(login.status === 303, `email and password sign-in answers 303 (got ${login.status})`);
const cookie = login.headers.get("set-cookie")!.split(";")[0];
const consent = await fetch(authorize, { headers: { Cookie: cookie } });
check(/Allow/.test(await consent.text()), "the consent page asks to allow the client");
const allowed = await fetch(server.authorization_endpoint, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: pages, Cookie: cookie }, body: form({ ...Object.fromEntries(query), decision: "allow" }) });
const back = new URL(allowed.headers.get("location") ?? "about:blank");
check(`${back.origin}${back.pathname}` === REDIRECT && back.searchParams.get("state") === state && back.searchParams.get("iss") === issuer, "consent redirects to ChatGPT with the state and iss");
step("sign-in with an email and password, and consent");

const exchange = async (body: Record<string, string>) => {
  const response = await fetch(server.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: client.client_id, client_secret: client.client_secret, resource: resource.resource, ...body }) });
  const json = await response.json();
  check(response.ok, `token endpoint: ${json.error ?? response.status}`);
  return json;
};
let tokens = await exchange({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: REDIRECT, code_verifier: verifier });
step(`code exchange: access token for ${tokens.expires_in} s, scope ${tokens.scope}`);
const meResponse = await fetch(`${pages}/v1/me`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
const meJson = await meResponse.json();
check(meResponse.ok && meJson.via === "oauth", `/v1/me answers for the grant (got ${meResponse.status})`);
step(`/v1/me with the access token: account ${meJson.tenant}, via ${meJson.via}`);

const mcp = new Client({ name: "camelrun-plugin-e2e", version: "1" });
await mcp.connect(new StreamableHTTPClientTransport(new URL(resource.resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result: any = await mcp.callTool({ name, arguments: args });
  const text: string = result.content?.[0]?.text ?? "";
  check(!result.isError, `${name}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const made: string[] = [];
try {
  const listed = (await mcp.listTools()).tools;
  for (const tool of listed) for (const hint of ["readOnlyHint", "destructiveHint", "openWorldHint"] as const) check(typeof tool.annotations?.[hint] === "boolean", `${tool.name} states ${hint}`);
  step(`${listed.length} tools, each with explicit read-only, destructive and open-world hints`);

  const me = await call("whoami");
  step(`whoami: account ${me.tenant}, default model ${me.defaultModel}`);

  await call("create_agent", { key: agentKey, systemPrompt: "Answer every message with a haiku, and nothing else." });
  made.push(agentKey);
  step(`create_agent ${agentKey}`);
  const ran = await call("run_agent", { agent: agentKey, message: "Write about autumn." });
  check(ran.status === "completed" && ran.text, `run_agent completed (status ${ran.status})`);
  step(`run_agent: ${JSON.stringify(ran.text.slice(0, 120))}`);
  check((await call("list_agents")).some((agent: any) => agent.key === agentKey), "list_agents shows the new agent");
  step("list_agents");

  const manifest = `key: ${definitionKey}\nsystemPrompt: "Label each message as bug, question or feedback, in one word."\nagents: [{ key: ${definitionKey}-1 }]\n`;
  await call("deploy", { manifest, dryRun: true });
  const deployed = await call("deploy", { manifest });
  made.push(`${definitionKey}-1`);
  check(deployed[0].agents[0].status === "ready", "deploy made the manifest's agent");
  const label = await call("run_agent", { agent: `${definitionKey}-1`, message: "The export button does nothing." });
  step(`deploy (dry run, then for real) and run_agent: ${JSON.stringify(label.text)}`);

  tokens = await exchange({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  step("refresh token rotated");
} finally {
  await mcp.close();
  // Clean up with a fresh connection on the latest access token.
  const cleanup = new Client({ name: "camelrun-plugin-e2e-cleanup", version: "1" });
  await cleanup.connect(new StreamableHTTPClientTransport(new URL(resource.resource), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
  for (const agent of made) {
    const result: any = await cleanup.callTool({ name: "delete_agent", arguments: { agent } });
    console.log(`- delete_agent ${agent}: ${result.isError ? result.content[0].text : "deleted"}`);
  }
  if (made.includes(`${definitionKey}-1`)) {
    const result: any = await cleanup.callTool({ name: "delete_definition", arguments: { definition: definitionKey } });
    console.log(`- delete_definition ${definitionKey}: ${result.isError ? result.content[0].text : "deleted"}`);
  }
  await cleanup.close();
  const revoked = await fetch(server.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: form({ client_id: client.client_id, client_secret: client.client_secret, token: tokens.refresh_token }) });
  const after = await fetch(resource.resource, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  console.log(`- revoked the grant (${revoked.status}); its access token now gets ${after.status}`);
}
console.log("ok");
