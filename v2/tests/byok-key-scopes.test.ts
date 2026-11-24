import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { unstable_startWorker } from "wrangler";
import { CamelRun } from "../sdk/src/index.ts";

test("v2 BYOK key scopes, header-only AI Gateway, custom apiStyle, and openai-codex end-to-end", async (t) => {
  const captured: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
  const upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const rawBuf = Buffer.concat(chunks);
      const enc = String(req.headers["content-encoding"] ?? "").toLowerCase();
      const decoded =
        enc === "zstd" ? zstdDecompressSync(rawBuf) : enc === "gzip" ? gunzipSync(rawBuf) : rawBuf;
      const body = JSON.parse(decoded.toString("utf8") || "{}") as Record<string, unknown>;
      captured.push({ url: req.url ?? "", headers: req.headers, body });
      res.setHeader("Content-Type", "text/event-stream");
      if ((req.url ?? "").includes("/responses")) {
        const text = `ok:${req.url}`;
        res.end(
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } })}\n\n` +
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text })}\n\n` +
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text }] } })}\n\n` +
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } })}\n\n`,
        );
      } else if ((req.url ?? "").includes("/v1/messages")) {
        const text = `ok-anthropic:${body.model}`;
        res.end(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", content: [], model: String(body.model ?? ""), stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n` +
          `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n` +
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n` +
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n` +
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n` +
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        );
      } else {
        const text = `ok-chat:${body.model}`;
        res.end(
          `data: ${JSON.stringify({ id: "chatcmpl_1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`,
        );
      }
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => upstream.close());
  const port = (upstream.address() as { port: number }).port;
  const upstreamBase = `http://127.0.0.1:${port}`;

  const dir = mkdtempSync(join(tmpdir(), "v2-byok-scopes-"));
  const config = join(dir, "wrangler.json");
  const admin = "fixture-byok-admin";
  writeFileSync(config, JSON.stringify({
    name: "v2-byok-scopes-test",
    main: fileURLToPath(new URL("../worker/src/index.ts", import.meta.url)),
    compatibility_date: "2026-03-01",
    compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
    vars: {
      ADMIN_SECRET: admin,
      VAULT_SECRET: "fixture-byok-vault-32-bytes-minimum",
      DEFAULT_MODEL: "mock/default",
      ANTHROPIC_API_KEY: "env-anthropic-should-not-leak",
    },
    durable_objects: { bindings: [{ name: "TENANT_DO", class_name: "TenantDO" }, { name: "AGENT_DO", class_name: "AgentDO" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] }],
  }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const worker = await unstable_startWorker({ config, dev: { persist: false, logLevel: "none" } });
  t.after(() => worker.dispose());
  const origin = "https://byok.test";
  const fetcher = worker.fetch.bind(worker) as unknown as typeof fetch;
  const tenant = await CamelRun.createTenant({ baseUrl: origin, fetch: fetcher, adminKey: admin, name: "byok-tenant", initialCreditsUsd: 5 });

  const req = (path: string, method = "GET", body?: unknown) =>
    worker.fetch(origin + path, {
      method,
      headers: {
        Authorization: `Bearer ${tenant.apiKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10_000),
    });

  // 1. Hosted AI Gateway scope (empty apiKey, auth via cf-aig-authorization header)
  const rHosted = await req("/v2/key-scopes/hosted/providers/openrouter", "PUT", {
    apiKey: "",
    baseUrl: `${upstreamBase}/gw/openrouter/v1`,
    headers: { "cf-aig-authorization": "Bearer cf-gw-secret", "HTTP-Referer": "https://camelai.dev" },
  });
  assert.equal(rHosted.status, 200);

  // 2. Org A BYOK Anthropic + custom Responses provider
  assert.equal((await req("/v2/key-scopes/org_a/providers/anthropic", "PUT", {
    apiKey: "sk-ant-org-a",
    baseUrl: `${upstreamBase}/ant`,
  })).status, 200);

  assert.equal((await req("/v2/key-scopes/org_a/providers/custom", "PUT", {
    apiKey: "sk-custom-a",
    baseUrl: `${upstreamBase}/custom/v1`,
    apiStyle: "openai-responses",
    headers: { "x-custom-org": "org_a" },
  })).status, 200);

  // 3. Org Codex with JWT carrying chatgpt_account_id
  const jwtPayload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_codex_42" },
  })).toString("base64url");
  const fakeJwt = `eyJhbGciOiJSUzI1NiJ9.${jwtPayload}.sig`;
  assert.equal((await req("/v2/key-scopes/org_codex/providers/openai-codex", "PUT", {
    apiKey: fakeJwt,
    baseUrl: `${upstreamBase}/backend-api`,
    headers: { "x-codex-proxy": "proxy-ok" },
  })).status, 200);

  // Verify listProviders for org_a
  const listRes = await req("/v2/key-scopes/org_a/providers");
  assert.equal(listRes.status, 200);
  const listed = (await listRes.json()) as { scope: string; providers: Array<{ provider: string; apiStyle: string | null }> };
  assert.equal(listed.scope, "org_a");
  assert.deepEqual(listed.providers.map((p) => p.provider), ["anthropic", "custom"]);
  assert.equal(listed.providers.find((p) => p.provider === "custom")?.apiStyle, "openai-responses");

  // Run 1: Hosted AI Gateway (empty apiKey, custom header sent, NO Authorization header)
  const a1 = await (await req("/v2/agents/hosted-agent", "PUT", {
    model: "openrouter/openai/gpt-6-luna",
    keyScope: "hosted",
    builtins: [],
  })).json() as { id: string };
  const run1 = await (await req(`/v2/agents/${a1.id}/runs`, "POST", { prompt: "hello", wait: true })).json() as { status: string; text: string };
  assert.equal(run1.status, "completed");
  assert.equal(run1.text, "ok-chat:openai/gpt-6-luna");
  assert.equal(captured.at(-1)?.headers["cf-aig-authorization"], "Bearer cf-gw-secret");
  assert.equal(captured.at(-1)?.headers.authorization, undefined);

  // Run 2: Org A BYOK Anthropic
  const a2 = await (await req("/v2/agents/org-a-agent", "PUT", {
    model: "anthropic/claude-sonnet-4",
    keyScope: "org_a",
    builtins: [],
  })).json() as { id: string };
  const run2 = await (await req(`/v2/agents/${a2.id}/runs`, "POST", { prompt: "hi", wait: true })).json() as { status: string; text: string };
  assert.equal(run2.status, "completed");
  assert.equal(run2.text, "ok-anthropic:claude-sonnet-4");
  assert.equal(captured.at(-1)?.headers["x-api-key"], "sk-ant-org-a");

  // Run 3: Org B (no key in org_b scope) MUST NOT fall back to env.ANTHROPIC_API_KEY
  const a3 = await (await req("/v2/agents/org-b-agent", "PUT", {
    model: "anthropic/claude-sonnet-4",
    keyScope: "org_b",
    builtins: [],
  })).json() as { id: string };
  const run3 = await (await req(`/v2/agents/${a3.id}/runs`, "POST", { prompt: "hi", wait: true })).json() as { status: string; error: { code: string } | null };
  assert.equal(run3.status, "failed");
  assert.equal(run3.error?.code, "missing_provider_key");

  // Run 4: Switch org-a-agent model to custom/my-llm (apiStyle: openai-responses) via PATCH /model
  const patchRes = await req(`/v2/agents/${a2.id}/model`, "PATCH", {
    model: "custom/my-llm",
    expectedModel: "anthropic/claude-sonnet-4",
    keyScope: "org_a",
  });
  assert.equal(patchRes.status, 200);
  const run4 = await (await req(`/v2/agents/${a2.id}/runs`, "POST", { prompt: "hi", wait: true })).json() as { status: string; text: string };
  assert.equal(run4.status, "completed");
  assert.equal(run4.text, "ok:/custom/v1/responses");
  assert.equal(captured.at(-1)?.headers["x-custom-org"], "org_a");

  // Run 5: openai-codex via /codex/responses with decoded chatgpt-account-id
  const a5 = await (await req("/v2/agents/codex-agent", "PUT", {
    model: "openai-codex/gpt-5.4-codex",
    keyScope: "org_codex",
    builtins: [],
  })).json() as { id: string };
  const run5 = await (await req(`/v2/agents/${a5.id}/runs`, "POST", { prompt: "code", wait: true })).json() as { status: string; text: string };
  assert.equal(run5.status, "completed");
  assert.equal(run5.text, "ok:/backend-api/codex/responses");
  assert.equal(captured.at(-1)?.headers["chatgpt-account-id"], "acct_codex_42");
  assert.equal(captured.at(-1)?.headers["openai-beta"], "responses=experimental");
  assert.ok(
    captured.at(-1)?.headers.originator === "pi" || captured.at(-1)?.headers.originator === "codex_cli_rs",
  );
  assert.equal(captured.at(-1)?.headers["x-codex-proxy"], "proxy-ok");
  assert.equal(captured.at(-1)?.body.store, false);
});
