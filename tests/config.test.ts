import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "../src/session-config.ts";
import { Tenants } from "../src/tenants.ts";

const tenantsFile = join(mkdtempSync(join(tmpdir(), "agent-config-")), "tenants.json");
writeFileSync(tenantsFile, JSON.stringify({ tenants: { acme: { tokenSha256: createHash("sha256").update("config-test-operator-token").digest("hex") } } }));

/** Start the server with `env` and return what it failed with; the settings are checked before anything connects. */
function startupError(env: Record<string, string>) {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
    env: { PATH: process.env.PATH, AGENT_TENANTS_FILE: tenantsFile, AGENT_SESSION_SECRET: "config-test-session-secret-with-32-chars", ...env },
    encoding: "utf8", timeout: 30_000,
  });
  assert.notEqual(result.status, 0);
  return result.stderr;
}

test("the runtime refuses to start without a tenants file or secret, or a session secret", () => {
  assert.match(startupError({ AGENT_TENANTS_FILE: "" }), /Set AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN/);
  assert.match(startupError({ AGENT_TENANTS_FILE: "", AGENT_RUNTIME_TOKEN: "an-operator-token-of-the-old-single-tenant-mode" }), /Set AGENT_TENANTS_FILE or AGENT_TENANTS_SECRET_ARN/);
  assert.match(startupError({ AGENT_SESSION_SECRET: "" }), /Set AGENT_SESSION_SECRET/);
});

test("hosted-agent caps are AGENT_MAX_AGENTS(_PER_TENANT), positive integers", () => {
  assert.match(startupError({ AGENT_MAX_AGENTS: "0" }), /AGENT_MAX_AGENTS must be a positive integer/);
  assert.match(startupError({ AGENT_MAX_AGENTS_PER_TENANT: "x" }), /AGENT_MAX_AGENTS_PER_TENANT must be a positive integer/);
  assert.match(startupError({ AGENT_MAX_AGENTS_PER_TENANT: "-1" }), /AGENT_MAX_AGENTS_PER_TENANT must be a positive integer/);
  // Valid caps get past the check (to the database, absent here).
  assert.doesNotMatch(startupError({ AGENT_MAX_AGENTS: "10", AGENT_MAX_AGENTS_PER_TENANT: "5" }), /must be a positive integer/);
});

test("a tenant's maxAgents is a positive integer; an invalid one rejects the reload and keeps the last good tenants", async () => {
  const entry = (maxAgents?: unknown) => JSON.stringify({ tenants: { acme: { tokenSha256: createHash("sha256").update("acme-token").digest("hex"), apiKeys: {}, ...(maxAgents !== undefined ? { maxAgents } : {}) } } });
  let secret = entry(3);
  const tenants = new Tenants({ read: async () => secret });
  await tenants.reload();
  assert.equal(tenants.maxAgents("acme"), 3);
  for (const bad of [0, -1, 1.5, "4", null]) {
    secret = entry(bad);
    await assert.rejects(tenants.reload(), /invalid maxAgents/, String(bad));
    assert.equal(tenants.maxAgents("acme"), 3, "the last good tenants stay in force");
  }
  secret = entry();
  await tenants.reload();
  assert.equal(tenants.maxAgents("acme"), undefined, "absent: the default applies");
  assert.equal(tenants.maxAgents("nobody"), undefined);
});

test("a tenant's maxMonthlyCost is a non-negative number of USD; an invalid one rejects the reload, and absent means unlimited", async () => {
  const entry = (maxMonthlyCost?: unknown) => JSON.stringify({ tenants: { acme: { tokenSha256: createHash("sha256").update("acme-token").digest("hex"), apiKeys: {}, ...(maxMonthlyCost !== undefined ? { maxMonthlyCost } : {}) } } });
  let secret = entry(12.5);
  const tenants = new Tenants({ read: async () => secret });
  await tenants.reload();
  assert.equal(tenants.maxMonthlyCost("acme"), 12.5);
  for (const bad of [-1, "20", null, Number.POSITIVE_INFINITY]) {
    secret = bad === Number.POSITIVE_INFINITY ? entry().replace("{}", '{},"maxMonthlyCost":1e999') : entry(bad);
    await assert.rejects(tenants.reload(), /invalid maxMonthlyCost/, String(bad));
    assert.equal(tenants.maxMonthlyCost("acme"), 12.5, "the last good tenants stay in force");
  }
  secret = entry(0);
  await tenants.reload();
  assert.equal(tenants.maxMonthlyCost("acme"), 0, "zero stops all model spend");
  secret = entry();
  await tenants.reload();
  assert.equal(tenants.maxMonthlyCost("acme"), undefined);
});

test("a tenant's apiKeys are optional, and invalid ones still reject the reload", async () => {
  const token = createHash("sha256").update("acme-token").digest("hex");
  let secret = JSON.stringify({ tenants: { acme: { tokenSha256: token, billing: "prepaid" } } });
  const tenants = new Tenants({ read: async () => secret });
  await tenants.reload();
  assert.ok(tenants.authenticate("Bearer acme-token"));
  assert.deepEqual(tenants.providers("acme"), []);
  for (const bad of [null, [], { anthropic: "" }, "key"]) {
    secret = JSON.stringify({ tenants: { acme: { tokenSha256: token, apiKeys: bad } } });
    await assert.rejects(tenants.reload(), /invalid apiKeys/, JSON.stringify(bad));
  }
});

test("a `*` provider key is rejected in a tenant's apiKeys and in platformKeys", async () => {
  const token = createHash("sha256").update("acme-token").digest("hex");
  let secret = JSON.stringify({ tenants: { acme: { tokenSha256: token, apiKeys: { anthropic: "sk-acme" } } } });
  const tenants = new Tenants({ read: async () => secret });
  await tenants.reload();
  secret = JSON.stringify({ tenants: { acme: { tokenSha256: token, apiKeys: { "*": "sk-any" } } } });
  await assert.rejects(tenants.reload(), /`\*` API key/);
  secret = JSON.stringify({ tenants: { acme: { tokenSha256: token } }, platformKeys: { "*": "sk-platform" } });
  await assert.rejects(tenants.reload(), /platformKeys cannot have a `\*` key/);
  assert.equal(tenants.apiKey("acme", "anthropic"), "sk-acme", "the last good tenants stay in force");
  assert.equal(tenants.apiKey("acme", "openai"), undefined);
});

test("a catalog model with a routing variant resolves like its base model and keeps the variant in its id", () => {
  const plain = resolveModel("openrouter/anthropic/claude-sonnet-5");
  const nitro = resolveModel("openrouter/anthropic/claude-sonnet-5:nitro");
  assert.equal(nitro.id, "anthropic/claude-sonnet-5:nitro");
  assert.equal(nitro.api, plain.api);
  assert.equal(nitro.contextWindow, plain.contextWindow);
  assert.equal(resolveModel("openrouter/openai/gpt-6-luna:floor").api, "openai-responses");
  assert.throws(() => resolveModel("openrouter/nobody/no-such-model:nitro"), /Unknown model/);
});
