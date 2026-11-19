import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startFixture } from "./fixture.ts";

test("the named hosted MCP Worker preserves bearer credentials and issuer discovery", { timeout: 180_000 }, async (t) => {
  const apiKey = "art_fixture-preserved-tenant-key";
  const oauth = "aro_fixture-preserved-oauth-grant";
  const origin = "https://run.example.test";
  const issuer = "https://agents.example.test";
  const f = await startFixture({
    tenants: [{ id: "fixture", token: apiKey }],
    vars: { AGENT_PUBLIC_URL: origin, AGENT_PUBLIC_ALIASES: issuer, AGENT_ISSUER: issuer },
    entrypoint: fileURLToPath(new URL("./legacy-mcp-entry.ts", import.meta.url)),
    loopbackServices: { MCP_LEGACY_API: "FixtureLegacyOrigin" },
  });
  t.after(() => f.stop());
  await f.db.query(`insert into oauth_grants(id,tenant,client_id,client_name,scope,resource,created_at)
    values('fixture','fixture','fixture','Fixture','agents','agents',$1)`, [Date.now()]);
  await f.db.query(`insert into oauth_tokens(sha256,kind,grant_id,expires_at) values($1,'access','fixture',$2)`, [
    createHash("sha256").update(oauth).digest("hex"), Date.now() + 60_000,
  ]);
  const retired = { ...generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }), kid: "retired", alg: "EdDSA", use: "sig" };
  await f.db.query(`insert into signing_keys(kid,public_jwk,private_sealed,created_at,retired_at) values('retired',$1,'{}',1,2)`, [retired]);

  const reachedAlias = { "x-forwarded-host": new URL(issuer).host };
  const challenge = await fetch(`${f.url}/mcp`, { headers: reachedAlias });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate")!, /https:\/\/agents\.example\.test\/\.well-known\/oauth-protected-resource\/mcp/);
  const metadata = await fetch(`${f.url}/.well-known/oauth-protected-resource/mcp`, { headers: reachedAlias });
  assert.equal(metadata.status, 200);
  const protectedResource = await metadata.json() as { resource: string; authorization_servers: string[] };
  assert.equal(protectedResource.resource, `${issuer}/mcp`);
  assert.deepEqual(protectedResource.authorization_servers, [issuer]);
  const discovery = await fetch(`${f.url}/.well-known/oauth-authorization-server`, { headers: reachedAlias });
  assert.equal(discovery.status, 200);
  const server = await discovery.json() as { issuer: string; jwks_uri: string; token_endpoint: string };
  assert.deepEqual([server.issuer, server.jwks_uri, server.token_endpoint], [issuer, `${issuer}/.well-known/jwks.json`, `${origin}/oauth/token`]);
  const jwks = await fetch(`${f.url}/.well-known/jwks.json`, { headers: reachedAlias });
  assert.equal(jwks.status, 200);
  assert.equal(jwks.headers.get("cache-control"), "public, max-age=300");
  const { keys } = await jwks.json() as { keys: { kid: string; d?: string }[] };
  assert.deepEqual(keys.map(({ kid }) => kid), ["retired", "fixture-camelfs"]);
  assert.deepEqual(keys[0], retired);
  assert.ok(keys.every(key => key.d === undefined));
  const scoped = `/v1/agents/client_${"0".repeat(40)}/mcp`;
  for (const endpoint of [scoped, "/v1/ops/mcp"]) {
    const path = `${f.url}/.well-known/oauth-protected-resource${endpoint}`;
    const resource = await fetch(path, { headers: reachedAlias });
    assert.equal(resource.status, 200);
    const entry = await resource.json() as { resource: string; scopes_supported: string[] };
    assert.equal(entry.resource, issuer + endpoint);
    assert.deepEqual(entry.scopes_supported, [endpoint === scoped ? "agents" : "ops"]);
    assert.equal((await fetch(path, { method: "OPTIONS", headers: reachedAlias })).status, 204);
  }
  assert.equal((await fetch(`${f.url}/oauth/token`, { method: "POST" })).status, 418);
  const framing = await fetch(`${f.url}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
  });
  assert.match(framing.headers.get("content-type")!, /^application\/json\b/);
  assert.equal((await framing.json() as { id: number }).id, 1);
  assert.equal((await fetch(`${f.url}/llms.txt`)).status, 418);

  for (const [token, via] of [[apiKey, "token"], [oauth, "oauth"]]) {
    const client = new Client({ name: "legacy-workerd-test", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`${f.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
      assert.ok((await client.listTools()).tools.some(tool => tool.name === "whoami"));
      const result = await client.callTool({ name: "whoami", arguments: {} });
      assert.equal(result.isError, undefined);
      const content = result.content as { type: string; text: string }[];
      assert.equal(content[0].type, "text");
      assert.deepEqual(JSON.parse(content[0].text), { tenant: "fixture", via, canStoreKeys: true, defaultModel: "test/echo", url: origin });
      for (const path of [undefined, "guides/definitions.md"]) {
        const document = await client.callTool({ name: "read_docs", arguments: path ? { path } : {} });
        const file = new URL(`../../../docs/${path ?? "llms.txt"}`, import.meta.url);
        assert.equal(document.isError, undefined);
        assert.deepEqual(document.content, [{ type: "text", text: (await readFile(file, "utf8")).replaceAll("https://run.camelai.com", origin) }]);
      }
      const missing = await client.callTool({ name: "read_docs", arguments: { path: "unknown-document.md" } });
      assert.equal(missing.isError, true);
      assert.match((missing.content as { text: string }[])[0].text, /^404: \/docs\/unknown-document\.md: no such page/);
    } finally {
      await client.close();
    }
  }
});
