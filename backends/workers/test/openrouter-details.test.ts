import assert from "node:assert/strict";
import test from "node:test";
import { passthroughModel, withOpenRouterDetails } from "../src/openrouter-details.ts";
import { reasoningFloor } from "../src/model-catalog.ts";

test("OpenRouter lookup keeps the most conservative host limits and declared capabilities", async () => {
  let path = "";
  const fetcher = async (url: RequestInfo | URL) => {
    path = String(url);
    return Response.json({ data: { name: "New model", architecture: { input_modalities: ["text"] }, endpoints: [
      { context_length: 400000, max_completion_tokens: 64000, supported_parameters: ["tools", "reasoning", "temperature"], pricing: { prompt: "0.000075", completion: "0.0003" } },
      { context_length: 200000, max_completion_tokens: 32000, supported_parameters: ["tools"], pricing: { prompt: "0.000001", completion: "0.000002" } },
    ] } });
  };
  const model = await withOpenRouterDetails(passthroughModel("new/dear:nitro"), "https://models.invalid", fetcher);
  assert.equal(path, "https://models.invalid/models/new/dear/endpoints");
  assert.equal(model.name, "New model");
  assert.equal(model.contextWindow, 400000);
  assert.equal(model.maxTokens, 32000);
  assert.equal(model.cost.input, 75);
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.passthrough, undefined);
  assert.equal(reasoningFloor(model), "low");
});

test("OpenRouter refuses nonexistent and non-tool models but retains defaults on an outage", async () => {
  await assert.rejects(withOpenRouterDetails(passthroughModel("new/nope"), "https://models.invalid", async () => Response.json({ error: { message: "No model" } }, { status: 404 })), /OpenRouter has no model/);
  await assert.rejects(withOpenRouterDetails(passthroughModel("new/no-tools"), "https://models.invalid", async () => Response.json({ data: { endpoints: [{ supported_parameters: ["temperature"] }] } })), /no tool support/);
  const down = await withOpenRouterDetails(passthroughModel("new/down"), "https://models.invalid", async () => new Response(null, { status: 503 }));
  assert.equal(down.contextWindow, 128000);
  assert.equal(down.passthrough, undefined);
});
