import assert from "node:assert/strict";
import { portedTest } from "../ported.ts";

const config = { federation_rule_id: "rule", organization_id: "org", service_account_id: "service", workspace_id: "workspace", region: "us-west-2" };
const token = (index: number) => `sk-ant-oat01-fixture-${index}`;

portedTest("models", "tests/anthropic-federation.test.ts:170")("existing agents recover from static fallback on their next call; tenant and scope keys never exchange", async t => {
  const { createContractFixture, listen } = await import("../support.ts");
  const { gateway, anthropic } = await import("../../provider-fixtures.ts");
  let fail = true, stsCalls = 0, exchanges = 0;
  const endpoint = await listen(t, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("content-type", "application/json");
    if (req.url === "/sts") {
      assert.deepEqual(JSON.parse(raw), { Audience: ["https://api.anthropic.com"], SigningAlgorithm: "RS256", DurationSeconds: 900 });
      res.end(JSON.stringify({ WebIdentityToken: `assertion-${++stsCalls}` }));
    } else {
      assert.equal(req.url, "/v1/oauth/token");
      assert.equal(JSON.parse(raw).assertion, `assertion-${stsCalls}`);
      exchanges++;
      res.writeHead(fail ? 401 : 200).end(JSON.stringify(fail ? { error: "fixture" } : { access_token: token(exchanges), expires_in: 600 }));
    }
  });
  const api = await gateway(t, () => anthropic([{ type: "text", text: "Hello." }], "end_turn"));
  const { OPERATOR, OTHER_OPERATOR } = await import("../support.ts");
  const { createHash } = await import("node:crypto");
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const r = await createContractFixture(t, { respond: () => ({}), env: {
    AGENT_PROVIDER: "anthropic", AGENT_MODEL: "claude-sonnet-5", AGENT_BASE_URL: api.url,
    AGENT_ANTHROPIC_FEDERATION_RULE_ID: config.federation_rule_id, AGENT_ANTHROPIC_ORGANIZATION_ID: config.organization_id,
    AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID: config.service_account_id, AGENT_ANTHROPIC_WORKSPACE_ID: config.workspace_id,
    TEST_ANTHROPIC_FEDERATION_ENDPOINT: endpoint, AGENT_VERIFY_KEYS: "false",
    AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32",
  }, tenants: { tenants: { alice: { tokenSha256: hash(OPERATOR) }, bob: { tokenSha256: hash(OTHER_OPERATOR), apiKeys: { anthropic: "tenant-own" } } }, platformKeys: { anthropic: "static-fallback" } },
  anthropicFederationEndpoint: endpoint });
  const created = await r.call("/v1/agents", { body: { systemPrompt: "Keep this system prompt." } });
  assert.equal(created.status, 201, created.text);
  assert.equal(exchanges, 0, "agent creation stores a per-call marker, not a short-lived token");
  assert.equal((await r.prompt(created.json.id, "first")).outcome.result.reply, "Hello.");
  assert.equal(api.requests.at(-1)!.headers["x-api-key"], "static-fallback");
  assert.equal(api.requests.at(-1)!.headers.authorization, undefined);
  fail = false;
  assert.equal((await r.prompt(created.json.id, "second")).outcome.result.reply, "Hello.");
  const request = api.requests.at(-1)!;
  assert.equal(request.headers.authorization, `Bearer ${token(2)}`, JSON.stringify({ stsCalls, exchanges, federation: r.logs.filter(line => line.includes("anthropic_federation")) }));
  assert.equal(request.headers["x-api-key"], undefined);
  assert.equal(request.headers["x-app"], undefined);
  assert.doesNotMatch(String(request.headers["anthropic-beta"]), /oauth|claude-code/);
  assert.doesNotMatch(JSON.stringify(request.body.system), /You are Claude Code/);
  assert.match(JSON.stringify(request.body.system), /Keep this system prompt/);
  const own = await r.call("/v1/agents", { body: {}, token: OTHER_OPERATOR });
  assert.equal(own.status, 201, own.text);
  await r.prompt(own.json.id, "own", OTHER_OPERATOR);
  assert.equal(api.requests.at(-1)!.headers["x-api-key"], "tenant-own");
  assert.equal((await r.call("/v1/key-scopes/customer/providers/anthropic", { method: "PUT", body: { apiKey: "scope-own" } })).status, 200);
  const scoped = await r.call("/v1/agents", { body: { keyScope: "customer" } });
  assert.equal(scoped.status, 201, scoped.text);
  await r.prompt(scoped.json.id, "scope");
  assert.equal(api.requests.at(-1)!.headers["x-api-key"], "scope-own");
  assert.equal(exchanges, 2);
  assert.equal(stsCalls, 2);
  const usage = (await r.call("/v1/usage")).json;
  assert.equal(usage.totals.platformResponses, 2, "both WIF and its static fallback are billed as platform calls");
});
