#!/usr/bin/env node
/**
 * Temporary Cloudflare Edge Deployment + Agent Spin-up & Working Benchmark
 *
 * 1. Starts a local v2 `camelfsd` daemon with an ephemeral Ed25519 keypair.
 * 2. Opens an ephemeral `cloudflared` quick-tunnel so the edge Worker can reach `camelfsd`
 *    (authenticated via Ed25519 JWTs; shut down in `finally`).
 * 3. Deploys a short-lived Worker (`camelrun-v2-temp-bench-<rand>`) on `workers.dev`
 *    with SQLite Durable Objects (`TenantDO` + `AgentDO`), uploads ephemeral secrets
 *    + `OPENROUTER_API_KEY` via stdin (`wrangler secret bulk`), runs latency benchmarks,
 *    and deletes the temporary Worker in `finally`.
 */

import { spawn, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const WRANGLER_BIN = resolve(ROOT, "node_modules/wrangler/bin/wrangler.js");
const CAMELFSD_BIN = resolve(ROOT, "camelfsd/bin/camelfsd");
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "85bbd288051330fb51ee1c86031a299b";

function cleanCfEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CLOUDFLARE_API_BASE_URL;
  delete env.CLOUDFLARE_BASE_URL;
  env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
  env.WRANGLER_SEND_METRICS = "false";
  env.WRANGLER_LOG_SANITIZE = "true";
  env.CI = "true";
  return env;
}

function runWrangler(args, { cwd = ROOT, input = "y\n", quiet = false, logDir } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const env = cleanCfEnv(logDir ? { WRANGLER_LOG_PATH: join(logDir, "wrangler-logs") } : {});
    const child = spawn(process.execPath, [WRANGLER_BIN, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
      if (!quiet) process.stdout.write(b);
    });
    child.stderr.on("data", (b) => {
      output += b;
      if (!quiet) process.stderr.write(b);
    });
    child.stdin.end(input);
    child.on("error", rejectRun);
    child.on("exit", (code) =>
      code === 0 ? resolveRun(output) : rejectRun(new Error(`wrangler ${args[0]} exited with ${code}`)),
    );
  });
}

async function getFreePort() {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createNetServer();
    srv.on("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? rejectPort(err) : resolvePort(port)));
    });
  });
}

function generateEd25519Pair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwkPub = publicKey.export({ format: "jwk" });
  const jwkPriv = privateKey.export({ format: "jwk" });
  return {
    signingSpec: `k1:${jwkPriv.d}`,
    publicSpec: `k1:${jwkPub.x}`,
  };
}

async function ensureCloudflared(tempDir) {
  const check = spawnSync("which", ["cloudflared"], { encoding: "utf8" });
  if (check.status === 0 && check.stdout.trim()) {
    return check.stdout.trim();
  }
  const cached = "/tmp/cloudflared-bench-bin";
  if (existsSync(cached)) return cached;

  console.log("==> Downloading cloudflared binary to /tmp/cloudflared-bench-bin for ephemeral camelfsd tunnel...");
  const res = await fetch(
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
  );
  if (!res.ok) throw new Error(`Failed to download cloudflared: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(cached, buf);
  chmodSync(cached, 0o755);
  return cached;
}

async function startQuickTunnel(cloudflaredBin, localUrl) {
  return new Promise((resolveTunnel, rejectTunnel) => {
    const child = spawn(
      cloudflaredBin,
      ["tunnel", "--url", localUrl, "--no-autoupdate", "--protocol", "http2"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let logs = "";
    let tunnelUrl = null;
    let registered = false;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectTunnel(new Error(`Timed out waiting for trycloudflare registration. Logs:\n${logs.slice(-600)}`));
    }, 35_000);

    const onChunk = (chunk) => {
      const text = chunk.toString("utf8");
      logs += text;
      if (!tunnelUrl) {
        const match = text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
        if (match) tunnelUrl = match[0];
      }
      if (text.includes("Registered tunnel connection")) {
        registered = true;
      }
      if (tunnelUrl && registered) {
        clearTimeout(timeout);
        resolveTunnel({ proc: child, url: tunnelUrl });
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("exit", (code) => {
      clearTimeout(timeout);
      rejectTunnel(new Error(`cloudflared exited early (${code}): ${logs.slice(-400)}`));
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      rejectTunnel(err);
    });
  });
}

async function waitForHealth(url, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) {
        const cfRay = res.headers.get("cf-ray") || "";
        return { cfRay, body: await res.json().catch(() => ({})) };
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err.message;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastErr}`);
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const pct = (p) => sorted[Math.min(n - 1, Math.floor((p / 100) * n))];
  return {
    n,
    min: round(sorted[0]),
    p50: round(pct(50)),
    p95: round(pct(95)),
    max: round(sorted[n - 1]),
    mean: round(sum / n),
  };
}

function round(v) {
  return Math.round(v * 10) / 10;
}

async function apiJson(baseUrl, token, path, { method = "GET", body, adminKey = false } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(adminKey ? { "X-Admin-Key": token } : { Authorization: `Bearer ${token}` }),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => null);
  const elapsedMs = performance.now() - t0;
  if (!res.ok) {
    throw new Error(`${method} ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return { data, elapsedMs, cfRay: res.headers.get("cf-ray") || "" };
}

/**
 * Measures durable streaming turn via `POST /runs` (`wait: false`) + `GET /events?runId=...` SSE:
 * - `submitMs`: client wall-clock until AgentDO persists run & starts turn loop
 * - `ttftMs`: client wall-clock to first `text_delta` SSE event
 * - `edgeLlmTtftMs`: pure Edge-side DO timestamp delta (`firstDelta.createdAt - runStarted.createdAt`)
 * - `firstToolMs`: client wall-clock to first `tool_call` SSE event
 * - `totalMs`: client wall-clock to `run_completed`
 */
async function measureStreamingRun(baseUrl, token, agentKey, body) {
  const t0 = performance.now();
  const submit = await apiJson(baseUrl, token, `/v2/agents/${encodeURIComponent(agentKey)}/runs`, {
    method: "POST",
    body: { ...body, wait: false },
  });
  const submitMs = performance.now() - t0;
  const runId = submit.data.id;

  const res = await fetch(
    `${baseUrl}/v2/agents/${encodeURIComponent(agentKey)}/events?after=0&runId=${encodeURIComponent(runId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "text/event-stream",
      },
      signal: AbortSignal.timeout(90_000),
    },
  );
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SSE GET /events failed (${res.status}): ${txt}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let runStartedServerTs = null;
  let firstDeltaServerTs = null;
  let firstDeltaMs = null;
  let firstToolMs = null;
  let completedMs = null;
  let finalPayload = null;
  let fullText = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let eventName = "message";
      let dataLine = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      let parsed;
      try {
        parsed = JSON.parse(dataLine);
      } catch {
        continue;
      }
      const now = performance.now() - t0;
      const type = parsed.type || eventName;
      const payload = parsed.data || parsed.payload || parsed;

      if (type === "run_started" && runStartedServerTs === null) {
        runStartedServerTs = parsed.createdAt ?? null;
      }
      if (type === "text_delta") {
        if (firstDeltaMs === null) {
          firstDeltaMs = now;
          firstDeltaServerTs = parsed.createdAt ?? null;
        }
        if (typeof payload.delta === "string") {
          fullText += payload.delta;
        }
      }
      if (
        (type === "tool_started" || type === "tool_call" || type === "tool_call_started") &&
        firstToolMs === null
      ) {
        firstToolMs = now;
      }
      if (type === "run_completed") {
        completedMs = now;
        finalPayload = payload;
      }
      if (type === "run_failed") {
        throw new Error(`Stream run failed: ${JSON.stringify(payload)}`);
      }
    }
    if (completedMs !== null) {
      await reader.cancel().catch(() => {});
      break;
    }
  }

  const totalMs = completedMs ?? performance.now() - t0;
  return {
    submitMs: round(submitMs),
    runStartedMs: round(submitMs),
    ttftMs: firstDeltaMs !== null ? round(firstDeltaMs) : null,
    edgeLlmTtftMs:
      runStartedServerTs !== null && firstDeltaServerTs !== null
        ? Math.max(0, round(firstDeltaServerTs - runStartedServerTs))
        : null,
    firstToolMs: firstToolMs !== null ? round(firstToolMs) : null,
    totalMs: round(totalMs),
    text: (fullText || finalPayload?.text || "").trim(),
    cfRay: res.headers.get("cf-ray") || "",
  };
}

async function main() {
  const isLocal = process.argv.includes("--local");
  const tempDir = mkdtempSync(join(tmpdir(), "camelrun-cf-bench-"));
  const workerName = `camelrun-v2-temp-bench-${randomBytes(4).toString("hex")}`;
  const adminSecret = randomBytes(32).toString("hex");
  const vaultSecret = randomBytes(32).toString("hex");
  const keys = generateEd25519Pair();

  let camelfsdProc = null;
  let tunnelProc = null;
  let localWorker = null;
  let uploadedWorker = false;
  let configPath = "";

  try {
    // 1. Build Go camelfsd if needed & start local camelfsd
    if (!existsSync(CAMELFSD_BIN)) {
      console.log("==> Building camelfsd binary...");
      const b = spawnSync("go", ["build", "-o", "bin/camelfsd", "./cmd/camelfsd"], {
        cwd: join(ROOT, "camelfsd"),
        stdio: "inherit",
      });
      if (b.status !== 0) throw new Error("go build camelfsd failed");
    }

    const fsPort = await getFreePort();
    const localFsUrl = `http://127.0.0.1:${fsPort}`;
    camelfsdProc = spawn(
      CAMELFSD_BIN,
      [
        "--listen",
        `127.0.0.1:${fsPort}`,
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
    await waitForHealth(`${localFsUrl}/healthz`, 10_000);
    console.log(`==> Local camelfsd healthy on ${localFsUrl}`);

    let baseUrl = "";
    let deployMs = 0;
    let edgeColo = "local";

    if (isLocal) {
      const { unstable_startWorker } = await import("wrangler");
      configPath = join(tempDir, "wrangler.local.json");
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            name: workerName,
            main: resolve(ROOT, "worker/src/index.ts"),
            compatibility_date: "2026-03-01",
            compatibility_flags: ["nodejs_compat"],
            vars: {
              ADMIN_SECRET: adminSecret,
              VAULT_SECRET: vaultSecret,
              CAMELFS_URL: localFsUrl,
              CAMELFS_SIGNING_KEY: keys.signingSpec,
              DEFAULT_MODEL: "mock/default",
            },
            durable_objects: {
              bindings: [
                { name: "TENANT_DO", class_name: "TenantDO" },
                { name: "AGENT_DO", class_name: "AgentDO" },
              ],
            },
            migrations: [{ tag: "v1", new_sqlite_classes: ["TenantDO", "AgentDO"] }],
          },
          null,
          2,
        ),
      );
      const wPort = await getFreePort();
      localWorker = await unstable_startWorker({
        config: configPath,
        dev: {
          persist: join(tempDir, "wrangler-state"),
          server: { hostname: "127.0.0.1", port: wPort },
          logLevel: "none",
        },
      });
      baseUrl = `http://127.0.0.1:${wPort}`;
      await waitForHealth(`${baseUrl}/healthz`, 10_000);
      console.log(`==> Local workerd healthy on ${baseUrl}\n`);
    } else {
      // 2. Start ephemeral cloudflared quick-tunnel for camelfsd
      const cloudflaredBin = await ensureCloudflared(tempDir);
      const tunnel = await startQuickTunnel(cloudflaredBin, localFsUrl);
      tunnelProc = tunnel.proc;
      console.log(`==> Ephemeral camelfsd tunnel registered at Cloudflare Edge: ${tunnel.url}`);
      try {
        await waitForHealth(`${tunnel.url}/healthz`, 12_000);
        console.log(`==> Verified camelfsd reachable over public HTTPS tunnel`);
      } catch {
        console.log(
          `==> Tunnel registered at Edge (local DNS propagation still warming; Edge Worker resolves trycloudflare authoritatively)`,
        );
      }

      // 3. Generate temporary wrangler config and deploy to Cloudflare Workers
      configPath = join(tempDir, "wrangler.bench.json");
      const wranglerConfig = {
        name: workerName,
        account_id: ACCOUNT_ID,
        main: resolve(ROOT, "worker/src/index.ts"),
        compatibility_date: "2026-03-01",
        compatibility_flags: ["nodejs_compat", "enhanced_error_serialization"],
        workers_dev: true,
        preview_urls: false,
        observability: { enabled: false },
        vars: {
          CAMELFS_URL: tunnel.url,
          DEFAULT_MODEL: "openrouter/meta/muse-ember",
        },
        durable_objects: {
          bindings: [
            { name: "TENANT_DO", class_name: "TenantDO" },
            { name: "AGENT_DO", class_name: "AgentDO" },
          ],
        },
        migrations: [
          {
            tag: "v1",
            new_sqlite_classes: ["TenantDO", "AgentDO"],
          },
        ],
      };
      writeFileSync(configPath, JSON.stringify(wranglerConfig, null, 2));

      console.log(`==> Deploying temporary Worker '${workerName}' to Cloudflare...`);
      const deployT0 = performance.now();
      const deployOut = await runWrangler(["deploy", "--config", configPath], {
        logDir: tempDir,
      });
      uploadedWorker = true;
      deployMs = round(performance.now() - deployT0);

      baseUrl = deployOut.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/)?.[0] || "";
      if (!baseUrl) {
        throw new Error(`Could not parse workers.dev URL from deploy output`);
      }
      console.log(`==> Deployed '${workerName}' at ${baseUrl} in ${deployMs} ms`);

      // 4. Push ephemeral secrets + OPENROUTER_API_KEY via stdin (never printed or logged)
      const secretsPayload = {
        ADMIN_SECRET: adminSecret,
        VAULT_SECRET: vaultSecret,
        CAMELFS_SIGNING_KEY: keys.signingSpec,
      };
      if (isLocal || process.env.OPENROUTER_API_KEY) {
        secretsPayload.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
      }
      if (process.env.GEMINI_API_KEY) {
        secretsPayload.GEMINI_API_KEY = process.env.GEMINI_API_KEY;
      }
      console.log(
        `==> Uploading secrets (${Object.keys(secretsPayload).join(", ")}) to '${workerName}'...`,
      );
      await runWrangler(["secret", "bulk", "--config", configPath], {
        input: JSON.stringify(secretsPayload),
        quiet: true,
        logDir: tempDir,
      });

      // 5. Wait for routing + new version propagation on workers.dev
      const health = await waitForHealth(`${baseUrl}/healthz`, 25_000);
      edgeColo = health.cfRay.split("-")[1] || health.cfRay || "unknown";
      console.log(`==> Worker live on Cloudflare Edge (colo=${edgeColo})!\n`);
    }

    const results = {
      workerName,
      baseUrl,
      edgeColo,
      deployMs,
      hasOpenRouterKey: Boolean(process.env.OPENROUTER_API_KEY),
      benchmarks: {},
    };

    // -------------------------------------------------------------------------
    // Benchmark 1: Edge HTTP ping (/healthz warm RTT from this VM to CF Edge)
    // -------------------------------------------------------------------------
    const pingSamples = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const r = await fetch(`${baseUrl}/healthz`);
      await r.text();
      pingSamples.push(performance.now() - t0);
    }
    results.benchmarks.edgeHealthRttMs = stats(pingSamples);
    console.log("[1] Edge HTTP RTT (/healthz):", results.benchmarks.edgeHealthRttMs);

    // -------------------------------------------------------------------------
    // Benchmark 2: Cold TenantDO spin-up (create tenant + SQLite schema + key mint + credits)
    // Retry briefly if workers.dev subdomain / secret bulk version is still propagating across POPs
    // -------------------------------------------------------------------------
    let tenantCreate;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        tenantCreate = await apiJson(baseUrl, adminSecret, "/v2/tenants", {
          method: "POST",
          adminKey: true,
          body: { name: "cf-bench-tenant", initialCreditsUsd: 50 },
        });
        break;
      } catch (err) {
        const msg = String(err.message);
        if (
          attempt === 19 ||
          !(msg.includes("401") || msg.includes("404") || msg.includes("502") || msg.includes("503"))
        ) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const tenantKey = tenantCreate.data.apiKey;
    results.benchmarks.coldTenantProvisionMs = round(tenantCreate.elapsedMs);
    console.log(`[2] Cold TenantDO provision + key mint: ${results.benchmarks.coldTenantProvisionMs} ms`);

    // -------------------------------------------------------------------------
    // Benchmark 3: Sequential Cold AgentDO Spin-up (10 brand-new AgentDOs)
    // Each call: Auth via TenantDO RPC -> Mint agent token -> Upsert index ->
    // Cold-instantiate brand-new AgentDO + initialize SQLite tables via DO RPC
    // -------------------------------------------------------------------------
    const seqSpinupSamples = [];
    for (let i = 0; i < 10; i++) {
      const res = await apiJson(baseUrl, tenantKey, `/v2/agents/seq-agent-${i}`, {
        method: "PUT",
        body: {
          instructions: "Reply concisely in under 8 words.",
          builtins: ["codemode"],
        },
      });
      seqSpinupSamples.push(res.elapsedMs);
    }
    results.benchmarks.coldAgentCreateSequentialMs = stats(seqSpinupSamples);
    console.log(
      "[3] Cold AgentDO create (sequential x10, SQLite init + token mint):",
      results.benchmarks.coldAgentCreateSequentialMs,
    );

    // -------------------------------------------------------------------------
    // Benchmark 4: 10-way Parallel Burst Cold AgentDO Spin-up
    // -------------------------------------------------------------------------
    const burstWallT0 = performance.now();
    const burstIndiv = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        apiJson(baseUrl, tenantKey, `/v2/agents/burst-agent-${i}`, {
          method: "PUT",
          body: {
            instructions: "Reply concisely.",
          },
        }).then((r) => r.elapsedMs),
      ),
    );
    const burstWallMs = round(performance.now() - burstWallT0);
    results.benchmarks.coldAgentCreateBurst10 = {
      wallClockForAll10Ms: burstWallMs,
      perAgentMs: stats(burstIndiv),
    };
    console.log(
      `[4] 10x Parallel AgentDO cold spin-up: all 10 ready in ${burstWallMs} ms wall-clock`,
      results.benchmarks.coldAgentCreateBurst10.perAgentMs,
    );

    // -------------------------------------------------------------------------
    // Benchmark 5: Warm AgentDO State Read (GET /v2/agents/:key via TenantDO+AgentDO RPC)
    // -------------------------------------------------------------------------
    const warmReadSamples = [];
    for (let i = 0; i < 10; i++) {
      const r = await apiJson(baseUrl, tenantKey, "/v2/agents/seq-agent-0");
      warmReadSamples.push(r.elapsedMs);
    }
    results.benchmarks.warmAgentGetMs = stats(warmReadSamples);
    console.log("[5] Warm AgentDO state read (x10):", results.benchmarks.warmAgentGetMs);

    // -------------------------------------------------------------------------
    // Benchmark 6: Instant Agent Fork (POST /v2/agents/:key/fork)
    // -------------------------------------------------------------------------
    const forkSamples = [];
    for (let i = 0; i < 5; i++) {
      const r = await apiJson(baseUrl, tenantKey, "/v2/agents/seq-agent-0/fork", {
        method: "POST",
        body: { key: `forked-agent-${i}` },
      });
      forkSamples.push(r.elapsedMs);
    }
    results.benchmarks.instantForkAgentOnlyMs = stats(forkSamples);
    console.log("[6] Instant AgentDO fork (x5):", results.benchmarks.instantForkAgentOnlyMs);

    // -------------------------------------------------------------------------
    // Benchmark 7: QuickJS Codemode WASI Sandbox Spin-up + Execution inside AgentDO
    // (Deterministic workflow executing JS inside QuickJS WASI on Cloudflare Edge)
    // -------------------------------------------------------------------------
    const codemodeCold = await apiJson(
      baseUrl,
      tenantKey,
      "/v2/agents/seq-agent-1/workflows",
      {
        method: "POST",
        body: {
          code: "let s = 0; for (let i = 1; i <= 1000; i++) s += i; return { sum: s };",
        },
      },
    );
    const codemodeWarmSamples = [];
    for (let i = 0; i < 5; i++) {
      const r = await apiJson(baseUrl, tenantKey, "/v2/agents/seq-agent-1/workflows", {
        method: "POST",
        body: {
          code: `return { idx: ${i}, val: ${i * 42} };`,
        },
      });
      codemodeWarmSamples.push(r.elapsedMs);
    }
    results.benchmarks.quickjsCodemodeMs = {
      coldFirstIsolateMs: round(codemodeCold.elapsedMs),
      warmMs: stats(codemodeWarmSamples),
    };
    console.log("[7] QuickJS WASI codemode on Edge:", results.benchmarks.quickjsCodemodeMs);

    // -------------------------------------------------------------------------
    // Benchmark 8: Brand-New Agent Cold Spin-up -> Start Working -> First Token (TTFT) & Full Turn
    // Uses live default model `openrouter/meta/muse-ember`!
    // -------------------------------------------------------------------------
    if (isLocal || process.env.OPENROUTER_API_KEY) {
      // 8a. Brand-new agent created + started in ONE call (`POST /v2/agents/:key/runs` auto-upsets if initialized, or create + stream)
      const coldCreateAndWorkT0 = performance.now();
      const created = await apiJson(baseUrl, tenantKey, "/v2/agents/live-cold-worker", {
        method: "PUT",
        body: {
          instructions: "Reply with the exact single word READY.",
        },
      });
      const streamCold = await measureStreamingRun(baseUrl, tenantKey, "live-cold-worker", {
        prompt: "Say READY.",
      });
      const endToEndFromZeroMs = round(performance.now() - coldCreateAndWorkT0);
      results.benchmarks.coldAgentToWorkingLiveLLM = {
        agentCreateMs: round(created.elapsedMs),
        runStartedEventMs: streamCold.runStartedMs,
        timeFromZeroToRunStartedMs: round(created.elapsedMs + streamCold.runStartedMs),
        clientTtftMs: streamCold.ttftMs,
        edgeOnlyLlmTtftMs: streamCold.edgeLlmTtftMs,
        timeFromZeroToFirstTokenMs:
          streamCold.ttftMs !== null ? round(created.elapsedMs + streamCold.ttftMs) : null,
        runTotalMs: streamCold.totalMs,
        endToEndFromZeroMs,
        reply: streamCold.text,
      };
      console.log(
        "[8a] Brand-new Agent -> Working (live openrouter/meta/muse-ember):",
        results.benchmarks.coldAgentToWorkingLiveLLM,
      );

      // 8b. Warm agent turns (3 consecutive streaming turns on live-cold-worker)
      const warmTurns = [];
      for (let i = 0; i < 3; i++) {
        const s = await measureStreamingRun(baseUrl, tenantKey, "live-cold-worker", {
          prompt: `Reply with the number ${i + 1} only.`,
        });
        warmTurns.push(s);
      }
      results.benchmarks.warmAgentStreamingTurnsLiveLLM = {
        runStartedMs: stats(warmTurns.map((t) => t.runStartedMs)),
        clientTtftMs: stats(warmTurns.filter((t) => t.ttftMs !== null).map((t) => t.ttftMs)),
        edgeOnlyLlmTtftMs: stats(
          warmTurns.filter((t) => t.edgeLlmTtftMs !== null).map((t) => t.edgeLlmTtftMs),
        ),
        totalTurnMs: stats(warmTurns.map((t) => t.totalMs)),
      };
      console.log(
        "[8b] Warm Agent streaming turns (x3, live openrouter/meta/muse-ember):",
        results.benchmarks.warmAgentStreamingTurnsLiveLLM,
      );

      // 8c. 5-Agent Parallel Live Spin-up + Working Simultaneously!
      const parallelLiveT0 = performance.now();
      const parallelLive = await Promise.all(
        Array.from({ length: 5 }, async (_, i) => {
          const tStart = performance.now();
          const c = await apiJson(baseUrl, tenantKey, `/v2/agents/parallel-live-${i}`, {
            method: "PUT",
            body: {
              instructions: "Reply with OK only.",
            },
          });
          const s = await measureStreamingRun(baseUrl, tenantKey, `parallel-live-${i}`, {
            prompt: "Status?",
          });
          return {
            createMs: round(c.elapsedMs),
            runStartedMs: s.runStartedMs,
            ttftMs: s.ttftMs,
            edgeLlmTtftMs: s.edgeLlmTtftMs,
            totalFromZeroMs: round(performance.now() - tStart),
          };
        }),
      );
      results.benchmarks.parallel5AgentsCreateAndWorkLiveLLM = {
        wallClockAll5CompletedMs: round(performance.now() - parallelLiveT0),
        zeroToRunStartedMs: stats(parallelLive.map((p) => p.createMs + p.runStartedMs)),
        zeroToFirstTokenMs: stats(
          parallelLive.filter((p) => p.ttftMs !== null).map((p) => p.createMs + p.ttftMs),
        ),
        zeroToCompletedMs: stats(parallelLive.map((p) => p.totalFromZeroMs)),
      };
      console.log(
        "[8c] 5 Parallel Agents Spin-up + Live LLM Turn simultaneously:",
        results.benchmarks.parallel5AgentsCreateAndWorkLiveLLM,
      );
    }

    // -------------------------------------------------------------------------
    // Benchmark 9: Full-Stack Cloudflare Edge <-> camelfsd (Repo + Files + VM Bash + Live Agent Tool Turn)
    // -------------------------------------------------------------------------
    const repoCreate = await apiJson(baseUrl, tenantKey, "/v2/repos", {
      method: "POST",
      body: { name: "bench-repo" },
    });
    const repoId = repoCreate.data.repoId ?? repoCreate.data.id;

    const fsAgentCreate = await apiJson(baseUrl, tenantKey, "/v2/agents/fs-vm-agent", {
      method: "PUT",
      body: {
        repoId,
        builtins: ["files", "bash"],
        instructions:
          "You have files and bash tools. Execute requested commands directly and reply in under 10 words.",
      },
    });

    // Direct camelfs tool execution via workflow (isolates Edge <-> camelfsd VM + commit without LLM variance)
    const vmColdExec = await apiJson(baseUrl, tenantKey, "/v2/agents/fs-vm-agent/workflows", {
      method: "POST",
      body: {
        code: `
          await wf.tool("write_file", { path: "bench.sh", content: "#!/bin/sh\\necho BENCH_OK_$(uname -s)\\n" });
          const out = await wf.bash("sh bench.sh && echo done > result.txt");
          return out;
        `,
      },
    });

    const vmWarmSamples = [];
    for (let i = 0; i < 5; i++) {
      const r = await apiJson(baseUrl, tenantKey, "/v2/agents/fs-vm-agent/workflows", {
        method: "POST",
        body: {
          code: `return await wf.bash("echo run_${i} >> result.txt && tail -n 1 result.txt");`,
        },
      });
      vmWarmSamples.push(r.elapsedMs);
    }

    // Instant fork of Agent + camelfsd Repo O(1) ref branch
    const repoFork = await apiJson(baseUrl, tenantKey, "/v2/agents/fs-vm-agent/fork", {
      method: "POST",
      body: { key: "fs-vm-agent-fork" },
    });

    let liveToolTurn = null;
    if (isLocal || process.env.OPENROUTER_API_KEY) {
      const s = await measureStreamingRun(baseUrl, tenantKey, "fs-vm-agent", {
        prompt: "Run `cat result.txt | wc -l` using bash and tell me the number.",
      });
      liveToolTurn = {
        runStartedMs: s.runStartedMs,
        firstToolCallMs: s.firstToolMs,
        totalTurnWithBashAndLlmMs: s.totalMs,
        reply: s.text,
      };
    }

    results.benchmarks.camelfsAndVmOverTunnel = {
      note: "camelfsd hosted on miguel-agents VM via ephemeral trycloudflare tunnel (includes Edge<->VM tunnel RTT)",
      repoCreateMs: round(repoCreate.elapsedMs),
      agentWithRepoCreateMs: round(fsAgentCreate.elapsedMs),
      coldWriteAndVmBashCommitMs: round(vmColdExec.elapsedMs),
      warmVmBashAndAtomicCommitMs: stats(vmWarmSamples),
      instantAgentPlusRepoForkMs: round(repoFork.elapsedMs),
      liveAgentBashToolTurn: liveToolTurn,
    };
    console.log(
      "[9] Full-Stack Edge <-> camelfsd (Repo + VM bash + fork + live tool turn):",
      results.benchmarks.camelfsAndVmOverTunnel,
    );

    const outJsonPath = join(ROOT, "docs/BENCHMARK_CLOUDFLARE.json");
    writeFileSync(outJsonPath, JSON.stringify(results, null, 2) + "\n");
    console.log(`\n==> Saved structured benchmark results to ${outJsonPath}`);
  } finally {
    if (localWorker) {
      await localWorker.dispose().catch(() => {});
    }
    if (uploadedWorker && configPath) {
      console.log(`\n==> Cleaning up temporary Cloudflare Worker '${workerName}'...`);
      try {
        await runWrangler(["delete", workerName, "--force", "--config", configPath], {
          logDir: tempDir,
        });
        console.log(`==> Deleted temporary Worker '${workerName}' cleanly.`);
      } catch (err) {
        console.error(`WARN: Failed to delete ${workerName}: ${err.message}`);
      }
    }
    if (tunnelProc) {
      tunnelProc.kill("SIGTERM");
    }
    if (camelfsdProc) {
      camelfsdProc.kill("SIGTERM");
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("BENCHMARK ERROR:", err);
  process.exit(1);
});
