import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

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

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text?: unknown }).text ?? "") : ""))
      .join("\n");
  }
  return "";
}

interface CapturedRequest {
  isSummarization: boolean;
  totalChars: number;
  messages: Array<{ role: string; content: unknown }>;
}

async function startMockLlmServer() {
  const captured: CapturedRequest[] = [];
  let failSummarization = false;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    if (url.pathname !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end("not found");
      return;
    }

    const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
    const systemText = messages
      .filter((m) => m.role === "system")
      .map((m) => messageText(m.content))
      .join("\n");
    const isSummarization = systemText.includes("context summarization assistant");
    const totalChars = messages.reduce((sum, m) => sum + messageText(m.content).length, 0);

    captured.push({ isSummarization, totalChars, messages });

    if (isSummarization && failSummarization) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "Simulated compaction summarization failure", type: "invalid_request_error" },
        }),
      );
      return;
    }

    const lastText = messageText(messages.at(-1)?.content);
    const reply = isSummarization
      ? [
          "## Goal",
          "Continue user conversation concisely.",
          "## Progress",
          "### Done",
          "- [x] Processed earlier verbose history about ALPHA-MARKER-99.",
          "## Critical Context",
          "- Key token: ALPHA-MARKER-99",
        ].join("\n")
      : `Reply to: ${lastText.slice(0, 60)} (msgs=${messages.length}, chars=${totalChars})`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    const emit = (
      delta: Record<string, unknown>,
      finishReason: string | null = null,
      usage?: Record<string, number>,
    ) => {
      res.write(
        `data: ${JSON.stringify({
          id: `chatcmpl_${captured.length}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: body.model || "gpt-idle-test",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(usage ? { usage } : {}),
        })}\n\n`,
      );
    };
    emit({ role: "assistant", content: reply });
    emit({}, "stop", {
      prompt_tokens: Math.max(10, Math.ceil(totalChars / 4)),
      completion_tokens: Math.max(5, Math.ceil(reply.length / 4)),
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  return {
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    captured,
    setFailSummarization(val: boolean) {
      failSummarization = val;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("compactOnIdle: lazy on-resume stale-cache compaction, definition inheritance, guards, and failure isolation", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "camelrun-idle-compact-"));
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

  const llm = await startMockLlmServer();
  t.after(() => llm.close());

  const adminSecret = "idle-compact-admin";
  const vaultSecret = "idle-compact-vault-secret-32-bytes!!";

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
            CAMELFS_URL: { type: "text", value: "http://127.0.0.1:9" },
            CAMELFS_DEV_TOKEN: { type: "text", value: "dev-token" },
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

  // Bootstrap tenant + BYOK openai provider pointing at our local mock LLM server
  const createTenantRes = await mf.dispatchFetch("http://worker.test/v2/tenants", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Key": adminSecret },
    body: JSON.stringify({ name: "idle-compact-tenant", initialCreditsUsd: 25 }),
  });
  assert.equal(createTenantRes.status, 201);
  const tenant = (await createTenantRes.json()) as { apiKey: string };

  const api = async (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
    const res = await mf.dispatchFetch(`http://worker.test${path}`, {
      method: init?.method,
      body: init?.body,
      headers: {
        Authorization: `Bearer ${tenant.apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };

  const provRes = await api("/v2/providers/openai", {
    method: "PUT",
    body: JSON.stringify({
      apiKey: "sk-test-idle",
      baseUrl: llm.baseUrl,
      apiStyle: "openai-chat",
    }),
  });
  assert.equal(provRes.status, 200, JSON.stringify(provRes));

  // Large payload (~1,000 tokens = ~4,000 chars) to comfortably cross minTokens
  const largeTurn1Prompt =
    "ALPHA-MARKER-99 detailed architectural notes: " + "lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(80);
  const smallTurn2Prompt = "Keep this recent message short and verbatim: RECENT-TURN-2.";

  // =========================================================================
  // 1. Stale cache (idle >= idleSeconds, active >= minTokens) compacts BEFORE
  //    resumed turn, emits context_compacted(reason: "idle_resume"), and
  //    delivers compacted summary with far fewer input tokens.
  // =========================================================================
  await t.test("1. compacts on idle resume when idle >= idleSeconds and context >= minTokens, and does not re-compact when already compacted", async () => {
    const upsert = await api("/v2/agents/idle-trigger", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        instructions: "You are a helpful assistant.",
        compactOnIdle: {
          enabled: true,
          idleSeconds: 1,
          minTokens: 400,
          keepRecentTokens: 120,
        },
      }),
    });
    assert.equal(upsert.status, 201, JSON.stringify(upsert));

    // GET /v2/agents/:id exposes compactOnIdle
    const state = await api("/v2/agents/idle-trigger");
    assert.equal(state.status, 200);
    assert.deepEqual(state.json.compactOnIdle, {
      enabled: true,
      idleSeconds: 1,
      minTokens: 400,
      keepRecentTokens: 120,
    });

    const reqStart = llm.captured.length;

    const r1 = await api("/v2/agents/idle-trigger/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: largeTurn1Prompt, wait: true }),
    });
    assert.equal(r1.status, 200, JSON.stringify(r1));
    assert.equal(r1.json.status, "completed");

    const r2 = await api("/v2/agents/idle-trigger/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: smallTurn2Prompt, wait: true }),
    });
    assert.equal(r2.status, 200, JSON.stringify(r2));
    assert.equal(r2.json.status, "completed");

    // Turn 2 happened immediately (warm cache) -> NO summarization call yet
    const callsBeforeIdle = llm.captured.slice(reqStart);
    assert.equal(callsBeforeIdle.length, 2);
    assert.equal(callsBeforeIdle.some((c) => c.isSummarization), false);
    const turn2Chars = callsBeforeIdle[1]!.totalChars;
    assert.ok(turn2Chars > 4000, `Expected Turn 2 to include full Turn 1 payload, got ${turn2Chars}`);

    // Wait past idleSeconds (1s) so prompt cache is considered cold
    await sleep(1150);

    const beforeTurn3Idx = llm.captured.length;
    const r3 = await api("/v2/agents/idle-trigger/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Turn 3 after idle gap.", wait: true }),
    });
    assert.equal(r3.status, 200, JSON.stringify(r3));
    assert.equal(r3.json.status, "completed");

    const turn3Calls = llm.captured.slice(beforeTurn3Idx);
    assert.equal(
      turn3Calls.length,
      2,
      `Expected [summarization, resumedTurn] = 2 LLM calls, got ${turn3Calls.length}`,
    );
    assert.equal(turn3Calls[0]!.isSummarization, true, "First LLM call on idle resume must be compaction summarization");
    assert.equal(turn3Calls[1]!.isSummarization, false, "Second LLM call must be the resumed user turn");

    // Resumed turn receives the compacted summary and far fewer chars/tokens than before compaction!
    const turn3Payload = turn3Calls[1]!.messages.map((m) => messageText(m.content)).join("\n");
    assert.ok(turn3Payload.includes("<summary>"), `Expected compacted <summary> in Turn 3 request: ${turn3Payload.slice(0, 400)}`);
    assert.ok(turn3Payload.includes("ALPHA-MARKER-99"), "Expected preserved summary context in Turn 3 request");
    assert.ok(turn3Payload.includes("RECENT-TURN-2"), "Expected recent turn kept verbatim in Turn 3 request");
    assert.ok(
      turn3Calls[1]!.totalChars < turn2Chars * 0.5,
      `Expected Turn 3 input (${turn3Calls[1]!.totalChars} chars) to be much smaller than Turn 2 (${turn2Chars} chars)`,
    );

    // Exactly one context_compacted event with reason: "idle_resume"
    const eventsRes = await api("/v2/agents/idle-trigger/events?after=0");
    assert.equal(eventsRes.status, 200);
    const compactedEvents = (eventsRes.json.events as Array<{ type: string; data: Record<string, unknown> }>).filter(
      (e) => e.type === "context_compacted",
    );
    assert.equal(compactedEvents.length, 1, `Expected exactly 1 context_compacted event: ${JSON.stringify(compactedEvents)}`);
    assert.equal(compactedEvents[0]!.data.reason, "idle_resume");
    assert.ok(Number(compactedEvents[0]!.data.compactedCount) > 0);
    assert.ok(Number(compactedEvents[0]!.data.upToSeq) > 0);
    assert.ok(Number(compactedEvents[0]!.data.idleSeconds) >= 1);

    // Now wait past idleSeconds AGAIN without adding >= minTokens of new context ->
    // already-compacted history must NOT trigger another compaction!
    await sleep(1150);
    const beforeTurn4Idx = llm.captured.length;
    const r4 = await api("/v2/agents/idle-trigger/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Turn 4 short follow-up after already-compacted idle.", wait: true }),
    });
    assert.equal(r4.status, 200);
    assert.equal(r4.json.status, "completed");

    const turn4Calls = llm.captured.slice(beforeTurn4Idx);
    assert.equal(
      turn4Calls.length,
      1,
      `Expected NO re-compaction when post-compaction active context < minTokens, got ${turn4Calls.length} calls`,
    );
    assert.equal(turn4Calls[0]!.isSummarization, false);
  });

  // =========================================================================
  // 2. Resuming before idleSeconds (warm cache) does NOT compact
  // =========================================================================
  await t.test("2. does NOT compact when resumed before idleSeconds (prompt cache still warm)", async () => {
    const upsert = await api("/v2/agents/warm-cache", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: {
          enabled: true,
          idleSeconds: 600,
          minTokens: 200,
          keepRecentTokens: 50,
        },
      }),
    });
    assert.equal(upsert.status, 201);

    const startIdx = llm.captured.length;
    const r1 = await api("/v2/agents/warm-cache/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: largeTurn1Prompt, wait: true }),
    });
    assert.equal(r1.json.status, "completed");

    const r2 = await api("/v2/agents/warm-cache/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Warm follow-up right away.", wait: true }),
    });
    assert.equal(r2.json.status, "completed");

    const calls = llm.captured.slice(startIdx);
    assert.equal(calls.length, 2);
    assert.equal(calls.some((c) => c.isSummarization), false);

    const eventsRes = await api("/v2/agents/warm-cache/events?after=0");
    const compacted = (eventsRes.json.events as Array<{ type: string }>).filter(
      (e) => e.type === "context_compacted",
    );
    assert.equal(compacted.length, 0);
  });

  // =========================================================================
  // 3. Resuming after idleSeconds with active context < minTokens does NOT compact
  // =========================================================================
  await t.test("3. does NOT compact after idleSeconds when active context < minTokens", async () => {
    const upsert = await api("/v2/agents/small-context", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: {
          enabled: true,
          idleSeconds: 1,
          minTokens: 5_000,
          keepRecentTokens: 100,
        },
      }),
    });
    assert.equal(upsert.status, 201);

    const startIdx = llm.captured.length;
    await api("/v2/agents/small-context/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Tiny message 1", wait: true }),
    });
    await api("/v2/agents/small-context/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Tiny message 2", wait: true }),
    });

    await sleep(1150);

    const r3 = await api("/v2/agents/small-context/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Tiny message 3 after idle", wait: true }),
    });
    assert.equal(r3.json.status, "completed");

    const calls = llm.captured.slice(startIdx);
    assert.equal(calls.length, 3);
    assert.equal(calls.some((c) => c.isSummarization), false);
  });

  // =========================================================================
  // 4. Definition-level compactOnIdle inheritance, overrides, null/disabled,
  //    and input validation
  // =========================================================================
  await t.test("4. definition-level compactOnIdle is inherited, overridable, disableable, and validated", async () => {
    // Validation errors on definition & agent
    const badDef = await api("/v2/definitions/bad-idle", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: { enabled: true, idleSeconds: 0 },
      }),
    });
    assert.equal(badDef.status, 400, JSON.stringify(badDef));

    const badAgentMin = await api("/v2/agents/bad-idle-agent", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: { enabled: true, idleSeconds: 10, minTokens: -1 },
      }),
    });
    assert.equal(badAgentMin.status, 400, JSON.stringify(badAgentMin));

    const badAgentKeep = await api("/v2/agents/bad-idle-agent-2", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: { enabled: true, idleSeconds: 10, keepRecentTokens: -5 },
      }),
    });
    assert.equal(badAgentKeep.status, 400, JSON.stringify(badAgentKeep));

    // Create valid definition with compactOnIdle
    const defPut = await api("/v2/definitions/idle-def", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        instructions: "Definition instructions",
        compactOnIdle: {
          enabled: true,
          idleSeconds: 1,
          minTokens: 400,
          keepRecentTokens: 120,
        },
      }),
    });
    assert.equal(defPut.status, 200, JSON.stringify(defPut));

    const defGet = await api("/v2/definitions/idle-def");
    assert.equal(defGet.status, 200);
    assert.deepEqual(defGet.json.config.compactOnIdle, {
      enabled: true,
      idleSeconds: 1,
      minTokens: 400,
      keepRecentTokens: 120,
    });

    // 4a. Agent inheriting compactOnIdle from definition
    const inheritedUpsert = await api("/v2/agents/from-idle-def", {
      method: "PUT",
      body: JSON.stringify({ definition: "idle-def" }),
    });
    assert.equal(inheritedUpsert.status, 201, JSON.stringify(inheritedUpsert));
    const inheritedState = await api("/v2/agents/from-idle-def");
    assert.deepEqual(inheritedState.json.compactOnIdle, {
      enabled: true,
      idleSeconds: 1,
      minTokens: 400,
      keepRecentTokens: 120,
    });

    // Verify inherited config actually triggers compaction on idle resume!
    await api("/v2/agents/from-idle-def/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: largeTurn1Prompt, wait: true }),
    });
    await api("/v2/agents/from-idle-def/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: smallTurn2Prompt, wait: true }),
    });
    await sleep(1150);
    const beforeDefResume = llm.captured.length;
    const defResume = await api("/v2/agents/from-idle-def/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Resume inherited agent", wait: true }),
    });
    assert.equal(defResume.json.status, "completed");
    assert.equal(llm.captured[beforeDefResume]?.isSummarization, true);

    // 4b. Agent overriding definition's compactOnIdle
    const overrideUpsert = await api("/v2/agents/override-idle-def", {
      method: "PUT",
      body: JSON.stringify({
        definition: "idle-def",
        compactOnIdle: { enabled: true, idleSeconds: 900, minTokens: 25_000, keepRecentTokens: 5_000 },
      }),
    });
    assert.equal(overrideUpsert.status, 201);
    const overrideState = await api("/v2/agents/override-idle-def");
    assert.deepEqual(overrideState.json.compactOnIdle, {
      enabled: true,
      idleSeconds: 900,
      minTokens: 25_000,
      keepRecentTokens: 5_000,
    });

    // 4c. Agent disabling definition's compactOnIdle via null
    const nullUpsert = await api("/v2/agents/disable-null-def", {
      method: "PUT",
      body: JSON.stringify({
        definition: "idle-def",
        compactOnIdle: null,
      }),
    });
    assert.equal(nullUpsert.status, 201);
    const nullState = await api("/v2/agents/disable-null-def");
    assert.equal(nullState.json.compactOnIdle, undefined);

    // 4d. Agent disabling via { enabled: false }
    const falseUpsert = await api("/v2/agents/disable-false-def", {
      method: "PUT",
      body: JSON.stringify({
        definition: "idle-def",
        compactOnIdle: { enabled: false, idleSeconds: 1, minTokens: 100 },
      }),
    });
    assert.equal(falseUpsert.status, 201);
    const falseState = await api("/v2/agents/disable-false-def");
    assert.deepEqual(falseState.json.compactOnIdle, {
      enabled: false,
      idleSeconds: 1,
      minTokens: 100,
    });
  });

  // =========================================================================
  // 5. Failure isolation: compaction error NEVER blocks or fails resumed run
  // =========================================================================
  await t.test("5. compaction failure is isolated and resumed run still succeeds cleanly", async () => {
    const upsert = await api("/v2/agents/idle-failure-isolated", {
      method: "PUT",
      body: JSON.stringify({
        model: "openai/gpt-idle-test",
        compactOnIdle: {
          enabled: true,
          idleSeconds: 1,
          minTokens: 400,
          keepRecentTokens: 120,
        },
      }),
    });
    assert.equal(upsert.status, 201);

    await api("/v2/agents/idle-failure-isolated/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: largeTurn1Prompt, wait: true }),
    });
    await api("/v2/agents/idle-failure-isolated/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: smallTurn2Prompt, wait: true }),
    });

    await sleep(1150);

    llm.setFailSummarization(true);
    const beforeIdx = llm.captured.length;
    try {
      const resumed = await api("/v2/agents/idle-failure-isolated/runs", {
        method: "POST",
        body: JSON.stringify({ prompt: "User turn must still succeed even if compaction fails!", wait: true }),
      });
      assert.equal(resumed.status, 200, JSON.stringify(resumed));
      assert.equal(resumed.json.status, "completed", JSON.stringify(resumed.json));
      assert.ok(
        String(resumed.json.text).includes("User turn must still succeed"),
        `Expected normal assistant reply despite compaction failure: ${resumed.json.text}`,
      );
    } finally {
      llm.setFailSummarization(false);
    }

    const calls = llm.captured.slice(beforeIdx);
    assert.equal(calls.length, 2, `Expected failed summarization + succeeded user turn, got ${calls.length}`);
    assert.equal(calls[0]!.isSummarization, true);
    assert.equal(calls[1]!.isSummarization, false);

    // No context_compacted event emitted when compaction failed
    const eventsRes = await api("/v2/agents/idle-failure-isolated/events?after=0");
    const compacted = (eventsRes.json.events as Array<{ type: string }>).filter(
      (e) => e.type === "context_compacted",
    );
    assert.equal(compacted.length, 0);
  });
});
