import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

const MAX_IMAGES_BASE64_BYTES = 20 * 1024 * 1024;

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG_SAMPLE = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

test("POST /v2/runs/text and /v2/runs support optional images and model with strict validation", async (t) => {
  const captured: Array<{ path: string; body: Record<string, unknown> }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    captured.push({ path: pathname, body });
    res.setHeader("Content-Type", "text/event-stream");
    if ((req.url ?? "").includes("/responses")) {
      const text = '{"seen":true}';
      res.end(
        `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}\n\n` +
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text })}\n\n` +
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}\n\n` +
        `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 120, output_tokens: 12, total_tokens: 132 } } })}\n\n`,
      );
      return;
    }
    if ((req.url ?? "").includes("/v1/messages")) {
      const text = "anthropic-saw-image";
      res.end(
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: String(body.model ?? ""), stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })}\n\n` +
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n` +
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );
      return;
    }
    res.end(
      `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "chat-saw-image" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    upstream.closeAllConnections();
    upstream.close();
  });
  const port = (upstream.address() as { port: number }).port;
  const mockUrl = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), "camelrun-text-runs-"));
  const config = join(dir, "wrangler.json");
  const adminKey = "fixture-text-runs-admin";
  writeFileSync(
    config,
    JSON.stringify({
      name: "text-runs-test",
      main: fileURLToPath(new URL("./fixtures/alarm-worker.ts", import.meta.url)),
      compatibility_date: "2026-03-01",
      compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
      vars: {
        ADMIN_SECRET: adminKey,
        VAULT_SECRET: "fixture-text-runs-vault-32-bytes!",
        DEFAULT_MODEL: "azure/gpt-6.1-terra",
        AZURE_OPENAI_SOL_ENDPOINT: mockUrl,
        AZURE_OPENAI_SOL_API_KEY: "fixture-azure-key",
        BUILDER_CUTOVER_CREDIT_TENANT_ID: "tnt_0000000000000001",
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
  const origin = "https://text-runs.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;

  const seed = await worker.fetch(`${origin}/test-text-tenant`, { method: "POST" });
  assert.equal(seed.status, 200);
  const { apiKey } = (await seed.json()) as { apiKey: string };

  const client = new CamelRun({ baseUrl: origin, apiKey, fetch: fetcher });
  await client.providers.set("openrouter", {
    apiKey: "sk-openrouter-test",
    baseUrl: `${mockUrl}/openrouter/v1`,
  });
  await client.providers.set("anthropic", {
    apiKey: "sk-anthropic-test",
    baseUrl: `${mockUrl}/anthropic`,
  });

  const postText = (body: Record<string, unknown>, key = crypto.randomUUID()) =>
    worker.fetch(`${origin}/v2/runs/text`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify(body),
    });

  await t.test("attaches images natively to default azure/gpt-6.1-terra Responses request", async () => {
    const before = captured.length;
    const res = await postText({
      input: "Describe these images",
      instructions: "Return JSON.",
      outputSchema: { type: "object", additionalProperties: true },
      timeoutMs: 5000,
      images: [
        { mediaType: "IMAGE/PNG", data: PNG_1X1 },
        { mediaType: "image/jpeg", data: JPEG_SAMPLE },
      ],
    });
    assert.equal(res.status, 200, await res.clone().text());
    const data = (await res.json()) as { status: string; output: unknown };
    assert.equal(data.status, "completed");
    assert.deepEqual(data.output, { seen: true });

    assert.equal(captured.length, before + 1);
    const req = captured[before]!;
    assert.equal(req.path, "/openai/v1/responses");
    assert.equal(req.body.model, "gpt-6.1-terra");
    assert.deepEqual(req.body.input, [
      { role: "developer", content: "Return JSON." },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe these images" },
          { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}`, detail: "auto" },
          { type: "input_image", image_url: `data:image/jpeg;base64,${JPEG_SAMPLE}`, detail: "auto" },
        ],
      },
    ]);
  });

  await t.test("supports optional model override across Responses, OpenAI Chat, and Anthropic", async () => {
    const start = captured.length;

    const solRes = await postText({
      input: "Check sol",
      timeoutMs: 5000,
      model: "azure/gpt-6.2-sol",
      images: [{ mediaType: "image/png", data: PNG_1X1 }],
    });
    assert.equal(solRes.status, 200, await solRes.clone().text());
    assert.equal(captured[start]!.path, "/openai/v1/responses");
    assert.equal(captured[start]!.body.model, "gpt-6.2-sol");

    const chatRes = await postText({
      input: "Check chat",
      timeoutMs: 5000,
      model: "openrouter/google/gemini-2.5-flash",
      images: [{ mediaType: "image/png", data: PNG_1X1 }],
    });
    assert.equal(chatRes.status, 200, await chatRes.clone().text());
    assert.equal(((await chatRes.json()) as { text: string }).text, "chat-saw-image");
    const chatReq = captured[start + 1]!;
    assert.equal(chatReq.path, "/openrouter/v1/chat/completions");
    assert.equal(chatReq.body.model, "google/gemini-2.5-flash");
    assert.deepEqual(chatReq.body.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "Check chat" },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_1X1}` } },
        ],
      },
    ]);

    const anthRes = await postText({
      input: "Check anthropic",
      timeoutMs: 5000,
      model: "anthropic/claude-sonnet-4-5",
      images: [{ mediaType: "image/png", data: PNG_1X1 }],
    });
    assert.equal(anthRes.status, 200, await anthRes.clone().text());
    assert.equal(((await anthRes.json()) as { text: string }).text, "anthropic-saw-image");
    const anthReq = captured[start + 2]!;
    assert.equal(anthReq.path, "/anthropic/v1/messages");
    assert.equal(anthReq.body.model, "claude-sonnet-4-5");
    assert.deepEqual(anthReq.body.messages, [
      {
        role: "user",
        content: [
          { type: "text", text: "Check anthropic" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: PNG_1X1 },
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  await t.test("preserves plain-string user content when images are omitted or empty", async () => {
    const start = captured.length;
    const omitted = await postText({ input: "Plain text", timeoutMs: 5000 });
    assert.equal(omitted.status, 200);
    assert.equal(captured[start]!.body.model, "gpt-6.1-terra");
    assert.deepEqual(captured[start]!.body.input, [{ role: "user", content: [{ type: "input_text", text: "Plain text" }] }]);

    const empty = await postText({ input: "Empty images", timeoutMs: 5000, images: [] });
    assert.equal(empty.status, 200);
    assert.deepEqual(captured[start + 1]!.body.input, [{ role: "user", content: [{ type: "input_text", text: "Empty images" }] }]);
  });

  await t.test("rejects invalid images and invalid model with 400 without consuming idempotency key", async () => {
    const before = captured.length;
    const reusableKey = crypto.randomUUID();
    const invalidBodies: Array<Record<string, unknown>> = [
      { input: "bad", timeoutMs: 5000, images: "not-an-array" },
      { input: "bad", timeoutMs: 5000, images: [{ mediaType: "application/pdf", data: PNG_1X1 }] },
      { input: "bad", timeoutMs: 5000, images: [{ mediaType: "image/", data: PNG_1X1 }] },
      { input: "bad", timeoutMs: 5000, images: [{ mediaType: "image/png", data: "" }] },
      { input: "bad", timeoutMs: 5000, images: [{ mediaType: "image/png", data: "not!base64!" }] },
      { input: "bad", timeoutMs: 5000, images: [{ mediaType: "image/png", data: "abc" }] },
      {
        input: "too many",
        timeoutMs: 5000,
        images: Array.from({ length: 9 }, () => ({ mediaType: "image/png", data: PNG_1X1 })),
      },
      {
        input: "too large",
        timeoutMs: 5000,
        images: [{ mediaType: "image/png", data: "A".repeat(MAX_IMAGES_BASE64_BYTES + 4) }],
      },
      { input: "bad model empty", timeoutMs: 5000, model: "   " },
      { input: "bad model type", timeoutMs: 5000, model: 123 },
    ];

    for (const body of invalidBodies) {
      const res = await postText(body, reusableKey);
      assert.equal(res.status, 400, `Expected 400 for ${JSON.stringify({ ...body, images: Array.isArray(body.images) ? `len=${body.images.length}` : body.images })}`);
    }
    assert.equal(captured.length, before, "invalid requests must not call upstream providers");

    // Reusing the same idempotency key on a valid request succeeds because invalid calls did not claim it.
    const valid = await postText({ input: "Valid after invalid", timeoutMs: 5000 }, reusableKey);
    assert.equal(valid.status, 200, await valid.clone().text());
    const dup = await postText({ input: "Valid after invalid", timeoutMs: 5000 }, reusableKey);
    assert.equal(dup.status, 409);
  });

  await t.test("POST /v2/runs also attaches validated images and rejects invalid images", async () => {
    const before = captured.length;
    const bad = await worker.fetch(`${origin}/v2/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ input: "Hello", images: [{ mediaType: "text/plain", data: PNG_1X1 }] }),
    });
    assert.equal(bad.status, 400);
    assert.equal(captured.length, before);

    const ok = await worker.fetch(`${origin}/v2/runs`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        input: "Stateless image",
        model: "azure/gpt-6.1-terra",
        images: [{ mediaType: "image/png", data: PNG_1X1 }],
      }),
    });
    assert.equal(ok.status, 200, await ok.clone().text());
    assert.equal(captured.length, before + 1);
    assert.deepEqual(captured[before]!.body.input, [
      {
        role: "user",
        content: [
          { type: "input_text", text: "Stateless image" },
          { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}`, detail: "auto" },
        ],
      },
    ]);
  });
});
