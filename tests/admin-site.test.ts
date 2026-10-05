import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { listen, runtime, until } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const OPS = "ops-operator-token-at-least-24-chars";
const tenantsFile = { tenants: { ops: { tokenSha256: sha(OPS), apiKeys: {} } }, platformKeys: { openrouter: "fixture-platform-key" } };
const HOST = "admin.example.test";
const AUD = "fixture-access-audience";

/** A GET as Cloudflare sends it to the load balancer: the site's name as Host, and Access's token, if any. */
function get(base: string, path: string, headers: Record<string, string> = {}) {
  const url = new URL(path, base);
  return new Promise<{ status: number; body: string; type?: string }>((resolve, reject) => {
    request(url, { headers: { host: HOST, ...headers } }, response => {
      let body = "";
      response.setEncoding("utf8").on("data", chunk => body += chunk).on("end", () => resolve({ status: response.statusCode!, body, type: response.headers["content-type"] }));
    }).on("error", reject).end();
  });
}

test("the admin site answers only on its hostname, to people Cloudflare Access signed in, with every tenant's stats", { timeout: 120_000 }, async t => {
  // A stand-in for the Access team: its signing keys, at the path Cloudflare publishes them.
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "fixture", alg: "RS256" };
  const team = await listen(t, (req, res) => {
    if (req.url !== "/cdn-cgi/access/certs") return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ keys: [jwk] }));
  });
  const token = (claims: { iss?: string; aud?: string; exp?: string } = {}, key = privateKey) =>
    new SignJWT({ email: "teammate@camelai.com" }).setProtectedHeader({ alg: "RS256", kid: "fixture" })
      .setIssuer(claims.iss ?? team).setAudience(claims.aud ?? AUD).setIssuedAt().setExpirationTime(claims.exp ?? "5m").sign(key);
  const access = async (claims?: Parameters<typeof token>[0]) => ({ "cf-access-jwt-assertion": await token(claims) });

  const { call, prompt, base } = await runtime(t, () => ({ role: "assistant", content: "hi", usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    { AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_ADMIN_HOST: HOST, AGENT_ADMIN_ACCESS_TEAM: team, AGENT_ADMIN_ACCESS_AUD: AUD }, tenantsFile);

  // Without a valid Access token for this application, nothing: not the page, not the stats, not the rest of the runtime.
  assert.equal((await get(base, "/api/stats")).status, 401);
  assert.equal((await get(base, "/")).status, 401);
  assert.equal((await get(base, "/v1/me", { authorization: `Bearer ${OPS}` })).status, 401);
  assert.equal((await get(base, "/api/stats", await access({ aud: "another-application" }))).status, 401);
  assert.equal((await get(base, "/api/stats", await access({ iss: "https://other.cloudflareaccess.com" }))).status, 401);
  assert.equal((await get(base, "/api/stats", await access({ exp: "-1m" }))).status, 401);
  const stranger = (await generateKeyPair("RS256")).privateKey;
  assert.equal((await get(base, "/api/stats", { "cf-access-jwt-assertion": await token({}, stranger) })).status, 401);

  // Signed in: the stats. The rest of the runtime is not served on the site's name, nor the site on any other.
  const empty = await get(base, "/api/stats", await access());
  assert.equal(empty.status, 200);
  assert.equal(JSON.parse(empty.body).viewer, "teammate@camelai.com");
  assert.equal(JSON.parse(empty.body).signups.total, 0);
  assert.equal(JSON.parse(empty.body).daily.length, 30, "a row for each day, empty ones too");
  assert.notEqual((await get(base, "/v1/me", { ...await access(), authorization: `Bearer ${OPS}` })).type, "application/json");
  assert.equal((await call("/api/stats")).status, 404);
  assert.equal((await get(base, "/api/stats?days=0", await access())).status, 400);

  // One sign-up that made a token and an agent and ran it; another that did nothing.
  const lab = (await call("/v1/tenants", { body: { id: "lab-one" }, token: OPS })).json.token.token;
  assert.equal((await call("/v1/tenants", { body: { id: "lab-two" }, token: OPS })).status, 201);
  assert.equal((await call("/v1/billing/adjustments", { body: { tenant: "lab-one", amount: 5_000_000, reason: "test", idempotencyKey: "admin:lab-one" }, token: OPS })).status, 201);
  const agent = (await call("/v1/agents", { body: {}, token: lab })).json;
  await prompt(agent.id, "hello", lab);

  // Usage reaches the database in batched flushes.
  const stats = await until(async () => {
    const read = JSON.parse((await get(base, "/api/stats?days=7", await access())).body);
    return read.activation.withUsage === 1 && read;
  }, "the turn's usage to be flushed", 60_000);
  assert.equal(stats.days, 7);
  assert.equal(stats.daily.length, 7);
  assert.equal(stats.signups.total, 2);
  assert.equal(stats.signups.last24h, 2);
  assert.equal(stats.signups.operator, 2);
  assert.equal(stats.daily.at(-1).signups, 2);
  assert.ok(stats.daily.at(-1).responses >= 1);
  assert.deepEqual(stats.activation, { tenants: 2, withToken: 2, withAgent: 1, withUsage: 1, purchased: 0 });
  assert.equal(stats.agents.live, 1);
  const one = stats.recent.find((row: any) => row.tenant === "lab-one");
  assert.equal(one.agents, 1);
  assert.ok(one.responses >= 1);
  assert.equal(one.signIn, "operator");
  assert.ok(one.balance <= 5_000_000);
});
