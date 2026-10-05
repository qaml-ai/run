import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { micros } from "../src/pricing.ts";
import { getModel } from "../src/pi-catalog.ts";
import { resolveModel } from "../src/session-config.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { runtime, until } from "./runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAYG = "payg-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const tenantsFile = {
  tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    ops: { tokenSha256: sha(OPS), apiKeys: { openrouter: "ops-admin-key" } },
  },
  platformKeys: { openrouter: "fixture-platform-key" },
};
const env = { AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0" };
const catalog = getModel("openrouter", "openai/gpt-5.5-pro")!;
const FREE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** The dollars the platform's OpenRouter key costs a tenant for `usd` of tokens: OpenRouter credit, with its funding. */
const funded = (usd: number) => micros(usd * 1.055);

test("a tenant cannot give its agent a model object: a free copy of a catalog model on the platform's key is refused", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "done", usage: { prompt_tokens: 5000, completion_tokens: 0 } }), env, tenantsFile);
  await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: micros(1), reason: "test" }, token: OPS });
  // The catalog's model at the endpoint the runtime trusts, at no cost and reporting no usage.
  const free = { ...resolveModel("openrouter/openai/gpt-5.5-pro"), baseUrl: r.model.url, cost: FREE, compat: { supportsUsageInStreaming: false } };
  const made = await r.call("/v1/agents", { body: { model: free }, token: PAYG });
  assert.equal(made.status, 400, made.text);
  assert.match(made.json.error, /model must be a "provider\/model-id" string/);
  assert.equal((await r.call("/v1/agents", { body: { model: free }, headers: { "Idempotency-Key": "upsert-free" }, token: PAYG })).status, 400, "nor in an upsert");
  assert.equal((await r.call("/v1/agents", { body: { model: free }, token: OPS })).status, 400, "nor for an admin tenant");
  const unknown = await r.call("/v1/agents", { body: { modelOverride: free }, token: PAYG });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.error, /Unknown agent field: modelOverride/);
  // The runtime's own model runs, and is billed at the catalog's price.
  const named = await r.call("/v1/agents", { body: {}, token: PAYG });
  assert.equal(named.status, 201, named.text);
  assert.equal(r.model.bodies.length, 0, "no model was called for the refused agents");
  const configured = await r.call(`/v1/agents/${named.json.id}/configuration`, { method: "PATCH", body: { model: free }, token: PAYG });
  assert.equal(configured.status, 400, "configure takes names only");
  assert.equal((await r.prompt(named.json.id, "go", PAYG)).outcome.result.reply, "done");
  const { balance } = (await r.call("/v1/billing", { token: PAYG })).json;
  assert.equal(balance, micros(1) - funded(5000 * catalog.cost.input / 1e6));
});

test("on a platform key a response is billed at the catalog's price, whatever the agent's stored model says, and one without usage is charged an estimate", async t => {
  let respond: (index: number) => object = () => ({ role: "assistant", content: "done", usage: { prompt_tokens: 5000, completion_tokens: 0 } });
  const first = await runtime(t, (_body, index) => respond(index), env, tenantsFile);
  const agent = (await first.call("/v1/agents", { body: {}, token: PAYG })).json;
  const stopped = once(first.child, "exit");
  first.child.kill("SIGTERM");
  await stopped;
  // An agent made before models were names only: a free copy of the catalog's model that reports no usage.
  const r = await runtime(t, (_body, index) => respond(index), env, tenantsFile, { databaseUrl: first.databaseUrl });
  const stored = { ...catalog, baseUrl: r.model.url, cost: FREE, compat: { supportsUsageInStreaming: false } };
  await first.db.query("update agents set header = jsonb_set(header::jsonb, '{config,model}', $2::jsonb)::json where id = $1", [agent.id, JSON.stringify(stored)]);
  await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: micros(10), reason: "test" }, token: OPS });

  assert.equal((await r.prompt(agent.id, "go", PAYG)).outcome.result.reply, "done");
  const charged = funded(5000 * catalog.cost.input / 1e6);
  assert.ok(charged > 0);
  const priced = await until(async () => {
    const { balance } = (await r.call("/v1/billing", { token: PAYG })).json;
    return balance !== micros(10) && balance;
  }, "the charge");
  assert.equal(priced, micros(10) - charged, "the catalog's price, not the stored model's zero");

  // A response that reports no usage on the platform's key is charged as if it filled the window and wrote the most.
  respond = () => ({ role: "assistant", content: "done" });
  assert.equal((await r.prompt(agent.id, "again", PAYG)).outcome.result.reply, "done");
  const estimate = funded((catalog.contextWindow * catalog.cost.input + catalog.maxTokens * catalog.cost.output) / 1e6);
  const after = await until(async () => {
    const { balance } = (await r.call("/v1/billing", { token: PAYG })).json;
    return balance !== priced && balance;
  }, "the estimate's charge");
  assert.equal(after, priced - estimate);
  assert.ok(r.logs.some(line => line.includes('"platform_usage_untrusted"') && line.includes('"estimated":true')), "the estimate is logged");
  assert.equal((await r.call(`/v1/agents/${agent.id}/prompt`, { body: { text: "more" }, token: PAYG })).status, 402, "and the account is out of credit");
});

test("platform pricing reads the catalog: variants at their base's price, unknown models at the provider's dearest", () => {
  const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const expected = (1000 * catalog.cost.input + 100 * catalog.cost.output) / 1e6;
  const priced = platformUsage(usage, "openrouter", "openai/gpt-5.5-pro");
  assert.ok(Math.abs(priced.usage.cost.total - expected) < 1e-12);
  assert.deepEqual([priced.estimated, priced.known], [false, true]);
  assert.equal(usage.cost.total, 0, "the response's own usage is not changed");
  assert.ok(Math.abs(platformUsage(usage, "openrouter", "openai/gpt-5.5-pro:nitro").usage.cost.total - expected) < 1e-12);
  const unknown = platformUsage(usage, "openrouter", "no/such-model");
  assert.equal(unknown.known, false);
  assert.ok(unknown.usage.cost.total >= expected, "never cheaper than a known model");
  // A cost the provider reported itself still comes first; billing reads it (usageCost).
  assert.equal(platformUsage({ ...usage, providerCost: 0.5 }, "openrouter", "openai/gpt-5.5-pro").usage.providerCost, 0.5);
  // Aborted before the provider sent usage: what it wrote, at two characters a token.
  const aborted = platformUsage({ ...usage, input: 0, output: 0 }, "openrouter", "openai/gpt-5.5-pro", { chars: 400 });
  assert.equal(aborted.estimated, true);
  assert.ok(Math.abs(aborted.usage.cost.total - 200 * catalog.cost.output / 1e6) < 1e-12);
});
