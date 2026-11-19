import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

  const reachedAlias = { "x-forwarded-host": new URL(issuer).host };
  const challenge = await fetch(`${f.url}/mcp`, { headers: reachedAlias });
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate")!, /https:\/\/agents\.example\.test\/\.well-known\/oauth-protected-resource\/mcp/);
  const metadata = await fetch(`${f.url}/.well-known/oauth-protected-resource/mcp`, { headers: reachedAlias });
  assert.equal(metadata.status, 200);
  const protectedResource = await metadata.json() as { resource: string; authorization_servers: string[] };
  assert.equal(protectedResource.resource, `${issuer}/mcp`);
  assert.deepEqual(protectedResource.authorization_servers, [issuer]);
  assert.equal((await fetch(`${f.url}/oauth/token`, { method: "POST" })).status, 418);
  const framing = await fetch(`${f.url}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${apiKey}`, accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
  });
  assert.match(framing.headers.get("content-type")!, /^application\/json\b/);
  assert.equal((await framing.json() as { id: number }).id, 1);

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
      assert.deepEqual(JSON.parse(content[0].text), { tenant: "fixture", via, url: origin });
    } finally {
      await client.close();
    }
  }
});
