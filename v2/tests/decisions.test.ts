import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

function sseOpenAIResponses(text: string, inputTokens = 200, outputTokens = 40): string {
  return (
    `event: response.output_item.added\ndata: ${JSON.stringify({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
    })}\n\n` +
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      output_index: 0,
      content_index: 0,
      delta: text,
    })}\n\n` +
    `event: response.output_item.done\ndata: ${JSON.stringify({
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] },
    })}\n\n` +
    `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
      },
    })}\n\n`
  );
}

test("POST /v2/decisions supports legacy, structured single, structured batch, normalization, and validation", async (t) => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const upstream = createServer(async (req, res) => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      captured.push({ path: pathname, body });

      const inputStr = JSON.stringify(body.input ?? "");
      if (inputStr.includes("__FORCE_PROVIDER_ERROR__")) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "synthetic upstream boom" } }));
        return;
      }

      if (inputStr.includes("__SLOW_CONCURRENCY__")) {
        await new Promise((r) => setTimeout(r, 40));
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          sseOpenAIResponses(
            JSON.stringify({ answers: { ok: { noul: 0.85 } } }),
            100,
            20,
          ),
        );
        return;
      }

      if (inputStr.includes("__UNNORMALIZED__")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          sseOpenAIResponses(
            JSON.stringify({
              answers: {
                spam: { noul: 1.4 },
                safe: { noul: -0.2 },
                category: { probabilities: { scam: 9, benign: 1, promo: -5 } },
                severity: { probabilities: [1, 3, 6] },
              },
            }),
            300,
            60,
          ),
        );
        return;
      }

      if (inputStr.includes("free nitro scam")) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          sseOpenAIResponses(
            JSON.stringify({
              answers: {
                spam: { noul: 0.98 },
                category: { probabilities: { scam: 0.96, benign: 0.04 } },
                severity: { probabilities: [0.02, 0.18, 0.8] },
              },
            }),
            250,
            50,
          ),
        );
        return;
      }

      // Legacy upstream call
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        sseOpenAIResponses(
          JSON.stringify({ choice: "billing", scores: { billing: 8, technical: 2 } }),
          120,
          25,
        ),
      );
    } finally {
      inFlight--;
    }
  });

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const port = (upstream.address() as { port: number }).port;
  const mockUrl = `http://127.0.0.1:${port}/v1`;

  const dir = mkdtempSync(join(tmpdir(), "camelrun-decisions-"));
  const config = join(dir, "wrangler.json");
  const adminKey = "fixture-decisions-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "decisions-test",
      main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
      compatibility_date: "2026-03-24",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: adminKey,
        VAULT_SECRET: "fixture-decisions-vault-32bytes!",
        DEFAULT_MODEL: "azure/gpt-6.1-terra",
        OPENAI_API_KEY: "platform-openai-fixture-key",
        CAMELFS_URL: "http://127.0.0.1:8790",
      },
      durable_objects: {
        bindings: [
          { name: "TENANT_DO", class_name: "TenantDO" },
          { name: "AGENT_DO", class_name: "AgentDO" },
          { name: "VOICE_CALL_DO", class_name: "VoiceCallDO" },
        ],
      },
      migrations: [
        { tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] },
        { tag: "v2", new_sqlite_classes: ["VoiceCallDO"] },
      ],
    }),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://decisions.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;

  const created = await CamelRun.createTenant({
    baseUrl: origin,
    adminKey,
    name: "decisions-tenant",
    initialCreditsUsd: 10,
    fetch: fetcher as any,
  });

  // Point tenant's openai provider at our local mock upstream so default `openai/gpt-4.1-mini` routes locally
  const setProv = await worker.fetch(`${origin}/v2/providers/openai`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${created.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ apiKey: "test-openai-key", baseUrl: mockUrl }),
  });
  assert.equal(setProv.status, 200);

  const postDecisions = async (payload: unknown) => {
    const res = await worker.fetch(`${origin}/v2/decisions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${created.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    const json = (await res.json()) as Record<string, any>;
    return { status: res.status, json };
  };

  // 1. Legacy shape with mock model (backwards-compatible)
  {
    const { status, json } = await postDecisions({
      input: "Please refund my duplicate invoice charge",
      choices: ["billing", "technical", "sales"],
      model: "mock/default",
    });
    assert.equal(status, 200);
    assert.ok(["billing", "technical", "sales"].includes(json.choice));
    assert.ok(json.confidence > 0 && json.confidence <= 1);
    assert.equal(typeof json.costUsd, "number");
    const sum = Object.values(json.scores as Record<string, number>).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-5, `expected legacy scores to sum to 1, got ${sum}`);
  }

  // 2. Legacy shape with default model (routes to fast openai/gpt-4.1-mini, not slow azure/gpt-6.1-terra)
  {
    captured.length = 0;
    const { status, json } = await postDecisions({
      input: "Billing question about invoice",
      choices: ["billing", "technical"],
    });
    assert.equal(status, 200);
    assert.equal(json.choice, "billing");
    assert.equal(json.confidence, 0.8);
    assert.deepEqual(json.scores, { billing: 0.8, technical: 0.2 });
    assert.ok(json.costUsd > 0);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.body.model, "gpt-4.1-mini");
  }

  // 3. Structured single-item shape (string state + all 3 question types + camel-bots optional fields)
  {
    captured.length = 0;
    const { status, json } = await postDecisions({
      state: "free nitro scam click here",
      questions: {
        spam: { type: "noul", instructions: "Is this spam?", criteria: { true: "Spam or scam", false: "Normal" } },
        category: {
          type: "choice",
          instructions: "Classify the message",
          criteria: { scam: "Scam or phishing", benign: "Normal chat" },
        },
        severity: {
          type: "score",
          instructions: "Harm 0-2",
          criteria: ["none", "mild", "severe"],
        },
      },
      context: { bot: "bot_123" },
      subject: "user_456",
      bucket: "decide:bot_123",
      maxUsd: 0.5,
    });
    assert.equal(status, 200);
    assert.equal(json.model, "openai/gpt-4.1-mini");
    assert.ok(json.costUsd > 0);
    assert.deepEqual(json.answers.spam, { type: "noul", noul: 0.98 });
    assert.deepEqual(json.answers.category, {
      type: "choice",
      choice: "scam",
      confidence: 0.96,
      probabilities: { scam: 0.96, benign: 0.04 },
    });
    assert.equal(json.answers.severity.type, "score");
    assert.deepEqual(json.answers.severity.probabilities, [0.02, 0.18, 0.8]);
    assert.equal(json.answers.severity.confidence, 0.8);
    assert.equal(json.answers.severity.score, 1.78);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.body.model, "gpt-4.1-mini");
    assert.equal(captured[0]!.body.temperature, 0);
  }

  // 4. Structured single-item normalization & clamping (unnormalized choice/score, out-of-range noul, JSON object state)
  {
    const { status, json } = await postDecisions({
      state: { marker: "__UNNORMALIZED__", author: "anon", text: "suspicious link" },
      questions: {
        spam: { type: "noul", instructions: "Is this spam?" },
        safe: { type: "noul", instructions: "Is this safe?" },
        category: {
          type: "choice",
          instructions: "Pick category",
          criteria: { scam: "Scam", benign: "Benign", promo: "" },
        },
        severity: {
          type: "score",
          instructions: "Severity",
          criteria: ["low", "medium", "high"],
        },
      },
    });
    assert.equal(status, 200);
    assert.deepEqual(json.answers.spam, { type: "noul", noul: 1 });
    assert.deepEqual(json.answers.safe, { type: "noul", noul: 0 });
    assert.deepEqual(json.answers.category, {
      type: "choice",
      choice: "scam",
      confidence: 0.9,
      probabilities: { scam: 0.9, benign: 0.1, promo: 0 },
    });
    assert.deepEqual(json.answers.severity, {
      type: "score",
      score: 1.5,
      confidence: 0.6,
      probabilities: [0.1, 0.3, 0.6],
    });
  }

  // 5. Structured single-item with JSON array state & mock/default model
  {
    const { status, json } = await postDecisions({
      model: "mock/default",
      state: [{ role: "user", content: "urgent billing refund invoice" }],
      questions: {
        urgent: { type: "noul", instructions: "Is this urgent?" },
        dept: {
          type: "choice",
          instructions: "Route ticket",
          criteria: { billing: "refund invoice payment", engineering: "crash bug error" },
        },
        priority: {
          type: "score",
          instructions: "Priority level",
          criteria: ["low", "medium", "urgent high"],
        },
      },
    });
    assert.equal(status, 200);
    assert.equal(json.costUsd, 0);
    assert.equal(json.answers.urgent.type, "noul");
    assert.ok(json.answers.urgent.noul >= 0 && json.answers.urgent.noul <= 1);
    assert.equal(json.answers.dept.type, "choice");
    assert.equal(json.answers.dept.choice, "billing");
    assert.equal(json.answers.dept.confidence, json.answers.dept.probabilities.billing);
    assert.equal(json.answers.priority.type, "score");
    assert.equal(json.answers.priority.probabilities.length, 3);
    const probSum = json.answers.priority.probabilities.reduce((a: number, b: number) => a + b, 0);
    assert.ok(Math.abs(probSum - 1) < 1e-5);
  }

  // 6. Structured batch with partial item error isolation (validation error + upstream provider error + valid items)
  {
    const { status, json } = await postDecisions({
      items: [
        {
          state: "free nitro scam click here",
          questions: {
            spam: { type: "noul", instructions: "Is this spam?" },
          },
        },
        {
          state: "   ",
          questions: {
            spam: { type: "noul", instructions: "Is this spam?" },
          },
        },
        {
          state: "__FORCE_PROVIDER_ERROR__",
          questions: {
            spam: { type: "noul", instructions: "Is this spam?" },
          },
        },
        {
          state: { marker: "__UNNORMALIZED__" },
          questions: {
            spam: { type: "noul", instructions: "Is this spam?" },
            severity: { type: "score", instructions: "Severity", criteria: ["low", "med", "high"] },
          },
        },
      ],
      subject: "user_batch",
      bucket: "decide:bot_batch",
    });
    assert.equal(status, 200);
    assert.equal(json.results.length, 4);
    assert.deepEqual(json.results[0].answers.spam, { type: "noul", noul: 0.98 });
    assert.ok(typeof json.results[1].error?.message === "string" && json.results[1].error.message.includes("non-empty"));
    assert.ok(typeof json.results[2].error?.message === "string" && json.results[2].error.message.length > 0);
    assert.deepEqual(json.results[3].answers.spam, { type: "noul", noul: 1 });
    assert.equal(json.results[3].answers.severity.score, 1.5);
    const expectedCost = Number((json.results[0].costUsd + json.results[3].costUsd).toFixed(8));
    assert.equal(json.costUsd, expectedCost);
  }

  // 7. Batch bounded concurrency (max 5 concurrent upstream calls across 8 items)
  {
    maxInFlight = 0;
    const { status, json } = await postDecisions({
      items: Array.from({ length: 8 }, (_, i) => ({
        state: `__SLOW_CONCURRENCY__ item ${i}`,
        questions: { ok: { type: "noul", instructions: "Is it ok?" } },
      })),
    });
    assert.equal(status, 200);
    assert.equal(json.results.length, 8);
    assert.ok(json.results.every((r: any) => r.answers?.ok?.noul === 0.85));
    assert.ok(maxInFlight <= 5, `expected bounded concurrency <= 5, got ${maxInFlight}`);
    assert.ok(maxInFlight >= 2, `expected concurrent batch execution, got maxInFlight=${maxInFlight}`);
  }

  // 8. Validation errors
  {
    // Empty / whitespace string state
    const emptyState = await postDecisions({
      state: "   ",
      questions: { q: { type: "noul", instructions: "ok?" } },
    });
    assert.equal(emptyState.status, 400);

    // Missing state
    const missingState = await postDecisions({
      questions: { q: { type: "noul", instructions: "ok?" } },
    });
    assert.equal(missingState.status, 400);

    // Oversized state (> 64,000 chars)
    const tooLarge = await postDecisions({
      state: "a".repeat(64_001),
      questions: { q: { type: "noul", instructions: "ok?" } },
    });
    assert.equal(tooLarge.status, 413);

    // Empty questions object
    const emptyQ = await postDecisions({
      state: "hello",
      questions: {},
    });
    assert.equal(emptyQ.status, 400);

    // > 32 questions
    const tooManyQ: Record<string, unknown> = {};
    for (let i = 0; i < 33; i++) {
      tooManyQ[`q${i}`] = { type: "noul", instructions: "test?" };
    }
    const over32 = await postDecisions({ state: "hello", questions: tooManyQ });
    assert.equal(over32.status, 400);

    // Invalid question type
    const badType = await postDecisions({
      state: "hello",
      questions: { q: { type: "boolean", instructions: "test?" } },
    });
    assert.equal(badType.status, 400);

    // Choice with < 2 criteria
    const badChoice = await postDecisions({
      state: "hello",
      questions: { q: { type: "choice", instructions: "pick", criteria: { only_one: "desc" } } },
    });
    assert.equal(badChoice.status, 400);

    // Score with < 2 criteria
    const badScore = await postDecisions({
      state: "hello",
      questions: { q: { type: "score", instructions: "rate", criteria: ["only_one"] } },
    });
    assert.equal(badScore.status, 400);

    // Empty batch
    const emptyBatch = await postDecisions({ items: [] });
    assert.equal(emptyBatch.status, 400);

    // > 100 batch items
    const over100 = await postDecisions({
      items: Array.from({ length: 101 }, () => ({
        state: "hi",
        questions: { q: { type: "noul", instructions: "ok?" } },
      })),
    });
    assert.equal(over100.status, 400);

    // Both items and state
    const mixed = await postDecisions({
      state: "hi",
      items: [{ state: "hi", questions: { q: { type: "noul", instructions: "ok?" } } }],
    });
    assert.equal(mixed.status, 400);

    // maxUsd exceeded (402 spend_limit)
    const overMaxUsd = await postDecisions({
      state: "free nitro scam click here",
      questions: { spam: { type: "noul", instructions: "Is this spam?" } },
      maxUsd: 0.000001,
    });
    assert.equal(overMaxUsd.status, 402);
    assert.equal(overMaxUsd.json.error?.code, "spend_limit");
  }

  // 9. Verify usage settled on TenantDO
  {
    const billingRes = await worker.fetch(`${origin}/v2/billing`, {
      headers: { Authorization: `Bearer ${created.apiKey}` },
    });
    assert.equal(billingRes.status, 200);
    const billing = (await billingRes.json()) as { usage: Array<{ model: string; runsCount: number }> };
    const miniUsage = billing.usage.find((u) => u.model === "openai/gpt-4.1-mini");
    assert.ok(miniUsage && miniUsage.runsCount >= 4, "expected openai/gpt-4.1-mini decision usage recorded");
  }
});
