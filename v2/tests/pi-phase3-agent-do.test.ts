import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
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

/**
 * Lightweight in-process HTTP mock for CamelFS (`camelfsd`), webhook custom tools,
 * and an OpenAI-compatible Chat Completions LLM server (for inspecting exact prompts
 * sent across legacy -> pi history migration!).
 */
interface MockServers {
  camelfsUrl: string;
  webhookBaseUrl: string;
  llmBaseUrl: string;
  filesByLineage: Map<string, Map<string, string>>;
  webhookCalls: Array<{ path: string; body: Record<string, unknown> }>;
  capturedLlmRequests: Array<{
    messages: Array<{ role: string; content: unknown; tool_call_id?: string; tool_calls?: unknown[] }>;
    tools?: unknown[];
  }>;
  close: () => Promise<void>;
}

async function startMockServers(): Promise<MockServers> {
  const filesByLineage = new Map<string, Map<string, string>>();
  let lineageSeq = 0;
  let commitSeq = 0;
  const webhookCalls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const capturedLlmRequests: MockServers["capturedLlmRequests"] = [];

  const readJsonBody = async (req: import("node:http").IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  };

  // 1. Mock CamelFS server
  const camelfsServer: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const method = req.method || "GET";
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === "/healthz") {
      return send(200, { ok: true });
    }
    if (method === "POST" && url.pathname === "/v1/lineages") {
      const body = await readJsonBody(req);
      const lineage = (typeof body.lineage === "string" && body.lineage) || `lin_${++lineageSeq}`;
      if (!filesByLineage.has(lineage)) filesByLineage.set(lineage, new Map());
      return send(200, {
        lineage,
        defaultRef: "refs/heads/main",
        commit: `c_${++commitSeq}`,
        tree: `t_${commitSeq}`,
      });
    }
    const forkMatch = /^\/v1\/lineages\/([^/]+)\/fork$/.exec(url.pathname);
    if (method === "POST" && forkMatch) {
      const src = decodeURIComponent(forkMatch[1]!);
      const dst = `lin_${++lineageSeq}`;
      const srcFiles = filesByLineage.get(src) ?? new Map<string, string>();
      filesByLineage.set(dst, new Map(srcFiles));
      return send(200, {
        lineage: dst,
        ref: "refs/heads/main",
        commit: `c_${++commitSeq}`,
        tree: `t_${commitSeq}`,
      });
    }
    const writeMatch = /^\/v1\/lineages\/([^/]+)\/write$/.exec(url.pathname);
    if (method === "POST" && writeMatch) {
      const lineage = decodeURIComponent(writeMatch[1]!);
      const files = filesByLineage.get(lineage) ?? new Map<string, string>();
      filesByLineage.set(lineage, files);
      const body = await readJsonBody(req);
      const changed: string[] = [];
      for (const put of (body.puts as Array<{ path: string; content?: string; base64?: string }>) ?? []) {
        const clean = put.path.replace(/^\/+/, "");
        const content =
          put.content !== undefined
            ? put.content
            : put.base64 !== undefined
              ? Buffer.from(put.base64, "base64").toString("utf8")
              : "";
        files.set(clean, content);
        changed.push(clean);
      }
      for (const del of (body.deletes as string[]) ?? []) {
        const clean = del.replace(/^\/+/, "");
        files.delete(clean);
        changed.push(clean);
      }
      return send(200, {
        commit: `c_${++commitSeq}`,
        tree: `t_${commitSeq}`,
        changed,
        totalBytes: 0,
      });
    }
    const readMatch = /^\/v1\/lineages\/([^/]+)\/(?:read|file)$/.exec(url.pathname);
    if (method === "GET" && readMatch) {
      const lineage = decodeURIComponent(readMatch[1]!);
      const path = (url.searchParams.get("path") || "").replace(/^\/+/, "");
      const files = filesByLineage.get(lineage);
      if (!files || !files.has(path)) {
        return send(404, { error: { code: "not_found", message: `File '${path}' not found` } });
      }
      const content = files.get(path)!;
      return send(200, {
        commit: `c_${commitSeq}`,
        path,
        size: Buffer.byteLength(content, "utf8"),
        mode: 0o644,
        binary: false,
        content,
        base64: Buffer.from(content, "utf8").toString("base64"),
      });
    }
    const lsMatch = /^\/v1\/lineages\/([^/]+)\/ls$/.exec(url.pathname);
    if (method === "GET" && lsMatch) {
      const lineage = decodeURIComponent(lsMatch[1]!);
      const prefix = (url.searchParams.get("path") || "").replace(/^\/+|\/+$/g, "");
      const files = filesByLineage.get(lineage) ?? new Map<string, string>();
      const entries: Array<Record<string, unknown>> = [];
      for (const [p, content] of files.entries()) {
        if (prefix && p !== prefix && !p.startsWith(`${prefix}/`)) continue;
        entries.push({
          path: p,
          type: "file",
          size: Buffer.byteLength(content, "utf8"),
          mode: 0o644,
          hash: "blob",
        });
      }
      return send(200, { commit: `c_${commitSeq}`, entries });
    }
    return send(404, { error: { code: "not_found", message: `Unknown camelfs route ${method} ${url.pathname}` } });
  });

  // 2. Mock Webhook Tools + OpenAI-Compatible Streaming LLM server
  const auxServer: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const body = await readJsonBody(req);

    if (url.pathname.startsWith("/tools/")) {
      webhookCalls.push({ path: url.pathname, body });
      const args = (body.args ?? {}) as Record<string, unknown>;
      if (url.pathname === "/tools/calc_double") {
        const n = Number(args.n ?? 0);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ doubled: n * 2 }));
        return;
      }
      if (url.pathname === "/tools/secret_action") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ executed: true, target: args.target ?? "unknown" }));
        return;
      }
      if (url.pathname === "/tools/lookup_fact") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ fact: "BLUE-OCEAN-42" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, args }));
      return;
    }

    if (url.pathname === "/llm/v1/chat/completions") {
      const messages = (body.messages ?? []) as MockServers["capturedLlmRequests"][number]["messages"];
      capturedLlmRequests.push({ messages, tools: body.tools as unknown[] | undefined });

      const lastMsg = messages[messages.length - 1];
      const lastContent =
        typeof lastMsg?.content === "string"
          ? lastMsg.content
          : Array.isArray(lastMsg?.content)
            ? (lastMsg.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n")
            : "";

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
            id: `chatcmpl_${capturedLlmRequests.length}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body.model || "gpt-test",
            choices: [{ index: 0, delta, finish_reason: finishReason }],
            ...(usage ? { usage } : {}),
          })}\n\n`,
        );
      };

      // Turn 1 (legacy): trigger lookup_fact tool call on first prompt
      if (lastMsg?.role === "user" && lastContent.includes("USE_LOOKUP_TOOL")) {
        emit({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "call_legacy_fact_1",
              type: "function",
              function: {
                name: "lookup_fact",
                arguments: JSON.stringify({ topic: "ocean" }),
              },
            },
          ],
        });
        emit({}, "tool_calls", { prompt_tokens: 40, completion_tokens: 10 });
      } else if (lastMsg?.role === "tool") {
        const reply = `Turn 1 noted fact from tool: ${lastContent}`;
        emit({ role: "assistant", content: reply });
        emit({}, "stop", { prompt_tokens: 60, completion_tokens: 15 });
      } else {
        // Summarize all non-system messages seen in the prompt so tests can assert continuity!
        const userCount = messages.filter((m) => m.role === "user").length;
        const toolCount = messages.filter((m) => m.role === "tool").length;
        const reply = `Seen ${userCount} user msgs and ${toolCount} tool msgs. Latest: ${lastContent}`;
        emit({ role: "assistant", content: reply });
        emit({}, "stop", { prompt_tokens: 80, completion_tokens: 20 });
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await Promise.all([
    new Promise<void>((r) => camelfsServer.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => auxServer.listen(0, "127.0.0.1", r)),
  ]);

  const cfsAddr = camelfsServer.address() as { port: number };
  const auxAddr = auxServer.address() as { port: number };

  return {
    camelfsUrl: `http://127.0.0.1:${cfsAddr.port}`,
    webhookBaseUrl: `http://127.0.0.1:${auxAddr.port}/tools`,
    llmBaseUrl: `http://127.0.0.1:${auxAddr.port}/llm/v1`,
    filesByLineage,
    webhookCalls,
    capturedLlmRequests,
    close: async () => {
      camelfsServer.closeAllConnections();
      auxServer.closeAllConnections();
      await Promise.all([
        new Promise<void>((r) => camelfsServer.close(() => r())),
        new Promise<void>((r) => auxServer.close(() => r())),
      ]);
    },
  };
}

test("Phase 3: Dual-engine AgentDO (pi-durable + Lifecycle + Remote CodemodeSandbox + ToolPark + Lazy Legacy Migration)", async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), "camelrun-phase3-"));
  const workerOut = join(tmpDir, "worker");
  const sandboxOut = join(tmpDir, "sandbox");
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
  execFileSync(
    "npx",
    ["wrangler", "deploy", "--dry-run", "-c", "codemode-sandbox/wrangler.jsonc", "--outdir", sandboxOut],
    { cwd: ROOT, env: envVars, stdio: "pipe" },
  );

  const mocks = await startMockServers();
  t.after(() => mocks.close());

  const adminSecret = "phase3-admin-secret";
  const vaultSecret = "phase3-vault-secret-32-bytes-minimum!!";

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
            CAMELFS_URL: { type: "text", value: mocks.camelfsUrl },
            CAMELFS_DEV_TOKEN: { type: "text", value: "dev-token" },
            DEFAULT_MODEL: { type: "text", value: "mock/default" },
            TENANT_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "TenantDO" },
            AGENT_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "AgentDO" },
            VOICE_CALL_DO: { type: "durable-object", worker: "camelrun-worker-v2", exportName: "VoiceCallDO" },
            CODEMODE_SANDBOX: {
              type: "durable-object",
              worker: "camelrun-v2-codemode-sandbox",
              exportName: "CodemodeSandbox",
            },
          },
        },
      },
      {
        config: {
          name: "camelrun-v2-codemode-sandbox",
          compatibilityDate: "2026-03-24",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "index.js",
            modules: loadDirModules(sandboxOut),
          },
          exports: {
            CodemodeSandbox: {
              type: "durable-object",
              storage: "legacy-kv",
            },
          },
          env: {
            CODEMODE_SANDBOX: {
              type: "durable-object",
              worker: "camelrun-v2-codemode-sandbox",
              exportName: "CodemodeSandbox",
            },
          },
        },
      },
    ],
  });
  t.after(() => mf.dispose());

  const origin = "https://phase3.test";
  const fetcher: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return mf.dispatchFetch(url, init as never) as unknown as Promise<Response>;
  };

  const tenant = await CamelRun.createTenant({
    baseUrl: origin,
    fetch: fetcher,
    adminKey: adminSecret,
    name: "phase3-tenant",
    initialCreditsUsd: 50,
  });
  const headers = {
    Authorization: `Bearer ${tenant.apiKey}`,
    "Content-Type": "application/json",
  };

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetcher(`${origin}${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text };
  };

  // =========================================================================
  // 1. End-to-end engine: "pi" run with mock/*, SSE streaming, coding tools,
  //    outputSchema, and GET /history parity
  // =========================================================================
  await t.test("1. engine: 'pi' end-to-end run, coding tools (write/read/edit), SSE events, and GET /history", async () => {
    const upsert = await api("/v2/agents/pi-coder", {
      method: "PUT",
      body: JSON.stringify({
        engine: "pi",
        model: "mock/default",
        instructions: "You are a helpful coding assistant.",
        builtins: ["files"],
      }),
    });
    assert.equal(upsert.status, 201, JSON.stringify(upsert));
    assert.equal(upsert.json.engine, "pi");

    const stateRes = await api("/v2/agents/pi-coder");
    assert.equal(stateRes.status, 200);
    assert.equal(stateRes.json.engine, "pi");

    // Run 1: write -> edit -> read via coding tools
    const runRes = await api("/v2/agents/pi-coder/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt:
          '[CALL:write({"path":"hello.txt","content":"Hello World\\n"})] ' +
          '[CALL:edit({"path":"hello.txt","edits":[{"oldText":"World","newText":"PiDurable"}]})] ' +
          '[CALL:read({"path":"hello.txt"})] Confirm contents.',
        wait: true,
      }),
    });
    assert.equal(runRes.status, 200, JSON.stringify(runRes));
    assert.equal(runRes.json.status, "completed", JSON.stringify(runRes.json));
    assert.ok(runRes.json.text.includes("Hello PiDurable"), `Expected edited content in reply: ${runRes.json.text}`);
    assert.ok(runRes.json.filesChanged.includes("hello.txt"), `Expected filesChanged to include hello.txt: ${JSON.stringify(runRes.json.filesChanged)}`);
    assert.ok(runRes.json.toolCalls.length >= 3, `Expected >= 3 tool calls: ${JSON.stringify(runRes.json.toolCalls)}`);

    // Verify SSE /events endpoint streams text_delta, tool_call_start, tool_call_end, run_completed
    const sseRes = await fetcher(`${origin}/v2/agents/pi-coder/events?after=0&runId=${encodeURIComponent(runRes.json.id)}`, {
      headers: {
        Authorization: `Bearer ${tenant.apiKey}`,
        Accept: "text/event-stream",
      },
    });
    assert.equal(sseRes.status, 200);
    const sseText = await sseRes.text();
    for (const expectedEvent of ["run_started", "tool_call_start", "tool_call_end", "text_delta", "run_completed"]) {
      assert.ok(
        sseText.includes(`event: ${expectedEvent}`),
        `Expected SSE stream to include event '${expectedEvent}', got:\n${sseText}`,
      );
    }

    // Verify GET /history parity
    const histRes = await api("/v2/agents/pi-coder/history");
    assert.equal(histRes.status, 200);
    const roles = (histRes.json.messages as Array<{ role: string }>).map((m) => m.role);
    assert.ok(roles.includes("user"), `Expected user role in history: ${JSON.stringify(roles)}`);
    assert.ok(roles.includes("assistant"), `Expected assistant role in history: ${JSON.stringify(roles)}`);
    assert.ok(roles.includes("tool"), `Expected tool role in history: ${JSON.stringify(roles)}`);

    // Verify structured outputSchema support under engine: "pi"
    const schemaRun = await api("/v2/agents/pi-coder/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: 'Return status [JSON:{"ok":true,"count":7}]',
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" }, count: { type: "number" } },
          required: ["ok", "count"],
        },
        wait: true,
      }),
    });
    assert.equal(schemaRun.status, 200, JSON.stringify(schemaRun));
    assert.equal(schemaRun.json.status, "completed");
    assert.deepEqual(schemaRun.json.output, { ok: true, count: 7 });
  });

  // =========================================================================
  // 2. Remote CodemodeSandbox RPC execution inside engine: "pi"
  // =========================================================================
  await t.test("2. Remote CodemodeSandbox RPC execution calling host custom tool callback", async () => {
    const upsert = await api("/v2/agents/pi-codemode", {
      method: "PUT",
      body: JSON.stringify({
        engine: "pi",
        model: "mock/default",
        builtins: ["codemode"],
        tools: [
          {
            name: "calc_double",
            description: "Double a number",
            parameters: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
            url: `${mocks.webhookBaseUrl}/calc_double`,
          },
        ],
      }),
    });
    assert.equal(upsert.status, 201, JSON.stringify(upsert));

    const code = `const r = await tools.calc_double({ n: 21 }); return { answer: r.doubled };`;
    const runRes = await api("/v2/agents/pi-codemode/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: `[CALL:codemode(${JSON.stringify({ code })})] Run remote codemode.`,
        wait: true,
      }),
    });
    assert.equal(runRes.status, 200, JSON.stringify(runRes));
    assert.equal(runRes.json.status, "completed", JSON.stringify(runRes.json));
    assert.ok(
      runRes.json.text.includes("42"),
      `Expected remote codemode result 42 in assistant text: ${runRes.json.text}`,
    );
    assert.ok(
      mocks.webhookCalls.some((c) => c.path === "/tools/calc_double"),
      "Expected remote CodemodeSandbox RPC callback to invoke host webhook tool calc_double",
    );
  });

  // =========================================================================
  // 3. ask_human & requiresApproval ToolPark pause -> engine_busy 409 ->
  //    POST /inputs/:id -> harness.signal resume -> completed
  // =========================================================================
  await t.test("3. ask_human & requiresApproval ToolPark pause/resume + 409 engine_busy guard", async () => {
    const upsert = await api("/v2/agents/pi-human", {
      method: "PUT",
      body: JSON.stringify({
        engine: "pi",
        model: "mock/default",
        builtins: ["human"],
        tools: [
          {
            name: "secret_action",
            description: "Perform a gated action",
            parameters: { type: "object", properties: { target: { type: "string" } } },
            url: `${mocks.webhookBaseUrl}/secret_action`,
            requiresApproval: true,
          },
        ],
      }),
    });
    assert.equal(upsert.status, 201, JSON.stringify(upsert));

    // 3a. ask_human pause
    const askRun = await api("/v2/agents/pi-human/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: '[CALL:ask_human({"question":"Pick a codename?"})] Ask the user.',
        wait: true,
      }),
    });
    assert.equal(askRun.status, 200, JSON.stringify(askRun));
    assert.equal(askRun.json.status, "input_required", JSON.stringify(askRun.json));
    assert.equal(askRun.json.inputs.length, 1);
    const questionInput = askRun.json.inputs[0];
    assert.equal(questionInput.kind, "question");

    // Resume via POST /inputs/:id -> harness.signal
    const resumeAsk = await api(`/v2/agents/pi-human/inputs/${questionInput.id}`, {
      method: "POST",
      body: JSON.stringify({ answer: "cerulean-falcon", wait: true }),
    });
    assert.equal(resumeAsk.status, 200, JSON.stringify(resumeAsk));
    assert.equal(resumeAsk.json.status, "completed", JSON.stringify(resumeAsk.json));
    assert.ok(
      resumeAsk.json.text.includes("cerulean-falcon"),
      `Expected resumed answer in reply: ${resumeAsk.json.text}`,
    );

    // 3b. requiresApproval pause -> approve -> webhook runs -> completed
    const callsBefore = mocks.webhookCalls.filter((c) => c.path === "/tools/secret_action").length;
    const approvalRun = await api("/v2/agents/pi-human/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: '[CALL:secret_action({"target":"prod-db"})] Run gated tool.',
        wait: true,
      }),
    });
    assert.equal(approvalRun.status, 200, JSON.stringify(approvalRun));
    assert.equal(approvalRun.json.status, "input_required", JSON.stringify(approvalRun.json));
    assert.equal(approvalRun.json.inputs[0].kind, "approval");
    assert.equal(
      mocks.webhookCalls.filter((c) => c.path === "/tools/secret_action").length,
      callsBefore,
      "Gated tool must NOT execute before human approval",
    );

    const approveRes = await api(`/v2/agents/pi-human/inputs/${approvalRun.json.inputs[0].id}`, {
      method: "POST",
      body: JSON.stringify({ approved: true, wait: true }),
    });
    assert.equal(approveRes.status, 200, JSON.stringify(approveRes));
    assert.equal(approveRes.json.status, "completed", JSON.stringify(approveRes.json));
    assert.equal(
      mocks.webhookCalls.filter((c) => c.path === "/tools/secret_action").length,
      callsBefore + 1,
      "Gated tool MUST execute after human approval",
    );
    assert.ok(approveRes.json.text.includes("prod-db"), `Expected tool result in reply: ${approveRes.json.text}`);
  });

  // =========================================================================
  // 4. POST /compact, POST /reset-context, POST /fork, POST /abort, and
  //    spendLimitUsd enforcement under engine: "pi"
  // =========================================================================
  await t.test("4. compact, reset-context, fork, abort, and spendLimitUsd under engine: 'pi'", async () => {
    const upsert = await api("/v2/agents/pi-ops", {
      method: "PUT",
      body: JSON.stringify({
        engine: "pi",
        model: "mock/default",
        builtins: ["human"],
        tools: [
          {
            name: "calc_double",
            description: "Double a number",
            parameters: { type: "object", properties: { n: { type: "number" } } },
            url: `${mocks.webhookBaseUrl}/calc_double`,
          },
        ],
      }),
    });
    assert.equal(upsert.status, 201);

    // Seed 2 turns
    const t1 = await api("/v2/agents/pi-ops/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "First message alpha", wait: true }),
    });
    assert.equal(t1.json.status, "completed");
    const t2 = await api("/v2/agents/pi-ops/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Second message beta", wait: true }),
    });
    assert.equal(t2.json.status, "completed");

    // 4a. POST /compact with custom summary
    const compactRes = await api("/v2/agents/pi-ops/compact", {
      method: "POST",
      body: JSON.stringify({ summary: "User discussed alpha and beta." }),
    });
    assert.equal(compactRes.status, 200, JSON.stringify(compactRes));
    assert.equal(compactRes.json.summary, "User discussed alpha and beta.");

    const histAfterCompact = await api("/v2/agents/pi-ops/history");
    assert.equal(histAfterCompact.status, 200);
    assert.equal(histAfterCompact.json.compaction?.summary, "User discussed alpha and beta.");

    // 4b. POST /fork preserves pi-durable entries & engine: "pi", supports atSeq + overrides + validation
    const forkRes = await api("/v2/agents/pi-ops/fork", {
      method: "POST",
      body: JSON.stringify({
        key: "pi-ops-forked",
        instructions: "You are the forked assistant.",
        toolIdentity: { subject: "user-fork", context: { thread: "fork-thread" } },
      }),
    });
    assert.equal(forkRes.status, 200, JSON.stringify(forkRes));
    const forkedState = await api("/v2/agents/pi-ops-forked");
    assert.equal(forkedState.json.engine, "pi");
    const forkedHist = await api("/v2/agents/pi-ops-forked/history");
    assert.ok(forkedHist.json.messages.length >= 4, `Expected forked history entries: ${JSON.stringify(forkedHist.json)}`);
    assert.equal(forkedHist.json.compaction?.summary, "User discussed alpha and beta.");

    // Follow-up turn on the forked agent succeeds cleanly
    const forkTurn = await api("/v2/agents/pi-ops-forked/runs", {
      method: "POST",
      body: JSON.stringify({ prompt: "Continue on the fork", wait: true }),
    });
    assert.equal(forkTurn.status, 200, JSON.stringify(forkTurn));
    assert.equal(forkTurn.json.status, "completed");

    // Fork at specific atSeq truncates history to that seq
    const firstAssistant = histAfterCompact.json.messages.find((m: any) => m.role === "assistant");
    assert.ok(firstAssistant, "Expected an assistant message in history");
    const forkAtSeqRes = await api("/v2/agents/pi-ops/fork", {
      method: "POST",
      body: JSON.stringify({ key: "pi-ops-forked-seq", atSeq: firstAssistant.seq }),
    });
    assert.equal(forkAtSeqRes.status, 200, JSON.stringify(forkAtSeqRes));
    assert.equal(forkAtSeqRes.json.forkedFrom.atSeq, firstAssistant.seq);
    const forkAtSeqHist = await api("/v2/agents/pi-ops-forked-seq/history");
    assert.equal(
      forkAtSeqHist.json.messages.length,
      histAfterCompact.json.messages.filter((m: any) => m.seq <= firstAssistant.seq).length,
    );

    // Invalid atSeq returns 404 fork_point_invalid
    const invalidForkRes = await api("/v2/agents/pi-ops/fork", {
      method: "POST",
      body: JSON.stringify({ key: "pi-ops-forked-bad", atSeq: 999999 }),
    });
    assert.equal(invalidForkRes.status, 404, JSON.stringify(invalidForkRes));
    assert.equal(invalidForkRes.json.error?.code, "fork_point_invalid");

    // 4c. POST /reset-context
    const resetRes = await api("/v2/agents/pi-ops/reset-context", {
      method: "POST",
      body: JSON.stringify({ summary: "Fresh handoff note" }),
    });
    assert.equal(resetRes.status, 200, JSON.stringify(resetRes));
    assert.equal(resetRes.json.ok, true);
    assert.equal(resetRes.json.summary, "Fresh handoff note");

    // 4d. POST /abort cancels a parked ask_human run
    const parked = await api("/v2/agents/pi-ops/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: '[CALL:ask_human({"question":"Wait forever?"})] Pause.',
        wait: true,
      }),
    });
    assert.equal(parked.json.status, "input_required");

    const abortRes = await api("/v2/agents/pi-ops/abort", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(abortRes.status, 200, JSON.stringify(abortRes));
    assert.equal(abortRes.json.aborted, true);
    assert.ok(abortRes.json.cancelledRunIds.includes(parked.json.id));

    const afterAbort = await api(`/v2/agents/pi-ops/runs/${parked.json.id}`);
    assert.equal(afterAbort.json.status, "cancelled");

    // 4e. spendLimitUsd enforcement mid-run (step 1 costs $0.08 >= $0.05 cap -> blocks step 2!)
    const capped = await api("/v2/agents/pi-ops/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: '[COST:0.08] [CALL:calc_double({"n":5})] Enforce budget cap.',
        spendLimitUsd: 0.05,
        wait: true,
      }),
    });
    assert.equal(capped.status, 200, JSON.stringify(capped));
    assert.equal(capped.json.status, "failed", JSON.stringify(capped.json));
    assert.equal(capped.json.error?.code, "spend_limit_exceeded", JSON.stringify(capped.json));
  });

  // =========================================================================
  // 5. Zero-data-loss lazy legacy history migration (imported legacy SQLite
  //    messages with tool calls + tool results -> Pi turn sees full transcript!)
  // =========================================================================
  await t.test("5. Zero-data-loss lazy legacy -> pi migration preserves transcript & tool pairing", async () => {
    // Configure BYOK OpenAI-compatible provider pointing to our capturing mock LLM server
    const provRes = await api("/v2/providers/openai", {
      method: "PUT",
      body: JSON.stringify({
        apiKey: "sk-phase3-test",
        baseUrl: mocks.llmBaseUrl,
        apiStyle: "openai-chat",
      }),
    });
    assert.equal(provRes.status, 200, JSON.stringify(provRes));

    // Create agent (even if caller passes legacy, AgentDO normalizes to pi)
    const createLegacy = await api("/v2/agents/migrate-agent", {
      method: "PUT",
      body: JSON.stringify({
        engine: "legacy",
        model: "openai/gpt-4o-mini",
        instructions: "Remember prior conversation turns carefully.",
        tools: [
          {
            name: "lookup_fact",
            description: "Lookup a fact",
            parameters: { type: "object", properties: { topic: { type: "string" } } },
            url: `${mocks.webhookBaseUrl}/lookup_fact`,
          },
        ],
      }),
    });
    assert.equal(createLegacy.status, 201, JSON.stringify(createLegacy));
    assert.equal(createLegacy.json.engine, "pi");

    // Seed legacy SQLite `messages` table via v1 history import (simulating pre-migration prod AgentDO)
    const importRes = await api("/v2/agents/migrate-agent/history/import", {
      method: "PUT",
      body: JSON.stringify({
        source: "legacy-prod-migration",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Turn 1: USE_LOOKUP_TOOL remember secret keyword ALPHA-LEGACY-1" }],
            timestamp: 1000,
          },
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call_legacy_1", name: "lookup_fact", arguments: { topic: "ocean" } }],
            timestamp: 1001,
          },
          {
            role: "toolResult",
            toolCallId: "call_legacy_1",
            toolName: "lookup_fact",
            content: [{ type: "text", text: JSON.stringify({ fact: "BLUE-OCEAN-42" }) }],
            timestamp: 1002,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "The fact is BLUE-OCEAN-42." }],
            timestamp: 1003,
          },
          {
            role: "user",
            content: [{ type: "text", text: "Turn 2: also remember BRAVO-LEGACY-2" }],
            timestamp: 1004,
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Noted BRAVO-LEGACY-2." }],
            timestamp: 1005,
          },
        ],
      }),
    });
    assert.equal(importRes.status, 200, JSON.stringify(importRes));

    // Read-only GET /history before first Pi turn serves legacy SQLite table without mutating
    const preHist = await api("/v2/agents/migrate-agent/history");
    assert.equal(preHist.status, 200);
    assert.equal(preHist.json.messages.length, 6);

    const reqCountBeforePi = mocks.capturedLlmRequests.length;

    // Turn 3 under Pi — triggers atomic lazy migration from SQLite `messages` into `PiSessionStore`!
    const piT3 = await api("/v2/agents/migrate-agent/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: "Turn 3: verify prior legacy turns are in context",
        wait: true,
      }),
    });
    assert.equal(piT3.status, 200, JSON.stringify(piT3));
    assert.equal(piT3.json.status, "completed", JSON.stringify(piT3.json));

    // Assert Turn 3's LLM request contained the imported legacy messages (turns 1 & 2 + tool call/result)!
    assert.ok(mocks.capturedLlmRequests.length > reqCountBeforePi, "Expected Turn 3 to call mock LLM");
    const turn3Req = mocks.capturedLlmRequests[mocks.capturedLlmRequests.length - 1]!;
    const serializedPrompt = JSON.stringify(turn3Req.messages);
    assert.ok(
      serializedPrompt.includes("ALPHA-LEGACY-1"),
      `Expected Turn 3 prompt to include Turn 1 user text: ${serializedPrompt}`,
    );
    assert.ok(
      serializedPrompt.includes("BLUE-OCEAN-42"),
      `Expected Turn 3 prompt to include Turn 1 tool result: ${serializedPrompt}`,
    );
    assert.ok(
      serializedPrompt.includes("BRAVO-LEGACY-2"),
      `Expected Turn 3 prompt to include Turn 2 user text: ${serializedPrompt}`,
    );
    assert.ok(
      turn3Req.messages.some((m) => m.role === "tool"),
      `Expected paired tool message in Turn 3 prompt: ${serializedPrompt}`,
    );

    // Assert GET /history under pi returns imported legacy history + Turn 3!
    const piHistory = await api("/v2/agents/migrate-agent/history");
    assert.equal(piHistory.status, 200);
    const histStr = JSON.stringify(piHistory.json.messages);
    assert.ok(histStr.includes("ALPHA-LEGACY-1"), "GET /history should contain Turn 1");
    assert.ok(histStr.includes("BLUE-OCEAN-42"), "GET /history should contain Turn 1 tool result");
    assert.ok(histStr.includes("BRAVO-LEGACY-2"), "GET /history should contain Turn 2");
    assert.ok(histStr.includes("Turn 3: verify prior legacy turns"), "GET /history should contain Turn 3");
  });

  // =========================================================================
  // 6. Native `tool_search` deferred tool discovery, native `CompactionTask`
  //    manual `/compact`, and native `CamelRunUserEntry` per-turn metadata
  // =========================================================================
  await t.test("6. native tool_search deferred discovery + native CompactionTask /compact + CamelRunUserEntry metadata", async () => {
    const upsert = await api("/v2/agents/pi-p6", {
      method: "PUT",
      body: JSON.stringify({
        model: "mock/default",
        tools: [
          {
            name: "calc_double",
            description: "Multiply a number by two for math calculations",
            parameters: { type: "object", properties: { n: { type: "number" } } },
            url: `${mocks.webhookBaseUrl}/calc_double`,
            deferred: true,
          },
          {
            name: "lookup_fact",
            description: "Lookup encyclopedia trivia facts by topic",
            parameters: { type: "object", properties: { topic: { type: "string" } } },
            url: `${mocks.webhookBaseUrl}/lookup_fact`,
            deferred: true,
          },
        ],
      }),
    });
    assert.equal(upsert.status, 201, JSON.stringify(upsert));

    // Step 1: calling a deferred tool directly before tool_search is NOT offered to the model.
    const beforeDiscovery = await api("/v2/agents/pi-p6/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: '[CALL:calc_double({"n":9})] Try before discovery',
        actor: "usr_p6",
        idempotencyKey: "req-p6-1",
        wait: true,
      }),
    });
    assert.equal(beforeDiscovery.status, 200, JSON.stringify(beforeDiscovery));
    assert.equal(beforeDiscovery.json.status, "completed");
    assert.equal(
      beforeDiscovery.json.toolCalls.length,
      0,
      `Deferred tool should not be offered before tool_search: ${JSON.stringify(beforeDiscovery.json)}`,
    );

    // Step 2: invoke native `tool_search` to load `calc_double`, then call `calc_double` in the next step!
    const withDiscovery = await api("/v2/agents/pi-p6/runs", {
      method: "POST",
      body: JSON.stringify({
        prompt: '[CALL:tool_search({"query":"multiply number math"})] [CALL:calc_double({"n":21})] Compute double',
        actor: "usr_p6",
        idempotencyKey: "req-p6-2",
        wait: true,
      }),
    });
    assert.equal(withDiscovery.status, 200, JSON.stringify(withDiscovery));
    assert.equal(withDiscovery.json.status, "completed", JSON.stringify(withDiscovery.json));
    assert.ok(
      withDiscovery.json.text.includes("42"),
      `Expected discovered calc_double(21) -> 42 in reply: ${withDiscovery.json.text}`,
    );
    const toolNames = withDiscovery.json.toolCalls.map((tc: { name: string }) => tc.name);
    assert.ok(toolNames.includes("tool_search"), `Expected tool_search call: ${JSON.stringify(toolNames)}`);
    assert.ok(toolNames.includes("calc_double"), `Expected calc_double call after discovery: ${JSON.stringify(toolNames)}`);

    // Step 3: verify native `CamelRunUserEntry` stored runId + actor + requestId in history
    const histBeforeCompact = await api("/v2/agents/pi-p6/history");
    assert.equal(histBeforeCompact.status, 200);
    const firstUser = histBeforeCompact.json.messages.find((m: { role: string }) => m.role === "user");
    assert.equal(firstUser?.runId, beforeDiscovery.json.id);
    assert.equal(firstUser?.content?.meta?.actor, "usr_p6");
    assert.equal(firstUser?.content?.meta?.requestId, "req-p6-1");
    const firstAssistant = histBeforeCompact.json.messages.find((m: { role: string }) => m.role === "assistant");
    assert.equal(firstAssistant?.runId, beforeDiscovery.json.id);

    // Step 4: native `CompactionTask` manual POST /compact WITHOUT custom summary returns real summary + upToSeq!
    const nativeCompact = await api("/v2/agents/pi-p6/compact", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(nativeCompact.status, 200, JSON.stringify(nativeCompact));
    assert.ok(
      typeof nativeCompact.json.summary === "string" && nativeCompact.json.summary.length > 0,
      `Expected native CompactionTask summary, got: ${JSON.stringify(nativeCompact.json)}`,
    );
    assert.ok(nativeCompact.json.upToSeq > 0, JSON.stringify(nativeCompact.json));
    assert.ok(nativeCompact.json.compactedCount > 0, JSON.stringify(nativeCompact.json));

    const histAfterCompact = await api("/v2/agents/pi-p6/history");
    assert.equal(histAfterCompact.status, 200);
    assert.equal(histAfterCompact.json.compaction?.summary, nativeCompact.json.summary);
  });
});
