import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";
import { CamelRun, CamelRunError, defineTool } from "../sdk/src/index.ts";

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
  let camelfsdProc: ChildProcess;
  let camelfsUrl: string;
  let auxServer: Server;
  let auxUrl: string;
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  let workerUrl: string;
  const receivedWebhooks: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];

  before(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "camelrun-next-e2e-"));
    const keys = generateEd25519Pair();

    // 1. Start local MCP + Webhook test HTTP server
    const auxPort = await getFreePort();
    auxUrl = `http://127.0.0.1:${auxPort}`;
    auxServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const rawBody = Buffer.concat(chunks).toString("utf8");

      if (req.url === "/mcp" && req.method === "POST") {
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
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { content: [{ type: "text", text: `72F and sunny in ${args.city ?? "unknown"}` }] },
            }),
          );
          return;
        }
      }

      if (req.url === "/webhook" && req.method === "POST") {
        receivedWebhooks.push({ headers: req.headers, body: rawBody });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: true }));
        return;
      }

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        const body = JSON.parse(rawBody) as {
          model?: string;
          messages?: Array<{ role: string; content: unknown }>;
        };
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

    // 2. Start real compiled Go camelfsd server with Ed25519 public key verification
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
    await waitForHealth(`${camelfsUrl}/healthz`);

    // 3. Start real Cloudflare workerd via Wrangler using an isolated test config
    const baseConfig = JSON.parse(readFileSync(join(ROOT, "worker/wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
    const testConfigPath = join(tempDir, "wrangler.test.jsonc");
    writeFileSync(
      testConfigPath,
      JSON.stringify(
        {
          ...baseConfig,
          main: join(ROOT, "worker/src/index.ts"),
          vars: {
            ADMIN_SECRET,
            VAULT_SECRET,
            CAMELFS_URL: camelfsUrl,
            CAMELFS_SIGNING_KEY: keys.signingSpec,
            CAMELFS_DEV_TOKEN: "",
            DEFAULT_MODEL: "mock/default",
          },
        },
        null,
        2,
      ),
    );
    const workerPort = await getFreePort();
    worker = await unstable_startWorker({
      config: testConfigPath,
      dev: {
        persist: join(tempDir, "wrangler-state"),
        server: { hostname: "127.0.0.1", port: workerPort },
        logLevel: "none",
      },
    });
    workerUrl = `http://127.0.0.1:${workerPort}`;
    await waitForHealth(`${workerUrl}/healthz`);
  });

  after(async () => {
    await worker?.dispose().catch(() => {});
    if (camelfsdProc && !camelfsdProc.killed) {
      camelfsdProc.kill("SIGTERM");
      await new Promise((resolve) => camelfsdProc.once("exit", resolve));
    }
    if (auxServer) {
      await new Promise((resolve) => auxServer.close(() => resolve(undefined)));
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("1. tenants, API keys, billing credits, and scoped agent tokens enforce boundaries", async () => {
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

  it("2. camelfsd repos, file tools, persistent bash VM (cwd + env + atomic commit), and edit-while-VM-live work seamlessly", async () => {
    const { apiKey } = await CamelRun.createTenant({
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

    const diff = await camel.repos.diff(repo.repoId, {
      from: hist.commits[hist.commits.length - 1]!.commit,
      to: hist.commits[0]!.commit,
    });
    assert.ok(diff.changes.some((c) => c.path === "src/app.txt"));

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

    const paused = await billingAgent.run(`Refund user [CALL:issueRefund {"amount":45}]`);
    assert.equal(paused.status, "input_required");
    assert.equal(refunded, false);
    assert.equal(paused.inputs.length, 1);

    const resumed = await billingAgent.answerInput(paused.inputs[0]!.id, { approved: true });
    assert.equal(resumed.status, "completed");
    assert.equal(refunded, true);
    assert.match(resumed.text, /45/);

    // Also test ask_human question -> answer -> completion
    const asked = await billingAgent.run(`Ask deploy window [CALL:ask_human {"question":"Deploy now?"}]`);
    assert.equal(asked.status, "input_required");
    assert.equal(asked.inputs.length, 1);

    const answered = await billingAgent.answerInput(asked.inputs[0]!.id, { answer: "Yes, ship at 5pm" });
    assert.equal(answered.status, "completed");
    assert.match(answered.text, /Yes, ship at 5pm/);

    await camel.close();
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

    // Compaction summarizes history while preserving full /history
    await agent.compact();
    const history = await agent.history();
    assert.ok(history.length >= 4);

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
      mcpServers: [{ name: "meteo", url: `${auxUrl}/mcp` }],
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
    while (receivedWebhooks.length === 0 && Date.now() < whDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(receivedWebhooks.length >= 1, "expected signed webhook delivery from Cloudflare Queue");
    const sigHeader = receivedWebhooks[0]!.headers["x-camelrun-signature"];
    assert.equal(typeof sigHeader, "string");
    assert.match(String(sigHeader), /v1=[0-9a-f]{64}/);

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
});
