import assert from "node:assert/strict";
import test from "node:test";
import { AnthropicFederation } from "../src/anthropic-federation-policy.ts";
import { federationFor } from "../src/anthropic-federation.ts";

const config = { federation_rule_id: "rule", organization_id: "org", service_account_id: "service", workspace_id: "workspace", region: "us-west-2" };
const env = { AGENT_ANTHROPIC_FEDERATION_RULE_ID: "rule", AGENT_ANTHROPIC_ORGANIZATION_ID: "org", AGENT_ANTHROPIC_SERVICE_ACCOUNT_ID: "service", AGENT_ANTHROPIC_WORKSPACE_ID: "workspace" };

test("source federation policy retries a failed exchange, then caches only the bearer token", async () => {
  let exchanges = 0, stsCalls = 0;
  const service = new AnthropicFederation(config, {
    log: () => {},
    sts: { send: async command => {
      assert.deepEqual(command.input, { Audience: ["https://api.anthropic.com"], SigningAlgorithm: "RS256", DurationSeconds: 900 });
      return { WebIdentityToken: `assertion-${++stsCalls}` };
    } },
    fetch: async (_input, init) => {
      assert.equal(JSON.parse(String(init?.body)).assertion, `assertion-${stsCalls}`);
      return ++exchanges === 1 ? new Response("", { status: 401 }) : Response.json({ access_token: "sk-ant-oat01-cached", expires_in: 600 });
    },
  });
  assert.deepEqual(await service.credentials("static"), { apiKey: "static" });
  assert.deepEqual(await service.credentials("static"), { apiKey: "sk-ant-oat01-cached", bearer: true });
  assert.deepEqual(await service.credentials("static"), { apiKey: "sk-ant-oat01-cached", bearer: true });
  assert.equal(stsCalls, 2);
  assert.equal(exchanges, 2);
});

test("concurrent federation requests share an exchange without retaining the assertion", async () => {
  let stsCalls = 0;
  const service = new AnthropicFederation(config, { log: () => {},
    sts: { send: async () => ({ WebIdentityToken: `assertion-${++stsCalls}` }) },
    fetch: async () => Response.json({ access_token: "sk-ant-oat01-shared", expires_in: 600 }),
  });
  const keys = await Promise.all(Array.from({ length: 4 }, () => service.credentials()));
  assert.equal(stsCalls, 1);
  assert.ok(keys.every(key => key.apiKey === "sk-ant-oat01-shared" && key.bearer));
});

test("Workers federation requires a signer outside local test transport", async () => {
  assert.throws(() => federationFor({ ...env, TEST_MODE: "1", TEST_ANTHROPIC_FEDERATION_ENDPOINT: "http://example.com" }), /loopback/);
  const service = federationFor({ ...env, TEST_ANTHROPIC_FEDERATION_ENDPOINT: "http://127.0.0.1:1" });
  assert.ok(service);
  assert.deepEqual(await service.credentials("static"), { apiKey: "static" });
});
