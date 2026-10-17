import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, getModels, withCatalogPrices } from "../src/pi-catalog.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { resolveModel } from "../src/session-config.ts";

test("Claude Sonnet 5.5 cache reads are priced at Anthropic's $0.10 per million, on Anthropic and Cloudflare's gateway", () => {
  for (const provider of ["anthropic", "cloudflare-ai-gateway"]) {
    const model = getModel(provider, "claude-sonnet-5-5")!;
    assert.deepEqual(model.cost, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, provider);
    assert.equal(getModels(provider).find(entry => entry.id === "claude-sonnet-5-5")!.cost.cacheRead, 0.1, provider);
  }
  // The other Claude prices are Pi's, unchanged: Sonnet 5's cache reads are $0.20.
  assert.equal(getModel("anthropic", "claude-sonnet-5")!.cost.cacheRead, 0.2);
});

test("a builder-shaped response on Sonnet 5.5 costs what Anthropic bills", () => {
  // 4 input, 113 output, 10,358 read from the cache and 12,468 written to it (5 minutes).
  const tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: Record<string, number> } = { input: 4, output: 113, cacheRead: 10_358, cacheWrite: 12_468 };
  const { usage } = platformUsage(tokens, "anthropic", "claude-sonnet-5-5");
  const anthropic = (4 * 2 + 113 * 10 + 10_358 * 0.1 + 12_468 * 2.5) / 1e6;
  assert.ok(Math.abs(usage.cost!.total - anthropic) < 1e-12, `${usage.cost!.total} != ${anthropic}`);
});

test("an agent made before a price was corrected counts the catalog's price now; a tenant's own model keeps its own", () => {
  const current = getModel("anthropic", "claude-sonnet-5-5")!;
  const stored = { ...current, cost: { ...current.cost, cacheRead: 0.2 } };
  assert.equal(withCatalogPrices(stored).cost.cacheRead, 0.1);
  assert.equal(withCatalogPrices(current), current);
  // Elsewhere than the catalog's endpoint (a tenant's endpoint or provider), its prices are the tenant's.
  const elsewhere = { ...stored, baseUrl: "https://llm.example.com" };
  assert.equal(withCatalogPrices(elsewhere), elsewhere);
  const unknown = { ...stored, provider: "acme", id: "acme-1" };
  assert.equal(withCatalogPrices(unknown), unknown);
});

test("OpenRouter models the platform's apps run on are at OpenRouter's list price, routing variants included", () => {
  const list: Record<string, { input: number; output: number; cacheRead: number }> = {
    "deepseek/deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
    "deepseek/deepseek-v4.1-flash-1017": { input: 0.15, output: 0.6, cacheRead: 0.003 },
    "moonshotai/kimi-k3": { input: 0.304, output: 11.936, cacheRead: 0.21 },
    "google/gemini-3.8-flash": { input: 0.825, output: 4.125, cacheRead: 0.0825 },
    "z-ai/glm-5.3": { input: 0.079, output: 4.8, cacheRead: 0.078 },
  };
  for (const [id, cost] of Object.entries(list)) {
    const model = getModel("openrouter", id)!;
    assert.deepEqual({ input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead }, cost, id);
    assert.equal(getModels("openrouter").find(entry => entry.id === id)!.cost.input, cost.input, id);
    assert.equal(resolveModel(`openrouter/${id}:nitro`).cost.input, cost.input, `${id}:nitro`);
  }
  // DeepSeek V4.1 Flash: a million tokens each way and read from the cache cost the list price, not the weekday-peak rate.
  const tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: Record<string, number> } = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 };
  const { usage } = platformUsage(tokens, "openrouter", "deepseek/deepseek-v4.1-flash");
  assert.ok(Math.abs(usage.cost!.total - 0.753) < 1e-12, String(usage.cost!.total));
  // An agent made at Pi's price counts the list price now.
  const stored = { ...getModel("openrouter", "deepseek/deepseek-v4.1-flash")!, cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } };
  assert.equal(withCatalogPrices(stored).cost.output, 0.6);
});

test("DeepSeek V4.1 Flash on OpenRouter asks for at most what DeepSeek's own endpoint serves, agents made before included", () => {
  for (const id of ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-1017"]) {
    assert.equal(getModel("openrouter", id)!.maxTokens, 393_216, id);
    assert.equal(getModels("openrouter").find(entry => entry.id === id)!.maxTokens, 393_216, id);
    const stored = { ...getModel("openrouter", id)!, maxTokens: 943_718 };
    assert.equal(withCatalogPrices(stored).maxTokens, 393_216, id);
  }
  // Pi's own value elsewhere: the batch variant's 131,072.
  assert.equal(getModel("openrouter", "deepseek/deepseek-v4.1-flash:batch")!.maxTokens, 131_072);
  // A tenant's endpoint keeps its own.
  const elsewhere = { ...getModel("openrouter", "deepseek/deepseek-v4.1-flash")!, maxTokens: 943_718, baseUrl: "https://llm.example.com" };
  assert.equal(withCatalogPrices(elsewhere), elsewhere);
});
