import {contractTest, createContractFixture} from '../support.ts';
import type {ModelReply, ContractFixture} from '../fixture.ts';
import type {T} from '../http.ts';
async function runtime(t:T,respond:ModelReply,env:Record<string,string>={},tenants?:object):Promise<ContractFixture>{return createContractFixture(t,{respond,env,tenants});}

import assert from "node:assert/strict";

import {createHash} from "node:crypto";

import {micros} from "../../../src/pricing.ts";

import {getModel} from "../../../src/pi-catalog.ts";

import {resolveModel} from "../../../src/session-config.ts";

import {until} from "../support.ts";

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

const funded = (usd: number) => micros(usd * 1.055);

contractTest("models", "tests/model-pricing-trust.test.ts:27", "a tenant cannot give its agent a model object: a free copy of a catalog model on the platform's key is refused", async t => {
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

contractTest("models", "tests/model-pricing-trust.test.ts:115", "an unbilled admin tenant's responses on platform or admin keys are as the provider reported them, never estimated", async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "done" }), env, tenantsFile);
  const agent = (await r.call("/v1/agents", { body: {}, token: OPS })).json;
  assert.equal((await r.prompt(agent.id, "go", OPS)).outcome.result.reply, "done");
  assert.equal((await r.prompt(agent.id, "again", OPS)).outcome.result.reply, "done", "not stopped by an estimate");
  const usage = await until(async () => {
    const totals = (await r.call("/v1/usage", { token: OPS })).json.totals;
    return totals.responses === 2 && totals;
  }, "the usage");
  assert.equal(usage.cost, 0);
  // Private diagnostic log observation remains in the source suite.
});

contractTest("models","tests/model-pricing-trust.test.ts:51","on a platform key a response is billed at the catalog's price, whatever the agent's stored model says, and one without usage is charged an estimate",async t => {
  let respond: (index: number) => object = () => ({ role: "assistant", content: "done", usage: { prompt_tokens: 5000, completion_tokens: 0 } });
  const r = await runtime(t, (_body, index) => respond(index), env, tenantsFile);
  const agent = (await r.call("/v1/agents", { body: {}, token: PAYG })).json;
  // Restore the exact historical model shape through the backend fixture at restart.
  await r.restartWithLegacyModel(agent.id, { ...catalog, cost: FREE, compat: { supportsUsageInStreaming: false } });
  await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: micros(10), reason: "test" }, token: OPS });

  assert.equal((await r.prompt(agent.id, "go", PAYG)).outcome.result.reply, "done");
  const charged = funded(5000 * catalog.cost.input / 1e6);
  assert.ok(charged > 0);
  const priced = await until(async () => {
    const { balance } = (await r.call("/v1/billing", { token: PAYG })).json;
    return balance !== micros(10) && balance;
  }, "the charge");
  assert.equal(priced, micros(10) - charged, "the catalog's price, not the stored model's zero");

  // A response that reports no usage on the platform's key is charged an estimate: the input the host estimated at its
  // begin, and what it streamed at two characters a token. Never the whole context window and the longest reply.
  respond = () => ({ role: "assistant", content: "done" });
  assert.equal((await r.prompt(agent.id, "again", PAYG)).outcome.result.reply, "done");
  const after = await until(async () => {
    const { balance } = (await r.call("/v1/billing", { token: PAYG })).json;
    return balance !== priced && balance;
  }, "the estimate's charge");
  const missing = r.logs.filter(line => line.includes('"model_usage_missing"')).map(line => JSON.parse(line.slice(line.indexOf("{"))));
  assert.equal(missing.length, 1, "said once");
  assert.equal(missing[0].completed, true);
  assert.ok(missing[0].inputTokens > 0 && missing[0].chars > 0, JSON.stringify(missing[0]));
  // At the prices of the catalog's tier for that many input tokens, where it has tiers.
  const rates = (catalog.cost.tiers ?? []).filter(tier => missing[0].inputTokens > tier.inputTokensAbove).at(-1) ?? catalog.cost;
  const estimate = funded((missing[0].inputTokens * rates.input + Math.ceil(missing[0].chars / 2) * rates.output) / 1e6);
  assert.ok(Math.abs(priced - after - estimate) <= 2, `charged ${priced - after}, the estimate ${estimate}`);
  const window = funded((catalog.contextWindow * rates.input + catalog.maxTokens * rates.output) / 1e6);
  assert.ok((priced - after) * 20 < window, "a small fraction of the full window's price");
  assert.ok(r.logs.some(line => line.includes('"platform_usage_untrusted"') && line.includes('"estimated":true')), "the estimate is logged");
  assert.equal((await r.prompt(agent.id, "more", PAYG)).outcome.result.reply, "done", "and the account still has credit");
});
