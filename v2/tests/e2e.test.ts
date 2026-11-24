import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { Miniflare } from "miniflare";
import { CamelFsClient } from "../worker/src/camelfs.ts";
import { CamelRun, CamelRunError, defineTool, parseSSE, type SSEMessage } from "../sdk/src/index.ts";

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

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CAMELFSD_BIN = join(ROOT, "camelfsd/bin/camelfsd");
const ADMIN_SECRET = "test-admin-secret-v2";
const VAULT_SECRET = "test-vault-secret-32-bytes-minimum!!";

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function generateEd25519Pair(): { signingSpec: string; publicSpec: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwkPub = publicKey.export({ format: "jwk" }) as { x: string };
  const jwkPriv = privateKey.export({ format: "jwk" }) as { d: string };
  return {
    signingSpec: `k1:${jwkPriv.d}`,
    publicSpec: `k1:${jwkPub.x}`,
  };
}

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`Timed out waiting for ${url}: ${String(lastErr)}`);
}

describe("camelRun v2 end-to-end (SDK <-> workerd <-> Ed25519 JWT <-> Go camelfsd)", () => {
  let tempDir: string;
  let camelfsdProc: ChildProcess | undefined;
  let camelfsUrl: string;
  let camelfsSigningKey: string;
  let auxServer: Server;
  let auxUrl: string;
  let worker: Miniflare;
  let startWorker: () => Promise<void>;
  let workerUrl: string;
  let failNextExec = false;
  let vmBootRequests = 0;
  const toolImage = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVQImWP4z8Dwn4EBAAj+Af/KOtJRAAAAAElFTkSuQmCC";
  const imageResult = { content: [
    { type: "text", text: "The tool returned a screenshot." },
    { type: "image", mimeType: "image/png", data: toolImage },
  ] };
  type ProviderMessage = { role: string; content: unknown; tool_call_id?: string };
  let lastProviderMessages: ProviderMessage[] | undefined;
  let lastProviderOptions: Record<string, unknown> | undefined;
  const azureRequests: Array<{ body: Record<string, unknown>; key?: string | string[]; authorization?: string }> = [];
  let textTimeoutEntered: (() => void) | undefined;
  let actorToolGate: { started: () => void; resume: Promise<void> } | undefined;
  const actorTokens = new Map<string, string>();
  const receivedWebhooks: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "camelrun-next-e2e-"));
    const keys = generateEd25519Pair();
    const externalCamelfsUrl = process.env.CAMELFSD_TEST_URL;
    const externalSigningKey = process.env.CAMELFSD_TEST_SIGNING_KEY;
    assert.equal(
      Boolean(externalCamelfsUrl),
      Boolean(externalSigningKey),
      "CAMELFSD_TEST_URL and CAMELFSD_TEST_SIGNING_KEY must be set together",
    );

    camelfsSigningKey = externalSigningKey ?? keys.signingSpec;

    // 1. Start local MCP + Webhook test HTTP server
    const auxPort = await getFreePort();
    auxUrl = `http://127.0.0.1:${auxPort}`;
    auxServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");

      if (req.url?.startsWith("/camelfs/")) {
        const path = req.url.slice("/camelfs".length);
        if (req.method === "POST" && path === "/v1/vms") vmBootRequests++;
        if (failNextExec && req.method === "POST" && path.endsWith("/exec")) {
          failNextExec = false;
          res.writeHead(502, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { code: "daemon_disconnected", message: "daemon disconnect probe" } }));
          return;
        }
        const upstream = await fetch(camelfsUrl + path, {
          method: req.method,
          headers: {
            Authorization: req.headers.authorization ?? "",
            "Content-Type": req.headers["content-type"] ?? "application/json",
          },
          body: rawBody || undefined,
        });
        res.writeHead(upstream.status, { "Content-Type": "application/json" });
        res.end(await upstream.text());
        return;
      }

      if ((req.url === "/mcp" || req.url === "/mcp-actor") && req.method === "POST") {
        const rpc = JSON.parse(rawBody) as { id: number | string; method: string; params?: Record<string, unknown> };
        if (rpc.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } } }));
          return;
        }
        if (rpc.method === "tools/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                tools: [
                  {
                    name: "weather_forecast",
                    description: "Returns weather for a city",
                    inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (rpc.method === "tools/call") {
          const args = (rpc.params?.arguments as { city?: string } | undefined) ?? {};
          if (req.url === "/mcp-actor" && args.city && req.headers.authorization) {
            actorTokens.set(args.city, req.headers.authorization.slice("Bearer ".length));
            if (args.city === "Paris" && actorToolGate) {
              actorToolGate.started();
              await actorToolGate.resume;
            }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: args.city === "image-fixture" ? imageResult
                : { content: [{ type: "text", text: `72F and sunny in ${args.city ?? "unknown"}` }] },
            }),
          );
          return;
        }
      }

      if (req.url === "/tool-image" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(imageResult));
        return;
      }

      if (req.url === "/webhook" && req.method === "POST") {
        receivedWebhooks.push({ headers: req.headers, body: rawBody });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
        return;
      }

      if (req.url === "/usage-webhook" && req.method === "POST") {
        const delivery = req.headers["x-camelrun-delivery"];
        const retry = receivedWebhooks.some(({ headers }) => headers["x-camelrun-delivery"] === delivery);
        receivedWebhooks.push({ headers: req.headers, body: rawBody });
        res.writeHead(retry ? 204 : 503);
        res.end();
        return;
      }

      const reqPath = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (reqPath === "/openai/v1/responses" && req.method === "POST") {
        const body = JSON.parse(rawBody) as Record<string, unknown>;
        azureRequests.push({ body, key: req.headers["api-key"], authorization: req.headers.authorization });
        const input = body.input as Array<{ type?: string; content?: string | Array<{ type?: string; text?: string }> }>;
        const rawLastContent = input.at(-1)?.content;
        const last =
          typeof rawLastContent === "string"
            ? rawLastContent
            : Array.isArray(rawLastContent)
              ? rawLastContent.map((b) => b.text ?? "").join("\n")
              : undefined;
        if (last === "native-text-timeout") {
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.flushHeaders();
          textTimeoutEntered?.();
          const finish = setTimeout(() => res.end(), 2000);
          res.once("close", () => clearTimeout(finish));
          return;
        }
        const plain =
          last === "native-text-fixture"
            ? '{"ok":1}'
            : last === "native-text-invalid-json"
              ? "No object"
              : last === "Funded" || last === "uncapped batch member" || last === "capped batch member"
                ? `SSE upstream (azure/gpt-6.2-sol) saw ${last}`
                : undefined;
        const toolResult = input.some((item) => item.type === "function_call_output");
        const call = last === "mcp-image-fixture"
          ? { name: "meteo__weather_forecast", arguments: '{"city":"image-fixture"}' }
          : last === "repo-image-fixture" ? { name: "view_image", arguments: '{"path":"fixture.png"}' }
          : { name: "lookup", arguments: "{}" };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const textOut =
          plain !== undefined
            ? plain
            : toolResult || rawBody.includes("app-runtime-credit-fixture")
              ? "read the result"
              : null;
        const events =
          textOut !== null
            ? [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
                },
                { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: textOut },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    type: "message",
                    id: "msg_1",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: textOut }],
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "resp_1",
                    status: "completed",
                    output: [],
                    usage: { input_tokens: 160_000, output_tokens: 7 },
                  },
                },
              ]
            : [
                {
                  type: "response.output_item.added",
                  output_index: 0,
                  item: {
                    type: "function_call",
                    id: "fc_azure_test",
                    call_id: "call_azure_test",
                    name: call.name,
                    arguments: "",
                  },
                },
                {
                  type: "response.output_item.done",
                  output_index: 0,
                  item: {
                    type: "function_call",
                    id: "fc_azure_test",
                    call_id: "call_azure_test",
                    name: call.name,
                    arguments: call.arguments,
                  },
                },
                {
                  type: "response.completed",
                  response: {
                    id: "resp_1",
                    status: "completed",
                    output: [],
                    usage: { input_tokens: 160_000, output_tokens: 7 },
                  },
                },
              ];
        res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
        return;
      }

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        const body = JSON.parse(rawBody) as {
          model?: string;
          messages?: ProviderMessage[];
          provider?: Record<string, unknown>;
        };
        lastProviderMessages = body.messages;
        lastProviderOptions = body.provider;
        const lastMsg = body.messages?.[body.messages.length - 1];
        const replyText = `SSE upstream (${body.model ?? "unknown"}) saw ${body.messages?.length ?? 0} messages (last role=${lastMsg?.role ?? "none"})`;
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const chunk1 = {
          id: "chatcmpl-test",
          choices: [{ index: 0, delta: { role: "assistant", content: replyText.slice(0, 16) }, finish_reason: null }],
        };
        const chunk2 = {
          id: "chatcmpl-test",
          choices: [{ index: 0, delta: { content: replyText.slice(16) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 18, completion_tokens: 10 },
        };
        res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
        res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });
    await new Promise<void>((resolve) => auxServer.listen(auxPort, "127.0.0.1", () => resolve()));

    // Run against either the local fixture or a dedicated Firecracker test daemon.
    if (externalCamelfsUrl) {
      camelfsUrl = externalCamelfsUrl;
    } else {
      const camelfsPort = await getFreePort();
      camelfsUrl = `http://127.0.0.1:${camelfsPort}`;
      camelfsdProc = spawn(
        CAMELFSD_BIN,
        [
          "--listen",
          `127.0.0.1:${camelfsPort}`,
          "--data-dir",
          join(tempDir, "camelfs-data"),
          "--backend",
          "local",
          "--vm-driver",
          "local",
          "--public-keys",
          keys.publicSpec,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    }
    await waitForHealth(`${camelfsUrl}/healthz`);

    // 3. Bundle & start real camelrun-worker-v2 + camelrun-v2-codemode-sandbox via multi-worker Miniflare
    const workerPort = await getFreePort();
    const toolKey = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
    const baseConfig = JSON.parse(readFileSync(join(ROOT, "worker/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    const testConfigPath = join(tempDir, "wrangler.test.jsonc");
    const runtimeMain = join(ROOT, "tests/fixtures/alarm-worker.ts");
    const workerOut = join(tempDir, "worker-dist");
    const sandboxOut = join(tempDir, "sandbox-dist");
    writeFileSync(
      testConfigPath,
      JSON.stringify(
        {
          ...baseConfig,
          main: runtimeMain,
        },
        null,
        2,
      ),
    );
    const wranglerEnv = {
      ...process.env,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || "/tmp/xdg",
      WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || join(ROOT, ".wrangler/logs"),
    };
    execFileSync(
      "npx",
      ["wrangler", "deploy", "--dry-run", "-c", testConfigPath, "--outdir", workerOut],
      { cwd: ROOT, env: wranglerEnv, stdio: "pipe" },
    );
    execFileSync(
      "npx",
      ["wrangler", "deploy", "--dry-run", "-c", join(ROOT, "codemode-sandbox/wrangler.jsonc"), "--outdir", sandboxOut],
      { cwd: ROOT, env: wranglerEnv, stdio: "pipe" },
    );
    const workerModules = loadDirModules(workerOut);
    const sandboxModules = loadDirModules(sandboxOut);
    workerUrl = `http://127.0.0.1:${workerPort}`;
    startWorker = async () => {
      worker = new Miniflare({
        host: "127.0.0.1",
        port: workerPort,
        resourcePersistencePath: join(tempDir, "wrangler-state"),
        workers: [
          {
            config: {
              name: "camelrun-worker-v2",
              compatibilityDate: "2026-03-24",
              compatibilityFlags: ["nodejs_compat", "enhanced_error_serialization"],
              manifest: {
                mainModule: "alarm-worker.js",
                modules: workerModules,
              },
              triggers: [
                {
                  type: "queue",
                  name: "camelrun-events-v2",
                  maxBatchSize: 25,
                  maxBatchTimeout: 1,
                  maxRetries: 3,
                },
              ],
              exports: {
                TenantDO: { type: "durable-object", storage: "sqlite" },
                AgentDO: { type: "durable-object", storage: "sqlite" },
                VoiceCallDO: { type: "durable-object", storage: "sqlite" },
              },
              env: {
                ADMIN_SECRET: { type: "text", value: ADMIN_SECRET },
                VAULT_SECRET: { type: "text", value: VAULT_SECRET },
                CAMELFS_URL: { type: "text", value: auxUrl + "/camelfs" },
                CAMELFS_SIGNING_KEY: { type: "text", value: camelfsSigningKey },
                CAMELFS_DEV_TOKEN: { type: "text", value: "" },
                DEFAULT_MODEL: { type: "text", value: "mock/default" },
                AZURE_OPENAI_SOL_ENDPOINT: { type: "text", value: auxUrl },
                AZURE_OPENAI_SOL_API_KEY: { type: "text", value: "fixture-azure-key" },
                BUILDER_CUTOVER_CREDIT_TENANT_ID: { type: "text", value: "tnt_0000000000000001" },
                APP_RUNTIME_CREDIT_TENANT_IDS: { type: "text", value: "tnt_0000000000000002" },
                TOOL_IDENTITY_ISSUER: { type: "text", value: `http://127.0.0.1:${workerPort}/v2` },
                TOOL_IDENTITY_PRIVATE_JWK: { type: "text", value: JSON.stringify({ ...toolKey, kid: "tool-fixture" }) },
                MEDIA_BUCKET: { type: "r2", name: "camelrun-media-v2" },
                EVENTS_QUEUE: { type: "queue", name: "camelrun-events-v2" },
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
                modules: sandboxModules,
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
      await worker.ready;
      await waitForHealth(`${workerUrl}/healthz`);
    };
    await startWorker();
  });

  after(async () => {
    await worker?.dispose().catch(() => {});
    const daemon = camelfsdProc;
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      await new Promise<void>((resolve) => {
        daemon.once("exit", () => resolve());
        daemon.kill("SIGTERM");
      });
    }
    if (auxServer) {
      await new Promise((resolve) => auxServer.close(() => resolve(undefined)));
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the developer prompt in the Azure Responses input prefix across tool calls", async () => {
    const created = await CamelRun.createTenant({
      baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "azure-sol-test", initialCreditsUsd: 1,
    });
    const instructions = "Use the lookup result to answer the user.";
    const response = await fetch(`${workerUrl}/v2/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${created.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "camelrun/default", input: "Call lookup before answering.",
        instructions,
        tools: [{ name: "lookup", url: `${auxUrl}/webhook` }],
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { text: string; usage: { costUsd: number } };
    assert.equal(result.text, "read the result");
    assert.equal(result.usage.costUsd, 0.32007, "short-context pricing applies to each request");
    assert.equal(azureRequests.length, 2);
    for (const { body, key, authorization } of azureRequests) {
      assert.equal(body.model, "gpt-6.1-terra");
      assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      assert.equal(body.store, false);
      assert.equal(Object.hasOwn(body, "instructions"), false);
      assert.deepEqual((body.input as unknown[]).slice(0, 2), [
        { role: "developer", content: instructions },
        { role: "user", content: [{ type: "input_text", text: "Call lookup before answering." }] },
      ]);
      assert.equal(key, "fixture-azure-key");
      assert.equal(authorization, undefined);
    }
    assert.ok((azureRequests[1].body.input as Array<{ type?: string; call_id?: string }>).some(
      (item) => item.type === "function_call_output" && item.call_id === "call_azure_test",
    ));
  });

  it("sends images from MCP, SDK, webhook and repo tools in Azure Responses tool output", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "vision tools", initialCreditsUsd: 20,
    });
    const client = new CamelRun({ baseUrl: workerUrl, apiKey });
    try {
      const repo = await client.repos.create({ name: "tool-image-repo" });
      await client.repos.write(repo.repoId, { puts: [{ path: "fixture.png", base64: toolImage }] });
      const lookup = { name: "lookup", description: "Return a screenshot", parameters: { type: "object", properties: {} } };
      const fixtures = [
        { name: "mcp", input: "mcp-image-fixture", options: { mcpServers: [{ name: "meteo", url: `${auxUrl}/mcp`, deferred: false }] } },
        { name: "webhook", input: "webhook-image-fixture", options: { tools: [{ ...lookup, url: `${auxUrl}/tool-image` }] } },
        { name: "sdk", input: "sdk-image-fixture", options: { tools: [{ ...lookup, execute: () => imageResult }] } },
        { name: "repo", input: "repo-image-fixture", options: { repoId: repo.repoId } },
      ];
      for (const fixture of fixtures) {
        const before = azureRequests.length;
        const agent = await client.agents.upsert(`tool-image-${fixture.name}`, {
          model: "camelrun/default", ...fixture.options,
          ...(fixture.name === "repo" && { builtins: ["files" as const] }),
        });
        const stream = agent.stream(fixture.input);
        const events = [];
        for await (const event of stream) events.push(event);
        const result = await stream.result;
        assert.equal(result.status, "completed", JSON.stringify(result.error));
        assert.equal(azureRequests.length, before + 2);
        const input = azureRequests.at(-1)!.body.input as Array<{ type: string; call_id: string; output?: unknown }>;
        const output = input.find(item => item.type === "function_call_output");
        const expectedText = fixture.name === "repo" ? /Repository image fixture.png.*\n\[image 2×1\]/ : /The tool returned a screenshot\.\n\[image 2×1\]/;
        assert.equal(output?.call_id, "call_azure_test");
        assert.ok(Array.isArray(output?.output));
        assert.match(output.output[0].text, expectedText);
        assert.deepEqual(output.output[1], { type: "input_image", image_url: `data:image/png;base64,${toolImage}`, detail: "auto" });
        const history = await agent.history();
        assert.ok(history.some(row => row.role === "tool" && JSON.stringify(row.content).includes("toolImages")));
        assert.ok(!JSON.stringify({ history, events }).includes(toolImage), "inline image bytes leaked to stored history or events");
      }
    } finally {
      await client.close();
    }
  });

  it("runs Camel Bots native text at zero balance, preserves Azure Sol options, and waits for settlement", async () => {
    const seed = await fetch(workerUrl + "/test-text-tenant", { method: "POST" });
    assert.equal(seed.status, 200);
    const { apiKey } = await seed.json() as { apiKey: string };
    const other = await CamelRun.createTenant({ baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "text denied" });
    const call = (input: string, timeoutMs: number, token = apiKey, key = crypto.randomUUID()) => fetch(workerUrl + "/v2/runs/text", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ input, instructions: "Be brief.", outputSchema: { type: "object", additionalProperties: true }, timeoutMs }),
      signal: AbortSignal.timeout(5_000),
    });
    const before = azureRequests.length;
    assert.equal((await call("native-text-fixture", 2000, other.apiKey)).status, 404);
    assert.equal((await call("native-text-fixture", 60001)).status, 400);
    assert.equal(azureRequests.length, before);
    const keyForRun = crypto.randomUUID();
    const duplicate = await Promise.all([call("native-text-fixture", 2000, apiKey, keyForRun), call("native-text-fixture", 2000, apiKey, keyForRun)]);
    assert.deepEqual(duplicate.map(response => response.status).sort(), [200, 409]);
    const response = duplicate.find(response => response.ok)!;
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { text: string; output: unknown; usage: { costUsd: number } };
    assert.equal(result.text, '{"ok":1}');
    assert.deepEqual(result.output, { ok: 1 });
    assert.equal(result.usage.costUsd, 0.160035);
    const { body, key, authorization } = azureRequests[before]!;
    assert.equal(key, "fixture-azure-key");
    assert.equal(authorization, undefined);
    assert.equal(body.model, "gpt-6.1-terra");
    assert.deepEqual(body.reasoning, { effort: "low", summary: "auto" });
    assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
    assert.equal(body.store, false);
    assert.equal(Object.hasOwn(body, "instructions"), false);
    assert.deepEqual(body.input, [
      { role: "developer", content: "Be brief." },
      { role: "user", content: [{ type: "input_text", text: "native-text-fixture" }] },
    ]);
    assert.equal((await call("native-text-fixture", 2000, apiKey, keyForRun)).status, 409);
    assert.equal((await call("native-text-invalid-json", 2000, apiKey, keyForRun)).status, 409);
    assert.equal(azureRequests.length, before + 1);

    const malformed = await call("native-text-invalid-json", 2000);
    assert.equal(malformed.status, 200);
    assert.equal((await malformed.json() as { error: { code: string } }).error.code, "output_missing");
    const billing = await new CamelRun({ baseUrl: workerUrl, apiKey }).billing.get();
    assert.equal(billing.usage.reduce((sum, usage) => sum + usage.runsCount!, 0), 2);
    assert.ok(billing.balanceUsd > 24);
    assert.equal((await fetch(workerUrl + "/test-text-tenant?failSettlement", { method: "POST" })).status, 204);
    assert.equal((await call("native-text-fixture", 2000)).status, 500, "a failed usage commit never replies with a model result");
    assert.deepEqual(await new CamelRun({ baseUrl: workerUrl, apiKey }).billing.get(), billing);
    const entered = new Promise<void>(resolve => { textTimeoutEntered = resolve; });
    const timed = call("native-text-timeout", 1000);
    await Promise.race([entered, timed]);
    assert.equal((await call("native-text-fixture", 2000)).status, 429, "the admitted call holds the single tenant slot");
    assert.equal((await timed).status, 408);
    assert.equal((await call("native-text-fixture", 2000)).status, 200, "the timed out run releases its slot");
  });

  it("runs Chiridion chat at zero shared balance and records usage", async t => {
    const seed = await fetch(workerUrl + "/test-chiridion-tenant", { method: "POST" });
    assert.equal(seed.status, 200);
    const { apiKey } = await seed.json() as { apiKey: string };
    const client = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => client.close());
    assert.equal((await client.billing.get()).balanceUsd, 0);

    const agent = await client.agents.upsert("chiridion-credit-fixture", { model: "azure/gpt-6.2-sol" });
    const run = await agent.run("app-runtime-credit-fixture");
    assert.equal(run.status, "completed");
    assert.equal(run.text, "read the result");
    const billing = await client.billing.get();
    assert.equal(billing.balanceUsd, 25);
    assert.ok(billing.usage.some(row => (row.costUsd ?? 0) > 0));
  });

  it("1. tenants, API keys, billing credits, and scoped agent tokens enforce boundaries", async () => {
    const version = await fetch(`${workerUrl}/v2`);
    assert.equal(version.status, 200);
    assert.deepEqual(await version.json(), { ok: true, service: "camelrun-worker-v2" });

    const created = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "acme-prod",
      initialCreditsUsd: 25,
    });
    assert.ok(created.tenantId.startsWith("tnt_"));
    assert.ok(created.apiKey.startsWith("cr_live_"));
    assert.equal(created.balanceUsd, 25);

    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey: created.apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    const me = await camel.me();
    assert.equal(me.name, "acme-prod");
    assert.equal(me.balanceUsd, 25);

    const topped = await camel.billing.addCredits({ amountUsd: 10, adminKey: ADMIN_SECRET, note: "bonus" });
    assert.equal(topped.balanceUsd, 35);

    const tok = await camel.tokens.create({ name: "ci-key" });
    assert.ok(tok.token?.startsWith("cr_live_"));
    const tokens = await camel.tokens.list();
    assert.equal(tokens.length, 2);
    await camel.tokens.delete(tok.id);
    assert.equal((await camel.tokens.list()).length, 1);

    // Scoped agent token can run its own agent, but cannot delete it or access tenant routes
    const agent = await camel.agents.upsert("scoped-bot", {
      model: "mock/echo",
      instructions: "Echo inputs.",
    });
    assert.ok(agent.agentToken?.startsWith("agt_tok_"));

    const scopedClient = new CamelRun({
      baseUrl: workerUrl,
      apiKey: agent.agentToken!,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });
    const scopedAgent = await scopedClient.agents.get(agent.id);
    const run = await scopedAgent.run("hello from scoped token");
    assert.equal(run.status, "completed");
    assert.match(run.text, /hello from scoped token/);

    await assert.rejects(
      () => scopedAgent.delete(),
      (err: unknown) => err instanceof CamelRunError && (err.status === 403 || err.status === 401),
    );
    await assert.rejects(
      () => scopedClient.tokens.list(),
      (err: unknown) => err instanceof CamelRunError && (err.status === 403 || err.status === 401),
    );

    await camel.close();
    await scopedClient.close();
  });

  it("isolates pilot credits by tenant and requires admin authorization to grant them", async (t) => {
    const provision = (name: string, initialCreditsUsd: number) =>
      CamelRun.createTenant({ baseUrl: workerUrl, adminKey: ADMIN_SECRET, name, initialCreditsUsd });
    const pilot = await provision("Funded pilot account", 1);
    const other = await provision("Unfunded pilot account", 0);
    const funded = new CamelRun({ baseUrl: workerUrl, apiKey: pilot.apiKey });
    const unfunded = new CamelRun({ baseUrl: workerUrl, apiKey: other.apiKey });
    t.after(() => { funded.close(); unfunded.close(); });

    const grant = { amountUsd: 1, refId: "pilot-grant" };
    const unauthorized = await fetch(`${workerUrl}/v2/billing/credits`, {
      method: "POST",
      headers: { Authorization: `Bearer ${other.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(grant),
    });
    assert.equal(unauthorized.status, 403);
    const builder = await unfunded.agents.upsert("pilot-builder", { model: "azure/gpt-6.2-sol" });
    const clearAgentCap = await fetch(`${workerUrl}/v2/agents/${builder.id}/spend-limit`, {
      method: "PATCH", headers: { Authorization: `Bearer ${other.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ spendLimitUsd: 0, expectedSpendLimitUsd: 10 }),
    });
    assert.equal(clearAgentCap.status, 200);
    const beforeDispatch = azureRequests.length;
    await assert.rejects(builder.run("Unfunded"), (error: unknown) =>
      error instanceof CamelRunError && error.code === "insufficient_credits");
    assert.equal(azureRequests.length, beforeDispatch);
    assert.equal((await unfunded.billing.get()).balanceUsd, 0);

    assert.equal((await unfunded.billing.addCredits({ ...grant, adminKey: ADMIN_SECRET })).balanceUsd, 1);
    assert.equal((await unfunded.billing.addCredits({ ...grant, adminKey: ADMIN_SECRET })).balanceUsd, 1);
    const run = await builder.run("Funded");
    assert.match(run.text, /SSE upstream/);
    assert.ok((await unfunded.billing.get()).balanceUsd < 1);
    assert.equal((await funded.billing.get()).balanceUsd, 1);
  });

  it("persists a run spend limit, isolates capped runs from batching, and bills metered usage", async (t) => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "per-run-spend",
      initialCreditsUsd: 1,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());
    await camel.webhooks.create({ url: `${auxUrl}/usage-webhook`, events: ["usage.recorded", "run.failed"] });
    const context = { org: "org-test", workspace: "workspace-test", thread: "thread-test" };
    const agent = await camel.agents.upsert("per-run-spend", {
      model: "azure/gpt-6.2-sol",
      queue: { mode: "batch", windowMs: 100 },
      toolIdentity: { subject: "owner", context },
    });
    const clearAgentCap = await fetch(`${workerUrl}/v2/agents/${agent.id}/spend-limit`, {
      method: "PATCH", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ spendLimitUsd: 0, expectedSpendLimitUsd: 10 }),
    });
    assert.equal(clearAgentCap.status, 200);
    assert.deepEqual(await clearAgentCap.json(), { spendLimitUsd: 0, changed: true });
    const beforeZero = azureRequests.length;
    const zero = await agent.run("no budget", { spendLimitUsd: 0, throwOnError: false });
    assert.ok(zero.error && typeof zero.error === "object");
    assert.equal(zero.error.code, "spend_limit_exceeded");
    assert.equal(zero.usage.costUsd, 0);
    assert.equal(azureRequests.length, beforeZero);
    await assert.rejects(agent.run("wrong budget", { spendLimitUsd: -1 }), (error: unknown) =>
      error instanceof CamelRunError && error.code === "invalid_spend_limit");

    await assert.rejects(agent.run("steering with a new budget", { whileRunning: "steer", spendLimitUsd: 0 }), (error: unknown) =>
      error instanceof CamelRunError && error.code === "invalid_spend_limit");

    const [normal, capped] = await Promise.all([
      agent.run("uncapped batch member"),
      agent.run("capped batch member", {
        actor: "sender",
        spendLimitUsd: 0.00000001,
        idempotencyKey: "capped",
        throwOnError: false,
      }),
    ]);
    assert.equal(normal.status, "completed");
    assert.equal(capped.batchedInto, null);
    assert.ok(capped.error && typeof capped.error === "object");
    assert.equal(capped.error.code, "spend_limit_exceeded");
    assert.ok(capped.usage.costUsd > 0);
    assert.equal((1 - (await camel.billing.get()).balanceUsd).toFixed(8), (normal.usage.costUsd + capped.usage.costUsd).toFixed(8));
    const retried = await agent.run("retry with larger budget", { spendLimitUsd: 1, idempotencyKey: "capped", throwOnError: false });
    assert.equal(retried.id, capped.id);
    assert.deepEqual(retried.error, capped.error);

    const deadline = Date.now() + 10_000;
    const usageDeliveries = () => receivedWebhooks.filter(({ headers }) => headers["x-camelrun-event"] === "usage.recorded");
    while (usageDeliveries().length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [first, second] = usageDeliveries();
    assert.ok(first && second, "expected usage delivery and retry");
    assert.equal(first.body, second.body);
    const event = JSON.parse(second.body);
    assert.equal(first.headers["x-camelrun-delivery"], event.id);
    assert.equal(second.headers["x-camelrun-delivery"], event.id);
    assert.match(String(second.headers["x-camelrun-signature"]), /v1=[0-9a-f]{64}/);
    assert.deepEqual(event.data, {
      agentId: agent.id,
      runId: capped.id,
      actor: "sender",
      context,
      model: "azure/gpt-6.2-sol",
      kind: "response",
      input: capped.usage.inputTokens,
      output: capped.usage.outputTokens,
      cacheRead: 0,
      cost: { usd: capped.usage.costUsd, source: "catalog" },
    });
    const failures = () => receivedWebhooks.filter(({ headers, body }) =>
      headers["x-camelrun-event"] === "run.failed" && JSON.parse(body).data.runId === capped.id);
    while (failures().length < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const [failed, retriedFailure] = failures();
    assert.ok(failed && retriedFailure, "expected lifecycle delivery and retry");
    assert.equal(failed.body, retriedFailure.body);
    const failure = JSON.parse(failed.body);
    assert.equal(failure.data.runId, capped.id);
    assert.equal(failure.data.actor, "sender");
    assert.deepEqual(failure.data.context, context);
    assert.equal(failure.data.error?.code, "spend_limit_exceeded");
  });

  it("binds signed tools to the run's actor and queues a steer from another actor", async (t) => {
    const { apiKey, tenantId } = await CamelRun.createTenant({
      baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "run-actor",
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());
    const audience = `${auxUrl}/mcp-actor`;
    const agent = await camel.agents.upsert("run-actor", {
      model: "mock/default",
      toolIdentity: { subject: "thread-owner", context: { thread: "shared-thread" } },
      mcpServers: [{ name: "app", url: audience, audience, auth: { type: "runtime" }, deferred: false }],
    });
    const scoped = new CamelRun({ baseUrl: workerUrl, apiKey: agent.agentToken! });
    t.after(() => scoped.close());
    const scopedAgent = await scoped.agents.get(agent.id);
    await assert.rejects(scopedAgent.run("Try to become a member", { actor: "another-member" }), (error: unknown) =>
      error instanceof CamelRunError && error.status === 403);

    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    actorToolGate = { started: markStarted, resume: paused };
    const parisPrompt = 'First [CALL:app__weather_forecast {"city":"Paris"}]';
    const londonPrompt = 'Second [CALL:app__weather_forecast {"city":"London"}]';
    const first = await agent.submit(parisPrompt, { actor: "first-member", idempotencyKey: "first" });
    let second;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([started, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("First actor did not reach the tool")), 3_000);
        })]);
      } finally { clearTimeout(timer); }
      const switchDuringTool = await fetch(`${workerUrl}/v2/agents/${agent.id}/model`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "mock/sol", expectedModel: "mock/default" }),
      });
      assert.equal(switchDuringTool.status, 409);
      const response = await switchDuringTool.json() as { error: { code: string } };
      assert.equal(response.error.code, "agent_busy");
      second = await agent.steer(londonPrompt, { actor: "second-member", idempotencyKey: "second", wait: false });
      assert.equal(second.status, "queued");
      assert.equal(second.batchedInto, null);
    } finally {
      resume();
      actorToolGate = undefined;
    }
    await agent.run(parisPrompt, { actor: "first-member", idempotencyKey: "first" });
    await agent.run(londonPrompt, { actor: "second-member", idempotencyKey: "second" });
    const issuer = `${workerUrl}/v2`;
    const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    for (const [city, actor, runId] of [["Paris", "first-member", first.id], ["London", "second-member", second.id]]) {
      const { payload } = await jwtVerify(actorTokens.get(city)!, jwks, { issuer, audience });
      assert.equal(payload.act, actor);
      assert.equal(payload.sub, "thread-owner");
      assert.equal(payload.tenant, tenantId);
      assert.equal(payload.agent, agent.id);
      assert.equal(payload.req, runId);
    }
  });

  it("2. camelfsd repos, file tools, persistent bash VM (cwd + env + atomic commit), and edit-while-VM-live work seamlessly", async () => {
    const { apiKey, tenantId } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "fs-vm-tenant",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    const repo = await camel.repos.create({ name: "app-repo" });
    assert.ok(repo.repoId);
    assert.ok(repo.lineage.startsWith("lin_"));

    const coder = await camel.agents.upsert("coder-1", {
      model: "mock/default",
      repoId: repo.repoId,
      builtins: ["files", "bash"],
    });

    // Step A: Write initial file via repo file tool
    const r1 = await coder.run(
      `Create seed [CALL:write_file {"path":"notes.txt","content":"line1\\n","message":"seed notes"}]`,
    );
    assert.equal(r1.status, "completed");

    // Step B: First bash call changes directory, exports shell env var, and modifies workspace
    const r2 = await coder.run(
      `Setup dir [CALL:bash {"command":"mkdir -p src && cd src && export GREETING=camel_v2 && echo \\"$GREETING\\" > app.txt && pwd"}]`,
    );
    assert.equal(r2.status, "completed");
    assert.ok(r2.usage.vmMs >= 0);

    // Step C: Second bash call reuses the SAME warm shell — cwd is still /workspace/src and $GREETING is still set!
    const r3 = await coder.run(
      `Verify persistence [CALL:bash {"command":"pwd && echo \\"val=$GREETING\\" >> app.txt && cat app.txt"}]`,
    );
    assert.equal(r3.status, "completed");
    assert.match(r3.text, /\/src/);
    assert.match(r3.text, /val=camel_v2/);

    // Step D: Edit file via file tool WHILE the VM holds the branch lease (must NOT 409!)
    const r4 = await coder.run(
      `Edit notes [CALL:edit_file {"path":"notes.txt","oldString":"line1","newString":"line1-edited"}]`,
    );
    assert.equal(r4.status, "completed");

    // Step E: Verify committed state directly through /v2/repos API (proving atomic post-bash + edit commits!)
    const appFile = await camel.repos.read(repo.repoId, { path: "src/app.txt" });
    assert.equal(appFile.content, "camel_v2\nval=camel_v2\n");

    const notesFile = await camel.repos.read(repo.repoId, { path: "notes.txt" });
    assert.equal(notesFile.content, "line1-edited\n");

    const grepRes = await camel.repos.grep(repo.repoId, { pattern: "camel_v2" });
    assert.ok(grepRes.matches.some((m) => m.path === "src/app.txt"));

    const hist = await camel.repos.history(repo.repoId, { limit: 10 });
    assert.ok(hist.commits.length >= 4, `expected >= 4 commits, got ${hist.commits.length}`);

    // Stop the VM through camelfsd and edit through the public API while it sleeps.
    const cfs = new CamelFsClient({ CAMELFS_URL: camelfsUrl, CAMELFS_SIGNING_KEY: camelfsSigningKey }, tenantId);
    const active = await cfs.ensureVm({ lineage: repo.lineage, ref: repo.defaultRef, holder: coder.id });
    assert.equal(active.reused, true);
    const liveLs = await camel.repos.ls(repo.repoId, { recursive: true });
    assert.ok(liveLs.entries.some((e) => e.path === "src/app.txt"));
    await cfs.stopVm(active.vmId, repo.lineage);
    await camel.repos.write(repo.repoId, { puts: [{ path: "asleep.txt", content: "edited-while-asleep" }] });

    const resumed = await coder.run(
      `Read after restart [CALL:bash {"command":"cat asleep.txt src/app.txt","cwd":"/workspace"}]`,
    );
    assert.equal(resumed.status, "completed");
    assert.match(resumed.text, /edited-while-asleep/);
    assert.match(resumed.text, /val=camel_v2/);
    const restarted = await cfs.ensureVm({ lineage: repo.lineage, ref: repo.defaultRef, holder: coder.id });
    assert.equal(restarted.reused, true);
    assert.notEqual(restarted.vmId, active.vmId);

    const bootsBeforeFailure = vmBootRequests;
    failNextExec = true;
    const interrupted = await coder.run(
      'Disconnect [CALL:bash {"command":"touch ambiguous.txt"}]',
    );
    assert.match(interrupted.text, /daemon disconnect probe/);
    assert.equal(vmBootRequests, bootsBeforeFailure, "an ambiguous exec must not trigger a replay");
    await assert.rejects(camel.repos.read(repo.repoId, { path: "ambiguous.txt" }));

    const afterDisconnect = await coder.run(
      'Check workspace [CALL:bash {"command":"cat asleep.txt"}]',
    );
    assert.match(afterDisconnect.text, /edited-while-asleep/);
    assert.equal(vmBootRequests, bootsBeforeFailure + 1, "the next bash call should refresh the VM");
    await cfs.stopVm(restarted.vmId, repo.lineage);

    await camel.close();
  });

  it("3. bidirectional WebSocket local SDK tools + QuickJS codemode calling SDK & repo tools", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "sdk-tools-tenant",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    const seenOrders: string[] = [];
    const lookupOrder = defineTool({
      name: "lookupOrder",
      description: "Fetch order status from host app memory",
      parameters: {
        type: "object",
        properties: { orderId: { type: "string" } },
        required: ["orderId"],
      },
      execute: async ({ orderId }: { orderId: string }) => {
        seenOrders.push(orderId);
        return { orderId, state: "shipped", totalUsd: 99 };
      },
    });

    const support = await camel.agents.upsert("support-ws", {
      model: "mock/default",
      tools: [lookupOrder],
      builtins: ["files", "codemode"],
    });

    // Direct SDK tool call over WebSocket
    const direct = await support.run(`Check order [CALL:lookupOrder {"orderId":"ORD-100"}]`);
    assert.equal(direct.status, "completed");
    assert.deepEqual(seenOrders, ["ORD-100"]);
    assert.match(direct.text, /shipped/);

    // QuickJS codemode script calling BOTH the host WebSocket SDK tool AND repo fs shim!
    const script = [
      `const ord = await tools.lookupOrder({ orderId: "ORD-200" });`,
      `await fs.writeFile("receipt.json", JSON.stringify(ord));`,
      `const saved = JSON.parse(await fs.readFile("receipt.json"));`,
      `return { verified: saved.state, total: saved.totalUsd };`,
    ].join(" ");
    const viaCodemode = await support.run(
      `Run codemode [CALL:codemode ${JSON.stringify({ code: script })}]`,
    );
    assert.equal(viaCodemode.status, "completed");
    assert.deepEqual(seenOrders, ["ORD-100", "ORD-200"]);
    assert.match(viaCodemode.text, /shipped/);

    await camel.close();
  });

  it("4. human approval & ask_human pause to input_required and resume cleanly to completed", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "human-gate-tenant",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    let refunded = false;
    const refundTool = defineTool({
      name: "issueRefund",
      description: "Issue customer refund",
      parameters: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
      requiresApproval: true,
      execute: async ({ amount }: { amount: number }) => {
        refunded = true;
        return { refunded: amount };
      },
    });

    const billingAgent = await camel.agents.upsert("refund-agent", {
      model: "mock/default",
      tools: [refundTool],
      builtins: ["human"],
    });

    const paused = await billingAgent.run(`Refund user [CALL:issueRefund {"amount":45}]`, { actor: "sender" });
    assert.equal(paused.status, "input_required");
    assert.equal(refunded, false);
    assert.equal(paused.inputs.length, 1);
    const runHeaders = { Authorization: "Bearer " + apiKey };
    const getPending = async () => {
      const response = await fetch(`${workerUrl}/v2/agents/${billingAgent.id}/inputs`, { headers: runHeaders });
      assert.equal(response.status, 200);
      return await response.json() as { runs: Array<{ id: string }> };
    };
    assert.deepEqual((await getPending()).runs.map(run => run.id), [paused.id]);

    const inputId = paused.inputs[0]!.id;
    assert.equal(paused.actor, "sender");
    for (const actor of [undefined, "different-sender"]) {
      await assert.rejects(billingAgent.answerInput(inputId, { approved: true, actor }), (error) =>
        error instanceof CamelRunError && error.code === "input_actor_mismatch");
    }
    assert.equal(refunded, false);
    const resumed = await billingAgent.answerInput(inputId, { approved: true, actor: "sender" });
    assert.equal(resumed.status, "completed");
    assert.equal(refunded, true);
    assert.match(resumed.text, /45/);
    assert.deepEqual((await getPending()).runs, []);

    // Also test ask_human question -> answer -> completion
    const asked = await billingAgent.run(`Ask deploy window [CALL:ask_human {"question":"Deploy now?"}]`);
    assert.equal(asked.status, "input_required");
    assert.equal(asked.inputs.length, 1);

    const answered = await billingAgent.answerInput(asked.inputs[0]!.id, { answer: "Yes, ship at 5pm" });
    assert.equal(answered.status, "completed");
    assert.match(answered.text, /Yes, ship at 5pm/);

    await camel.close();
  });

  it("switches an agent model only once its paused and queued turns are done", async (t) => {
    const { apiKey, tenantId } = await CamelRun.createTenant({
      baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "model-switch", initialCreditsUsd: 10,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());
    const agent = await camel.agents.upsert("model-switch", { model: "mock/default", builtins: ["human"] });
    const patchModel = async (expectedModel: string, bearer = apiKey) => {
      const response = await fetch(`${workerUrl}/v2/agents/${agent.id}/model`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "mock/sol", expectedModel }),
      });
      const body = await response.json() as { error?: { code: string }; model?: string; changed?: boolean };
      return { status: response.status, body };
    };

    assert.equal((await patchModel("mock/default", agent.agentToken!)).status, 403);
    const headers = { Authorization: `Bearer ${apiKey}` };
    const modelIndexFixture = `${workerUrl}/test-model-index/${tenantId}`;
    assert.equal((await fetch(modelIndexFixture, { method: "POST" })).status, 204);
    const unavailable = await patchModel("mock/default");
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.body.error?.code, "model_update_unavailable");
    const previousState = await fetch(`${workerUrl}/v2/agents/${agent.id}`, { headers });
    assert.equal((await previousState.json() as { model: string }).model, "mock/default");
    assert.equal((await fetch(modelIndexFixture + "?enabled=true", { method: "POST" })).status, 204);
    assert.equal((await patchModel("mock/another")).body.error?.code, "model_changed");
    const paused = await agent.run('Pause [CALL:ask_human {"question":"Continue?"}]');
    assert.equal(paused.status, "input_required");
    const queued = await agent.submit("Next old-model turn", { idempotencyKey: "before-switch", supersedeInputs: false });
    assert.equal(queued.status, "queued");
    const busy = await patchModel("mock/default");
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error?.code, "agent_busy");

    await agent.answerInput(paused.inputs[0]!.id, { answer: "Continue" });
    const drained = await agent.run("Next old-model turn", { idempotencyKey: "before-switch" });
    assert.equal(drained.id, queued.id);
    assert.equal(drained.status, "completed");
    assert.deepEqual(await patchModel("mock/default"), { status: 200, body: { model: "mock/sol", changed: true } });
    assert.deepEqual(await patchModel("mock/default"), { status: 200, body: { model: "mock/sol", changed: false } });
    const same = await camel.agents.upsert("model-switch", { instructions: "Retain the selected model" });
    assert.equal(same.id, agent.id);
    assert.equal(same.agentToken, agent.agentToken);
    const stateRes = await fetch(`${workerUrl}/v2/agents/${agent.id}`, { headers });
    const state = await stateRes.json() as { model: string; messageCount: number };
    assert.equal(state.model, "mock/sol");
    assert.ok(state.messageCount >= 4);
    const listRes = await fetch(`${workerUrl}/v2/agents`, { headers });
    const { agents } = await listRes.json() as { agents: Array<{ id: string; model: string }> };
    assert.equal(agents.find(row => row.id === agent.id)?.model, "mock/sol");
  });

  it("keeps an idle SSE follow open, streams the next run, and replays after Last-Event-ID", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "sse-follow",
      initialCreditsUsd: 10,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    const agent = await camel.agents.upsert("sse-follow", { model: "mock/default", builtins: [] });
    const url = `${workerUrl}/v2/agents/${agent.id}/events`;
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: "text/event-stream" };
    const signal = AbortSignal.timeout(7_000);
    const unauthorized = await fetch(url, { headers: { Accept: "text/event-stream" }, signal });
    assert.equal(unauthorized.status, 401);
    await unauthorized.body?.cancel();

    const stream = await fetch(url + "?follow=1", { headers, signal });
    assert.equal(stream.status, 200);
    const events: SSEMessage[] = [];
    const collect = (async () => {
      for await (const event of parseSSE(stream.body!, signal)) {
        events.push(event);
        if (event.event === "run_completed") return;
      }
      assert.fail("The follow stream closed before the run finished");
    })();
    const [run] = await Promise.all([agent.run("A run after subscribing to the idle agent"), collect]);
    assert.equal(run.status, "completed");
    assert.ok(events.some(event => event.event === "text_delta"));
    assert.ok(events.every(event => JSON.parse(event.data).runId === run.id));
    const runUrl = url + "?" + new URLSearchParams({ runId: run.id });
    const replay = await fetch(runUrl, { headers: { ...headers, "Last-Event-ID": events[0]!.id! }, signal });
    assert.equal(replay.status, 200);
    const caughtUp: SSEMessage[] = [];
    for await (const event of parseSSE(replay.body!, signal)) caughtUp.push(event);
    assert.deepEqual(caughtUp, events.slice(1));
    await camel.close();
  });

  it("settles queued runs before deleting an agent during its batch window", { timeout: 15_000 }, async (t) => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "delete-batching-agent",
      initialCreditsUsd: 1,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());
    const agent = await camel.agents.upsert("delete-batcher", {
      model: "mock/default",
      queue: { mode: "batch", windowMs: 5_000 },
    });
    const idempotencyKey = "delete-queued-run";
    const run = agent.run("This run should be cancelled", {
      idempotencyKey,
      signal: AbortSignal.timeout(10_000),
    });
    const deletion = (async () => {
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline) {
        try {
          const record = await agent.getRunByKey(idempotencyKey);
          assert.equal(record.status, "queued");
          return await agent.delete();
        } catch (err) {
          if (!(err instanceof CamelRunError) || err.code !== "run_not_found") throw err;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      assert.fail("Run did not enter the queue before deletion");
    })();
    const [cancelled, deleted] = await Promise.all([run, deletion]);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(deleted.deleted, true);
    assert.equal((await camel.agents.list()).length, 0);
  });

  it("5. SSE streaming, idempotency, batch queue coalescing, compaction, resetContext, and instant agent+repo fork", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "lifecycle-tenant",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    const agent = await camel.agents.upsert("lead-agent", {
      model: "mock/default",
      builtins: ["files", "bash"],
      queue: { mode: "batch", windowMs: 80 },
    });

    // SSE stream yields live deltas
    const deltas: string[] = [];
    const stream = agent.stream("Stream me a friendly greeting and write v1 [CALL:write_file {\"path\":\"version.txt\",\"content\":\"v1\\n\"}]");
    for await (const ev of stream) {
      if (ev.type === "text_delta" || (ev.data && typeof (ev.data as { delta?: unknown }).delta === "string")) {
        deltas.push(String((ev.data as { delta?: string })?.delta ?? ""));
      }
    }
    const finalStreamRun = await stream.result;
    assert.equal(finalStreamRun.status, "completed");
    assert.ok(deltas.length >= 1);

    // Idempotency key returns identical run without re-executing
    const idem1 = await agent.run("Count once", { idempotencyKey: "idem-key-1" });
    const idem2 = await agent.run("Count once", { idempotencyKey: "idem-key-1" });
    assert.equal(idem1.id, idem2.id);
    assert.equal((await agent.getRunByKey("idem-key-1")).id, idem1.id);

    // Compaction summarizes history while preserving full /history
    await agent.compact();
    const history = await agent.history();
    assert.ok(history.length >= 4);
    const latest = await agent.history({ before: "latest", limit: 2 });
    assert.deepEqual(latest, history.slice(-2));
    assert.deepEqual(await agent.history({ before: latest[0]!.seq!, limit: 2 }), history.slice(-4, -2));

    // Fork creates an independent agent + forked camelfs repo
    const forked = await agent.fork({ key: "lead-agent-fork" });
    assert.notEqual(forked.id, agent.id);
    assert.notEqual(forked.repoId, agent.repoId);

    // Mutate file inside fork via bash; original repo stays at v1!
    await forked.run(`Bump fork [CALL:bash {"command":"echo v2-fork > version.txt"}]`);
    const origVersion = await camel.repos.read((await camel.agents.get(agent.id)).repoId!, { path: "version.txt" });
    const forkVersion = await camel.repos.read(forked.repoId!, { path: "version.txt" });
    assert.equal(origVersion.content, "v1\n");
    assert.equal(forkVersion.content, "v2-fork\n");

    // Reset context
    await forked.resetContext({ summary: "Fresh slate", keepLast: 1 });
    const afterReset = await forked.run("Still alive after reset");
    assert.equal(afterReset.status, "completed");

    await camel.close();
  });

  it("6. sub-agent delegation and deterministic replay-cached QuickJS workflows", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "orch-tenant",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    const coordinator = await camel.agents.upsert("coordinator", {
      model: "mock/default",
      builtins: ["files", "bash", "delegate", "workflows"],
    });

    // Sub-agent delegation
    const delRun = await coordinator.run(
      `Delegate task [CALL:delegate {"prompt":"Summarize module A","key":"sub-worker-a"}]`,
    );
    assert.equal(delRun.status, "completed");
    assert.match(delRun.text, /Summarize module A/);

    // Replay-based workflow running parallel child agents + bash + commit
    const wfCode = `
      const [a, b] = await wf.parallel([
        () => wf.agent("Analyze frontend"),
        () => wf.agent("Analyze backend"),
      ]);
      const sh = await wf.bash("echo workflow-ok > wf.txt && cat wf.txt");
      const c = await wf.commit("record workflow output");
      return { a: a.text, b: b.text, bashOut: sh.stdout.trim(), commit: c.commit };
    `;
    const wf1 = await coordinator.runWorkflow(wfCode, { idempotencyKey: "wf-scope-1" });
    assert.equal(wf1.status, "completed");
    const out1 = wf1.output as { bashOut: string };
    assert.equal(out1.bashOut, "workflow-ok");

    // Re-running with the same idempotency scope hits SQLite step_cache (0 re-executed steps!)
    const wf2 = await coordinator.runWorkflow(wfCode, { idempotencyKey: "wf-scope-1" });
    assert.equal(wf2.status, "completed");
    assert.deepEqual(wf2.output, wf1.output);
    if (typeof wf2.cachedSteps === "number") {
      assert.ok(wf2.cachedSteps >= 3, `expected >= 3 cached steps on replay, got ${wf2.cachedSteps}`);
    }

    await camel.close();
  });

  it("7. remote MCP tools, stateless structured runs, decisions, VoiceDO bridge, channels, R2 media, dreaming, and webhooks", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "platform-extras",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    // Register webhook
    const wh = await camel.webhooks.create({
      url: `${auxUrl}/webhook`,
      events: ["run.completed"],
    });
    assert.ok(wh.id);

    // Remote HTTP MCP Server discovery & invocation + Dreaming into camelfs MEMORY.md
    const mcpAgent = await camel.agents.upsert("mcp-dreamer", {
      model: "mock/default",
      mcpServers: [{ name: "meteo", url: `${auxUrl}/mcp`, deferred: false }],
      builtins: ["files"],
    });
    const mcpRun = await mcpAgent.run(
      `Check weather [CALL:meteo__weather_forecast {"city":"San Francisco"}]`,
    );
    assert.equal(mcpRun.status, "completed");
    assert.match(mcpRun.text, /72F and sunny in San Francisco/);

    const dreamRes = await mcpAgent.dream();
    assert.ok(dreamRes);
    const refreshedAgent = await camel.agents.get(mcpAgent.id);
    const memoryDoc = await camel.repos.read(refreshedAgent.repoId!, { path: "MEMORY.md" });
    assert.match(memoryDoc.content ?? "", /Consolidated Agent Memory/);

    // Stateless run with JSON outputSchema
    const stateless = await camel.runs.create<{ urgency: string; score: number }>({
      model: "mock/default",
      instructions: "Extract ticket triage JSON.",
      input: 'Server down! [JSON:{"urgency":"critical","score":99}]',
      outputSchema: {
        type: "object",
        properties: { urgency: { type: "string" }, score: { type: "number" } },
        required: ["urgency", "score"],
      },
    });
    assert.equal(stateless.status, "completed");
    assert.deepEqual(stateless.output, { urgency: "critical", score: 99 });

    // Calibrated decisions API
    const decision = await camel.decisions.decide({
      input: "Please refund my duplicate invoice charge immediately",
      choices: ["billing", "technical", "sales"],
      model: "mock/default",
    });
    assert.ok(["billing", "technical", "sales"].includes(decision.choice));
    assert.ok(decision.confidence > 0 && decision.confidence <= 1);

    // Folded AgentDO voice session (both HTTP /tool RPC and hibernatable /ws)
    const voice = await camel.voice.createSession({
      agentIdOrKey: mcpAgent.key,
      provider: "openai",
      voice: "alloy",
    });
    assert.ok(voice.sessionId.startsWith("vs_"));
    const voiceTool = await camel.voice.invokeTool(voice.sessionId, {
      name: "write_file",
      args: { path: "voice-note.txt", content: "recorded during voice call\n" },
    });
    assert.ok(voiceTool);

    // Also verify live voice WebSocket tool_call directly on AgentDO
    const wsVoiceUrl = `${workerUrl.replace("http://", "ws://")}/v2/voice/sessions/${encodeURIComponent(voice.sessionId)}/ws?token=${encodeURIComponent(apiKey)}`;
    await new Promise<void>((resolve, reject) => {
      const vws = new globalThis.WebSocket(wsVoiceUrl);
      vws.addEventListener("open", () => {
        vws.send(
          JSON.stringify({
            type: "tool_call",
            callId: "vt_ws_1",
            name: "write_file",
            args: { path: "voice-ws.txt", content: "via voice ws\n" },
          }),
        );
      });
      vws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data)) as { type: string; ok?: boolean };
        if (msg.type === "tool_result") {
          vws.close();
          if (msg.ok) resolve();
          else reject(new Error("voice ws tool_call failed"));
        }
      });
      vws.addEventListener("error", () => reject(new Error("voice ws error")));
    });

    const voiceFile = await camel.repos.read(refreshedAgent.repoId!, { path: "voice-note.txt" });
    assert.equal(voiceFile.content, "recorded during voice call\n");
    const voiceWsFile = await camel.repos.read(refreshedAgent.repoId!, { path: "voice-ws.txt" });
    assert.equal(voiceWsFile.content, "via voice ws\n");

    // Channels inbound routing into keyed channel agent
    const ch = await camel.channels.create({
      kind: "slack",
      agentKey: "slack-bot",
    });
    const inbound = await camel.channels.sendInbound(ch.id, {
      threadId: "C123-T1",
      text: "Hello from Slack thread!",
      user: "U999",
    });
    assert.ok(inbound);

    // Media (R2 image generation + fetch, speech, transcription)
    const img = await camel.media.generateImage({ prompt: "desert camel at sunset" });
    assert.ok(img.id);
    const imgRec = await camel.media.getImage(img.id);
    assert.ok((imgRec.data?.byteLength ?? 0) > 0);

    const speech = await camel.media.speech({ input: "Welcome to camelRun v2" });
    assert.ok((speech.audio?.byteLength ?? 0) > 0);

    const transcript = await camel.media.transcribe({
      file: new TextEncoder().encode("fake-audio-frame"),
      mimeType: "audio/wav",
      prompt: "camelRun",
    });
    assert.equal(typeof transcript.text, "string");

    // Wait briefly for EVENTS_QUEUE batch delivery to hit our webhook endpoint
    const whDeadline = Date.now() + 3_000;
    const runDelivery = () => receivedWebhooks.find(({ headers }) => headers["x-camelrun-event"] === "run.completed");
    while (!runDelivery() && Date.now() < whDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const delivered = runDelivery();
    assert.ok(delivered, "expected signed webhook delivery from Cloudflare Queue");
    const sigHeader = delivered.headers["x-camelrun-signature"];
    assert.equal(typeof sigHeader, "string");
    assert.match(String(sigHeader), /v1=[0-9a-f]{64}/);

    await camel.close();
  });

  it("routes provider model aliases without changing the agent model or billing", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "provider-aliases", initialCreditsUsd: 1,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    const model = "azure/deepseek-v4.1-flash";
    const baseUrl = `${auxUrl}/v1`;
    await camel.providers.set("azure", {
      apiKey: "initial-key",
      baseUrl,
      modelAliases: { "deepseek-v4.1-flash": "deployment-flash" },
    });
    await camel.providers.set("azure", { apiKey: "rotated-key", baseUrl });

    const agent = await camel.agents.upsert("aliased-agent", { model });
    const run = await agent.run("Use the configured Azure deployment.");
    assert.equal(run.status, "completed");
    assert.match(run.text, /SSE upstream \(deployment-flash\) saw/);
    assert.equal(agent.model, model);
    assert.equal(run.usage.costUsd, 0.0000174);

    await camel.providers.set("azure", { apiKey: "rotated-key", baseUrl, modelAliases: {} });
    const unaliased = await agent.run("Use the upstream model name directly.");
    assert.equal(unaliased.status, "completed");
    assert.match(unaliased.text, /SSE upstream \(deepseek-v4\.1-flash\) saw/);
    await camel.close();
  });

  it("8. AES-GCM sealed upstream OpenAI SSE provider, definitions inheritance, schedules CRUD, and batch coalescing", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "sse-batch-tenant",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({
      baseUrl: workerUrl,
      apiKey,
      WebSocket: globalThis.WebSocket as unknown as NonNullable<ConstructorParameters<typeof CamelRun>[0]["WebSocket"]>,
    });

    // Store encrypted upstream OpenRouter provider pointing at our local SSE server
    await camel.providers.set("openrouter", {
      apiKey: "sk-or-local-sse-secret",
      baseUrl: `${auxUrl}/v1`,
    });

    // Create reusable agent definition using Muse Ember and inherit from it
    await camel.definitions.upsert("sse-assistant", {
      model: "openrouter/meta/muse-ember",
      instructions: "Use upstream SSE.",
    });
    const defs = await camel.definitions.list();
    assert.equal(defs.length, 1);

    const sseAgent = await camel.agents.upsert("live-sse-agent", {
      definition: "sse-assistant",
    });
    assert.equal(sseAgent.model, "openrouter/meta/muse-ember");
    const sseRun = await sseAgent.run("Hello live Muse Ember SSE adapter!");
    assert.equal(sseRun.status, "completed");
    assert.match(sseRun.text, /SSE upstream \(meta\/muse-ember\) saw/);
    assert.equal(sseRun.usage.inputTokens, 18);
    assert.equal(sseRun.usage.outputTokens, 10);
    // 18 * $0.10/1M + 10 * $0.50/1M = $0.0000068
    assert.equal(sseRun.usage.costUsd, 0.0000068);
    assert.deepEqual(lastProviderOptions, { data_collection: "deny" });

    const assets = await camel.repos.create({ name: "attachments" });
    const originalImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmfQAAAAASUVORK5CYII=";
    const attachedVersion = await camel.repos.write(assets.repoId, {
      puts: [
        { path: "notes.txt", content: "Original notes" },
        { path: "image.png", base64: originalImage },
      ],
    });
    await camel.repos.write(assets.repoId, {
      puts: [{ path: "notes.txt", content: "Revised notes" }],
      deletes: ["image.png"],
    });
    const attachmentAgent = await camel.agents.upsert("attachment-agent", {
      definition: "sse-assistant",
      repoId: assets.repoId,
    });
    const files = [
      { path: "notes.txt", commit: attachedVersion.commit, contentType: "text/plain" },
      { path: "image.png", commit: attachedVersion.commit, contentType: "image/png" },
    ];
    const stream = attachmentAgent.stream("Use these specific revisions", { files });
    for await (const event of stream) assert.ok(event.type);
    assert.equal((await stream.result).status, "completed");
    assert.deepEqual(lastProviderMessages?.at(-1)?.content, [
      { type: "text", text: [
        "Use these specific revisions",
        `Workspace attachment "notes.txt" at commit ${attachedVersion.commit} (text/plain, 14 bytes).`,
        `Workspace attachment "image.png" at commit ${attachedVersion.commit} (image/png, ${Buffer.from(originalImage, "base64").length} bytes).`,
      ].join("\n") },
      { type: "image_url", image_url: { url: `data:image/png;base64,${originalImage}` } },
    ]);
    assert.equal((await camel.repos.read(assets.repoId, { at: attachedVersion.commit, path: "notes.txt" })).content, "Original notes");
    const history = await attachmentAgent.history();
    assert.deepEqual(
      (history[0]?.content as { files: Array<{ path: string; commit: string }> }).files.map(({ path, commit }) => ({ path, commit })),
      files.map(({ path, commit }) => ({ path, commit })),
    );
    await assert.rejects(attachmentAgent.run("Use this file", {
      files: [{ ...files[0]!, path: "missing.txt" }],
    }), /Attachment missing.txt is missing/);
    assert.equal((await attachmentAgent.history()).length, history.length);

    // Schedules CRUD
    const sched = await sseAgent.schedules.create({
      prompt: "Hourly health check",
      intervalSeconds: 3600,
    });
    assert.ok(sched.id);
    assert.equal((await sseAgent.schedules.list()).length, 1);
    await sseAgent.schedules.delete(sched.id);
    assert.equal((await sseAgent.schedules.list()).length, 0);

    // Concurrent batch queue coalescing (batchedInto)
    const batcher = await camel.agents.upsert("inbox-batcher", {
      model: "mock/default",
      queue: { mode: "batch", windowMs: 120 },
    });
    const [b1, b2, b3] = await Promise.all([
      batcher.run("First burst item"),
      batcher.run("Second burst item"),
      batcher.run("Third burst item"),
    ]);
    assert.equal(b1.status, "completed");
    assert.equal(b2.status, "completed");
    assert.equal(b3.status, "completed");
    assert.ok(
      b2.batchedInto !== null || b3.batchedInto !== null,
      `expected queued burst items to coalesce via batchedInto (${JSON.stringify([b1.batchedInto, b2.batchedInto, b3.batchedInto])})`,
    );

    await camel.close();
  });

  it("keeps a queued run's spend limit and actor after a Worker restart", async (t) => {
    const { apiKey } = await CamelRun.createTenant({ baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "restart-run-context" });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());
    const agent = await camel.agents.upsert("restart-run-context", { model: "mock/default", builtins: ["human"] });
    const repoPath = `${workerUrl}/v2/agents/${agent.id}/repo`;
    const ensureRepo = (key: string) => fetch(repoPath, { method: "PUT", headers: { Authorization: `Bearer ${key}` } });
    assert.equal((await ensureRepo(agent.agentToken!)).status, 403);
    const repos = await Promise.all([ensureRepo(apiKey), ensureRepo(apiKey)]);
    assert.deepEqual(repos.map((response) => response.status), [200, 200]);
    const [firstRepo, secondRepo] = await Promise.all(repos.map((response) => response.json()));
    assert.ok(firstRepo && typeof firstRepo === "object" && "repoId" in firstRepo && firstRepo.repoId);
    assert.deepEqual(secondRepo, firstRepo);
    const paused = await agent.run('Pause the queue [CALL:ask_human {"question":"Continue?"}]');
    assert.equal(paused.status, "input_required");
    const capped = await agent.submit("Wait with no spend left", { spendLimitUsd: 0, idempotencyKey: "capped", supersedeInputs: false });
    const attributed = await agent.submit("Wait with a sender", { actor: "returning-member", idempotencyKey: "attributed", supersedeInputs: false });
    assert.equal(capped.status, "queued");
    assert.equal(attributed.status, "queued");

    await worker.dispose();
    await startWorker();
    await agent.answerInput(paused.inputs[0]!.id, { answer: "Continue" });
    await assert.rejects(agent.run("See queued run", { idempotencyKey: "capped" }), (error: unknown) =>
      error instanceof CamelRunError && error.code === "spend_limit_exceeded");
    const completed = await agent.run("See queued run", { idempotencyKey: "attributed" });
    assert.equal(completed.id, attributed.id);
    const content = (await agent.history()).find(message => message.runId === attributed.id && message.role === "user")?.content;
    assert.ok(content && typeof content === "object" && "meta" in content);
    assert.deepEqual(content.meta, { actor: "returning-member", requestId: "attributed" });
  });

  it("drains already accepted turns when a pending input expires without another request", async (t) => {
    const { apiKey } = await CamelRun.createTenant({ baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "expired-input-queue" });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());
    const agent = await camel.agents.upsert("expired-input-queue", { model: "mock/default", builtins: ["human"] });
    const paused = await agent.run('Pause [CALL:ask_human {"question":"Continue?"}]');
    assert.equal(paused.status, "input_required");
    const queued = await agent.submit("This turn must survive without a new request", { idempotencyKey: "queued", supersedeInputs: false });
    assert.equal(queued.status, "queued");
    const control = `${workerUrl}/test-alarm/${agent.id}`;
    assert.equal((await fetch(control, { method: "POST" })).status, 204);
    const deadline = Date.now() + 8000;
    let status: unknown;
    do {
      await new Promise(resolve => setTimeout(resolve, 100));
      status = await (await fetch(`${control}?runId=${queued.id}`)).json();
    } while (status !== "completed" && Date.now() < deadline);
    assert.equal(status, "completed");
    assert.equal(await (await fetch(`${control}?runId=${paused.id}`)).json(), "failed");
    const replay = await agent.run("Do not run this again", { idempotencyKey: "queued" });
    assert.equal(replay.id, queued.id);
    const messages = await agent.history();
    assert.equal(messages.filter(message => message.runId === queued.id && message.role === "user").length, 1);
  });

  it("wakes a reset isolate for an accepted turn and flags the overdue queue", async (t) => {
    const { apiKey } = await CamelRun.createTenant({ baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "reset-queue-watch" });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());
    const agent = await camel.agents.upsert("reset-queue-watch", {
      model: "mock/default", builtins: [], queue: { mode: "batch", windowMs: 2000 },
    });
    const queued = await agent.submit("Recover this accepted turn", { idempotencyKey: "recover" });
    assert.equal(queued.status, "queued");
    const control = `${workerUrl}/test-alarm/${agent.id}`;
    const statusUrl = `${control}?runId=${queued.id}`;
    assert.equal((await fetch(statusUrl, { method: "POST" })).status, 204);

    const deadline = Date.now() + 8000;
    let status: unknown;
    do {
      await new Promise(resolve => setTimeout(resolve, 125));
      status = await (await fetch(statusUrl)).json();
    } while (status !== "completed" && Date.now() < deadline);
    assert.equal(status, "completed");
    assert.match(await (await fetch(control)).json() as string, new RegExp(`^${queued.id}:`));
    const history = await agent.history();
    assert.equal(history.filter(message => message.runId === queued.id && message.role === "user").length, 1);
  });

  it("serves repo read-all snapshots, models catalog, usage days, busyAgents, voice search, and speech text alias", async (t) => {
    const { apiKey } = await CamelRun.createTenant({ baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "v2-parity-routes" });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());
    await camel.providers.set("openrouter", { apiKey: "fake-key", baseUrl: `${auxUrl}/v1` });

    const repo = await camel.repos.create({ name: "bot-repo" });
    const written = await camel.repos.write(repo.repoId, {
      puts: [
        { path: "bot.ts", content: "export default {};\n" },
        { path: "src/helper.ts", content: "export const x = 1;\n" },
      ],
    });
    const readAllRes = await fetch(`${workerUrl}/v2/repos/${repo.repoId}/read-all`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(readAllRes.status, 200);
    const readAll = (await readAllRes.json()) as { commit: string; files: Array<{ path: string; content: string | null }> };
    assert.equal(readAll.commit, written.commit);
    assert.deepEqual(
      readAll.files.map((f) => [f.path, f.content]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      [["bot.ts", "export default {};\n"], ["src/helper.ts", "export const x = 1;\n"]],
    );

    const modelsRes = await fetch(`${workerUrl}/v2/models?available=true`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(modelsRes.status, 200);
    const models = (await modelsRes.json()) as Array<{ id: string; available: boolean }>;
    assert.ok(models.some((m) => m.id === "openrouter/meta/muse-ember" && m.available));

    const billingRes = await fetch(`${workerUrl}/v2/billing`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(billingRes.status, 200);
    const billing = (await billingRes.json()) as { busyAgents?: { busy: number; limit: number | null } };
    assert.equal(typeof billing.busyAgents?.busy, "number");
    assert.ok(typeof billing.busyAgents?.limit === "number" || billing.busyAgents?.limit === null);

    const usageRes = await fetch(`${workerUrl}/v2/usage?days=7`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(usageRes.status, 200);
    const usage = (await usageRes.json()) as { days: unknown[] };
    assert.ok(Array.isArray(usage.days));

    const voicesRes = await fetch(`${workerUrl}/v2/voices/search?provider=openai&q=alloy`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    assert.equal(voicesRes.status, 200);
    const voices = (await voicesRes.json()) as { voices: Array<{ provider: string; id: string }> };
    assert.equal(voices.voices.length, 1);
    assert.equal(voices.voices[0]!.id, "alloy");

    const speechRes = await fetch(`${workerUrl}/v2/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hello world", model: "mock/tts", format: "wav" }),
    });
    assert.equal(speechRes.status, 200);
    assert.ok((await speechRes.arrayBuffer()).byteLength > 44);
  });

  it("supports git-native refs, leases, restore CAS, repo diff, and bounded agent file tools", async (t) => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl,
      adminKey: ADMIN_SECRET,
      name: "git-native-repos",
      initialCreditsUsd: 50,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    t.after(() => camel.close());

    const repo = await camel.repos.create({ name: "git-native-test" });

    // 1. Seed initial commit c1 with text, unchanged, and binary files.
    const pngBase64 = toolImage;
    const w1 = await camel.repos.write(repo.repoId, {
      message: "commit 1",
      puts: [
        { path: "keep.txt", content: "never changes\n" },
        { path: "src/app.ts", content: "const a = 1;\nconst b = 2;\nconst c = 3;\n" },
        { path: "drop.txt", content: "to be deleted\n" },
        { path: "img.png", base64: pngBase64 },
      ],
    });

    // 2. POST /v2/repos/:repoId/refs — validation + create ref + CAS conflict.
    const invalidRefRes = await fetch(`${workerUrl}/v2/repos/${repo.repoId}/refs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", commit: w1.commit }),
    });
    assert.equal(invalidRefRes.status, 400);

    const traversalRefRes = await fetch(`${workerUrl}/v2/repos/${repo.repoId}/refs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "refs/heads/a..b", commit: w1.commit }),
    });
    assert.equal(traversalRefRes.status, 400);

    const createdRef = await camel.repos.updateRef(repo.repoId, {
      ref: "refs/camel/live",
      commit: w1.commit,
    });
    assert.equal(createdRef.ref, "refs/camel/live");
    assert.equal(createdRef.commit, w1.commit);

    // Write second commit c2 on refs/heads/main.
    const w2 = await camel.repos.write(repo.repoId, {
      message: "commit 2",
      puts: [
        { path: "src/app.ts", content: "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n" },
        { path: "added.ts", content: "export const ok = true;\n" },
        { path: "img.png", base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString("base64") },
      ],
      deletes: ["drop.txt"],
    });

    // Stale expectedCommit on updateRef returns HTTP 409.
    await assert.rejects(
      () => camel.repos.updateRef(repo.repoId, {
        ref: "refs/camel/live",
        commit: w2.commit,
        expectedCommit: "0".repeat(64),
      }),
      (err: unknown) => err instanceof CamelRunError && err.status === 409,
    );

    // 3. GET /v2/repos/:repoId/diff (using ref names, statOnly, path filter, and maxBytes).
    const fullDiff = await camel.repos.diff(repo.repoId, {
      from: "refs/camel/live",
      to: "HEAD",
    });
    assert.equal(fullDiff.from, w1.commit);
    assert.equal(fullDiff.to, w2.commit);
    assert.equal(fullDiff.identical, false);
    assert.equal(fullDiff.truncated, false);
    assert.deepEqual(fullDiff.summary, { added: 1, modified: 2, deleted: 1, totalFiles: 4 });
    const diffByPath = new Map(fullDiff.files.map((f) => [f.path, f]));
    assert.ok(!diffByPath.has("keep.txt"), "unchanged file must be excluded");
    assert.equal(diffByPath.get("img.png")?.binary, true);
    assert.equal(diffByPath.get("img.png")?.patch, undefined);
    assert.equal(diffByPath.get("src/app.ts")?.additions, 2);
    assert.equal(diffByPath.get("src/app.ts")?.deletions, 1);
    assert.match(diffByPath.get("src/app.ts")?.patch ?? "", /-const b = 2;\n\+const b = 20;/);
    assert.equal(diffByPath.get("added.ts")?.status, "added");
    assert.equal(diffByPath.get("drop.txt")?.status, "deleted");

    const statDiff = await camel.repos.diff(repo.repoId, {
      from: "refs/camel/live",
      to: "refs/heads/main",
      statOnly: true,
    });
    assert.equal(statDiff.summary.totalFiles, 4);
    assert.ok(statDiff.files.every((f) => f.patch === undefined));

    const pathDiff = await camel.repos.diff(repo.repoId, {
      from: w1.commit,
      to: w2.commit,
      path: "src/app.ts",
    });
    assert.equal(pathDiff.files.length, 1);
    assert.equal(pathDiff.files[0]?.path, "src/app.ts");

    const truncatedDiff = await camel.repos.diff(repo.repoId, {
      from: w1.commit,
      to: w2.commit,
      maxBytes: 40,
    });
    assert.equal(truncatedDiff.truncated, true);

    // 4. POST /v2/repos/:repoId/lease — acquire, 409 conflict for intruder, release.
    const lease1 = await camel.repos.leaseRef(repo.repoId, {
      ref: "refs/camel/live",
      holder: "worker-a",
      ttlMs: 30_000,
    });
    assert.equal(lease1.holder, "worker-a");
    assert.ok(lease1.epoch >= 1);

    await assert.rejects(
      () => camel.repos.leaseRef(repo.repoId, {
        ref: "refs/camel/live",
        holder: "worker-b",
        ttlMs: 30_000,
      }),
      (err: unknown) => err instanceof CamelRunError && err.status === 409,
    );

    // Update ref by wrong holder while leased fails with 409.
    await assert.rejects(
      () => camel.repos.updateRef(repo.repoId, {
        ref: "refs/camel/live",
        commit: w2.commit,
        expectedCommit: w1.commit,
        holder: "worker-b",
      }),
      (err: unknown) => err instanceof CamelRunError && err.status === 409,
    );

    // Update ref by lease holder succeeds.
    const movedRef = await camel.repos.updateRef(repo.repoId, {
      ref: "refs/camel/live",
      commit: w2.commit,
      expectedCommit: w1.commit,
      holder: "worker-a",
    });
    assert.equal(movedRef.commit, w2.commit);

    const released = await camel.repos.leaseRef(repo.repoId, {
      ref: "refs/camel/live",
      holder: "worker-a",
      release: true,
    });
    assert.equal(released.holder, "");

    // Delete custom ref cleanly.
    await camel.repos.updateRef(repo.repoId, {
      ref: "refs/camel/live",
      delete: true,
    });

    // 5. POST /v2/repos/:repoId/restore CAS support.
    await assert.rejects(
      () => camel.repos.restore(repo.repoId, {
        targetCommit: w1.commit,
        expectedCommit: w1.commit, // stale: HEAD is w2.commit!
      }),
      (err: unknown) => err instanceof CamelRunError && err.status === 409 && err.code === "conflict",
    );

    const restored = await camel.repos.restore(repo.repoId, {
      targetCommit: w1.commit,
      expectedCommit: w2.commit,
      message: "cas restore",
    });
    assert.equal(restored.tree, w1.tree);

    // 6. Builtin agent file tools: bounded read_file, edit_file multi-match error, delete_file updateRepoCommit, repo_diff.
    const bigLines = Array.from({ length: 60 }, (_, i) => `line-${i + 1}: ${i % 10 === 0 ? "DUP_TOKEN" : "val"}`).join("\n") + "\n";
    const seedForAgent = await camel.repos.write(repo.repoId, {
      message: "seed agent file",
      puts: [
        { path: "big.txt", content: bigLines },
        { path: "temp.txt", content: "delete me\n" },
      ],
    });

    const agent = await camel.agents.upsert("git-tools-agent", {
      model: "mock/default",
      repoId: repo.repoId,
      builtins: ["files"],
    });

    const readRangeRun = await agent.run(
      `Read lines [CALL:read_file {"path":"big.txt","start_line":10,"end_line":12}]`,
    );
    assert.equal(readRangeRun.status, "completed");
    assert.match(readRangeRun.text, /10: line-10: val/);
    assert.match(readRangeRun.text, /11: line-11: DUP_TOKEN/);
    assert.match(readRangeRun.text, /12: line-12: val/);
    assert.match(readRangeRun.text, /"totalLines":60/);
    assert.match(readRangeRun.text, /"truncated":false/);

    // Byte-capped read_file line range sets truncated: true.
    const readTruncRun = await agent.run(
      `Read capped [CALL:read_file {"path":"big.txt","start_line":1,"end_line":60,"limit":60}]`,
    );
    assert.equal(readTruncRun.status, "completed");
    assert.match(readTruncRun.text, /"truncated":true/);

    // Backwards compatibility: read_file without start_line/end_line returns unnumbered content via pi-durable read tool.
    const readCompatRun = await agent.run(
      `Read raw [CALL:read_file {"path":"temp.txt"}]`,
    );
    assert.equal(readCompatRun.status, "completed");
    assert.match(readCompatRun.text, /delete me/);

    // edit_file with multiple matches and replaceAll omitted must return an actionable error with count and line numbers.
    const multiMatchRun = await agent.run(
      `Try ambiguous edit [CALL:edit_file {"path":"big.txt","oldString":"DUP_TOKEN","newString":"FIXED"}]`,
    );
    assert.equal(multiMatchRun.status, "completed");
    assert.match(multiMatchRun.text, /matched 6 times/);
    assert.match(multiMatchRun.text, /lines 1, 11, 21, 31, 41, 51/);

    // File must remain unmodified after rejected ambiguous edit.
    const afterReject = await camel.repos.read(repo.repoId, { path: "big.txt" });
    assert.equal(afterReject.content, bigLines);

    // edit_file with replaceAll: true succeeds across all occurrences.
    const replaceAllRun = await agent.run(
      `Replace all [CALL:edit_file {"path":"big.txt","oldString":"DUP_TOKEN","newString":"FIXED","replaceAll":true}]`,
    );
    assert.equal(replaceAllRun.status, "completed");
    const afterReplaceAll = await camel.repos.read(repo.repoId, { path: "big.txt" });
    assert.ok(!afterReplaceAll.content?.includes("DUP_TOKEN"));
    assert.equal(afterReplaceAll.content?.match(/FIXED/g)?.length, 6);

    // delete_file updates repo commit cleanly.
    const deleteRun = await agent.run(
      `Delete temp [CALL:delete_file {"path":"temp.txt","message":"cleanup temp"}]`,
    );
    assert.equal(deleteRun.status, "completed");
    const repoAfterDelete = await camel.repos.get(repo.repoId);
    assert.notEqual(repoAfterDelete.commit, seedForAgent.commit);

    // repo_diff builtin tool compares seedForAgent -> current branch.
    const diffRun = await agent.run(
      `Diff changes [CALL:repo_diff {"from":"${seedForAgent.commit}"}]`,
    );
    assert.equal(diffRun.status, "completed");
    assert.match(diffRun.text, /temp\.txt/);
    assert.match(diffRun.text, /"deleted":1/);
  });
});
