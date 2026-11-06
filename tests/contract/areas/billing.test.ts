import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contractTest, createContractFixture, listen, toolCall, toolResults, until, type T } from "../support.ts";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const PAYG = "payg-operator-token-at-least-24-chars";
const OPS = "ops-operator-token-at-least-24-chars";
const micros = (usd: number) => Math.round(usd * 1_000_000);
const billingOptions = {
  env: { AGENT_MODEL: "openai/gpt-5.5-pro", AGENT_BILLING_ADMINS: "ops", AGENT_PRICE_AGENT_HOUR_USD: "0", AGENT_VERIFY_KEYS: "false" },
  tenants: { tenants: {
    payg: { tokenSha256: sha(PAYG), apiKeys: {}, billing: "prepaid" },
    ops: { tokenSha256: sha(OPS), apiKeys: { anthropic: "ops-admin-key", openrouter: "ops-admin-key" } },
  }, platformKeys: { anthropic: "fixture-platform-key", openrouter: "fixture-platform-key" } },
};

contractTest("billing", "tests/billing.test.ts","a prepaid tenant pays the catalog fallback plus funding when actual cost is absent; spent credit stops runs", async (t, r) => {
  const { call, prompt, model } = r;
  r.setModel( (_body, index) => ({
    // Each response costs $0.15: 5000 input tokens of openai/gpt-5.5-pro.
    ...(index < 2 ? toolCall("codemode", { code: `return ${index}` }, `call_${index}`) : { role: "assistant", content: "finished" }),
    usage: { prompt_tokens: 5000, completion_tokens: 0 },
  }));
  const agent = (await call("/v1/agents", { body: {}, token: PAYG })).json;
  const refused = await call(`/v1/agents/${agent.id}/prompt`, { body: { text: "hi" }, token: PAYG });
  assert.equal(refused.status, 402);
  assert.match(refused.json.error, /^This account is out of credit/);
  assert.doesNotMatch(refused.json.error, /console|buy|add credit/i, "API errors point to nothing to buy");
  const code = await call(`/clients/${agent.id}/requests`, { body: { id: "code", method: "execute", params: { code: "return 1" } }, token: agent.token });
  assert.equal(code.status, 402, "code runs need credit too");

  // Only the platform operator adjusts credit; an adjustment repeated with its key applies once.
  const adjustment = { tenant: "payg", amount: 200_000, reason: "test credit", idempotencyKey: "topup-1" };
  assert.equal((await call("/v1/billing/adjustments", { body: adjustment, token: PAYG })).status, 403);
  const added = await call("/v1/billing/adjustments", { body: adjustment, token: OPS });
  assert.equal(added.status, 201);
  assert.equal((await call("/v1/billing/adjustments", { body: adjustment, token: OPS })).json.id, added.json.id);
  assert.equal((await call("/v1/billing/adjustments", { body: { ...adjustment, amount: 1 }, token: OPS })).status, 409);
  assert.equal((await call("/v1/billing/adjustments", { body: { ...adjustment, tenant: "nobody" }, token: OPS })).status, 404);
  assert.equal((await call("/v1/billing", { token: PAYG })).json.balance, 200_000);

  const first = await prompt(agent.id, "go", PAYG);
  assert.equal(first.outcome.result.stopped, "spend_limit");
  assert.equal(first.outcome.result.limit, "credit");
  assert.match(first.outcome.result.error, /This account is out of credit/);
  assert.equal(model.bodies.length, 2, "the turn ended after the response that spent the last credit");
  assert.deepEqual(new Set(model.keys), new Set(["Bearer fixture-platform-key"]));
  assert.equal((await call(`/v1/agents/${agent.id}/prompt`, { body: { text: "again" }, token: PAYG })).status, 402);

  const billing = (await call("/v1/billing", { token: PAYG })).json;
  assert.equal(billing.billing, "prepaid");
  assert.equal(billing.balance, 200_000 - 316_500);
  assert.equal(billing.month.usage, -316_500);
  assert.equal(billing.month.adjustment, 200_000);
  assert.equal(billing.rates.agentHour, 0);
  const usage = (await call("/v1/usage", { token: PAYG })).json;
  assert.equal(usage.totals.platformResponses, 2);
  // Paging through the ledger.
  const page = (await call("/v1/billing/ledger?limit=1", { token: PAYG })).json;
  assert.equal(page.entries.length, 1);
  const rest = (await call(`/v1/billing/ledger?before=${page.next}`, { token: PAYG })).json;
  assert.deepEqual([...page.entries, ...rest.entries].map((entry: any) => entry.kind).at(-1), "adjustment");
  assert.equal([...page.entries, ...rest.entries].reduce((sum: number, entry: any) => sum + entry.amount, 0), billing.balance);
  // Unbilled tenants see their mode and no balance.
  assert.equal((await call("/v1/billing", { token: OPS })).json.billing, "none");
}, billingOptions);

contractTest("billing", "tests/billing.test.ts","streamed OpenRouter actual cost reaches the credit ledger instead of the catalog estimate", async (t, r) => {
  const costs = [
    { cost: 0.02 },
    { cost: 0.005, is_byok: true, cost_details: { upstream_inference_cost: 0.1 } },
    { cost: 0 },
  ];
  r.setModel( (_body, index) => ({ role: "assistant", content: "done", usage: { prompt_tokens: 5000, completion_tokens: 0, ...costs[index] } }));
  await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: micros(1), reason: "test" }, token: OPS });
  const agent = (await r.call("/v1/agents", { body: {}, token: PAYG })).json;
  assert.equal((await r.prompt(agent.id, "go", PAYG)).outcome.result.reply, "done");
  const summary = (await r.call("/v1/billing", { token: PAYG })).json;
  assert.equal(summary.balance, micros(1 - 0.02 * 1.055));
  assert.equal(summary.rates.openrouterCreditMultiplier, 1.055);
  const usage = (await r.call("/v1/usage", { token: PAYG })).json;
  assert.equal(usage.totals.cost, 0.02);
  assert.ok(Math.abs(usage.totals.platformCost - 0.02 * 1.055) < 1e-12);
  assert.equal((await r.prompt(agent.id, "again", PAYG)).outcome.result.reply, "done");
  const afterByok = (await r.call("/v1/billing", { token: PAYG })).json;
  assert.equal(afterByok.balance, micros(1 - 0.025 * 1.055 - 0.1), "funding applies only to OpenRouter's portion of a BYOK response");
  assert.equal((await r.prompt(agent.id, "free response", PAYG)).outcome.result.reply, "done");
  assert.equal((await r.call("/v1/billing", { token: PAYG })).json.balance, afterByok.balance, "reported zero must not fall back to the catalog estimate");
}, billingOptions);

contractTest("billing", "tests/billing.test.ts","responses on the tenant's own key cost no credit for tokens, but time in turns is charged", async (t, r) => {
  const { call, prompt, model } = r;
  r.setModel( (_body, index) => ({
    ...(index === 0 ? toolCall("codemode", { code: "return 1" }) : { role: "assistant", content: "done" }),
    usage: { prompt_tokens: 5000, completion_tokens: 0 }, delayMs: 150,
  }));
  assert.equal((await call("/v1/billing/adjustments", { body: { tenant: "payg", amount: micros(10), reason: "test" }, token: OPS })).status, 201);
  assert.equal((await call("/v1/providers/openrouter/key", { method: "PUT", body: { apiKey: "sk-or-own-key" }, token: PAYG })).status, 200);
  const agent = (await call("/v1/agents", { body: {}, token: PAYG })).json;
  const started = Date.now();
  assert.equal((await prompt(agent.id, "go", PAYG)).outcome.result.reply, "done");
  const elapsed = Date.now() - started;
  assert.deepEqual(new Set(model.keys), new Set(["Bearer sk-or-own-key"]));
  const entries = await until(async () => {
    const ledger = (await call("/v1/billing/ledger", { token: PAYG })).json.entries.filter((entry: any) => entry.kind === "usage");
    return ledger.length && ledger;
  }, "the usage flush");
  const activeMs = entries.reduce((sum: number, entry: any) => sum + entry.metadata.activeMs, 0);
  assert.ok(activeMs >= 300 && activeMs <= elapsed, `two responses of at least 150 ms each, within the turn (${activeMs} of ${elapsed} ms)`);
  for (const entry of entries) {
    assert.equal(entry.metadata.tokens, 0);
    // Each flush rounds its time to the millisecond, and an hour's entry adds up several flushes.
    assert.ok(Math.abs(entry.amount + entry.metadata.activeMs * 1000) <= 2000, "$1 per second of agent time");
  }
  assert.equal((await call("/v1/usage", { token: PAYG })).json.totals.platformResponses, 0);
}, { ...billingOptions, env: { ...billingOptions.env, AGENT_PRICE_AGENT_HOUR_USD: "3600" } });

// An operator's key in a tenant's tenants-file entry (apiKeys) is the tenant's key, like one it stored: a prepaid entry
// pays no credit for a model call, an auxiliary call (a decision) or a web search on it. Only the platform's keys charge.
const ENTRY = "entry-operator-token-at-least-24-chars";

/** A prepaid entry with `apiKeys`, $10 of credit, and a model call that searches then answers (two responses), and a decision. */
async function entryCalls(t: T, apiKeys: Record<string, string>) {
  const decisions: string[] = [];
  const decisionsUrl = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the body */ }
    decisions.push(String(req.headers.authorization));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ model: "typesafe/jev-1.14-20261014", answers: { ok: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 400, output_tokens: 70, cost: 0.01 }, id: "gen-dec-1", provider: "TypeSafe" }));
  });
  const searches: string[] = [];
  const braveUrl = await listen(t, async (req, res) => {
    for await (const _chunk of req) { /* the body */ }
    searches.push(String(req.headers["x-subscription-token"]));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ web: { results: [{ title: "Docs", url: "https://example.com/docs", description: "The docs" }] } }));
  });
  const r = await createContractFixture(t, {
    // Each model response costs $0.15 on the catalog: 5000 input tokens of openai/gpt-5.5-pro.
    respond: body => ({ ...(toolResults(body).length === 0 ? toolCall("web_search", { query: "agent runtime" }, "call_search") : { role: "assistant", content: "done" }), usage: { prompt_tokens: 5000, completion_tokens: 0 } }),
    env: {
      ...billingOptions.env, AGENT_OPENROUTER_CREDIT_MULTIPLIER: "1", AGENT_PRICE_WEB_SEARCH_USD: "0.25",
      AGENT_OUTBOUND_ALLOW_HTTP: "true", AGENT_OUTBOUND_ALLOW_CIDRS: "127.0.0.1/32", AGENT_DECISIONS_URL: decisionsUrl,
      AGENT_BRAVE_SEARCH_URL: `${braveUrl}/res/v1/web/search`, AGENT_WEB_SEARCH_PROVIDERS: "brave",
    },
    tenants: { tenants: {
      entry: { tokenSha256: sha(ENTRY), apiKeys, billing: "prepaid" },
      ops: { tokenSha256: sha(OPS), apiKeys: {} },
    }, platformKeys: { openrouter: "platform-openrouter-key", brave: "platform-brave-key" } },
  });
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "entry", amount: micros(10), reason: "test" }, token: OPS })).status, 201);
  const definition = (await r.call("/v1/definitions", { body: { name: "Searcher", builtins: ["web_search"] }, token: ENTRY })).json;
  const agent = (await r.call("/v1/agents", { body: { definition: definition.id }, token: ENTRY })).json;
  assert.equal((await r.prompt(agent.id, "look it up", ENTRY)).outcome.result.reply, "done");
  const decided = await r.call("/v1/decisions", { body: { state: "hello", questions: { ok: { type: "noul", instructions: "It is fine." } } }, token: ENTRY });
  assert.equal(decided.status, 200, decided.text);
  const days = await until(async () => {
    const found = (await r.call("/v1/usage", { token: ENTRY })).json.days;
    return found.some((day: any) => day.kind === "decision") && found.some((day: any) => day.model === "brave/web_search")
      && found.some((day: any) => !day.kind && day.model.endsWith("gpt-5.5-pro") && day.responses === 2) && found;
  }, "the calls' usage");
  const usage = {
    model: days.find((day: any) => !day.kind && day.model.endsWith("gpt-5.5-pro")),
    search: days.find((day: any) => day.model === "brave/web_search"),
    decision: days.find((day: any) => day.kind === "decision"),
  };
  // A call's charge commits with its usage row, so the balance is final once all three rows are there.
  const balance = (await r.call("/v1/billing", { token: ENTRY })).json.balance;
  return { r, decisions, searches, usage, balance };
}

contractTest("billing", "tests/billing.test.ts", "a prepaid tenants-file entry's apiKeys are its own: model, decision and search calls on them charge no credit", async t => {
  const { r, decisions, searches, usage, balance } = await entryCalls(t, { openrouter: "entry-openrouter-key", brave: "entry-brave-key" });
  assert.deepEqual(new Set(r.model.keys), new Set(["Bearer entry-openrouter-key"]));
  assert.deepEqual(decisions, ["Bearer entry-openrouter-key"]);
  assert.deepEqual(searches, ["entry-brave-key"]);
  for (const [kind, day] of Object.entries(usage)) assert.deepEqual([kind, day.platformResponses, day.platformCost], [kind, 0, 0], `${kind} on the entry's key is not the platform's`);
  assert.equal(balance, micros(10), "no credit spent on the entry's keys");
  assert.equal((await r.call("/v1/usage", { token: ENTRY })).json.totals.platformResponses, 0);
});

contractTest("billing", "tests/billing.test.ts", "the same prepaid entry without apiKeys runs on the platform's keys and is charged for model, decision and search calls", async t => {
  const { r, decisions, searches, usage, balance } = await entryCalls(t, {});
  assert.deepEqual(new Set(r.model.keys), new Set(["Bearer platform-openrouter-key"]));
  assert.deepEqual(decisions, ["Bearer platform-openrouter-key"]);
  assert.deepEqual(searches, ["platform-brave-key"]);
  assert.deepEqual([usage.model.platformResponses, Math.round(usage.model.platformCost * 1e6)], [2, 300_000]);
  assert.deepEqual([usage.search.platformResponses, Math.round(usage.search.platformCost * 1e6)], [1, 250_000]);
  assert.deepEqual([usage.decision.platformResponses, Math.round(usage.decision.platformCost * 1e6)], [1, 10_000]);
  assert.equal(balance, micros(10) - 560_000, "$0.30 of model responses, a $0.25 search and a $0.01 decision");
});

