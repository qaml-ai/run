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
import { createRemoteJWKSet, jwtVerify } from "jose";
import { unstable_startWorker } from "wrangler";
import { CamelFsClient } from "../worker/src/camelfs.ts";
import { CamelRun, CamelRunError, defineTool, parseSSE, type SSEMessage } from "../sdk/src/index.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CAMELFSD_BIN = join(ROOT, "camelfsd/bin/camelfsd");
const ADMIN_SECRET = "test-admin-secret-v2";
const VAULT_SECRET = "test-vault-secret-32-bytes-minimum!!";
// Load the optional Node fixture before registering tests so its database cleanup runs after the suite.
const migrationFixture = process.env.CAMELRUN_TEST_V1_MIGRATION === "1"
  ? await import(new URL("../scripts/v1-migration-fixture.ts", import.meta.url).href)
  : undefined;

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
  let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
  let startWorker: () => Promise<void>;
  let workerUrl: string;
  let failNextExec = false;
  let vmBootRequests = 0;
  type ProviderMessage = { role: string; content: unknown; tool_call_id?: string };
  let lastProviderMessages: ProviderMessage[] | undefined;
  let lastProviderOptions: Record<string, unknown> | undefined;
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

      if (req.url === "/usage-webhook" && req.method === "POST") {
        const delivery = req.headers["x-camelrun-delivery"];
        const retry = receivedWebhooks.some(({ headers }) => headers["x-camelrun-delivery"] === delivery);
        receivedWebhooks.push({ headers: req.headers, body: rawBody });
        res.writeHead(retry ? 204 : 503);
        res.end();
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

    // 3. Start real Cloudflare workerd via Wrangler using an isolated test config
    const workerPort = await getFreePort();
    const toolKey = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
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
            CAMELFS_URL: auxUrl + "/camelfs",
            CAMELFS_SIGNING_KEY: camelfsSigningKey,
            CAMELFS_DEV_TOKEN: "",
            DEFAULT_MODEL: "mock/default",
            TOOL_IDENTITY_ISSUER: `http://127.0.0.1:${workerPort}/v2`,
            TOOL_IDENTITY_PRIVATE_JWK: JSON.stringify({ ...toolKey, kid: "tool-fixture" }),
          },
        },
        null,
        2,
      ),
    );
    workerUrl = `http://127.0.0.1:${workerPort}`;
    startWorker = async () => {
      worker = await unstable_startWorker({
        config: testConfigPath,
        dev: {
          persist: join(tempDir, "wrangler-state"),
          server: { hostname: "127.0.0.1", port: workerPort },
          logLevel: "none",
        },
      });
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

  it("moves three v1 bot drafts through the v2 client", { skip: !migrationFixture }, async (t) => {
    await migrationFixture.rehearseMigration(t, workerUrl, ADMIN_SECRET);
  });

  it("authenticates v2 calls with the Camel Bots tool verifier", { skip: !migrationFixture }, async (t) => {
    await migrationFixture.rehearseSignedTools(t, workerUrl, ADMIN_SECRET);
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
    await unfunded.providers.set("openrouter", { apiKey: "fake-provider-key", baseUrl: auxUrl + "/v1" });
    const builder = await unfunded.agents.upsert("pilot-builder", { model: "openrouter/meta/muse-ember" });
    const beforeDispatch = lastProviderMessages;
    await assert.rejects(builder.run("Unfunded"), (error: unknown) =>
      error instanceof CamelRunError && error.code === "insufficient_credits");
    assert.equal(lastProviderMessages, beforeDispatch);
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
    await camel.providers.set("openrouter", { apiKey: "test-spend", baseUrl: `${auxUrl}/v1` });
    await camel.webhooks.create({ url: `${auxUrl}/usage-webhook`, events: ["usage.recorded", "run.failed"] });
    const context = { org: "org-test", workspace: "workspace-test", thread: "thread-test" };
    const agent = await camel.agents.upsert("per-run-spend", {
      model: "openrouter/meta/muse-ember",
      queue: { mode: "batch", windowMs: 100 },
      toolIdentity: { subject: "owner", context },
    });
    const beforeZero = lastProviderMessages;
    const zero = await agent.run("no budget", { spendLimitUsd: 0, throwOnError: false });
    assert.ok(zero.error && typeof zero.error === "object");
    assert.equal(zero.error.code, "spend_limit_exceeded");
    assert.equal(zero.usage.costUsd, 0);
    assert.equal(lastProviderMessages, beforeZero);
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
      model: "openrouter/meta/muse-ember",
      kind: "response",
      input: capped.usage.inputTokens,
      output: capped.usage.outputTokens,
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
      mcpServers: [{ name: "app", url: audience, audience, auth: { type: "runtime" } }],
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
      assert.equal((await switchDuringTool.json()).error.code, "agent_busy");
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
    const { apiKey } = await CamelRun.createTenant({
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
      return { status: response.status, body: await response.json() };
    };

    assert.equal((await patchModel("mock/default", agent.agentToken!)).status, 403);
    assert.equal((await patchModel("mock/another")).body.error.code, "model_changed");
    const paused = await agent.run('Pause [CALL:ask_human {"question":"Continue?"}]');
    assert.equal(paused.status, "input_required");
    const queued = await agent.submit("Next old-model turn", { idempotencyKey: "before-switch" });
    assert.equal(queued.status, "queued");
    const busy = await patchModel("mock/default");
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, "agent_busy");

    await agent.answerInput(paused.inputs[0]!.id, { answer: "Continue" });
    const drained = await agent.run("Next old-model turn", { idempotencyKey: "before-switch" });
    assert.equal(drained.id, queued.id);
    assert.equal(drained.status, "completed");
    assert.deepEqual(await patchModel("mock/default"), { status: 200, body: { model: "mock/sol", changed: true } });
    assert.deepEqual(await patchModel("mock/default"), { status: 200, body: { model: "mock/sol", changed: false } });
    const same = await camel.agents.upsert("model-switch", { instructions: "Retain the selected model" });
    assert.equal(same.id, agent.id);
    assert.equal(same.agentToken, agent.agentToken);
    const headers = { Authorization: `Bearer ${apiKey}` };
    const state = await fetch(`${workerUrl}/v2/agents/${agent.id}`, { headers }).then(res => res.json());
    assert.equal(state.model, "mock/sol");
    assert.ok(state.messageCount >= 4);
    const { agents } = await fetch(`${workerUrl}/v2/agents`, { headers }).then(res => res.json());
    assert.equal(agents.find((row: { id: string }) => row.id === agent.id).model, "mock/sol");
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

  it("auto-compacts imported history without splitting a tool call from any of its results", async () => {
    const { apiKey } = await CamelRun.createTenant({
      baseUrl: workerUrl, adminKey: ADMIN_SECRET, name: "compaction-tenant", initialCreditsUsd: 1,
    });
    const camel = new CamelRun({ baseUrl: workerUrl, apiKey });
    try {
      await camel.providers.set("openrouter", { apiKey: "test-compaction-key", baseUrl: `${auxUrl}/v1` });
      const agent = await camel.agents.upsert("imported-agent", { model: "openrouter/test/context-compaction" });
      const timestamp = Date.now();
      const textBlock = (text: string) => ({ type: "text", text });
      const assistant = (text: string) => ({ role: "assistant", content: [textBlock(text)], timestamp });
      const user = (content: string) => ({ role: "user", content, timestamp });
      const toolResult = (id: string) => ({
        role: "toolResult", content: [textBlock(id)], toolCallId: id, toolName: "lookup", timestamp,
      });
      const messages = [
        user("Earlier context. ".repeat(21_000)), assistant("Prior reply"), user("Use both lookups"),
        { role: "assistant", content: ["call_one", "call_two"].map(id => ({ type: "toolCall", id, name: "lookup", arguments: {} })), timestamp },
        toolResult("call_one"), toolResult("call_two"), assistant("Both found"), user("Thanks"), assistant("Of course"),
      ];
      await agent.importV1History({ source: "imported-v1", messages });

      const run = await agent.run("Continue from my history");
      assert.equal(run.status, "completed");
      assert.deepEqual(lastProviderMessages?.map(message => message.role), [
        "system", "assistant", "tool", "tool", "assistant", "user", "assistant", "user",
      ]);
      assert.deepEqual(lastProviderMessages?.filter(message => message.role === "tool").map(message => message.tool_call_id),
        ["call_one", "call_two"]);
      assert.match(String(lastProviderMessages?.[0]?.content), /summary \(up to message #3\)/);
      assert.equal(lastProviderMessages?.at(-1)?.content, "Continue from my history");
      const history = (await agent.history()).map(row => row.content as { text?: string; meta?: { v1?: unknown } });
      assert.deepEqual(history.slice(0, messages.length).map(content => content.meta?.v1), messages);
      assert.equal(history[messages.length]?.text, "Continue from my history");
    } finally {
      await camel.close();
    }
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
    const capped = await agent.submit("Wait with no spend left", { spendLimitUsd: 0, idempotencyKey: "capped" });
    const attributed = await agent.submit("Wait with a sender", { actor: "returning-member", idempotencyKey: "attributed" });
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
});
