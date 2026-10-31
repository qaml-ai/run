import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Accounts } from "../src/accounts.ts";
import { Tenants } from "../src/tenants.ts";
import { EndUserCredits, unmarked } from "../src/end-user-credits.ts";
import { ModelAttempts } from "../src/model-attempts.ts";
import { attemptAck } from "../src/model-attempt.ts";
import { catalogRates, platformUsage } from "../src/platform-pricing.ts";
import { getModel } from "../src/pi-catalog.ts";
import { DEFAULT_PRICING } from "../src/pricing.ts";
import { testDatabase } from "./database.ts";

// A model call that completes but reports no usage and no cost (its stream closed between its finish and its usage) is
// billed as a call cut short is: the input the host estimated at its begin, and what it streamed at two characters a
// token. Never the whole context window and the longest reply, and never nothing.

const USD = 1_000_000;
const KEY = "fixture-only";
const keyHash = createHash("sha256").update(KEY).digest("hex");
const MODEL = "anthropic/claude-opus-4.1";
const NONE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture() {
  const { db } = await testDatabase();
  const tenants = new Tenants({ read: async () => JSON.stringify({ tenants: { payg: { tokenSha256: keyHash, billing: "prepaid" }, free: { tokenSha256: createHash("sha256").update("other").digest("hex") } }, platformKeys: { openrouter: KEY } }) });
  await tenants.reload();
  const service = new EndUserCredits(db);
  // The tenant's credit to run on: a call on the platform's key holds some (credit-holds.ts).
  await db.query("insert into credit_accounts (tenant, balance, purchased) values ('payg', $1, $1)", [1_000 * USD]);
  for (const tenant of ["payg", "free"]) {
    await service.setSettings(tenant, { enabled: true, markupBps: 2_000 });
    await service.post(tenant, "person", { kind: "grant", amount: 10 * USD, key: "pay" });
  }
  const attempts = new ModelAttempts(db, new Accounts({ tenants, db, pricing: { ...DEFAULT_PRICING, openrouterCreditMultiplier: 1 } }), undefined, 0, undefined, service);
  /** Who pays and how: `payg` on the platform's key is catalog priced; `free` (unbilled) and a tenant's own key are not. */
  const call = async (options: { tenant?: string; platform?: boolean; provider?: string; model?: string; kind?: "response" | "compaction"; inputTokens?: number; generation?: boolean } = {}) => {
    const { tenant = "payg", platform = true, provider = "openrouter", model = MODEL, kind = "response", inputTokens = 20_000 } = options;
    const id = randomUUID();
    const ack = attemptAck(await attempts.event(tenant, "agent", platform, tenant === "payg" && platform, { type: "begin", id, provider, model, kind, at: Date.now(), keyHash,
      estimate: { inputTokens, maxOutputTokens: 32_000, rates: catalogRates(provider, model) }, endUser: { id: "person", bucket: "b" } }));
    assert.ok(ack.tracked && !ack.refused);
    if (options.generation) await attempts.event(tenant, "agent", platform, tenant === "payg" && platform, { type: "generation", id, generation: `gen-${id}` });
    const finish = (usage: Record<string, unknown>, chars: number, completed = true) =>
      attempts.event(tenant, "agent", platform, tenant === "payg" && platform, { type: "finish", id, usage, chars, completed });
    return { id, tenant, finish };
  };
  const attempt = async (id: string) => {
    const row = (await db.query("select * from model_attempts where id = $1", [id])).rows[0];
    return { state: row.state, charge: Number(row.charge), endUserRaw: Number(row.end_user_raw), estimatedInputTokens: row.estimated_input_tokens, totals: row.totals };
  };
  const entry = async (tenant: string, id: string) => (await service.ledger(tenant, "person", { limit: 200 })).entries.filter(entry => entry.metadata.attempt === id);
  const held = async (id: string) => {
    const row = (await db.query("select allowance, paid from end_user_holds where id = $1", [id])).rows[0];
    return Number(row.allowance) + unmarked(Number(row.paid), 2_000);
  };
  return { db, service, attempts, call, attempt, entry, held };
}
/** Run `work` with console.log captured: the JSON lines it logged of `type`. */
async function logged(type: string, work: () => Promise<unknown>) {
  const lines: any[] = [];
  const log = console.log;
  console.log = (line: unknown) => { try { const parsed = JSON.parse(String(line)); if (parsed.type === type) lines.push(parsed); } catch { /* not ours */ } };
  try { await work(); } finally { console.log = log; }
  return lines;
}
/** Raw micro-USD of `input` and `output` tokens at the catalog's rates. */
const at = (provider: string, model: string, input: number, output: number) => {
  const rates = catalogRates(provider, model);
  return Math.round(input * rates.input + output * rates.output);
};

test("platformUsage: a completed response with no usage is the estimate, not the whole window; one with counts keeps them", () => {
  const model = getModel("openrouter", MODEL)!;
  const missing = platformUsage(NONE, "openrouter", MODEL, { chars: 3_000, inputTokens: 20_000, completed: true });
  assert.equal(missing.estimated, true);
  assert.deepEqual([missing.usage.input, missing.usage.output], [20_000, 1_500]);
  assert.ok(missing.usage.input < model.contextWindow);
  // No estimate at all: nothing to bill by, never the window.
  const bare = platformUsage(NONE, "openrouter", MODEL);
  assert.deepEqual([bare.estimated, bare.usage.input, bare.usage.output, bare.usage.cost.total], [true, 0, 0, 0]);
  // A completed response that reported counts keeps them, with no partial-output bump.
  const reported = platformUsage({ ...NONE, input: 1_000, output: 10 }, "openrouter", MODEL, { chars: 3_000, inputTokens: 20_000, completed: true });
  assert.deepEqual([reported.estimated, reported.usage.input, reported.usage.output], [false, 1_000, 10]);
  // An aborted one still takes the larger of its count and the estimate.
  const aborted = platformUsage({ ...NONE, input: 1_000, output: 10 }, "openrouter", MODEL, { chars: 3_000, inputTokens: 20_000 });
  assert.deepEqual([aborted.estimated, aborted.usage.output], [true, 1_500]);
});

test("prepaid, platform key: a completed call with no usage charges the tenant and the end user the estimate, stays estimated, and reconciliation replaces it", async () => {
  const { db, attempts, call, attempt, entry } = await fixture();
  const { id, finish } = await call({ generation: true });
  const lines = await logged("model_usage_missing", () => finish(NONE, 3_000));
  const estimate = at("openrouter", MODEL, 20_000, 1_500);
  const settled = await attempt(id);
  assert.equal(settled.state, "estimated", "an OpenRouter generation can still correct it");
  assert.equal(settled.estimatedInputTokens, 20_000, "the input estimate is kept at begin");
  assert.ok(Math.abs(settled.charge - estimate) <= 1, `tenant charged ${settled.charge}, the estimate ${estimate}`);
  assert.equal(settled.endUserRaw, settled.charge, "the end user's raw cost is the tenant's");
  const [posted] = await entry("payg", id);
  assert.deepEqual([posted.raw, posted.amount, posted.metadata.estimated], [settled.charge, -Math.ceil(settled.charge * 1.2), true]);
  const ledger = (await db.query("select amount, metadata from credit_ledger where idempotency_key = $1", [`model-attempt:${id}:1`])).rows[0];
  assert.deepEqual([-Number(ledger.amount), ledger.metadata.estimated], [settled.charge, true]);
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0].completed, lines[0].generation, lines[0].inputTokens, lines[0].chars, lines[0].endUserRaw], [true, true, 20_000, 3_000, settled.charge]);

  // The provider's record replaces the estimate, for the tenant and the end user.
  await attempts.settle(id, "payg", "agent", { input: 19_000, output: 1_200, cacheRead: 0, cacheWrite: 0, providerCost: 0.05, providerCreditCost: 0.05 }, 0, true, true);
  const reconciled = await attempt(id);
  assert.deepEqual([reconciled.state, reconciled.charge, reconciled.endUserRaw], ["settled", 50_000, 50_000]);
  const entries = await entry("payg", id);
  assert.equal(entries.reduce((sum, item) => sum + item.raw, 0), 50_000);
  assert.equal(entries.reduce((sum, item) => sum + item.amount, 0), -60_000);
});

test("an estimated call is never charged to its end user past what it held; with no hold left, the estimate itself", async () => {
  const { db, call, attempt, entry, held } = await fixture();
  // A reply that streamed far past its hold (its characters run high: JSON, signatures).
  const big = await call();
  const hold = await held(big.id);
  await logged("model_usage_missing", () => big.finish(NONE, 400_000));
  const capped = await attempt(big.id);
  assert.equal(capped.endUserRaw, hold, "capped at the hold");
  assert.ok(capped.charge > hold, "the tenant (no hold) is charged the estimate");
  assert.equal((await entry("payg", big.id))[0].raw, hold);
  // The same end delivered again posts nothing more.
  await big.finish(NONE, 400_000);
  assert.equal((await entry("payg", big.id)).length, 1);
  assert.equal((await attempt(big.id)).endUserRaw, hold);

  // A cut call (aborted) too.
  const cut = await call();
  const cutHold = await held(cut.id);
  await cut.finish({ ...NONE, estimatedInputTokens: 20_000 }, 400_000, false);
  assert.equal((await attempt(cut.id)).endUserRaw, cutHold);

  // Its hold lapsed: the estimate, uncapped, and still not the window.
  const lapsed = await call();
  const lapsedHold = await held(lapsed.id);
  await db.query("delete from end_user_holds where id = $1", [lapsed.id]);
  await logged("model_usage_missing", () => lapsed.finish(NONE, 40_000));
  const estimate = at("openrouter", MODEL, 20_000, 20_000);
  assert.ok(estimate > lapsedHold);
  assert.ok(Math.abs((await attempt(lapsed.id)).endUserRaw - estimate) <= 1);
  const model = getModel("openrouter", MODEL)!;
  assert.ok(estimate < at("openrouter", MODEL, model.contextWindow, model.maxTokens));
});

test("an unbilled tenant and a tenant's own key: the end user pays the estimate, not nothing; OpenRouter still reconciles it", async () => {
  const { attempts, call, attempt, entry } = await fixture();
  const unbilled = await call({ tenant: "free", generation: true });
  await logged("model_usage_missing", () => unbilled.finish(NONE, 3_000));
  const estimate = at("openrouter", MODEL, 20_000, 1_500);
  const first = await attempt(unbilled.id);
  assert.deepEqual([first.state, first.charge], ["estimated", 0], "unbilled: no tenant charge, still estimated");
  assert.ok(Math.abs(first.endUserRaw - estimate) <= 1, `end user ${first.endUserRaw}, the estimate ${estimate}`);
  await attempts.settle(unbilled.id, "free", "agent", { input: 19_000, output: 1_200, cacheRead: 0, cacheWrite: 0, providerCost: 0.03, providerCreditCost: 0.03 }, 0, true, true);
  assert.deepEqual([(await attempt(unbilled.id)).state, (await attempt(unbilled.id)).endUserRaw], ["settled", 30_000]);
  assert.equal((await entry("free", unbilled.id)).reduce((sum, item) => sum + item.raw, 0), 30_000);

  // A tenant's own key on a provider with no reconciliation (Azure, OpenAI): the estimate, and final.
  const own = await call({ platform: false, provider: "openai", model: "gpt-4.1" });
  await logged("model_usage_missing", () => own.finish(NONE, 3_000));
  const ownSettled = await attempt(own.id);
  assert.equal(ownSettled.state, "settled", "nothing will correct it");
  assert.ok(Math.abs(ownSettled.endUserRaw - at("openai", "gpt-4.1", 20_000, 1_500)) <= 1);
  assert.equal((await entry("payg", own.id))[0].metadata.estimated, true, "its entry says it is an estimate");

  // On the platform's key with no reconciliation adapter: the estimate, not the window, and final.
  const azure = await call({ provider: "azure", model: "gpt-4.1" });
  await logged("model_usage_missing", () => azure.finish(NONE, 3_000));
  const azureSettled = await attempt(azure.id);
  assert.equal(azureSettled.state, "settled");
  assert.ok(Math.abs(azureSettled.charge - at("azure", "gpt-4.1", 20_000, 1_500)) <= 1);
});

test("a completed call that reported usage is unchanged; a compaction summary without usage uses the input estimated at its begin", async () => {
  const { call, attempt } = await fixture();
  const reported = await call();
  const lines = await logged("model_usage_missing", () => reported.finish({ ...NONE, input: 1_000, output: 10 }, 40_000));
  assert.equal(lines.length, 0);
  const settled = await attempt(reported.id);
  assert.deepEqual([settled.state, settled.totals.input, settled.totals.output], ["settled", 1_000, 10], "no partial-output bump");
  assert.equal(settled.charge, at("openrouter", MODEL, 1_000, 10));

  const summary = await call({ kind: "compaction", inputTokens: 50_000 });
  await logged("model_usage_missing", () => summary.finish(NONE, 2_000));
  const compacted = await attempt(summary.id);
  assert.ok(Math.abs(compacted.charge - at("openrouter", MODEL, 50_000, 1_000)) <= 1, `${compacted.charge}`);
  assert.equal(compacted.state, "estimated", "OpenRouter may still correct it");
});
