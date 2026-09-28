import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tenantsFromEnvironment } from "../src/tenants.ts";
import { storageFromEnvironment } from "../shared/storage-config.ts";
import { runtime } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const TOKEN = "selfhost-operator-token-at-least-24-chars";

test("tenants come from the environment without a file or a secret: one tenant and its operator token, or the tenants file inline", async () => {
  const one = await tenantsFromEnvironment({ AGENT_TENANT: "acme", AGENT_OPERATOR_TOKEN: TOKEN, AGENT_TENANT_API_KEYS: '{"anthropic":"sk-ant","openrouter":"sk-or"}' });
  assert.equal(one.source, "env");
  assert.equal(one.authenticate(`Bearer ${TOKEN}`)?.id, "acme");
  assert.equal(one.apiKey("acme", "openrouter"), "sk-or");
  assert.equal(one.authenticate("Bearer another-token-of-at-least-24-chars"), undefined);
  const bare = await tenantsFromEnvironment({ AGENT_TENANT: "acme", AGENT_OPERATOR_TOKEN: TOKEN });
  assert.equal(bare.apiKey("acme", "anthropic"), undefined, "keys may come later, through the API");

  const inline = await tenantsFromEnvironment({ AGENT_TENANTS_JSON: JSON.stringify({ tenants: { beta: { tokenSha256: sha(TOKEN), apiKeys: { openai: "sk-oa" } } } }) });
  assert.equal(inline.source, "env");
  assert.equal(inline.authenticate(`Bearer ${TOKEN}`)?.id, "beta");

  await assert.rejects(tenantsFromEnvironment({ AGENT_TENANT: "acme" }), /AGENT_TENANT needs AGENT_OPERATOR_TOKEN/);
  await assert.rejects(tenantsFromEnvironment({ AGENT_TENANT: "acme", AGENT_OPERATOR_TOKEN: "short" }), /AGENT_OPERATOR_TOKEN must be at least 24 characters/);
  await assert.rejects(tenantsFromEnvironment({ AGENT_TENANT: "acme", AGENT_OPERATOR_TOKEN: TOKEN, AGENT_TENANT_API_KEYS: "[1]" }), /AGENT_TENANT_API_KEYS must be a JSON object of provider keys/);
  await assert.rejects(tenantsFromEnvironment({ AGENT_TENANT: "acme", AGENT_OPERATOR_TOKEN: TOKEN, AGENT_TENANTS_FILE: "/tmp/tenants.json" }), /only one of/);
  await assert.rejects(tenantsFromEnvironment({}), /AGENT_TENANT and AGENT_OPERATOR_TOKEN/);
});

test("S3-compatible storage takes an endpoint and path-style addressing", () => {
  assert.deepEqual(storageFromEnvironment("/data", { AGENT_STORAGE: "s3", AGENT_S3_BUCKET: "runtime", AGENT_S3_ENDPOINT: "http://minio:9000", AGENT_S3_FORCE_PATH_STYLE: "true", AWS_REGION: "us-east-1" }),
    { kind: "s3", bucket: "runtime", region: "us-east-1", endpoint: "http://minio:9000", forcePathStyle: true });
  assert.deepEqual(storageFromEnvironment("/data", { AGENT_STORAGE: "s3", AGENT_S3_BUCKET: "runtime", AWS_REGION: "us-west-2" }), { kind: "s3", bucket: "runtime", region: "us-west-2" });
  assert.throws(() => storageFromEnvironment("/data", { AGENT_STORAGE: "s3", AGENT_S3_BUCKET: "runtime", AGENT_S3_FORCE_PATH_STYLE: "yes" }), /AGENT_S3_FORCE_PATH_STYLE must be true or false/);
});

test("a runtime bootstrapped from AGENT_TENANT and AGENT_OPERATOR_TOKEN serves that tenant", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "Self-hosted." }), {
    AGENT_TENANTS_FILE: "", AGENT_TENANT: "acme", AGENT_OPERATOR_TOKEN: TOKEN, AGENT_TENANT_API_KEYS: JSON.stringify({ openrouter: "fixture-model-key" }),
  });
  assert.equal((await r.call("/v1/me", { token: TOKEN })).json.tenant, "acme");
  const agent = (await r.call("/v1/agents", { body: {}, token: TOKEN })).json.id;
  assert.equal((await r.prompt(agent, "Hi", TOKEN)).outcome.result.reply, "Self-hosted.");
});
