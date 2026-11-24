import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

test("cost accounting discounts cacheReadTokens, sends prompt_cache_key, and tightens autoCompactThreshold", async (t) => {
  const recordedRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const receivedWebhooks: Array<{ event: string | undefined; body: Record<string, unknown> }> = [];

  const mockServer = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    recordedRequests.push({ path: pathname, body });

    if (pathname === "/usage-webhook") {
      receivedWebhooks.push({
        event: req.headers["x-camelrun-event"] as string | undefined,
        body,
      });
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/tool-echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (pathname === "/openai/v1/responses") {
      const input = (body.input as Array<{ type?: string }>) ?? [];
      const hasToolOutput = input.some((item) => item.type === "function_call_output");
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = hasToolOutput
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
            },
            { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Done after tool" },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "message",
                id: "msg_1",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "Done after tool" }],
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_2",
                status: "completed",
                output: [],
                usage: {
                  input_tokens: 100_000,
                  output_tokens: 500,
                  input_tokens_details: { cached_tokens: 90_000 },
                },
              },
            },
          ]
        : [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_cache_1",
                call_id: "call_cache_1",
                name: "echo",
                arguments: "",
              },
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: {
                type: "function_call",
                id: "fc_cache_1",
                call_id: "call_cache_1",
                name: "echo",
                arguments: "{}",
              },
            },
            {
              type: "response.completed",
              response: {
                id: "resp_1",
                status: "completed",
                output: [],
                usage: {
                  input_tokens: 100_000,
                  output_tokens: 500,
                  input_tokens_details: { cached_tokens: 90_000 },
                },
              },
            },
          ];
      res.end(events.map((ev) => `data: ${JSON.stringify(ev)}\n\n`).join("") + "data: [DONE]\n\n");
      return;
    }

    if (pathname === "/v1/chat/completions") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({
        choices: [],
        usage: {
          prompt_tokens: 50_000,
          completion_tokens: 200,
          prompt_tokens_details: { cached_tokens: 40_000 },
        },
      })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }

    if (pathname === "/v1/messages") {
      // Anthropic reports input_tokens as uncached and cache_read_input_tokens separately.
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: "msg_anth_1",
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-sonnet-4-0",
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 2_000,
            cache_read_input_tokens: 18_000,
            cache_creation_input_tokens: 0,
            output_tokens: 1,
          },
        },
      })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "claude ok" },
      })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 0,
      })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 100 },
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      res.end();
      return;
    }

    if (req.url?.includes(":streamGenerateContent")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "gemini ok" }] }, finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 40_000,
          candidatesTokenCount: 300,
          cachedContentTokenCount: 30_000,
        },
      })}\n\n`);
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    mockServer.closeAllConnections();
    mockServer.close();
  });
  const addr = mockServer.address();
  assert.ok(addr && typeof addr === "object");
  const mockUrl = `http://127.0.0.1:${addr.port}`;

  const dir = mkdtempSync(join(tmpdir(), "camelrun-cost-caching-"));
  const config = join(dir, "wrangler.json");
  const adminKey = "fixture-cost-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "cost-caching-test",
      main: fileURLToPath(new URL("./fixtures/cost-caching-worker.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: adminKey,
        VAULT_SECRET: "fixture-cost-vault-32-bytes-minimum",
        DEFAULT_MODEL: "azure/gpt-6.2-sol",
        AZURE_OPENAI_SOL_ENDPOINT: mockUrl,
        AZURE_OPENAI_SOL_API_KEY: "fixture-azure-key",
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
  const origin = "https://cost-caching.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;

  const calcCost = async (
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
  ) => {
    const res = await worker.fetch(`${origin}/_test/cost`, {
      method: "POST",
      body: JSON.stringify({ model, inputTokens, outputTokens, cacheReadTokens }),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as { costUsd: number; usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; costUsd: number } };
  };

  await t.test("calculateCostUsd discounts cacheReadTokens accurately across models and tiers", async () => {
    // azure/gpt-6-luna <= 272k: uncached $0.10/1M, cacheRead $0.01/1M, output $0.50/1M
    const lunaShort = await calcCost("azure/gpt-6-luna", 100_000, 1_000, 90_000);
    // 10k * 0.1 + 90k * 0.01 + 1k * 0.5 = 0.001 + 0.0009 + 0.0005 = 0.0024
    assert.equal(lunaShort.costUsd, 0.0024);
    assert.equal(lunaShort.usage.cacheReadTokens, 90_000);

    // azure/gpt-6.1-terra <= 272k: uncached $1/1M, cacheRead $0.05/1M, output $5/1M
    const terraShort = await calcCost("azure/gpt-6.1-terra", 100_000, 1_000, 90_000);
    // 10k * 1 + 90k * 0.05 + 1k * 5 = 0.01 + 0.0045 + 0.005 = 0.0195
    assert.equal(terraShort.costUsd, 0.0195);
    assert.equal(terraShort.usage.cacheReadTokens, 90_000);
    assert.equal(terraShort.usage.costUsd, 0.0195);

    // azure/gpt-6.1-terra > 272k: uncached $2/1M, cacheRead $0.10/1M, output $7.50/1M
    const terraLong = await calcCost("azure/gpt-6.1-terra", 300_000, 1_000, 250_000);
    // 50k * 2 + 250k * 0.1 + 1k * 7.5 = 0.10 + 0.025 + 0.0075 = 0.1325
    assert.equal(terraLong.costUsd, 0.1325);

    // azure/gpt-6.2-sol <= 272k: uncached $2/1M, cacheRead $0.10/1M, output $10/1M
    const solShort = await calcCost("azure/gpt-6.2-sol", 100_000, 1_000, 90_000);
    // 10k * 2 + 90k * 0.1 + 1k * 10 = 0.02 + 0.009 + 0.01 = 0.039
    assert.equal(solShort.costUsd, 0.039);
    assert.equal(solShort.usage.cacheReadTokens, 90_000);
    assert.equal(solShort.usage.costUsd, 0.039);

    // azure/gpt-6.2-sol > 272k: uncached $4/1M, cacheRead $0.20/1M, output $15/1M
    const solLong = await calcCost("azure/gpt-6.2-sol", 300_000, 1_000, 250_000);
    // 50k * 4 + 250k * 0.2 + 1k * 15 = 0.20 + 0.05 + 0.015 = 0.265
    assert.equal(solLong.costUsd, 0.265);

    // openai/gpt-4.1: uncached $2/1M, cacheRead $0.50/1M, output $8/1M
    const gpt41 = await calcCost("openai/gpt-4.1", 100_000, 1_000, 80_000);
    // 20k * 2 + 80k * 0.5 + 1k * 8 = 0.04 + 0.04 + 0.008 = 0.088
    assert.equal(gpt41.costUsd, 0.088);

    // anthropic/claude-sonnet-4-0: uncached $3/1M, cacheRead $0.30/1M, output $15/1M
    const claude = await calcCost("anthropic/claude-sonnet-4-0", 20_000, 1_000, 18_000);
    // 2k * 3 + 18k * 0.3 + 1k * 15 = 0.006 + 0.0054 + 0.015 = 0.0264
    assert.equal(claude.costUsd, 0.0264);

    // gemini/gemini-2.5-pro: uncached $1.25/1M, cacheRead $0.125/1M, output $10/1M
    const gemini = await calcCost("gemini/gemini-2.5-pro", 40_000, 1_000, 30_000);
    // 10k * 1.25 + 30k * 0.125 + 1k * 10 = 0.0125 + 0.00375 + 0.01 = 0.02625
    assert.equal(gemini.costUsd, 0.02625);

    // Clamps cacheReadTokens > inputTokens and leaves cacheReadTokens unset when 0
    const clamped = await calcCost("azure/gpt-6.2-sol", 10_000, 0, 50_000);
    assert.equal(clamped.costUsd, 0.001);
    assert.equal(clamped.usage.cacheReadTokens, 10_000);

    const noCache = await calcCost("azure/gpt-6.2-sol", 10_000, 0, 0);
    assert.equal(noCache.costUsd, 0.02);
    assert.equal(noCache.usage.cacheReadTokens, undefined);
  });

  await t.test("getAutoCompactThreshold caps at 40_000 tokens and honors clamped compactThresholdTokens overrides", async () => {
    const check = async (model: string, expected: number, override?: number | null) => {
      const res = await worker.fetch(`${origin}/_test/compact-threshold`, {
        method: "POST",
        body: JSON.stringify({ model, ...(override !== undefined ? { override } : {}) }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { threshold: expected });
    };
    await check("azure/gpt-6.1-terra", 40_000);
    await check("azure/gpt-6.2-sol", 40_000);
    await check("openai/gpt-4.1", 40_000);
    await check("anthropic/claude-sonnet-4-0", 40_000);
    await check("gemini/gemini-2.5-pro", 40_000);
    await check("openai/gpt-4o", 40_000);

    // Custom per-agent compactThresholdTokens override (clamped to [8_000, Math.floor(ctx * 0.8)])
    await check("azure/gpt-6.2-sol", 24_000, 24_000);
    await check("azure/gpt-6.2-sol", 8_000, 2_500);
    await check("openai/gpt-4o", Math.floor(128_000 * 0.8), 500_000);
    await check("azure/gpt-6.2-sol", 40_000, null);
  });

  await t.test("protocol stream parsers extract cacheReadTokens accurately without double-counting", async () => {
    const runStream = async (model: string, credentials?: Record<string, unknown>, promptCacheKey?: string) => {
      const res = await worker.fetch(`${origin}/_test/stream`, {
        method: "POST",
        body: JSON.stringify({ model, credentials, promptCacheKey }),
      });
      assert.equal(res.status, 200, await res.clone().text());
      const { chunks } = (await res.json()) as { chunks: Array<Record<string, unknown>> };
      return chunks.find((c) => c.type === "done")!;
    };

    // OpenAI Chat (explicit apiStyle override)
    const chatDone = await runStream("openai/gpt-4.1", {
      provider: "openai",
      apiKey: "test-key",
      baseUrl: `${mockUrl}/v1`,
      apiStyle: "openai-chat",
    });
    assert.equal(chatDone.inputTokens, 50_000);
    assert.equal(chatDone.outputTokens, 200);
    assert.equal(chatDone.cacheReadTokens, 40_000);

    // Anthropic: raw input_tokens (2,000) + cache_read_input_tokens (18,000) => total inputTokens 20,000
    const anthDone = await runStream("anthropic/claude-sonnet-4-0", {
      provider: "anthropic",
      apiKey: "test-key",
      baseUrl: mockUrl,
    });
    assert.equal(anthDone.inputTokens, 20_000);
    assert.equal(anthDone.outputTokens, 100);
    assert.equal(anthDone.cacheReadTokens, 18_000);

    // Gemini: promptTokenCount includes cachedContentTokenCount
    const gemDone = await runStream("gemini/gemini-2.5-pro", {
      provider: "gemini",
      apiKey: "test-key",
      baseUrl: mockUrl,
    });
    assert.equal(gemDone.inputTokens, 40_000);
    assert.equal(gemDone.outputTokens, 300);
    assert.equal(gemDone.cacheReadTokens, 30_000);

    // Azure Responses clamps prompt_cache_key to 64 chars (both sol and luna use platform Azure)
    const longKey = "a".repeat(80);
    await runStream("azure/gpt-6.2-sol", undefined, longKey);
    const lastAzure = recordedRequests.at(-1)!;
    assert.equal(lastAzure.path, "/openai/v1/responses");
    await runStream("azure/gpt-6-luna", undefined, "luna-cache-key");
    const lastLuna = recordedRequests.at(-1)!;
    assert.equal(lastLuna.path, "/openai/v1/responses");
    assert.equal(lastAzure.body.prompt_cache_key, "a".repeat(64));
  });

  await t.test("turn-loop & agent-do pass prompt_cache_key, discount costUsd for spendLimitUsd, and record cacheRead", async () => {
    const owner = await CamelRun.createTenant({
      baseUrl: origin,
      fetch: fetcher,
      adminKey,
      name: "cache-billing-owner",
      initialCreditsUsd: 5,
    });
    const camel = new CamelRun({ baseUrl: origin, fetch: fetcher, apiKey: owner.apiKey });
    t.after(() => camel.close());

    await camel.webhooks.create({
      url: `${mockUrl}/usage-webhook`,
      events: ["usage.recorded"],
    });

    const agent = await camel.agents.upsert("cached-sol-agent", {
      model: "azure/gpt-6.2-sol",
      builtins: [],
      tools: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: {} }, url: `${mockUrl}/tool-echo` }],
      spendLimitUsd: 0.1,
      compactThresholdTokens: 28_000,
    });
    const agentState = await camel.agents.get("cached-sol-agent");
    assert.equal(agentState.summary.compactThresholdTokens, 28_000);

    // Two model steps, each with 100k input (90k cached) + 500 output:
    // Without cache discount each step would cost $0.205 (tripping $0.10 spendLimitUsd after step 1!).
    // With cache discount each step costs 10k*$2/1M + 90k*$0.10/1M + 500*$10/1M = 0.02 + 0.009 + 0.005 = $0.034.
    // Total for 2 steps = $0.068 <= $0.10, so the run completes!
    const beforeReqs = recordedRequests.length;
    const run = await agent.run("Call echo and summarize", { actor: "user-1", spendLimitUsd: 0.1 });
    assert.equal(run.status, "completed", JSON.stringify(run.error));
    assert.equal(run.text, "Done after tool");
    assert.equal(run.usage.inputTokens, 200_000);
    assert.equal(run.usage.outputTokens, 1_000);
    assert.equal(run.usage.cacheReadTokens, 180_000);
    assert.equal(run.usage.costUsd, 0.068);

    const azureCalls = recordedRequests.slice(beforeReqs).filter((r) => r.path === "/openai/v1/responses");
    assert.equal(azureCalls.length, 2);
    for (const call of azureCalls) {
      assert.equal(call.body.prompt_cache_key, agent.id);
    }

    // Verify TenantDO usage_daily stored cacheReadTokens and discounted costUsd
    const billing = await camel.billing.get();
    const row = billing.usage.find((u) => u.model === "azure/gpt-6.2-sol") as
      | { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number }
      | undefined;
    assert.ok(row);
    assert.equal(row.inputTokens, 200_000);
    assert.equal(row.outputTokens, 1_000);
    assert.equal(row.cacheReadTokens, 180_000);
    assert.equal(row.costUsd, 0.068);
    assert.equal(Number((5 - billing.balanceUsd).toFixed(8)), 0.068);

    // Wait briefly for usage.recorded webhooks to deliver
    const deadline = Date.now() + 5_000;
    while (receivedWebhooks.length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(receivedWebhooks.length >= 2, `expected 2 usage.recorded webhooks, got ${receivedWebhooks.length}`);
    for (const wh of receivedWebhooks.slice(0, 2)) {
      assert.equal(wh.event, "usage.recorded");
      const data = wh.body.data as Record<string, unknown>;
      assert.equal(data.cacheRead, 90_000);
      assert.deepEqual(data.cost, { usd: 0.034, source: "catalog" });
    }
  });
});
