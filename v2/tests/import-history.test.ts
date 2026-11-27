import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { CamelRun } from "../sdk/src/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function loadDirModules(dir: string) {
  const modules: Record<
    string,
    { type: "esm" | "wasm" | "data"; contents: string | Uint8Array<ArrayBuffer> }
  > = {};
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith(".map") || entry === "README.md") continue;
    const full = join(dir, entry);
    if (entry.endsWith(".wasm")) {
      const buf = readFileSync(full);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      modules[entry] = { type: "wasm", contents: new Uint8Array(ab) };
    } else if (entry.endsWith(".js") || entry.endsWith(".mjs")) {
      modules[entry] = { type: "esm", contents: readFileSync(full, "utf8") };
    }
  }
  return modules;
}

test("POST /v2/agents/:idOrKey/import-history seeds v1 chunks, preserves meta.v1, stays idempotent, and appends existing v2 turns", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "camelrun-import-history-"));
  const workerOut = join(tmpDir, "worker");
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const envVars = {
    ...process.env,
    XDG_CONFIG_HOME: "/tmp/xdg",
    WRANGLER_LOG_PATH: join(ROOT, ".wrangler/logs"),
  };

  execFileSync(
    "npx",
    ["wrangler", "deploy", "--dry-run", "-c", "worker/wrangler.jsonc", "--outdir", workerOut],
    { cwd: ROOT, env: envVars, stdio: "pipe" },
  );

  const adminSecret = "import-admin-secret";
  const vaultSecret = "import-vault-secret-32-bytes-minimum!!";

  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "camelrun-worker-v2",
          compatibilityDate: "2026-03-24",
          compatibilityFlags: ["nodejs_compat", "enhanced_error_serialization"],
          manifest: {
            mainModule: "index.js",
            modules: loadDirModules(workerOut),
          },
          exports: {
            TenantDO: { type: "durable-object", storage: "sqlite" },
            AgentDO: { type: "durable-object", storage: "sqlite" },
            VoiceCallDO: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            ADMIN_SECRET: { type: "text", value: adminSecret },
            VAULT_SECRET: { type: "text", value: vaultSecret },
            DEFAULT_MODEL: { type: "text", value: "mock/default" },
            TENANT_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "TenantDO" },
            AGENT_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "AgentDO" },
            VOICE_CALL_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "VoiceCallDO" },
          },
        },
      },
    ],
  });
  t.after(() => mf.dispose());

  const origin = "https://import-history.test";
  const fetcher: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return mf.dispatchFetch(url, init as never) as unknown as Promise<Response>;
  };

  const tenant = await CamelRun.createTenant({
    baseUrl: origin,
    fetch: fetcher,
    adminKey: adminSecret,
    name: "import-tenant",
    initialCreditsUsd: 5,
  });

  const headers = {
    authorization: `Bearer ${tenant.apiKey}`,
    "content-type": "application/json",
  };

  // 1. Create an existing post-cutover agent with 1 live turn (e.g. user asked "summarize so far")
  const existingRes = await fetcher(`${origin}/v2/agents/builder-old`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "mock/default", instructions: "You are a helper." }),
  });
  assert.equal(existingRes.status, 201);
  const existingAgent = (await existingRes.json()) as { id: string };

  const liveRunRes = await fetcher(`${origin}/v2/agents/${existingAgent.id}/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "Summarize the conversation so far", wait: true }),
  });
  assert.equal(liveRunRes.status, 200);

  // 2. Provision restored agent and import chunk 1 (user + assistant toolCall + toolResult + assistant)
  const targetRes = await fetcher(`${origin}/v2/agents/builder-restored`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ model: "mock/default", instructions: "You are a helper." }),
  });
  assert.equal(targetRes.status, 201);
  const targetAgent = (await targetRes.json()) as { id: string };

  const v1User = { role: "user", content: [{ type: "text", text: "Build me a reminder bot" }], timestamp: 1_700_000_001_000 };
  const v1AssistantCall = {
    role: "assistant",
    content: [{ type: "toolCall", id: "toolu_1", name: "bot__open_bot", arguments: { id: "bot_1" } }],
    timestamp: 1_700_000_002_000,
  };
  const v1ToolRes = {
    role: "toolResult",
    toolCallId: "toolu_1",
    toolName: "bot__open_bot",
    content: [{ type: "text", text: '{"ok":true}' }],
    isError: false,
    timestamp: 1_700_000_003_000,
  };
  const v1AssistantReply = {
    role: "assistant",
    content: [{ type: "text", text: "Opened your bot!" }],
    timestamp: 1_700_000_004_000,
  };

  const chunk1 = [
    { seq: 1, runId: "req_1", role: "user", content: { text: "Build me a reminder bot", meta: { v1: v1User } }, tokensEst: 6, createdAt: v1User.timestamp },
    {
      seq: 2,
      runId: "req_1",
      role: "assistant",
      content: {
        toolCalls: [{ id: "toolu_1", name: "bot__open_bot", argumentsJson: '{"id":"bot_1"}', args: { id: "bot_1" } }],
        meta: { v1: v1AssistantCall },
      },
      tokensEst: 10,
      createdAt: v1AssistantCall.timestamp,
    },
    {
      seq: 3,
      runId: null,
      role: "tool",
      content: { toolCallId: "toolu_1", toolName: "bot__open_bot", text: '{"ok":true}', isError: false, meta: { v1: v1ToolRes } },
      tokensEst: 5,
      createdAt: v1ToolRes.timestamp,
    },
    {
      seq: 4,
      runId: "req_1",
      role: "assistant",
      content: { text: "Opened your bot!", meta: { v1: v1AssistantReply } },
      tokensEst: 5,
      createdAt: v1AssistantReply.timestamp,
    },
  ];

  const import1Res = await fetcher(`${origin}/v2/agents/${targetAgent.id}/import-history`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: chunk1, append: false }),
  });
  assert.equal(import1Res.status, 200);
  const import1 = (await import1Res.json()) as { imported: number; alreadyImported: boolean; messageCount: number };
  assert.equal(import1.alreadyImported, false);
  assert.equal(import1.imported, 4);
  assert.equal(import1.messageCount, 4);

  // 3. Idempotent retry without append=true must NOT duplicate
  const retryRes = await fetcher(`${origin}/v2/agents/${targetAgent.id}/import-history`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: chunk1, append: false }),
  });
  assert.equal(retryRes.status, 200);
  const retry = (await retryRes.json()) as { imported: number; alreadyImported: boolean; messageCount: number };
  assert.equal(retry.alreadyImported, true);
  assert.equal(retry.imported, 0);
  assert.equal(retry.messageCount, 4);

  // 4. Append chunk 2 + append existing post-cutover v2 turns from builder-old
  const chunk2 = [
    { seq: 5, runId: "req_2", role: "user", content: { text: "Add /remind command" }, tokensEst: 5, createdAt: 1_700_000_010_000 },
    { seq: 6, runId: "req_2", role: "assistant", content: { text: "Added /remind!" }, tokensEst: 4, createdAt: 1_700_000_011_000 },
  ];
  const import2Res = await fetcher(`${origin}/v2/agents/${targetAgent.id}/import-history`, {
    method: "POST",
    headers,
    body: JSON.stringify({ messages: chunk2, append: true, appendFromAgentId: existingAgent.id }),
  });
  assert.equal(import2Res.status, 200);
  const import2 = (await import2Res.json()) as { imported: number; appendedFromSource: number; messageCount: number };
  assert.equal(import2.imported, 2);
  assert.equal(import2.appendedFromSource, 2);
  assert.equal(import2.messageCount, 8);

  // 5. Verify full chronological history and meta.v1 preservation
  const histRes = await fetcher(`${origin}/v2/agents/${targetAgent.id}/history?after=0&limit=50`, { headers });
  assert.equal(histRes.status, 200);
  const hist = (await histRes.json()) as {
    messages: Array<{ role: string; content: { text?: string; meta?: { v1?: unknown }; toolCalls?: unknown[]; toolCallId?: string } }>;
  };
  assert.equal(hist.messages.length, 8);
  assert.equal(hist.messages[0]!.role, "user");
  assert.deepEqual(hist.messages[0]!.content.meta?.v1, v1User);
  assert.equal(hist.messages[1]!.role, "assistant");
  assert.equal(hist.messages[1]!.content.toolCalls?.length, 1);
  assert.deepEqual(hist.messages[1]!.content.meta?.v1, v1AssistantCall);
  assert.equal(hist.messages[2]!.role, "tool");
  assert.equal(hist.messages[2]!.content.toolCallId, "toolu_1");
  assert.deepEqual(hist.messages[2]!.content.meta?.v1, v1ToolRes);
  assert.equal(hist.messages[3]!.content.text, "Opened your bot!");
  assert.equal(hist.messages[4]!.content.text, "Add /remind command");
  assert.equal(hist.messages[5]!.content.text, "Added /remind!");
  assert.equal(hist.messages[6]!.role, "user");
  assert.equal(hist.messages[6]!.content.text, "Summarize the conversation so far");
  assert.equal(hist.messages[7]!.role, "assistant");

  // 6. Verify a follow-up live run works cleanly on the restored conversation
  const nextRunRes = await fetcher(`${origin}/v2/agents/${targetAgent.id}/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "What did we build?", wait: true }),
  });
  assert.equal(nextRunRes.status, 200);
  const nextRun = (await nextRunRes.json()) as { status: string };
  assert.equal(nextRun.status, "completed");
});
