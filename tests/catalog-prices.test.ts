import { test } from "node:test";
import assert from "node:assert/strict";
import { getModel, getModels, withCatalogPrices } from "../src/pi-catalog.ts";
import { platformUsage } from "../src/platform-pricing.ts";

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
