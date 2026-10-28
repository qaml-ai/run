import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, getModels, withCatalogPrices } from "../src/pi-catalog.ts";
import { platformUsage } from "../src/platform-pricing.ts";
import { resolveModel } from "../src/session-config.ts";

test("Terra costs half Sol's rates, including cache writes and the long-context tier on every provider", () => {
  for (const provider of ["openai", "azure", "openrouter"]) {
    const id = `${provider === "openrouter" ? "openai/" : ""}gpt-6.1-terra`;
    assert.deepEqual(getModel(provider, id)!.cost, {
      input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25,
      tiers: [{ inputTokensAbove: 272_000, input: 2, output: 7.5, cacheRead: 0.1, cacheWrite: 2.5 }],
    });
    // Cached and written tokens count toward the input threshold too. Check both sides of it.
    for (const input of [242_000, 242_001]) {
      const { usage, known } = platformUsage({ input, output: 1_000, cacheRead: 20_000, cacheWrite: 10_000, cost: {} as Record<string, number> }, provider, id);
      const long = input > 242_000;
      const expected = (input * (long ? 2 : 1) + 1_000 * (long ? 7.5 : 5) + 20_000 * (long ? 0.1 : 0.05) + 10_000 * (long ? 2.5 : 1.25)) / 1e6;
      assert.equal(known, true);
      assert.ok(Math.abs(usage.cost.total - expected) < 1e-12, `${provider}: ${input}`);
    }
  }
});

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

test("DeepSeek V4.1 Flash 1017 asks for at most what all its hosts serve (DeepInfra, Prime Intellect and InferenceNet 131,072), agents made before included; V4.1 Flash keeps Pi's", () => {
  const id = "deepseek/deepseek-v4.1-flash-1017";
  assert.equal(getModel("openrouter", id)!.maxTokens, 131_072);
  assert.equal(getModels("openrouter").find(entry => entry.id === id)!.maxTokens, 131_072);
  assert.equal(withCatalogPrices({ ...getModel("openrouter", id)!, maxTokens: 943_718 }).maxTokens, 131_072);
  assert.equal(getModel("openrouter", "deepseek/deepseek-v4.1-flash")!.maxTokens, 131_072, "the vendored pi-ai's catalog");
  // A tenant's endpoint keeps its own.
  const elsewhere = { ...getModel("openrouter", id)!, maxTokens: 943_718, baseUrl: "https://llm.example.com" };
  assert.equal(withCatalogPrices(elsewhere), elsewhere);
});

test("OpenRouter Luna and its routing and Pro variants keep the catalog window, including stored agents", () => {
  const variants = getModels("openrouter").filter(model => model.id.startsWith("openai/gpt-6-luna") || model.id === "~openai/gpt-luna-latest");
  assert.ok(variants.length >= 2);
  for (const model of [...variants, resolveModel("openrouter/openai/gpt-6-luna:nitro")]) {
    assert.equal(model.contextWindow, 1_050_000, model.id);
    assert.equal(withCatalogPrices({ ...model, contextWindow: 272_000 }).contextWindow, 1_050_000, model.id);
  }
});


test("all routes keep Pi's catalog window", async () => {
  const { getModels: nativeModels } = await import("@earendil-works/pi-ai/compat");
  for (const provider of ["openai", "openrouter", "azure", "vercel-ai-gateway", "cloudflare-ai-gateway", "amazon-bedrock", "github-copilot"]) {
    for (const native of nativeModels(provider as never)) {
      const model = getModel(provider, native.id)!;
      assert.equal(model.contextWindow, native.contextWindow, `${provider}/${native.id}`);
    }
  }
  for (const id of ["gpt-6-luna", "gpt-6-luna-pro", "gpt-5.6-luna", "gpt-5.6-luna-pro"]) for (const suffix of ["", ":batch", ":nitro"])
    assert.equal(resolveModel(`openrouter/openai/${id}${suffix}`).contextWindow, getModel("openrouter", `openai/${id}`)!.contextWindow);
});

test("suffix fallback corrects prices, maxTokens and the stored window", () => {
  const model = { ...getModel("openrouter", "deepseek/deepseek-v4.1-flash-1017")!, id: "deepseek/deepseek-v4.1-flash-1017:nitro", contextWindow: 2_000_000, maxTokens: 943_718 };
  assert.equal(withCatalogPrices(model).maxTokens, 131_072);
  assert.equal(withCatalogPrices(model).contextWindow, getModel("openrouter", "deepseek/deepseek-v4.1-flash-1017")!.contextWindow);
});


test("Azure DeepSeek V4.1 Flash has its measured limits, Azure prices and Chat Completions compatibility", () => {
  const model = getModel("azure", "deepseek-v4.1-flash")!;
  assert.equal(model.name, "DeepSeek V4.1 Flash");
  assert.equal(model.api, "openai-completions");
  assert.equal(model.contextWindow, 1_048_576);
  assert.equal(model.maxTokens, 131_072);
  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(model.cost, { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 });
  assert.deepEqual(model.thinkingLevelMap, getModel("openrouter", "deepseek/deepseek-v4.1-flash")!.thinkingLevelMap);
  assert.deepEqual(model.compat, { ...getModel("azure", "deepseek-v4-pro")!.compat, maxTokensField: "max_tokens" });
});
