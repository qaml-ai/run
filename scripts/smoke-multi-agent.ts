// Real-model smoke test for delegate and handoff, on OpenRouter (not part of the suite; needs OPENROUTER_API_KEY and the test database):
// node --experimental-strip-types --test scripts/smoke-multi-agent.ts   (SMOKE_MODEL=<openrouter model id> to pick the model)
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { OPERATOR, runtime } from "../tests/runtime-server.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const key = process.env.OPENROUTER_API_KEY!;
const MODEL = process.env.SMOKE_MODEL ?? "openai/gpt-4.1-mini";

test("real model: delegate to a definition and hand off", { timeout: 300_000 }, async t => {
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), { AGENT_BASE_URL: "https://openrouter.ai/api/v1", AGENT_MODEL: MODEL },
    { tenants: { alice: { tokenSha256: sha(OPERATOR), apiKeys: { openrouter: key } } } });
  const definition = async (idempotency: string, body: unknown) => {
    const saved = await r.call("/v1/definitions", { headers: { "Idempotency-Key": idempotency }, body });
    assert.equal(saved.status, 201, saved.text);
    return saved.json.id as string;
  };
  await definition("calculator", { name: "Calculator", description: "Does arithmetic exactly", systemPrompt: "You do arithmetic. Answer with the number only.", model: `openrouter/${MODEL}` });
  const parent = (await r.call("/v1/agents", { body: { model: `openrouter/${MODEL}`, systemPrompt: "You are a coordinator. For any arithmetic, use the delegate tool with the calculator agent; never compute it yourself.", builtins: ["delegate"], delegate: { agents: ["calculator"], instructions: true } } })).json.id;
  const delegated = await r.prompt(parent, "What is 1234 * 5678? Then, in parallel, have two sub-agents of your own design each write a one-line haiku about the sea, and give me all three results.");
  console.log("DELEGATE reply:", delegated.outcome?.result?.reply, "\ntoolCalls:", JSON.stringify(delegated.outcome?.result?.toolCalls), "\nusage:", JSON.stringify(delegated.outcome?.result?.usage));
  assert.equal(delegated.error, undefined, JSON.stringify(delegated));
  assert.match(delegated.outcome.result.reply.replace(/,/g, ""), /7006652/);
  const calls = delegated.outcome.result.toolCalls.filter((call: any) => call.tool === "delegate");
  assert.ok(calls.length >= 3 && calls.every((call: any) => call.ok && call.agentId));

  const billing = await definition("billing", { name: "Billing", systemPrompt: "You are the billing agent. Begin every reply with \"BILLING:\". You handle refunds.", model: `openrouter/${MODEL}` });
  const triage = await definition("triage", { name: "Triage", systemPrompt: "You are the triage agent. Hand refund requests to billing with the handoff tool; do not answer them yourself.", model: `openrouter/${MODEL}`, builtins: ["handoff"], handoff: { definitions: [{ name: "billing", definition: "billing", description: "Refunds, invoices and charges" }] } });
  const agent = (await r.call("/v1/agents", { body: { definition: triage } })).json.id;
  const handed = await r.prompt(agent, "I was charged twice for order 42 and want a refund.");
  console.log("HANDOFF reply:", handed.outcome?.result?.reply, "\nhandoffs:", JSON.stringify(handed.outcome?.result?.handoffs));
  assert.equal(handed.error, undefined, JSON.stringify(handed));
  assert.equal(handed.outcome.result.handoffs?.[0]?.definition, billing);
  assert.match(handed.outcome.result.reply, /^BILLING:/);
});
