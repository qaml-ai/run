import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveModel } from "../src/session-config.ts";
import { listModels } from "../src/catalog.ts";
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
  assert.match(startupError({ AGENT_TENANTS_FILE: "" }), /Set AGENT_TENANT and AGENT_OPERATOR_TOKEN, or AGENT_TENANTS_FILE, AGENT_TENANTS_JSON or AGENT_TENANTS_SECRET_ARN/);
  assert.match(startupError({ AGENT_TENANTS_FILE: "", AGENT_RUNTIME_TOKEN: "an-operator-token-of-the-old-single-tenant-mode" }), /Set AGENT_TENANT and AGENT_OPERATOR_TOKEN, or AGENT_TENANTS_FILE, AGENT_TENANTS_JSON or AGENT_TENANTS_SECRET_ARN/);
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

test("admin tenants use the platform's keys unless an unbilled one sets platformKeys: false; a prepaid one always may", async () => {
  const token = (name: string) => createHash("sha256").update(name).digest("hex");
  let secret = JSON.stringify({ tenants: {
    ops: { tokenSha256: token("ops") }, own: { tokenSha256: token("own"), billing: "none", platformKeys: false }, payg: { tokenSha256: token("payg"), billing: "prepaid" },
  } });
  const tenants = new Tenants({ read: async () => secret });
  await tenants.reload();
  assert.deepEqual(["ops", "own", "payg", "u-self-serve"].map(id => tenants.usesPlatformKeys(id)), [true, false, true, undefined]);
  for (const bad of ["no", null, 0]) {
    secret = JSON.stringify({ tenants: { ops: { tokenSha256: token("ops"), platformKeys: bad } } });
    await assert.rejects(tenants.reload(), /invalid platformKeys/, JSON.stringify(bad));
  }
  secret = JSON.stringify({ tenants: { payg: { tokenSha256: token("payg"), billing: "prepaid", platformKeys: false } } });
  await assert.rejects(tenants.reload(), /prepaid, so it pays for the platform's keys/);
  assert.equal(tenants.usesPlatformKeys("own"), false, "the last good tenants stay in force");
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

test("Claude Sonnet 5.5 resolves on Anthropic, OpenRouter and Bedrock (through its inference profiles), always reasoning, and is listed", () => {
  for (const [reference, id, api] of [
    ["anthropic/claude-sonnet-5-5", "claude-sonnet-5-5", "anthropic-messages"],
    ["openrouter/anthropic/claude-sonnet-5.5", "anthropic/claude-sonnet-5.5", "anthropic-messages"],
    ["openrouter/anthropic/claude-sonnet-5.5:nitro", "anthropic/claude-sonnet-5.5:nitro", "anthropic-messages"],
    ["amazon-bedrock/global.anthropic.claude-sonnet-5-5", "global.anthropic.claude-sonnet-5-5", "bedrock-converse-stream"],
    ["amazon-bedrock/us.anthropic.claude-sonnet-5-5", "us.anthropic.claude-sonnet-5-5", "bedrock-converse-stream"],
    // Bedrock refuses the base id: it names the global profile.
    ["amazon-bedrock/anthropic.claude-sonnet-5-5", "global.anthropic.claude-sonnet-5-5", "bedrock-converse-stream"],
  ]) {
    const model = resolveModel(reference);
    assert.equal(model.id, id, reference);
    assert.equal(model.api, api, reference);
    assert.match(model.name, /Sonnet 5\.5/, reference);
    assert.equal(model.contextWindow, 1_000_000, reference);
    assert.equal(model.maxTokens, 128_000, reference);
    assert.equal(model.reasoning, true, reference);
    assert.equal(model.thinkingLevelMap?.off, null, `${reference} always reasons`);
    // Pi's prices; US profiles cost a tenth more than global ones.
    assert.deepEqual([model.cost.input, model.cost.output], id.startsWith("us.") ? [2.2, 11] : [2, 10], reference);
  }
  assert.deepEqual(resolveModel("anthropic/claude-sonnet-5").id, "claude-sonnet-5", "Sonnet 5 stays");
  assert.ok(listModels("anthropic").some(model => model.id === "anthropic/claude-sonnet-5-5"));
  assert.ok(listModels("openrouter").some(model => model.id === "openrouter/anthropic/claude-sonnet-5.5"));
  assert.ok(listModels("amazon-bedrock").some(model => model.id === "amazon-bedrock/global.anthropic.claude-sonnet-5-5"));
  assert.ok(!listModels("amazon-bedrock").some(model => model.id === "amazon-bedrock/anthropic.claude-sonnet-5-5"), "no base id is listed");
});
