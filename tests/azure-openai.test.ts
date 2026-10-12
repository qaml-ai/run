import { test } from "node:test";
import assert from "node:assert/strict";
import { AZURE_API_VERSION, azureCredentials, azureOpenAIConfig } from "../src/azure-openai.ts";
import { safetyRefusal } from "../src/images.ts";
import { Transcriber, TranscriptionFailed, type TranscriptionProvider } from "../src/transcription.ts";
import { until } from "./runtime-server.ts";
import { OPS, OWN, PAYG, start } from "./image-generation-fixture.ts";

test("Azure OpenAI settings: an https endpoint and a key, deployments defaulting to the models' names, \"\" leaving one on OpenAI", () => {
  assert.equal(azureOpenAIConfig({}, "x"), undefined);
  assert.deepEqual(azureOpenAIConfig({ endpoint: "https://camel.openai.azure.com/", apiKey: "k" }, "x"),
    { endpoint: "https://camel.openai.azure.com", apiKey: "k", apiVersion: AZURE_API_VERSION, imageDeployment: "gpt-image-2.5-flare", transcriptionDeployment: "gpt-transcribe" });
  assert.deepEqual(azureOpenAIConfig({ endpoint: "https://camel.openai.azure.com", apiKey: "k", imageDeployment: "img", transcriptionDeployment: "", apiVersion: "2025-03-01-preview" }, "x"),
    { endpoint: "https://camel.openai.azure.com", apiKey: "k", apiVersion: "2025-03-01-preview", imageDeployment: "img" });
  for (const bad of [{ endpoint: "https://a.example" }, { apiKey: "k" }, { endpoint: "http://camel.openai.azure.com", apiKey: "k" }, { endpoint: "nope", apiKey: "k" }, { endpoint: "https://a.example", apiKey: "k", imageDeployment: "a/b" }, { endpoint: "https://a.example", apiKey: "k", apiVersion: "latest" }]) {
    assert.throws(() => azureOpenAIConfig(bad, "AZURE"), /AZURE/, JSON.stringify(bad));
  }
  const config = azureOpenAIConfig({ endpoint: "https://camel.openai.azure.com", apiKey: "k" }, "x")!;
  assert.deepEqual(azureCredentials(config, "gpt-transcribe", { apiKey: "sk-platform" }), {
    apiKey: "", baseUrl: "https://camel.openai.azure.com/openai/deployments/gpt-transcribe", query: `api-version=${AZURE_API_VERSION}`,
    model: "gpt-transcribe", secrets: { "api-key": "k" }, via: "azure", fallback: { apiKey: "sk-platform" },
  });
});

test("a safety refusal as OpenAI or Azure's content filter says it", () => {
  assert.deepEqual(safetyRefusal({ code: "moderation_blocked", moderation_details: { moderation_stage: "output", categories: ["sexual"] } }), { stage: "output", categories: ["sexual"] });
  assert.deepEqual(safetyRefusal({ code: "contentFilter", inner_error: { code: "ResponsibleAIPolicyViolation", content_filter_results: { hate: { filtered: false }, violence: { filtered: true, severity: "high" } } } }), { stage: "input", categories: ["violence"] });
  assert.deepEqual(safetyRefusal({ code: "content_policy_violation", message: "…" }), { stage: "input", categories: [] });
  assert.deepEqual(safetyRefusal({ code: "invalid_request", innererror: { code: "ResponsibleAIPolicyViolation" } }), { stage: "input", categories: [] });
  assert.equal(safetyRefusal({ code: "invalid_value", message: "size" }), undefined);
  assert.equal(safetyRefusal(undefined), undefined);
});

test("the platform's key goes to the Azure deployment, falling back on OpenAI when Azure is rate limited; a tenant's own key stays on OpenAI", async t => {
  const { r, openai, azure } = await start(t, undefined, { azure: true });
  assert.equal((await r.call("/v1/billing/adjustments", { body: { tenant: "payg", amount: 1_000_000, reason: "test" }, token: OPS })).status, 201);
  const made = await r.call("/v1/images", { body: { prompt: "a camel", quality: "low" }, token: PAYG });
  assert.equal(made.status, 200, made.text);
  assert.deepEqual([made.json.model, made.json.costUsd], ["openai/gpt-image-2.5-flare", 0.1], "billed as before");
  assert.deepEqual(azure!.requests.map(call => [call.path, call.apiKey, call.key, call.fields.model]), [[`/openai/deployments/images-eastus2/images/generations?api-version=${AZURE_API_VERSION}`, "azure-test-key", "undefined", "images-eastus2"]]);
  assert.equal(openai.requests.length, 0);

  // Rate limited on Azure: the platform's OpenAI key makes it, billed once.
  const busy = await r.call("/v1/images", { body: { prompt: "a busy camel" }, token: PAYG });
  assert.equal(busy.status, 200, busy.text);
  assert.deepEqual([azure!.requests.length, openai.requests.length, openai.requests.at(-1)!.key, openai.requests.at(-1)!.fields.model], [2, 1, "Bearer platform-openai-key", "gpt-image-2.5-flare"]);
  // Logged as made on Azure, then (after the fallback) without it.
  const generated = r.logs.filter(line => line.includes('"type":"images_generated"'));
  assert.deepEqual(generated.map(line => JSON.parse(line).via ?? null), ["azure", null]);

  // Azure's content filter refusing: IMAGE_REFUSED, with no fallback.
  const filtered = await r.call("/v1/images", { body: { prompt: "a filtered camel" }, token: PAYG });
  assert.equal(filtered.status, 400);
  assert.deepEqual([filtered.json.code, filtered.json.stage, filtered.json.categories], ["IMAGE_REFUSED", "input", ["violence"]]);
  assert.match(filtered.json.error, /^Azure OpenAI's safety system refused this request \(violence\)$/);
  assert.equal(openai.requests.length, 1);

  // A tenant's own OpenAI key never goes to Azure.
  assert.equal((await r.call("/v1/providers/openai/key", { method: "PUT", body: { apiKey: "sk-own-openai", verify: false }, token: OPS })).status, 200);
  const own = await r.call("/v1/images", { body: { prompt: "my camel" }, token: OPS });
  assert.equal(own.status, 200, own.text);
  assert.deepEqual([azure!.requests.length, openai.requests.at(-1)!.key], [3, "Bearer sk-own-openai"]);
  await until(async () => (await r.call("/v1/billing", { token: PAYG })).json.balance === 1_000_000 - 200_000, "two images charged");
  assert.equal((await r.call("/v1/images", { body: { prompt: "a camel" }, token: OWN })).json.code, "IMAGE_UNAVAILABLE");
});

test("a transcription on the platform's Azure deployment falls back on OpenAI when Azure fails for now, and only then", async () => {
  const seen: (string | undefined)[] = [];
  let failure: TranscriptionFailed | undefined;
  const provider: TranscriptionProvider = {
    id: "openai", model: "gpt-transcribe",
    transcribe: async (_audio, _options, credentials) => {
      seen.push(credentials.via ?? credentials.apiKey);
      if (credentials.via === "azure" && failure) throw failure;
      return { text: "hi", seconds: 5, model: "gpt-transcribe" };
    },
  };
  const azure = azureOpenAIConfig({ endpoint: "https://camel.openai.azure.com", apiKey: "k" }, "x")!;
  const transcriber = new Transcriber({ provider, price: () => 0, key: async () => ({ ...azureCredentials(azure, "gpt-transcribe", { apiKey: "sk-platform" }), platform: true }) });
  const audio = { bytes: new Uint8Array(1), header: { format: "ogg" as const, contentType: "audio/ogg", seconds: 5 } };
  const signal = new AbortController().signal;
  await transcriber.transcribe({ tenant: "payg" }, audio, {}, signal);
  assert.deepEqual(seen, ["azure"]);
  failure = new TranscriptionFailed(502, "Azure OpenAI failed to transcribe the audio (HTTP 429)", true);
  await transcriber.transcribe({ tenant: "payg" }, audio, {}, signal);
  assert.deepEqual(seen, ["azure", "azure", "sk-platform"]);
  failure = new TranscriptionFailed(400, "Azure OpenAI could not transcribe the audio (HTTP 400)");
  await assert.rejects(transcriber.transcribe({ tenant: "payg" }, audio, {}, signal), /HTTP 400/);
  assert.deepEqual(seen, ["azure", "azure", "sk-platform", "azure"]);
});
