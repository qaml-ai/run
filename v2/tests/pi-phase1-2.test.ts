import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { loadQuickJSWasm } from "@earendil-works/pi-codemode";
import {
  serveCodemodeRemote,
  type CodemodeRemote,
} from "@earendil-works/pi-codemode/portable";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodemodeStoreDoc } from "@earendil-works/pi-durable/codemode";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { num, obj } from "@earendil-works/pi-schema";
import { Miniflare } from "miniflare";
import type {
  CamelFsLsResponse,
  CamelFsReadResponse,
  CamelFsVmExecRequest,
  CamelFsVmExecResult,
  CamelFsVmInfo,
  CamelFsWriteRequest,
  CamelFsWriteResponse,
} from "../worker/src/camelfs.ts";
import {
  createCamelFsExecutionEnv,
  type CamelFsClientLike,
} from "../worker/src/pi/camelfs-env.ts";
import { createCamelRunCodemodeExtension } from "../worker/src/pi/codemode-extension.ts";
import {
  createCamelRunBillingExtension,
  createCamelRunCodingExtension,
  createCamelRunHumanExtension,
  createCamelRunSkillsExtension,
  HumanInputSignal,
  type BillingUsageEvent,
  type HumanInputRequiredEvent,
  type SpendLimitExceededEvent,
} from "../worker/src/pi/extensions.ts";
import {
  buildPiModels,
  createProviderRequestHook,
  parsePiModelRef,
  resolveAzurePlatformConfig,
} from "../worker/src/pi/models.ts";
import { getSkillStore, type SkillRecord } from "../worker/src/skills.ts";
import { ApiError, type Env, type ProviderCredentials } from "../worker/src/types.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---- In-memory Mock CamelFS Client ----

class MockCamelFsClient implements CamelFsClientLike {
  readonly files = new Map<string, string>();
  readonly commits: Array<{ message: string; changed: string[] }> = [];
  private commitSeq = 0;
  vmExecAttempts = 0;
  failFirstExecWithVmStopped = false;
  vmBoots = 0;

  constructor(initialFiles?: Record<string, string>) {
    for (const [k, v] of Object.entries(initialFiles ?? {})) {
      this.files.set(k.replace(/^\/+/, ""), v);
    }
  }

  async read(
    _lineage: string,
    params: { at?: string; path: string },
  ): Promise<CamelFsReadResponse> {
    const clean = params.path.replace(/^\/+/, "");
    if (!this.files.has(clean)) {
      throw new ApiError(404, "not_found", `File '${clean}' not found`);
    }
    const content = this.files.get(clean)!;
    return {
      commit: `commit_${this.commitSeq}`,
      path: clean,
      size: Buffer.byteLength(content, "utf8"),
      mode: 0o644,
      binary: false,
      content,
      base64: Buffer.from(content, "utf8").toString("base64"),
    };
  }

  async write(_lineage: string, req: CamelFsWriteRequest): Promise<CamelFsWriteResponse> {
    const changed: string[] = [];
    for (const put of req.puts ?? []) {
      const clean = put.path.replace(/^\/+/, "");
      const text =
        put.content !== undefined
          ? put.content
          : put.base64 !== undefined
            ? Buffer.from(put.base64, "base64").toString("utf8")
            : "";
      this.files.set(clean, text);
      changed.push(clean);
    }
    for (const del of req.deletes ?? []) {
      const clean = del.replace(/^\/+/, "");
      this.files.delete(clean);
      changed.push(clean);
    }
    for (const mv of req.moves ?? []) {
      const from = mv.from.replace(/^\/+/, "");
      const to = mv.to.replace(/^\/+/, "");
      const existing = this.files.get(from);
      if (existing !== undefined) {
        this.files.delete(from);
        this.files.set(to, existing);
        changed.push(from, to);
      }
    }
    this.commitSeq++;
    this.commits.push({ message: req.message ?? "write", changed });
    return {
      commit: `commit_${this.commitSeq}`,
      tree: `tree_${this.commitSeq}`,
      changed,
      totalBytes: 0,
    };
  }

  async ls(
    _lineage: string,
    params?: { at?: string; path?: string; recursive?: boolean | number },
  ): Promise<CamelFsLsResponse> {
    const prefix = (params?.path ?? "").replace(/^\/+|\/+$/g, "");
    const entries: CamelFsLsResponse["entries"] = [];
    const seenDirs = new Set<string>();
    for (const [filePath, content] of this.files.entries()) {
      if (prefix && filePath !== prefix && !filePath.startsWith(`${prefix}/`)) continue;
      const rel = prefix ? filePath.slice(prefix.length + 1) : filePath;
      if (!params?.recursive && rel.includes("/")) {
        const dir = rel.split("/")[0]!;
        const fullDir = prefix ? `${prefix}/${dir}` : dir;
        if (!seenDirs.has(fullDir)) {
          seenDirs.add(fullDir);
          entries.push({ path: fullDir, type: "dir", size: 0, mode: 0o755, hash: "dir" });
        }
        continue;
      }
      entries.push({
        path: filePath,
        type: "file",
        size: Buffer.byteLength(content, "utf8"),
        mode: 0o644,
        hash: "blob",
      });
    }
    return { commit: `commit_${this.commitSeq}`, entries };
  }

  async ensureVm(req: { lineage: string; ref: string; holder: string }): Promise<CamelFsVmInfo> {
    this.vmBoots++;
    return {
      vmId: `vm_${this.vmBoots}`,
      lineage: req.lineage,
      ref: req.ref,
      holder: req.holder,
      state: "running",
      headCommit: `commit_${this.commitSeq}`,
      leaseExpiresAt: Date.now() + 600_000,
    };
  }

  async execVm(
    _vmId: string,
    _lineage: string,
    req: CamelFsVmExecRequest,
  ): Promise<CamelFsVmExecResult> {
    this.vmExecAttempts++;
    if (this.failFirstExecWithVmStopped && this.vmExecAttempts === 1) {
      throw new ApiError(410, "vm_stopped", "Session VM stopped due to idle timeout");
    }
    return {
      execId: req.execId,
      exitCode: 0,
      stdout: `ran:${req.command}\n`,
      stderr: "",
      cwd: req.cwd ?? "/workspace",
      timedOut: false,
      durationMs: 45,
      billableMs: 120,
      commit: {
        changed: false,
        commit: `commit_${this.commitSeq}`,
        tree: `tree_${this.commitSeq}`,
        filesChanged: [],
      },
    };
  }
}

function makeBaseEnv(overrides?: Partial<Env>): Env {
  return {
    ADMIN_SECRET: "test-admin",
    VAULT_SECRET: "test-vault-secret-32-bytes-long!!",
    CAMELFS_URL: "http://127.0.0.1:8790",
    TENANT_DO: undefined as unknown as Env["TENANT_DO"],
    AGENT_DO: undefined as unknown as Env["AGENT_DO"],
    ...overrides,
  };
}

async function waitFor<T>(
  predicate: () => Promise<T | undefined | false> | T | undefined | false,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await predicate();
    if (val) return val;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

// =============================================================================
// 1. Real Multi-Worker Miniflare Test: RemoteCodemodeSandbox -> CodemodeSandbox
// =============================================================================

test("Phase 1: Multi-worker Miniflare RPC — RemoteCodemodeSandbox invokes host tools and enforces interrupt budget", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "camelrun-codemode-rpc-"));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));

  const sandboxOut = join(tempDir, "sandbox");
  const clientOut = join(tempDir, "client");
  const clientWranglerConfig = join(tempDir, "client.wrangler.jsonc");

  writeFileSync(
    clientWranglerConfig,
    JSON.stringify({
      name: "codemode-rpc-client",
      main: join(ROOT, "tests/fixtures/codemode-rpc-client-worker.ts"),
      compatibility_date: "2026-03-24",
      compatibility_flags: ["nodejs_compat"],
      durable_objects: {
        bindings: [
          {
            name: "CODEMODE_SANDBOX",
            class_name: "CodemodeSandbox",
            script_name: "camelrun-v2-codemode-sandbox",
          },
        ],
      },
    }),
  );

  const wranglerBin = join(ROOT, "node_modules/.bin/wrangler");
  const buildEnv = {
    ...process.env,
    XDG_CONFIG_HOME: "/tmp/xdg",
    WRANGLER_LOG_PATH: join(tempDir, "wrangler.log"),
  };

  execFileSync(
    wranglerBin,
    ["deploy", "--dry-run", "-c", join(ROOT, "codemode-sandbox/wrangler.jsonc"), "--outdir", sandboxOut],
    { cwd: ROOT, env: buildEnv, stdio: "pipe" },
  );
  execFileSync(
    wranglerBin,
    ["deploy", "--dry-run", "-c", clientWranglerConfig, "--outdir", clientOut],
    { cwd: ROOT, env: buildEnv, stdio: "pipe" },
  );

  const loadDirModules = (dir: string) => {
    const modules: Record<
      string,
      { type: "esm" | "wasm" | "data"; contents: string | Uint8Array<ArrayBuffer> }
    > = {};
    for (const entry of readdirSync(dir)) {
      if (entry.endsWith(".map")) continue;
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
  };

  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: "codemode-rpc-client",
          compatibilityDate: "2026-03-24",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "codemode-rpc-client-worker.js",
            modules: loadDirModules(clientOut),
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

  // 1a. Sandbox worker health check
  const sandboxWorker = await mf.getWorker("camelrun-v2-codemode-sandbox");
  const healthRes = await sandboxWorker.fetch("http://sandbox/");
  assert.equal(healthRes.status, 200);
  assert.deepEqual(await healthRes.json(), {
    ok: true,
    service: "camelrun-v2-codemode-sandbox",
  });

  // 1b. Execute JS over Workers RPC calling back into host tools
  const runRes = await mf.dispatchFetch("http://client/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instanceName: "agent-1:conv-1",
      code: `
        const { sum } = await tools.add({ a: 21, b: 21 });
        const msg = await tools.greet({ name: "CamelRun" });
        return { sum, msg };
      `,
    }),
  });
  assert.equal(runRes.status, 200);
  const runData = (await runRes.json()) as {
    result: { ok: boolean; value?: unknown; error?: { kind: string; message: string } };
    calls: Array<{ name: string; args: unknown }>;
  };
  assert.equal(runData.result.ok, true, JSON.stringify(runData));
  assert.deepEqual(runData.result.value, { sum: 42, msg: "Hello, CamelRun!" });
  assert.deepEqual(runData.calls, [
    { name: "add", args: { a: 21, b: 21 } },
    { name: "greet", args: { name: "CamelRun" } },
  ]);

  // 1c. Infinite loop is terminated cleanly by interruptBudget
  const loopRes = await mf.dispatchFetch("http://client/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      instanceName: "agent-1:conv-loop",
      interruptBudget: 20_000,
      code: "while (true) {}",
    }),
  });
  assert.equal(loopRes.status, 200);
  const loopData = (await loopRes.json()) as {
    result: { ok: boolean; error?: { kind: string; message: string } };
  };
  assert.equal(loopData.result.ok, false);
  assert.equal(loopData.result.error?.kind, "timeout");
});

// =============================================================================
// 2. CamelFS ExecutionEnv + Virtual /.skills (R2SkillStore) + VM 410 Retry
// =============================================================================

test("Phase 2: ExecutionEnv over mock CamelFS + R2 Skills supports read/write/edit, virtual /.skills, read-only rejection, and VM 410 retry", async () => {
  const tenantId = `tnt_env_${Date.now()}`;
  const env = makeBaseEnv();
  const skillStore = getSkillStore(env);
  await skillStore.upsertSkill(tenantId, "camel-bots/sql", {
    description: "SQLite storage helper skill",
    markdown: "---\nname: sql\ndescription: SQLite storage helper skill\n---\n# SQL Guide\nUse prepared statements.",
    files: {
      "references/api.d.ts": "export declare function query(sql: string): unknown[];",
    },
  });

  const mockCfs = new MockCamelFsClient({
    "src/app.ts": "export const greeting = 'hello';\n",
  });
  mockCfs.failFirstExecWithVmStopped = true;

  const changedFiles: string[] = [];
  const committed: Array<{ repoId: string; commit: string }> = [];
  const vmSessions = new Map<string, { vmId: string; leaseExpiresAt: number }>();
  let totalVmMs = 0;

  const execEnv = createCamelFsExecutionEnv({
    env,
    tenantId,
    agentId: "agt_env_test",
    ensureRepo: async () => ({
      repoId: "repo_1",
      lineage: "lin_1",
      branch: "refs/heads/main",
    }),
    client: mockCfs,
    onFilesChanged: (files) => changedFiles.push(...files),
    onRepoCommit: (repoId, commit) => {
      committed.push({ repoId, commit });
    },
    getVmSession: (branch) => vmSessions.get(branch) ?? null,
    saveVmSession: (branch, vmId, leaseExpiresAt) =>
      vmSessions.set(branch, { vmId, leaseExpiresAt }),
    clearVmSession: (branch) => vmSessions.delete(branch),
    onVmBillableMs: (ms) => {
      totalVmMs += ms;
    },
  });

  // Read CamelFS file
  const initialRead = await execEnv.readTextFile("src/app.ts", BACKGROUND_CONTEXT);
  assert.equal(initialRead.ok, true);
  if (initialRead.ok) assert.match(initialRead.value, /hello/);

  // Write & read back CamelFS file
  const writeRes = await execEnv.writeFile(
    "/workspace/src/new.ts",
    "export const answer = 42;\n",
    BACKGROUND_CONTEXT,
  );
  assert.equal(writeRes.ok, true);
  assert.equal(mockCfs.files.get("src/new.ts"), "export const answer = 42;\n");
  assert.ok(changedFiles.includes("src/new.ts"));
  assert.equal(committed.length, 1);

  // Read virtual `/.skills/...` SKILL.md and nested reference file
  const skillMd = await execEnv.readTextFile("/.skills/camel-bots/sql/SKILL.md", BACKGROUND_CONTEXT);
  assert.equal(skillMd.ok, true);
  if (skillMd.ok) assert.match(skillMd.value, /Use prepared statements/);

  const skillRef = await execEnv.readTextFile(
    "/.skills/camel-bots/sql/references/api.d.ts",
    BACKGROUND_CONTEXT,
  );
  assert.equal(skillRef.ok, true);
  if (skillRef.ok) assert.match(skillRef.value, /declare function query/);

  // Listing virtual `/.skills`
  const skillList = await execEnv.listFiles!("/.skills", undefined, BACKGROUND_CONTEXT);
  assert.equal(skillList.ok, true);
  if (skillList.ok) {
    const paths = skillList.value.entries.map((e) => e.path);
    assert.ok(paths.includes("camel-bots/sql/SKILL.md"));
    assert.ok(paths.includes("camel-bots/sql/references/api.d.ts"));
  }

  // Strict read-only rejection on `/.skills/...`
  const rejectWrite = await execEnv.writeFile(
    "/.skills/camel-bots/sql/SKILL.md",
    "hacked",
    BACKGROUND_CONTEXT,
  );
  assert.equal(rejectWrite.ok, false);
  if (!rejectWrite.ok) assert.equal(rejectWrite.error.code, "permission_denied");

  const rejectRemove = await execEnv.remove(
    "/.skills/camel-bots/sql/SKILL.md",
    undefined,
    BACKGROUND_CONTEXT,
  );
  assert.equal(rejectRemove.ok, false);
  if (!rejectRemove.ok) assert.equal(rejectRemove.error.code, "permission_denied");

  const rejectRename = await execEnv.renameFile(
    "/.skills/camel-bots/sql/SKILL.md",
    "/workspace/stolen.md",
    BACKGROUND_CONTEXT,
  );
  assert.equal(rejectRename.ok, false);
  if (!rejectRename.ok) assert.equal(rejectRename.error.code, "permission_denied");

  // Ephemeral `/tmp/...` scratch file
  const tmpFile = await execEnv.createTempFile({ prefix: "spill-", suffix: ".txt" }, BACKGROUND_CONTEXT);
  assert.equal(tmpFile.ok, true);
  if (tmpFile.ok) {
    assert.ok(tmpFile.value.startsWith("/tmp/spill-"));
    assert.equal((await execEnv.writeFile(tmpFile.value, "spilled output", BACKGROUND_CONTEXT)).ok, true);
    const readTmp = await execEnv.readTextFile(tmpFile.value, BACKGROUND_CONTEXT);
    assert.equal(readTmp.ok, true);
    if (readTmp.ok) assert.equal(readTmp.value, "spilled output");
  }

  // Firecracker VM `exec` retries automatically on HTTP 410 `vm_stopped` and bills VM ms
  const outputs: string[] = [];
  const execRes = await execEnv.exec(
    "echo hi",
    {
      onOutput: (text) => outputs.push(text),
    },
    BACKGROUND_CONTEXT,
  );
  assert.equal(execRes.ok, true);
  if (execRes.ok) assert.equal(execRes.value.exitCode, 0);
  assert.equal(mockCfs.vmBoots, 2, "Should reboot VM once after 410 vm_stopped");
  assert.equal(mockCfs.vmExecAttempts, 2);
  assert.equal(totalVmMs, 120);
  assert.deepEqual(outputs, ["ran:echo hi\n"]);
});

// =============================================================================
// 3. `pi/models.ts`: Azure Dual-Endpoint, BYOK Override, Hooks, and `mock/*`
// =============================================================================

test("Phase 2: pi/models.ts resolves Azure Luna vs Sol endpoints, BYOK overrides, beforeProviderRequest hooks, and mock/* turns", async () => {
  const env = makeBaseEnv({
    AZURE_OPENAI_LUNA_ENDPOINT: "https://luna-resource.openai.azure.com",
    AZURE_OPENAI_LUNA_API_KEY: "luna-secret-key",
    AZURE_OPENAI_SOL_ENDPOINT: "https://sol-resource.openai.azure.com",
    AZURE_OPENAI_SOL_API_KEY: "sol-secret-key",
  });

  // Dual-endpoint Azure resolution
  const lunaCfg = resolveAzurePlatformConfig(env, "gpt-6-luna");
  assert.ok(lunaCfg);
  assert.equal(lunaCfg.endpointKind, "luna");
  assert.equal(lunaCfg.baseUrl, "https://luna-resource.openai.azure.com/openai/v1");
  assert.equal(lunaCfg.apiKey, "luna-secret-key");

  const terraCfg = resolveAzurePlatformConfig(env, "gpt-6.1-terra");
  assert.ok(terraCfg);
  assert.equal(terraCfg.endpointKind, "sol");
  assert.equal(terraCfg.baseUrl, "https://sol-resource.openai.azure.com/openai/v1");
  assert.equal(terraCfg.apiKey, "sol-secret-key");

  const solCfg = resolveAzurePlatformConfig(env, "gpt-6.2-sol");
  assert.ok(solCfg);
  assert.equal(solCfg.endpointKind, "sol");
  assert.equal(solCfg.baseUrl, "https://sol-resource.openai.azure.com/openai/v1");
  assert.equal(solCfg.apiKey, "sol-secret-key");

  // BYOK override beats platform endpoint + supports deployment alias
  const byokCreds: ProviderCredentials = {
    provider: "azure",
    apiKey: "tenant-byok-key",
    baseUrl: "https://tenant-azure.openai.azure.com",
    headers: { "x-tenant-trace": "abc" },
    modelAliases: { "gpt-6.1-terra": "custom-terra-deploy" },
  };
  const byokCfg = resolveAzurePlatformConfig(env, "gpt-6.1-terra", { byok: byokCreds });
  assert.ok(byokCfg);
  assert.equal(byokCfg.endpointKind, "byok");
  assert.equal(byokCfg.baseUrl, "https://tenant-azure.openai.azure.com/openai/v1");
  assert.equal(byokCfg.apiKey, "tenant-byok-key");
  assert.equal(byokCfg.deploymentName, "custom-terra-deploy");
  assert.deepEqual(byokCfg.headers, { "x-tenant-trace": "abc" });

  // Virtual alias parsing
  assert.deepEqual(parsePiModelRef("camelrun/default"), {
    provider: "azure",
    modelId: "gpt-6.1-terra",
  });
  assert.deepEqual(parsePiModelRef("mock/echo"), {
    provider: "mock",
    modelId: "echo",
  });

  // `buildPiModels` catalog + AZURE_MODELS metadata (1.05M context window)
  const models = await buildPiModels({
    env,
    tenantId: "tnt_models",
    credentialLookup: async () => null,
  });
  const lunaModel = models.getModel("azure", "gpt-6-luna");
  const terraModel = models.getModel("azure", "gpt-6.1-terra");
  const solModel = models.getModel("azure", "gpt-6.2-sol");
  assert.ok(lunaModel && terraModel && solModel);
  assert.equal(lunaModel.baseUrl, "https://luna-resource.openai.azure.com/openai/v1");
  assert.equal(terraModel.baseUrl, "https://sol-resource.openai.azure.com/openai/v1");
  assert.equal(solModel.baseUrl, "https://sol-resource.openai.azure.com/openai/v1");
  assert.equal(terraModel.contextWindow, 1_050_000);

  // `beforeProviderRequest` hook: Azure default reasoning + outputSchema + OpenRouter privacy
  const schema = {
    type: "object",
    properties: { status: { type: "string" } },
    required: ["status"],
  };
  const hookFn = createProviderRequestHook({ getOutputSchema: () => schema });

  const azureHookRes = await hookFn(
    { model: terraModel, payload: { model: "gpt-6.1-terra", input: [] } },
    {} as never,
    BACKGROUND_CONTEXT,
  );
  assert.ok(azureHookRes);
  const azurePayload = azureHookRes.payload as Record<string, unknown>;
  assert.deepEqual(azurePayload.reasoning, { effort: "low" });
  assert.deepEqual((azurePayload.text as Record<string, unknown>).format, {
    type: "json_schema",
    name: "structured_output",
    schema,
    strict: false,
  });

  const orModel = models.getModel("openrouter", "meta/muse-ember");
  assert.ok(orModel);
  const orHookRes = await hookFn(
    { model: orModel, payload: { model: "meta/muse-ember", messages: [] } },
    {} as never,
    BACKGROUND_CONTEXT,
  );
  assert.ok(orHookRes);
  const orPayload = orHookRes.payload as Record<string, unknown>;
  assert.deepEqual(orPayload.provider, { data_collection: "deny" });
  assert.ok(orPayload.response_format);

  // `mock/*` provider turn
  const mockModel = models.getModel("mock", "default");
  assert.ok(mockModel);
  const reply = await models.completeSimple(mockModel, {
    messages: [{ role: "user", content: "hello pi-durable", timestamp: Date.now() }],
  });
  assert.equal(reply.stopReason, "stop");
  assert.equal(reply.content[0]?.type, "text");
  if (reply.content[0]?.type === "text") {
    assert.match(reply.content[0].text, /hello pi-durable/);
  }
});

// =============================================================================
// 4. Full `pi-durable` Harness Integration Tests
// =============================================================================

test("Phase 2: pi-durable Harness runs coding tools (write -> edit -> read) and skills section", async (t) => {
  const env = makeBaseEnv();
  const mockCfs = new MockCamelFsClient();
  const changed: string[] = [];

  const skills: SkillRecord[] = [
    {
      slug: "demo/style",
      name: "style",
      description: "Code style rules",
      tags: ["style"],
      version: 1,
      contentHash: "hash1",
      markdown: "# Style Guide\nAlways use strict mode.",
      files: {},
      createdAt: 1,
      updatedAt: 1,
    },
  ];

  const models = await buildPiModels({
    env,
    tenantId: "tnt_harness_1",
    credentialLookup: async () => null,
  });
  const registry = createRegistry();
  registry.install(createCamelRunCodingExtension());
  registry.install(
    createCamelRunSkillsExtension({
      env,
      tenantId: "tnt_harness_1",
      getResolvedSkills: async () => skills,
    }),
  );

  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      env: () =>
        createCamelFsExecutionEnv({
          env,
          tenantId: "tnt_harness_1",
          agentId: "agt_1",
          ensureRepo: async () => ({
            repoId: "repo_1",
            lineage: "lin_1",
            branch: "refs/heads/main",
          }),
          getResolvedSkills: async () => skills,
          client: mockCfs,
          onFilesChanged: (f) => changed.push(...f),
        }),
    },
    BACKGROUND_CONTEXT,
  );
  t.after(() => harness.close(BACKGROUND_CONTEXT));

  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "mock", modelId: "default" } },
  });

  const prompt = [
    `[CALL:write({"path":"notes.txt","content":"line 1\\nhello world\\n"})]`,
    `[CALL:edit({"path":"notes.txt","edits":[{"oldText":"hello world","newText":"hello pi-durable"}]})]`,
    `[CALL:read({"path":"notes.txt"})]`,
    "Done editing notes",
  ].join(" ");

  const sub = await root.submit({ type: "input", content: prompt }, BACKGROUND_CONTEXT);
  const settled = await sub.wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, "done");
  assert.equal(mockCfs.files.get("notes.txt"), "line 1\nhello pi-durable\n");
  assert.ok(changed.includes("notes.txt"));

  const view = await root.context(BACKGROUND_CONTEXT);
  const lastMsg = view.messages.at(-1);
  assert.equal(lastMsg?.role, "assistant");
  if (lastMsg?.role === "assistant") {
    const text = lastMsg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    assert.match(text, /hello pi-durable/);
  }
});

test("Phase 2: pi-durable Harness supports HumanInputSignal ToolPark pause & resume for ask_human and requiresApproval", async (t) => {
  const env = makeBaseEnv();
  const models = await buildPiModels({
    env,
    tenantId: "tnt_human",
    credentialLookup: async () => null,
  });

  const pendingInputs: HumanInputRequiredEvent[] = [];
  const deployedTargets: string[] = [];

  const deployTool = defineTool({
    name: "deploy_prod",
    description: "Deploy release to production",
    parameters: obj({ target: { type: "string" } as const }, { open: true }),
    async execute(args) {
      const target = String((args as { target?: string }).target ?? "unknown");
      deployedTargets.push(target);
      return { output: [{ type: "text", text: `deployed:${target}` }] };
    },
  });

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "test-deploy",
      tools: [deployTool as unknown as ToolRegistration],
    }),
  );
  registry.install(
    createCamelRunHumanExtension({
      requiresApproval: (name) => name === "deploy_prod",
      onInputRequired: (event) => {
        pendingInputs.push(event);
      },
    }),
  );

  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  t.after(() => harness.close(BACKGROUND_CONTEXT));

  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "mock", modelId: "default" } },
  });

  // 4b-1. `ask_human` parks on HumanInputSignal and resumes cleanly when signalled
  const askSub = await root.submit(
    {
      type: "input",
      content: `[CALL:ask_human({"question":"Which environment?"})]`,
    },
    BACKGROUND_CONTEXT,
  );

  const askEvent = await waitFor(() =>
    pendingInputs.find((e) => e.toolName === "ask_human" && e.kind === "question"),
  );
  // Confirm task is durably sleeping
  const inspection = await harness.inspect(BACKGROUND_CONTEXT);
  assert.ok(
    inspection.tasks.some(
      (tk) => tk.record.id === askEvent.taskId && tk.state.kind === "sleeping",
    ),
  );

  const sigRes = await harness.signal(
    askEvent.taskId as never,
    HumanInputSignal,
    askEvent.inputId,
    { answer: "staging-eu", at: Date.now() },
    BACKGROUND_CONTEXT,
  );
  assert.equal(sigRes, "delivered");

  const askSettled = await askSub.wait(BACKGROUND_CONTEXT);
  assert.equal(askSettled.status, "done");
  const askView = await root.context(BACKGROUND_CONTEXT);
  const askLast = askView.messages.at(-1);
  assert.equal(askLast?.role, "assistant");
  if (askLast?.role === "assistant") {
    const txt = askLast.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    assert.match(txt, /staging-eu/);
  }

  // 4b-2. `requiresApproval` approves tool via HumanInputSignal
  const approveSub = await root.submit(
    {
      type: "input",
      content: `[CALL:deploy_prod({"target":"us-east-1"})]`,
    },
    BACKGROUND_CONTEXT,
  );
  const approveEvent = await waitFor(() =>
    pendingInputs.find(
      (e) =>
        e.toolName === "deploy_prod" &&
        e.kind === "approval" &&
        (e.prompt.args as { target?: string })?.target === "us-east-1",
    ),
  );
  assert.equal(deployedTargets.length, 0, "Tool must NOT execute before approval signal");

  const approveSig = await harness.signal(
    approveEvent.taskId as never,
    HumanInputSignal,
    approveEvent.inputId,
    { approved: true, actor: "usr_admin", at: Date.now() },
    BACKGROUND_CONTEXT,
  );
  assert.equal(approveSig, "delivered");
  const approveSettled = await approveSub.wait(BACKGROUND_CONTEXT);
  assert.equal(approveSettled.status, "done");
  assert.deepEqual(deployedTargets, ["us-east-1"]);

  // 4b-3. `requiresApproval` denies tool via HumanInputSignal (tool never executes)
  const denySub = await root.submit(
    {
      type: "input",
      content: `[CALL:deploy_prod({"target":"eu-west-1"})]`,
    },
    BACKGROUND_CONTEXT,
  );
  const denyEvent = await waitFor(() =>
    pendingInputs.find(
      (e) =>
        e.toolName === "deploy_prod" &&
        e.kind === "approval" &&
        (e.prompt.args as { target?: string })?.target === "eu-west-1",
    ),
  );
  const denySig = await harness.signal(
    denyEvent.taskId as never,
    HumanInputSignal,
    denyEvent.inputId,
    { approved: false, actor: "usr_admin", at: Date.now() },
    BACKGROUND_CONTEXT,
  );
  assert.equal(denySig, "delivered");
  const denySettled = await denySub.wait(BACKGROUND_CONTEXT);
  assert.equal(denySettled.status, "done");
  assert.deepEqual(deployedTargets, ["us-east-1"], "Denied tool must never execute");
});

test("Phase 2: pi-durable Harness enforces spend limit via camelrun-billing", async (t) => {
  const env = makeBaseEnv();
  // Each mock model response costs $0.06; spend limit is $0.10.
  // Round 1 (tool call) costs $0.06 -> allowed.
  // Round 2 (second tool call) costs $0.06 -> cumulative $0.12 >= $0.10 -> Round 3 blocked before calling model!
  const models = await buildPiModels({
    env,
    tenantId: "tnt_billing",
    credentialLookup: async () => null,
    mockCostPerCallUsd: 0.06,
  });

  const usageEvents: BillingUsageEvent[] = [];
  const exceededEvents: SpendLimitExceededEvent[] = [];
  let harnessRef: Harness | null = null;

  const pingTool = defineTool({
    name: "ping",
    description: "Returns pong",
    parameters: obj({}, { open: true }),
    async execute() {
      return { output: [{ type: "text", text: "pong" }] };
    },
  });

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "test-ping",
      tools: [pingTool as unknown as ToolRegistration],
    }),
  );
  registry.install(
    createCamelRunBillingExtension({
      getSpendLimitUsd: () => 0.1,
      onUsageRecorded: (ev) => {
        usageEvents.push(ev);
      },
      onSpendLimitExceeded: (ev) => {
        exceededEvents.push(ev);
      },
      abortTask: (taskId) => harnessRef?.abortTask(taskId as never, BACKGROUND_CONTEXT),
    }),
  );

  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  harnessRef = harness;
  t.after(() => harness.close(BACKGROUND_CONTEXT));

  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "mock", modelId: "default" } },
  });

  // Two sequential tool calls -> requires 3 LLM requests if unbounded,
  // but after 2 requests ($0.12 >= $0.10), request 3 MUST be aborted!
  const sub = await root.submit(
    {
      type: "input",
      content: `[CALL:ping({})] [CALL:ping({})] finish`,
    },
    BACKGROUND_CONTEXT,
  );
  const settled = await sub.wait(BACKGROUND_CONTEXT);

  assert.equal(usageEvents.length, 2, "Only 2 LLM calls should complete before hitting $0.10 cap");
  assert.equal(exceededEvents.length, 1);
  assert.equal(exceededEvents[0]!.code, "run_spend_limit_exceeded");
  assert.ok(exceededEvents[0]!.spentUsd >= 0.1);
  assert.equal(settled.status, "unanswered");
});

test("Phase 2: pi-durable Harness runs remote codemode extension with tool calls, CodemodeStoreDoc, and replay durability", async (t) => {
  const env = makeBaseEnv();
  const models = await buildPiModels({
    env,
    tenantId: "tnt_codemode_harness",
    credentialLookup: async () => null,
  });

  // Load local QuickJS WASM module via `loadQuickJSWasm()` and serve via `serveCodemodeRemote`
  const wasmModule = await loadQuickJSWasm();
  let remoteExecutions = 0;
  const remoteFactory = (): CodemodeRemote => ({
    async execute(request, exchange) {
      remoteExecutions++;
      await serveCodemodeRemote(request, exchange, {
        wasm: wasmModule,
        maxInterruptBudget: 500_000,
        maxMemoryLimitBytes: 32 * 1024 * 1024,
      });
    },
  });

  const doubleCalls: number[] = [];
  const doubleTool = defineTool({
    name: "double",
    description: "Double a number",
    parameters: obj({ n: num() }, { open: true }),
    structuredOutputSchema: obj({ value: num() }),
    async execute(args) {
      doubleCalls.push(args.n);
      const value = args.n * 2;
      return {
        output: [{ type: "text", text: String(value) }],
        structuredOutput: { value },
      };
    },
  });

  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "math-tools",
      namespace: { name: "math", description: "Math helpers" },
      tools: [doubleTool as unknown as ToolRegistration],
    }),
  );
  registry.install(
    createCamelRunCodemodeExtension({
      remote: remoteFactory,
      models: false,
    }),
  );

  const dbDir = mkdtempSync(join(tmpdir(), "camelrun-pi-codemode-sqlite-"));
  t.after(() => rmSync(dbDir, { recursive: true, force: true }));
  const dbPath = join(dbDir, "session.sqlite");

  const storage = await openNodeSqliteStorage(dbPath, { prefix: "pi_" });
  const harness = await Harness.open(
    storage,
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  let harnessClosed = false;
  t.after(async () => {
    if (!harnessClosed) await harness.close(BACKGROUND_CONTEXT);
  });

  const root = await harness.root(BACKGROUND_CONTEXT, {
    agent: { model: { provider: "mock", modelId: "default" } },
  });

  const code = `
    const first = await tools.double({ n: 21 });
    store("lastResult", first.value);
    return { doubled: first.value, loaded: load("lastResult") };
  `;
  const sub = await root.submit(
    {
      type: "input",
      content: `[CALL:codemode(${JSON.stringify({ code })})] summarize`,
    },
    BACKGROUND_CONTEXT,
  );
  const settled = await sub.wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, "done");
  assert.equal(remoteExecutions, 1);
  assert.deepEqual(doubleCalls, [21]);

  // Verify rewindable CodemodeStoreDoc persisted store("lastResult", 42)
  const storeSnap = await harness.snapshot(CodemodeStoreDoc, root.id, BACKGROUND_CONTEXT);
  assert.ok(storeSnap);
  assert.equal(storeSnap.values.lastResult, 42);

  // Verify subsequent codemode turn reads stored value across real SQLite close & reopen
  await harness.close(BACKGROUND_CONTEXT);
  harnessClosed = true;
  const storage2 = await openNodeSqliteStorage(dbPath, { prefix: "pi_" });
  const reopened = await Harness.open(
    storage2,
    { models, registry },
    BACKGROUND_CONTEXT,
  );
  t.after(() => reopened.close(BACKGROUND_CONTEXT));

  const root2 = await reopened.root(BACKGROUND_CONTEXT);
  const sub2 = await root2.submit(
    {
      type: "input",
      content: `[CALL:codemode(${JSON.stringify({ code: 'return { fromStore: load("lastResult") };' })})] verify`,
    },
    BACKGROUND_CONTEXT,
  );
  const settled2 = await sub2.wait(BACKGROUND_CONTEXT);
  assert.equal(settled2.status, "done");
  const view2 = await root2.context(BACKGROUND_CONTEXT);
  const last2 = view2.messages.at(-1);
  assert.equal(last2?.role, "assistant");
  if (last2?.role === "assistant") {
    const txt = last2.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
    assert.match(txt, /42/);
  }
});
