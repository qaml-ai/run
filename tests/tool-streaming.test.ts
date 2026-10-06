import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { listModels, toolCallStreaming } from "../src/catalog.ts";
import { classify, combine } from "../scripts/probe-tool-streaming.ts";
import { OPERATOR, runtime } from "./runtime-server.ts";

const measured: Record<string, boolean> = JSON.parse(readFileSync(new URL("../src/tool-streaming.json", import.meta.url), "utf8")).models;

test("the measurements are booleans keyed by catalog model ids, with both answers among them", () => {
  const entries = Object.entries(measured);
  assert.ok(entries.length > 100, "the probe's results are checked in");
  for (const [id, value] of entries) {
    assert.equal(typeof value, "boolean", id);
    assert.match(id, /^[a-z0-9-]+\/\S+$/, id);
  }
  assert.ok(entries.some(([, value]) => value) && entries.some(([, value]) => !value));
});

test("each catalog model says whether it streams tool-call arguments, and unmeasured ones say unknown", () => {
  const models = ["openrouter", "anthropic", "openai", "google", "vercel-ai-gateway"].flatMap(provider => listModels(provider));
  for (const model of models) assert.equal(model.toolCallStreaming, Object.hasOwn(measured, model.id) ? measured[model.id] : "unknown", model.id);
  assert.ok(models.some(model => model.toolCallStreaming === "unknown"));
  // Never guessed from another provider's measurement of a model of the same name.
  const [routed] = Object.keys(measured).filter(id => id.startsWith("openrouter/")).map(id => id.slice("openrouter/".length));
  assert.equal(toolCallStreaming(`vercel-ai-gateway/${routed}`), Object.hasOwn(measured, `vercel-ai-gateway/${routed}`) ? measured[`vercel-ai-gateway/${routed}`] : "unknown");
  assert.equal(toolCallStreaming("openrouter/no-such/model"), "unknown");
});

test("the probe calls arguments in many pieces over time streaming, and one piece (even once) not", () => {
  assert.equal(classify(1, 0), false);
  assert.equal(classify(40, 5), false, "a buffered call replayed in pieces at once is not streaming");
  assert.equal(classify(40, 900), true);
  assert.equal(classify(4, 50), "unknown");
  assert.equal(combine([true, true, true]), true);
  assert.equal(combine([true, false, true]), false, "a model that sent one piece even once cannot be counted on");
  assert.equal(combine(["unknown", true]), true);
  assert.equal(combine(["unknown"]), "unknown");
});

test("GET /v1/models carries toolCallStreaming; a model on an operator's endpoint has its upstream model's", async t => {
  const [streams] = Object.entries(measured).find(([id, value]) => value && id.startsWith("openrouter/"))!;
  const [single] = Object.entries(measured).find(([id, value]) => !value && id.startsWith("openrouter/"))!;
  const tenants = { tenants: { alice: {
    tokenSha256: createHash("sha256").update(OPERATOR).digest("hex"),
    modelEndpoints: { gw: { baseUrl: "https://gateway.example.com", models: { [streams]: { contextWindow: 8_000, maxTokens: 1_000 }, [single]: { contextWindow: 8_000, maxTokens: 1_000 }, "openrouter/free/tiny": { contextWindow: 4_000, maxTokens: 1_000 } } } },
  } } };
  const r = await runtime(t, () => ({ role: "assistant", content: "unused" }), {}, tenants);
  const own = Object.fromEntries((await r.call("/v1/models?provider=gw")).json.map((model: any) => [model.id, model.toolCallStreaming]));
  assert.deepEqual(own, { [`gw/${streams}`]: true, [`gw/${single}`]: false, "gw/openrouter/free/tiny": "unknown" });
  const catalog = (await r.call("/v1/models?provider=openrouter")).json;
  assert.equal(catalog.find((model: any) => model.id === streams).toolCallStreaming, true);
  assert.equal(catalog.find((model: any) => model.id === single).toolCallStreaming, false);
});
