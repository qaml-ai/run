import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contractTest, OPERATOR } from "../support.ts";

contractTest("billing", "tests/credit-holds.test.ts:114", "a run on a tenant with too little credit stops before any call, as a spend limit; a small balance caps the call's max_tokens", async (_t, r) => {
  await r.seedTenant("alice", { token: OPERATOR, billingMode: "prepaid", credits: 500_000, config: { apiKeys: {} } });
  let calls = 0;
  r.setModel(() => { calls++; return { role: "assistant", content: "Done.", usage: { prompt_tokens: 10, completion_tokens: 2 } }; });
  const agent = (await r.call("/v1/agents", { body: { systemPrompt: "Be brief." } })).json.id;
  const done = await r.prompt(agent, "Hello");
  assert.equal(done.outcome.result.reply, "Done.");
  const sent = r.model.bodies.at(-1)!;
  const asked = sent.max_output_tokens ?? sent.max_completion_tokens ?? sent.max_tokens;
  assert.ok(asked < 3_000, `$0.50 at $180 per million: ${asked}`);

  // Set the same one-cent balance through the public adjustment endpoint.
  const balance = (await r.call("/v1/billing")).json.balance;
  const adjusted = await r.call("/v1/billing/adjustments", { body: { tenant: "alice", amount: 10_000 - balance, reason: "contract balance fixture" } });
  assert.equal(adjusted.status, 201, adjusted.text);
  calls = 0;
  const big = await r.prompt(agent, "x ".repeat(200_000));
  assert.equal(calls, 0, "no call was made");
  assert.equal(big.outcome.result.stopped, "spend_limit");
  assert.equal(big.outcome.result.limit, "credit");
}, {
  env: { AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_BILLING_ADMINS: "alice" },
  tenants: { tenants: { alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), billing: "prepaid" } }, platformKeys: { openrouter: "fixture-platform-key" } },
});
