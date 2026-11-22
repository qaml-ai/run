import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

test("OpenAI /v1/responses routing, BYOK provider defaults, pricing, and full v1 model catalog", async (t) => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    captured.push({ path: req.url ?? "", body });
    res.setHeader("Content-Type", "application/json");
    if ((req.url ?? "").includes("/responses")) {
      res.end(
        JSON.stringify({
          output: [{ type: "message", content: [{ type: "output_text", text: "ok-responses" }] }],
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok-chat" } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const port = (upstream.address() as { port: number }).port;
  const mockUrl = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), "camelrun-models-routing-"));
  const config = join(dir, "wrangler.json");
  const adminKey = "fixture-models-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "models-routing-test",
      main: fileURLToPath(new URL("./fixtures/models-routing-worker.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: adminKey,
        VAULT_SECRET: "fixture-models-vault-32-bytes-min",
        DEFAULT_MODEL: "azure/gpt-6.1-terra",
        OPENAI_API_KEY: "sk-platform-openai-test",
        AZURE_OPENAI_SOL_ENDPOINT: mockUrl,
        AZURE_OPENAI_SOL_API_KEY: "fixture-azure-sol-key",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] }],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://models-routing.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;

  const resolveEndpoint = async (payload: Record<string, unknown>) => {
    const res = await worker.fetch(`${origin}/_test/resolve`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  await t.test("all OpenAI models route to openai-responses by default (platform and BYOK), honoring explicit openai-chat override", async () => {
    const openAiModels = [
      "openai/gpt-5",
      "openai/gpt-5.4",
      "openai/gpt-5.3-codex",
      "openai/gpt-6.2-sol",
      "openai/o3",
      "openai/o4-mini",
      "openai/gpt-4.1",
      "openai/gpt-4o",
      "gpt-5.4",
      "o3",
      "gpt-4.1",
    ];

    for (const model of openAiModels) {
      // Platform OPENAI_API_KEY
      const platform = await resolveEndpoint({ model, credentials: null });
      assert.equal(platform.status, 200, `${model}: ${JSON.stringify(platform.json)}`);
      assert.equal(platform.json.protocol, "openai-responses", `${model} should default to openai-responses`);
      assert.equal(platform.json.baseUrl, "https://api.openai.com/v1");
      assert.equal(platform.json.apiKey, "sk-platform-openai-test");

      // BYOK stored under provider "openai" with no apiStyle
      const byok = await resolveEndpoint({
        model,
        credentials: { provider: "openai", apiKey: "sk-byok-openai" },
      });
      assert.equal(byok.status, 200);
      assert.equal(byok.json.protocol, "openai-responses", `${model} BYOK should default to openai-responses`);
      assert.equal(byok.json.apiKey, "sk-byok-openai");
    }

    // Explicit tenant apiStyle: "openai-chat" override is respected
    const forcedChat = await resolveEndpoint({
      model: "openai/gpt-5.4",
      credentials: { provider: "openai", apiKey: "sk-byok-chat", apiStyle: "openai-chat" },
    });
    assert.equal(forcedChat.status, 200);
    assert.equal(forcedChat.json.protocol, "openai-chat");
    assert.equal(forcedChat.json.baseUrl, "https://api.openai.com/v1");
  });

  await t.test("xai and other v1 BYOK providers resolve default endpoints and never leak platform OPENAI_API_KEY", async () => {
    // Missing xai key MUST fail with 400 missing_provider_key (never leak OPENAI_API_KEY!)
    const missingXai = await resolveEndpoint({ model: "xai/grok-4.7", credentials: null });
    assert.equal(missingXai.status, 400);

    const xai = await resolveEndpoint({
      model: "xai/grok-4.7",
      credentials: { provider: "xai", apiKey: "xai-key" },
    });
    assert.equal(xai.status, 200);
    assert.equal(xai.json.protocol, "openai-responses");
    assert.equal(xai.json.baseUrl, "https://api.x.ai/v1");
    assert.equal(xai.json.modelId, "grok-4.7");

    const providerExpectations: Array<[string, string, string]> = [
      ["deepseek/deepseek-chat", "openai-chat", "https://api.deepseek.com"],
      ["groq/llama-3.3-70b-versatile", "openai-chat", "https://api.groq.com/openai/v1"],
      ["mistral/mistral-large-latest", "openai-chat", "https://api.mistral.ai/v1"],
      ["together/meta-llama/Llama-3.3-70B-Instruct-Turbo", "openai-chat", "https://api.together.ai/v1"],
      ["fireworks/accounts/fireworks/models/deepseek-v3p1", "openai-chat", "https://api.fireworks.ai/inference/v1"],
      ["cerebras/llama3.1-8b", "openai-chat", "https://api.cerebras.ai/v1"],
      ["moonshotai/kimi-k2.5", "openai-chat", "https://api.moonshot.ai/v1"],
      ["minimax/MiniMax-M2.5", "anthropic", "https://api.minimax.io/anthropic"],
      ["zai/glm-5", "openai-chat", "https://api.z.ai/api/coding/paas/v4"],
      ["baseten/deepseek-ai/DeepSeek-V3.2", "openai-chat", "https://inference.baseten.co/v1"],
      ["nvidia/meta/llama-3.3-70b-instruct", "openai-chat", "https://integrate.api.nvidia.com/v1"],
      ["huggingface/deepseek-ai/DeepSeek-V3.2", "openai-chat", "https://router.huggingface.co/v1"],
    ];

    for (const [model, expectedProtocol, expectedBaseUrl] of providerExpectations) {
      const provider = model.split("/")[0]!;
      const missing = await resolveEndpoint({ model, credentials: null });
      assert.equal(missing.status, 400, `${model} must require its own key`);

      const resolved = await resolveEndpoint({
        model,
        credentials: { provider, apiKey: `key-${provider}` },
      });
      assert.equal(resolved.status, 200, `${model}: ${JSON.stringify(resolved.json)}`);
      assert.equal(resolved.json.protocol, expectedProtocol, model);
      assert.equal(resolved.json.baseUrl, expectedBaseUrl, model);
    }

    // Both google/* and gemini/* resolve to gemini protocol
    for (const model of ["gemini/gemini-3.5-flash", "google/gemini-3.5-flash"]) {
      const resolved = await resolveEndpoint({
        model,
        credentials: { provider: "google", apiKey: "gem-key" },
      });
      assert.equal(resolved.status, 200);
      assert.equal(resolved.json.protocol, "gemini");
      assert.equal(resolved.json.modelId, "gemini-3.5-flash");
    }
  });

  await t.test("streamOpenAiResponses and streamOpenAiChat send compatible payloads for reasoning vs non-reasoning models", async () => {
    const stream = async (body: Record<string, unknown>) => {
      const res = await worker.fetch(`${origin}/_test/stream`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return captured.at(-1)!;
    };

    // Reasoning model on OpenAI Responses: store: false, no temperature, prompt_cache_key sent
    const r54 = await stream({
      model: "openai/gpt-5.4",
      temperature: 0.7,
      maxOutputTokens: 256,
      promptCacheKey: "agent-key-123",
      credentials: { provider: "openai", apiKey: "sk-test", baseUrl: `${mockUrl}/v1` },
    });
    assert.equal(r54.path, "/v1/responses");
    assert.equal(r54.body.store, false);
    assert.equal(r54.body.temperature, undefined);
    assert.equal(r54.body.max_output_tokens, 256);
    assert.equal(r54.body.prompt_cache_key, "agent-key-123");

    // Non-reasoning model on OpenAI Responses: includes temperature
    const r41 = await stream({
      model: "openai/gpt-4.1",
      temperature: 0.3,
      maxOutputTokens: 128,
      credentials: { provider: "openai", apiKey: "sk-test", baseUrl: `${mockUrl}/v1` },
    });
    assert.equal(r41.path, "/v1/responses");
    assert.equal(r41.body.temperature, 0.3);
    assert.equal(r41.body.max_output_tokens, 128);
    assert.equal(r41.body.store, false);

    // Forced openai-chat on OpenAI reasoning model: uses max_completion_tokens, omits temperature
    const rChatReasoning = await stream({
      model: "openai/gpt-5",
      temperature: 0.7,
      maxOutputTokens: 512,
      credentials: { provider: "openai", apiKey: "sk-test", baseUrl: `${mockUrl}/v1`, apiStyle: "openai-chat" },
    });
    assert.equal(rChatReasoning.path, "/v1/chat/completions");
    assert.equal(rChatReasoning.body.max_completion_tokens, 512);
    assert.equal(rChatReasoning.body.max_tokens, undefined);
    assert.equal(rChatReasoning.body.temperature, undefined);

    // OpenRouter chat completions keeps max_tokens and temperature
    const rOpenRouter = await stream({
      model: "openrouter/openai/gpt-5",
      temperature: 0.5,
      maxOutputTokens: 512,
      credentials: { provider: "openrouter", apiKey: "or-test", baseUrl: `${mockUrl}/v1` },
    });
    assert.equal(rOpenRouter.path, "/v1/chat/completions");
    assert.equal(rOpenRouter.body.max_tokens, 512);
    assert.equal(rOpenRouter.body.max_completion_tokens, undefined);
    assert.equal(rOpenRouter.body.temperature, 0.5);
  });

  await t.test("DEFAULT_MODEL_ID is azure/gpt-6.1-terra and both platform Azure models route to Responses with reasoning low", async () => {
    const defRes = await worker.fetch(`${origin}/_test/default-model`);
    assert.equal(defRes.status, 200);
    assert.deepEqual(await defRes.json(), { defaultModelId: "azure/gpt-6.1-terra" });

    for (const model of ["azure/gpt-6.1-terra", "camelrun/default", ""]) {
      const resolved = await resolveEndpoint({ model, credentials: null });
      assert.equal(resolved.status, 200, `${model}: ${JSON.stringify(resolved.json)}`);
      assert.equal(resolved.json.protocol, "openai-responses");
      assert.equal(resolved.json.providerName, "azure");
      assert.equal(resolved.json.modelId, "gpt-6.1-terra");
      assert.equal(resolved.json.baseUrl, `${mockUrl}/openai/v1`);
      assert.equal(resolved.json.apiKey, "fixture-azure-sol-key");
    }

    const solResolved = await resolveEndpoint({ model: "azure/gpt-6.2-sol", credentials: null });
    assert.equal(solResolved.status, 200, JSON.stringify(solResolved.json));
    assert.equal(solResolved.json.protocol, "openai-responses");
    assert.equal(solResolved.json.providerName, "azure");
    assert.equal(solResolved.json.modelId, "gpt-6.2-sol");
    assert.equal(solResolved.json.baseUrl, `${mockUrl}/openai/v1`);
    assert.equal(solResolved.json.apiKey, "fixture-azure-sol-key");

    const stream = async (body: Record<string, unknown>) => {
      const res = await worker.fetch(`${origin}/_test/stream`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return captured.at(-1)!;
    };

    const terraStream = await stream({ model: "azure/gpt-6.1-terra", temperature: 0.4 });
    assert.equal(terraStream.path, "/openai/v1/responses");
    assert.equal(terraStream.body.model, "gpt-6.1-terra");
    assert.deepEqual(terraStream.body.reasoning, { effort: "low" });
    assert.equal(terraStream.body.store, false);
    assert.equal(terraStream.body.temperature, undefined);

    const solStream = await stream({ model: "azure/gpt-6.2-sol", temperature: 0.4 });
    assert.equal(solStream.path, "/openai/v1/responses");
    assert.equal(solStream.body.model, "gpt-6.2-sol");
    assert.deepEqual(solStream.body.reasoning, { effort: "low" });
    assert.equal(solStream.body.store, false);
    assert.equal(solStream.body.temperature, undefined);
  });

  await t.test("streamOpenAiResponses normalizes tool call_id > 64 chars deterministically while preserving <= 64-char IDs", async () => {
    const stream = async (body: Record<string, unknown>) => {
      const res = await worker.fetch(`${origin}/_test/stream`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      assert.equal(res.status, 200, await res.clone().text());
      return captured.at(-1)!;
    };

    const longIdA = `call_openrouter_composite_${"a".repeat(52)}00001`;
    const longIdB = `call_openrouter_composite_${"a".repeat(52)}00002`;
    const exact64Id = `call_${"x".repeat(59)}`;
    const shortId = "call_short_123";
    assert.equal(longIdA.length, 83);
    assert.equal(longIdB.length, 83);
    assert.equal(exact64Id.length, 64);

    const messages = [
      { role: "user", text: "Run tools" },
      {
        role: "assistant",
        toolCalls: [
          { id: longIdA, name: "tool_a", argumentsJson: "{}", args: {} },
          { id: longIdB, name: "tool_b", argumentsJson: "{}", args: {} },
          { id: exact64Id, name: "tool_64", argumentsJson: "{}", args: {} },
          { id: shortId, name: "tool_short", argumentsJson: "{}", args: {} },
          { id: "", name: "tool_empty", argumentsJson: "{}", args: {} },
        ],
      },
      { role: "tool", toolCallId: longIdA, text: "out_a" },
      { role: "tool", toolCallId: longIdB, text: "out_b" },
      { role: "tool", toolCallId: exact64Id, text: "out_64" },
      { role: "tool", toolCallId: shortId, text: "out_short" },
      { role: "tool", toolCallId: "", text: "out_empty" },
    ];

    const first = await stream({ model: "azure/gpt-6.1-terra", messages });
    const second = await stream({ model: "azure/gpt-6.1-terra", messages });
    assert.equal(first.path, "/openai/v1/responses");

    const input1 = first.body.input as Array<{ type?: string; call_id?: string; name?: string; output?: string }>;
    const input2 = second.body.input as Array<{ type?: string; call_id?: string; name?: string; output?: string }>;
    const calls1 = input1.filter((item) => item.type === "function_call");
    const outputs1 = input1.filter((item) => item.type === "function_call_output");
    const calls2 = input2.filter((item) => item.type === "function_call");
    assert.equal(calls1.length, 5);
    assert.equal(outputs1.length, 5);

    // Every emitted call_id must be non-empty and <= 64 chars, and match between call & output.
    for (let i = 0; i < calls1.length; i++) {
      const callId = calls1[i]!.call_id!;
      assert.ok(callId.length > 0 && callId.length <= 64, `invalid call_id length (${callId.length}): ${callId}`);
      assert.equal(outputs1[i]!.call_id, callId, `mismatched function_call_output.call_id at index ${i}`);
      assert.equal(calls2[i]!.call_id, callId, `non-deterministic call_id at index ${i}`);
    }

    // Long IDs sharing the same prefix normalize to distinct <= 64-char IDs.
    assert.notEqual(calls1[0]!.call_id, longIdA);
    assert.notEqual(calls1[1]!.call_id, longIdB);
    assert.notEqual(calls1[0]!.call_id, calls1[1]!.call_id);
    assert.equal(calls1[0]!.call_id!.length, 64);
    assert.equal(calls1[1]!.call_id!.length, 64);

    // Normal <= 64-char IDs are preserved verbatim; empty call_id falls back to "call_0".
    assert.equal(calls1[2]!.call_id, exact64Id);
    assert.equal(calls1[3]!.call_id, shortId);
    assert.equal(calls1[4]!.call_id, "call_0");
  });

  await t.test("calculateCostUsd and getModelContextWindow cover restored v1 catalog models and long-context tiers", async () => {
    const check = async (model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0) => {
      const res = await worker.fetch(`${origin}/_test/pricing`, {
        method: "POST",
        body: JSON.stringify({ model, inputTokens, outputTokens, cacheReadTokens }),
      });
      assert.equal(res.status, 200);
      return (await res.json()) as { contextWindow: number; costUsd: number };
    };

    // openai/gpt-5.4: $2.50 in, $15 out, $0.25 cacheRead; >272k tier $5 in, $22.50 out, $0.50 cacheRead
    const g54 = await check("openai/gpt-5.4", 100_000, 10_000, 50_000);
    assert.equal(g54.contextWindow, 272_000);
    // 50k*2.5 + 50k*0.25 + 10k*15 = 0.125 + 0.0125 + 0.15 = 0.2875
    assert.equal(g54.costUsd, 0.2875);

    const g54Long = await check("openai/gpt-5.4", 300_000, 10_000, 100_000);
    // 200k*5 + 100k*0.5 + 10k*22.5 = 1.0 + 0.05 + 0.225 = 1.275
    assert.equal(g54Long.costUsd, 1.275);

    // openai/gpt-5-mini: $0.25 in, $2 out, $0.025 cacheRead, ctx 400_000
    const g5m = await check("openai/gpt-5-mini", 100_000, 10_000, 0);
    assert.equal(g5m.contextWindow, 400_000);
    assert.equal(g5m.costUsd, 0.045);

    // openai/o3: $2 in, $8 out, $0.50 cacheRead, ctx 200_000
    const o3 = await check("openai/o3", 100_000, 10_000, 0);
    assert.equal(o3.contextWindow, 200_000);
    assert.equal(o3.costUsd, 0.28);

    // anthropic/claude-sonnet-5-5: $2 in, $10 out, $0.10 cacheRead, ctx 1_000_000
    const s55 = await check("anthropic/claude-sonnet-5-5", 100_000, 10_000, 80_000);
    assert.equal(s55.contextWindow, 1_000_000);
    // 20k*2 + 80k*0.1 + 10k*10 = 0.04 + 0.008 + 0.1 = 0.148
    assert.equal(s55.costUsd, 0.148);

    // azure/gpt-6.1-terra: $1 in, $5 out, $0.05 cacheRead, ctx 272_000; >272k tier $2 in, $7.50 out, $0.10 cacheRead
    const terraShort = await check("azure/gpt-6.1-terra", 100_000, 10_000, 80_000);
    assert.equal(terraShort.contextWindow, 272_000);
    // 20k*1 + 80k*0.05 + 10k*5 = 0.02 + 0.004 + 0.05 = 0.074
    assert.equal(terraShort.costUsd, 0.074);

    const terraLong = await check("azure/gpt-6.1-terra", 300_000, 10_000, 200_000);
    // 100k*2 + 200k*0.10 + 10k*7.5 = 0.20 + 0.02 + 0.075 = 0.295
    assert.equal(terraLong.costUsd, 0.295);

    // gemini/gemini-3.5-flash and google/gemini-3.5-flash: $1.50 in, $9 out, ctx 1_048_576
    const gem35 = await check("gemini/gemini-3.5-flash", 100_000, 10_000, 0);
    const goog35 = await check("google/gemini-3.5-flash", 100_000, 10_000, 0);
    assert.equal(gem35.contextWindow, 1_048_576);
    assert.equal(gem35.costUsd, 0.24);
    assert.deepEqual(goog35, gem35);
  });

  await t.test("GET /v2/models returns full v1 catalog with accurate availability flags", async () => {
    const owner = await CamelRun.createTenant({
      baseUrl: origin,
      fetch: fetcher,
      adminKey,
      name: "catalog-owner",
      initialCreditsUsd: 5,
    });
    const headers = { Authorization: `Bearer ${owner.apiKey}` };

    const openaiRes = await worker.fetch(`${origin}/v2/models?provider=openai`, { headers });
    assert.equal(openaiRes.status, 200);
    const openaiModels = (await openaiRes.json()) as Array<{ id: string; available: boolean }>;
    assert.equal(openaiModels.length, 44);
    assert.ok(openaiModels.every((m) => m.available), "all 44 OpenAI models should be available via platform OPENAI_API_KEY");
    for (const id of ["openai/gpt-5", "openai/gpt-5.4", "openai/gpt-5-mini", "openai/gpt-5.3-codex", "openai/o3", "openai/o4-mini", "openai/gpt-4.1"]) {
      assert.ok(openaiModels.some((m) => m.id === id), `missing ${id}`);
    }

    // ?provider=google maps cleanly to gemini catalog
    const googleRes = await worker.fetch(`${origin}/v2/models?provider=google`, { headers });
    assert.equal(googleRes.status, 200);
    const googleModels = (await googleRes.json()) as Array<{ id: string; available: boolean }>;
    assert.equal(googleModels.length, 23);
    assert.ok(googleModels.some((m) => m.id === "gemini/gemini-3.5-flash"));

    // Azure: platform-deployed azure/gpt-6.1-terra and azure/gpt-6.2-sol are available without BYOK azure key
    const azureRes = await worker.fetch(`${origin}/v2/models?provider=azure`, { headers });
    assert.equal(azureRes.status, 200);
    const azureModels = (await azureRes.json()) as Array<{ id: string; available: boolean }>;
    const availAzure = azureModels.filter((m) => m.available).map((m) => m.id).sort();
    assert.deepEqual(availAzure, ["azure/gpt-6.1-terra", "azure/gpt-6.2-sol"]);

    // Full catalog includes xai, anthropic, openrouter, etc.
    const allRes = await worker.fetch(`${origin}/v2/models`, { headers });
    assert.equal(allRes.status, 200);
    const allModels = (await allRes.json()) as Array<{ id: string; provider: string; available: boolean }>;
    assert.ok(allModels.length >= 500, `expected full v1 catalog, got ${allModels.length}`);
    assert.equal(allModels.filter((m) => m.provider === "xai").length, 4);
    assert.equal(allModels.filter((m) => m.provider === "anthropic").length, 19);
  });
});
