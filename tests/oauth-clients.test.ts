import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { OAuth } from "../src/oauth.ts";
import { PublicOrigins } from "../src/origins.ts";

const BASE = "https://run.example.test";
const oauth = (signedIn = true) => new OAuth({
  db: {} as never, accounts: {} as never, secret: "fixture-server-secret", origins: new PublicOrigins(BASE), github: false,
  consoleAuth: { principal: async () => signedIn ? { tenant: "acme", via: "console", login: "alice" } : undefined } as never,
});
const register = async (server: OAuth, body: object) => (await server.app.request("/oauth/register", { method: "POST", body: JSON.stringify(body) })).json() as Promise<any>;

test("registering a confidential client's public metadata again never yields its secret", async () => {
  const server = oauth();
  const metadata = { client_name: "Server app", redirect_uris: ["https://app.example/cb"] };
  const victim = await register(server, metadata);
  // Everything in the registration can be read back from the public client_id.
  const payload = JSON.parse(Buffer.from(victim.client_id.slice(4).split(".")[0], "base64url").toString("utf8"));
  const copy = await register(server, { client_name: payload.n, redirect_uris: payload.r, token_endpoint_auth_method: payload.m });
  assert.notEqual(copy.client_id, victim.client_id);
  assert.notEqual(copy.client_secret, victim.client_secret);
  // A client registered before ids had a nonce is still recognized.
  const legacy = Buffer.from(JSON.stringify({ n: "Old app", r: ["https://old.example/cb"], m: "none" })).toString("base64url");
  const legacyId = `mcp_${legacy}.${createHmac("sha256", "fixture-server-secret").update(`oauth-client:${legacy}`).digest("base64url").slice(0, 32)}`;
  const consent = await server.app.request(`/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: legacyId, redirect_uri: "https://old.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`);
  assert.equal(consent.status, 200);
});
