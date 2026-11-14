import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contractTest, OPERATOR } from "../support.ts";

contractTest("billing", "tests/model-credit.test.ts", "a small positive balance admits a full response, and the next run is refused once the balance goes negative", async (_t, r) => {
  await r.seedTenant("alice", { token: OPERATOR, billingMode: "prepaid", credits: 1, config: { apiKeys: {} } });
  let calls = 0;
  r.setModel(() => { calls++; return { role: "assistant", content: "Done.", usage: { prompt_tokens: 1_000, completion_tokens: 2 } }; });
  const agent = (await r.call("/v1/agents", { body: { systemPrompt: "Be brief." } })).json.id;
  const done = await r.prompt(agent, "Hello");
  assert.equal(done.outcome.result.reply, "Done.");
  const sent = r.model.bodies.at(-1)!;
  const asked = sent.max_output_tokens ?? sent.max_completion_tokens ?? sent.max_tokens;
  assert.ok(asked === undefined || asked > 3_000, `the tenant balance does not size the response: ${asked}`);
  assert.ok((await r.call("/v1/billing")).json.balance < 0);
  const next = await r.call(`/v1/agents/${agent}/prompt`, { body: { text: "Try again" } });
  assert.equal(next.status, 402, next.text);
  assert.equal(calls, 1);
}, {
  env: { AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_BILLING_ADMINS: "alice" },
  tenants: { tenants: { alice: { tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"), billing: "prepaid" } }, platformKeys: { openrouter: "fixture-platform-key" } },
});
