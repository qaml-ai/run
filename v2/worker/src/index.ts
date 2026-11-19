import { Hono } from "hono";
import { cors } from "hono/cors";
import { AgentDO, getAgentStub } from "./agent-do.ts";
import {
  assertAgentAccess,
  assertTenantScope,
  authenticateRequest,
  parseRequestCredentials,
  verifyAdminHeader,
} from "./auth.ts";
import { CamelFsClient } from "./camelfs.ts";
import {
  createChannelRecord,
  deleteChannelRecord,
  handleChannelInbound,
  listChannelRecords,
} from "./channels.ts";
import {
  mintAgentToken,
  mintTenantApiKey,
  mintVoiceSessionId,
  openSecret,
  parseVoiceSessionAgentId,
  randomId,
  sealSecret,
  sha256Hex,
} from "./crypto.ts";
import { runDecisionClassifier, type DecisionRequest } from "./decisions.ts";
import { parseV1History } from "./history-import.ts";
import {
  handleImageGenerateRequest,
  handleImageGetRequest,
  handleSpeechRequest,
  handleTranscriptionRequest,
} from "./media.ts";
import { executeStatelessRun, type StatelessRunInput } from "./stateless-run.ts";
import { bridgeEvents } from "./sse-bridge.ts";
import { DEFAULT_MODEL_ID } from "./providers.ts";
import { getTenantStub, TenantDO } from "./tenant-do.ts";
import { toolIdentityKeys } from "./tool-identity.ts";
import {
  ApiError,
  errorResponse,
  toApiErrorResponse,
  type AgentUpsertInput,
  type Env,
  type QueueMessagePayload,
  type StartRunInput,
} from "./types.ts";
import {
  createWebhookRecord,
  deleteWebhookRecord,
  listWebhookRecords,
  processEventsQueueBatch,
} from "./webhooks.ts";

export { TenantDO, AgentDO };

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.onError((err) => {
  return toApiErrorResponse(err);
});

app.notFound((c) => {
  return errorResponse(404, "not_found", `Route not found: ${c.req.method} ${c.req.path}`);
});

app.get("/healthz", (c) => c.json({ ok: true, service: "camelrun-worker-v2" }));
app.get("/v2", (c) => c.json({ ok: true, service: "camelrun-worker-v2" }));
app.get("/v2/health", (c) => c.json({ ok: true, service: "camelrun-worker-v2" }));
app.get("/v2/.well-known/jwks.json", (c) => c.json(toolIdentityKeys(c.env), 200, { "Cache-Control": "public, max-age=60" }));

// ---- 1. Tenants, Keys, Providers, Billing & Definitions (Per-Tenant TenantDO RPC) ----

app.post("/v2/tenants", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    initialCreditsUsd?: number;
    tier?: string;
    monthlyCapUsd?: number;
    concurrencyLimit?: number;
    rateLimitRpm?: number;
  };
  const name = body.name?.trim();
  if (!name) {
    throw new ApiError(400, "invalid_request", "`name` is required");
  }

  const tenantId = randomId("tnt", 8);
  const minted = await mintTenantApiKey(tenantId);
  const profile = await getTenantStub(c.env, tenantId).initTenant({
    tenantId,
    name,
    tier: body.tier,
    initialCreditsUsd: body.initialCreditsUsd,
    monthlyCapUsd: body.monthlyCapUsd,
    concurrencyLimit: body.concurrencyLimit,
    rateLimitRpm: body.rateLimitRpm,
    keyId: minted.id,
    keyPrefix: minted.prefix,
    keyHash: minted.keyHash,
  });

  return c.json(
    {
      tenantId: profile.id,
      name: profile.name,
      apiKey: minted.token,
      balanceUsd: profile.balanceUsd,
    },
    201,
  );
});

app.get("/v2/me", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const me = await getTenantStub(c.env, auth.tenantId).getMe();
  return c.json(me);
});

app.post("/v2/tokens", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    scopes?: string[];
  };
  const minted = await mintTenantApiKey(auth.tenantId);
  const name = body.name?.trim() || "api-key";
  const scopes = Array.isArray(body.scopes) && body.scopes.length > 0 ? body.scopes : ["*"];
  const created = await getTenantStub(c.env, auth.tenantId).createApiKey({
    id: minted.id,
    name,
    prefix: minted.prefix,
    keyHash: minted.keyHash,
    scopes,
  });

  return c.json(
    {
      id: created.id,
      name: created.name,
      token: minted.token,
      prefix: created.prefix,
      scopes: created.scopes,
      createdAt: created.createdAt,
    },
    201,
  );
});

app.get("/v2/tokens", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const tokens = await getTenantStub(c.env, auth.tenantId).listApiKeys();
  return c.json({ tokens });
});

app.delete("/v2/tokens/:id", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const id = c.req.param("id");
  const deleted = await getTenantStub(c.env, auth.tenantId).deleteApiKey(id);
  if (!deleted) {
    throw new ApiError(404, "not_found", `Token '${id}' not found`);
  }
  return c.json({ deleted: true });
});

app.put("/v2/providers/:provider", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const provider = c.req.param("provider").toLowerCase();
  const body = (await c.req.json()) as { apiKey?: string; baseUrl?: string };
  if (typeof body.apiKey !== "string" || !body.apiKey.trim()) {
    throw new ApiError(400, "invalid_request", "`apiKey` is required");
  }
  const out = await getTenantStub(c.env, auth.tenantId).setProviderSecret(
    provider,
    body.apiKey.trim(),
    body.baseUrl?.trim() || null,
  );
  return c.json(out);
});

app.get("/v2/providers", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const providers = await getTenantStub(c.env, auth.tenantId).listProviders();
  return c.json({ providers });
});

app.delete("/v2/providers/:provider", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  await getTenantStub(c.env, auth.tenantId).deleteProvider(c.req.param("provider"));
  return c.json({ deleted: true });
});

app.get("/v2/billing", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const summary = await getTenantStub(c.env, auth.tenantId).getBillingSummary();
  return c.json(summary);
});

app.post("/v2/billing/credits", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(403, "forbidden", "Only an admin can add credits");
  }
  const body = (await c.req.json()) as {
    tenantId?: string;
    amountUsd: number;
    refId: string;
    note?: string;
  };
  let targetTenantId = body.tenantId?.trim();
  if (!targetTenantId) {
    const caller = await authenticateRequest(c.env, c.req.raw).catch(() => null);
    if (!caller) throw new ApiError(400, "invalid_request", "`tenantId` is required with X-Admin-Key");
    targetTenantId = caller.tenantId;
  }

  const amountUsd = Number(body.amountUsd);
  if (!Number.isFinite(amountUsd) || amountUsd === 0) {
    throw new ApiError(400, "invalid_request", "`amountUsd` must be a non-zero number");
  }
  if (!body.refId?.trim()) {
    throw new ApiError(400, "invalid_request", "`refId` is required");
  }

  const out = await getTenantStub(c.env, targetTenantId).addCredits({
    amountUsd,
    refId: body.refId.trim(),
    note: body.note,
  });
  return c.json(out);
});

app.put("/v2/definitions/:slug", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const slug = c.req.param("slug");
  const config = (await c.req.json()) as AgentUpsertInput;
  const out = await getTenantStub(c.env, auth.tenantId).upsertDefinition(slug, config);
  return c.json(out);
});

app.get("/v2/definitions", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const definitions = await getTenantStub(c.env, auth.tenantId).listDefinitions();
  return c.json({ definitions });
});

app.get("/v2/definitions/:slug", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const slug = c.req.param("slug");
  const def = await getTenantStub(c.env, auth.tenantId).getDefinition(slug);
  if (!def) {
    throw new ApiError(404, "not_found", `Definition '${slug}' not found`);
  }
  return c.json(def);
});

app.delete("/v2/definitions/:slug", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const slug = c.req.param("slug");
  const deleted = await getTenantStub(c.env, auth.tenantId).deleteDefinition(slug);
  if (!deleted) {
    throw new ApiError(404, "not_found", `Definition '${slug}' not found`);
  }
  return c.json({ deleted: true });
});

// ---- 2. Repos (`/v2/repos`) ----

app.post("/v2/repos", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const body = (await c.req.json().catch(() => ({}))) as { name?: string };
  const created = await getTenantStub(c.env, auth.tenantId).createRepo({ name: body.name });
  return c.json(created, 201);
});

app.get("/v2/repos", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const repos = await getTenantStub(c.env, auth.tenantId).listRepos();
  return c.json({ repos });
});

app.get("/v2/repos/:repoId", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const repoId = c.req.param("repoId");
  const repo = await getTenantStub(c.env, auth.tenantId).getRepo(repoId);
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  let refs: unknown[] = [];
  try {
    const r = await cfs.listRefs(repo.lineage);
    refs = r.refs;
  } catch {
    refs = [];
  }
  return c.json({ ...repo, refs });
});

app.delete("/v2/repos/:repoId", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const out = await getTenantStub(c.env, auth.tenantId).deleteRepo(c.req.param("repoId"));
  return c.json(out);
});

app.get("/v2/repos/:repoId/files", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const repo = await getTenantStub(c.env, auth.tenantId).getRepo(c.req.param("repoId"));
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  const path = c.req.query("path") ?? "";
  if (!path) {
    throw new ApiError(400, "invalid_request", "`path` query parameter is required");
  }
  const at = c.req.query("at") || repo.defaultRef;
  const offset = c.req.query("offset") ? Number(c.req.query("offset")) : undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const out = await cfs.read(repo.lineage, { at, path, offset, limit });
  return c.json(out);
});

app.post("/v2/repos/:repoId/write", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const tenantStub = getTenantStub(c.env, auth.tenantId);
  const repo = await tenantStub.getRepo(c.req.param("repoId"));
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  const body = (await c.req.json()) as {
    ref?: string;
    expectedCommit?: string;
    holder?: string;
    author?: string;
    message?: string;
    puts?: Array<{ path: string; content?: string; base64?: string; mode?: number }>;
    deletes?: string[];
    moves?: Array<{ from: string; to: string }>;
  };
  const out = await cfs.write(repo.lineage, {
    ref: body.ref || repo.defaultRef,
    expectedCommit: body.expectedCommit,
    holder: body.holder,
    author: body.author || `tenant:${auth.tenantId}`,
    message: body.message || "api write",
    puts: body.puts,
    deletes: body.deletes,
    moves: body.moves,
  });
  void tenantStub.updateRepoCommit(repo.repoId, out.commit).catch(() => {});
  return c.json(out);
});

app.get("/v2/repos/:repoId/ls", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const repo = await getTenantStub(c.env, auth.tenantId).getRepo(c.req.param("repoId"));
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  const out = await cfs.ls(repo.lineage, {
    at: c.req.query("at") || repo.defaultRef,
    path: c.req.query("path") || "",
    recursive: c.req.query("recursive") !== "0",
    glob: c.req.query("glob") || undefined,
  });
  return c.json(out);
});

app.post("/v2/repos/:repoId/grep", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const repo = await getTenantStub(c.env, auth.tenantId).getRepo(c.req.param("repoId"));
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  const body = (await c.req.json()) as {
    at?: string;
    pattern: string;
    pathPrefix?: string;
    maxMatches?: number;
  };
  const out = await cfs.grep(repo.lineage, {
    at: body.at || repo.defaultRef,
    pattern: body.pattern,
    pathPrefix: body.pathPrefix,
    maxMatches: body.maxMatches,
  });
  return c.json(out);
});

app.get("/v2/repos/:repoId/history", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const repo = await getTenantStub(c.env, auth.tenantId).getRepo(c.req.param("repoId"));
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  const out = await cfs.history(repo.lineage, {
    ref: c.req.query("ref") || repo.defaultRef,
    limit: c.req.query("limit") ? Number(c.req.query("limit")) : 20,
  });
  return c.json(out);
});

app.post("/v2/repos/:repoId/fork", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const tenantStub = getTenantStub(c.env, auth.tenantId);
  const repo = await tenantStub.getRepo(c.req.param("repoId"));
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    sourceRef?: string;
    atCommit?: string;
  };
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  const forked = await cfs.forkLineage(repo.lineage, {
    sourceRef: body.sourceRef || repo.defaultRef,
    atCommit: body.atCommit,
  });
  const newRepo = await tenantStub.createRepo({
    name: body.name || `${repo.name}-fork`,
    existingLineage: forked.lineage,
    defaultRef: forked.ref,
    commit: forked.commit,
  });
  return c.json(newRepo, 201);
});

app.post("/v2/repos/:repoId/restore", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const tenantStub = getTenantStub(c.env, auth.tenantId);
  const repo = await tenantStub.getRepo(c.req.param("repoId"));
  const body = (await c.req.json()) as {
    ref?: string;
    targetCommit: string;
    message?: string;
  };
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  const out = await cfs.restore(repo.lineage, {
    ref: body.ref || repo.defaultRef,
    targetCommit: body.targetCommit,
    author: `tenant:${auth.tenantId}`,
    message: body.message || "restore",
  });
  void tenantStub.updateRepoCommit(repo.repoId, out.commit).catch(() => {});
  return c.json(out);
});

// ---- 3. Durable Keyed Agents (`/v2/agents`, Native AgentDO RPC) ----

async function getAgentTarget(
  env: Env,
  req: Request,
  idOrKey: string,
  operation: "read" | "run" | "input" | "admin",
  allowQueryToken = false,
) {
  const creds = await parseRequestCredentials(env, req, { allowQueryToken });
  if (creds.kind === "admin") {
    throw new ApiError(401, "unauthorized", "Missing Bearer token");
  }
  const prep = await getTenantStub(env, creds.tenantId).authorizeAndPrepareRun({
    credKind: creds.kind,
    tokenHash: creds.tokenHash,
    agentIdFromToken: creds.kind === "agent" ? creds.agentId : undefined,
    idOrKey,
    defaultModel: env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
    operation,
    includeProviderCredentials: false,
  });
  return {
    auth: prep.auth,
    agentId: prep.agentId,
    balanceUsd: prep.balanceUsd,
    stub: getAgentStub(env, prep.agentId),
  };
}

app.put("/v2/agents/:key", async (c) => {
  const creds = await parseRequestCredentials(c.env, c.req.raw);
  if (creds.kind === "admin") {
    throw new ApiError(401, "unauthorized", "Missing Bearer token");
  }
  const key = c.req.param("key").trim();
  if (!key) {
    throw new ApiError(400, "invalid_request", "Agent key cannot be empty");
  }

  const input = (await c.req.json().catch(() => ({}))) as AgentUpsertInput;
  const identity = input.toolIdentity;
  if (identity !== undefined && (!identity || typeof identity.subject !== "string" || !identity.subject.trim() ||
    (identity.context !== undefined && (!identity.context || typeof identity.context !== "object" || Array.isArray(identity.context))))) {
    throw new ApiError(400, "invalid_tool_identity", "Tool identity needs a subject and optional context object");
  }
  const candidateAgentId = randomId("agt", 8);
  const minted = await mintAgentToken(creds.tenantId, candidateAgentId);
  const candidateSealedToken = await sealSecret(minted.token, c.env.VAULT_SECRET);

  const hasInitialPrompt = typeof input.prompt === "string";
  const preacquireRunId =
    hasInitialPrompt && input.whileRunning !== "steer" ? randomId("run", 8) : undefined;

  const tenantStub = getTenantStub(c.env, creds.tenantId);
  const prep = await tenantStub.authorizeAndPrepareAgent({
    credKind: creds.kind,
    tokenHash: creds.tokenHash,
    agentIdFromToken: creds.kind === "agent" ? creds.agentId : undefined,
    key,
    input,
    defaultModel: c.env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
    candidateAgentId,
    candidateTokenHash: minted.tokenHash,
    candidateSealedToken,
    preacquireRunId,
  });

  const agentToken = prep.created
    ? minted.token
    : await openSecret(prep.sealedToken, c.env.VAULT_SECRET);

  const defCfg = prep.definitionConfig;
  const queueCfg = input.queue
    ? { mode: input.queue.mode ?? "each", windowMs: input.queue.windowMs ?? 0 }
    : defCfg?.queue
      ? { mode: defCfg.queue.mode ?? "each", windowMs: defCfg.queue.windowMs ?? 0 }
      : undefined;
  const dreamingCfg = input.dreaming
    ? {
        enabled: input.dreaming.enabled ?? false,
        idleSeconds: input.dreaming.idleSeconds ?? 3600,
      }
    : defCfg?.dreaming
      ? {
          enabled: defCfg.dreaming.enabled ?? false,
          idleSeconds: defCfg.dreaming.idleSeconds ?? 3600,
        }
      : undefined;

  let initResult: Awaited<ReturnType<ReturnType<typeof getAgentStub>["initAgent"]>>;
  try {
    initResult = await getAgentStub(c.env, prep.agentId).initAgent(
      {
        id: prep.agentId,
        tenantId: prep.tenantId,
        key,
        model: prep.model,
        instructions: input.instructions ?? defCfg?.instructions,
        definition: input.definition,
        tools: input.tools ?? defCfg?.tools,
        mcpServers: input.mcpServers ?? defCfg?.mcpServers,
        toolIdentity: identity,
        builtins: input.builtins ?? defCfg?.builtins,
        queue: queueCfg,
        repoId: prep.repoId,
        lineage: prep.lineage,
        branch: prep.branch,
        spendLimitUsd: input.spendLimitUsd ?? defCfg?.spendLimitUsd,
        idleTtlSeconds: input.idleTtlSeconds ?? defCfg?.idleTtlSeconds,
        dreaming: dreamingCfg,
      },
      hasInitialPrompt
        ? {
            input: {
              prompt: input.prompt!,
              idempotencyKey: input.idempotencyKey,
              whileRunning: input.whileRunning,
              wait: input.wait,
              outputSchema: input.outputSchema,
              maxSteps: input.maxSteps,
            },
            hints: {
              runId: preacquireRunId,
              preacquiredSlot: prep.slotAcquired,
              prefetchedProvider: prep.prefetchedProvider,
              prefetchedBalanceUsd: prep.balanceUsd,
            },
          }
        : undefined,
    );
  } catch (err) {
    if (prep.slotAcquired && preacquireRunId) {
      c.executionCtx.waitUntil(tenantStub.releaseSlot(preacquireRunId).catch(() => {}));
    }
    throw err;
  }

  return c.json(
    {
      id: prep.agentId,
      key,
      agentToken,
      repoId: prep.repoId,
      branch: prep.branch,
      model: prep.model,
      created: prep.created,
      ...(initResult.run ? { run: initResult.run } : {}),
    },
    prep.created ? 201 : 200,
  );
});

app.get("/v2/agents", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const agents = await getTenantStub(c.env, auth.tenantId).listAgents();
  return c.json({ agents });
});

app.get("/v2/agents/:idOrKey", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "read");
  return c.json(await stub.getState());
});

app.delete("/v2/agents/:idOrKey", async (c) => {
  const { auth, agentId, stub } = await getAgentTarget(
    c.env,
    c.req.raw,
    c.req.param("idOrKey"),
    "admin",
  );
  await stub.destroyAgent();
  await getTenantStub(c.env, auth.tenantId).deleteAgentIndex(agentId);
  return c.json({ deleted: true });
});

app.put("/v2/agents/:idOrKey/repo", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  return c.json(await stub.ensureAgentRepository());
});

app.post("/v2/agents/:idOrKey/runs", async (c) => {
  const creds = await parseRequestCredentials(c.env, c.req.raw);
  if (creds.kind === "admin") {
    throw new ApiError(401, "unauthorized", "Missing Bearer token");
  }
  const body = (await c.req.json()) as StartRunInput;
  if (body.actor !== undefined && creds.kind !== "tenant") {
    throw new ApiError(403, "forbidden", "A tenant credential is required to set the run actor");
  }
  const preacquireRunId = body.whileRunning !== "steer" ? randomId("run", 8) : undefined;
  const tenantStub = getTenantStub(c.env, creds.tenantId);
  const prep = await tenantStub.authorizeAndPrepareRun({
    credKind: creds.kind,
    tokenHash: creds.tokenHash,
    agentIdFromToken: creds.kind === "agent" ? creds.agentId : undefined,
    idOrKey: c.req.param("idOrKey"),
    defaultModel: c.env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
    operation: "run",
    includeProviderCredentials: true,
    preacquireRunId,
  });
  try {
    return c.json(
      await getAgentStub(c.env, prep.agentId).startRun(body, {
        runId: preacquireRunId,
        preacquiredSlot: prep.slotAcquired,
        prefetchedProvider: prep.prefetchedProvider,
        prefetchedBalanceUsd: prep.balanceUsd,
      }),
    );
  } catch (err) {
    if (prep.slotAcquired && preacquireRunId) {
      c.executionCtx.waitUntil(tenantStub.releaseSlot(preacquireRunId).catch(() => {}));
    }
    throw err;
  }
});

app.get("/v2/agents/:idOrKey/runs/:runId", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "read");
  return c.json(await stub.getRun(c.req.param("runId"), c.req.query("by") === "idempotency-key"));
});

app.post("/v2/agents/:idOrKey/abort", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "run");
  const body = (await c.req.json().catch(() => ({}))) as { keepQueued?: boolean };
  return c.json(await stub.abortRuns(body));
});

app.get("/v2/agents/:idOrKey/events", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "read", true);
  const accept = c.req.header("Accept") ?? "";
  if (accept.includes("text/event-stream")) {
    const url = new URL(c.req.url);
    const after = Number(c.req.header("Last-Event-ID") ?? url.searchParams.get("after") ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new ApiError(400, "invalid_request", "The event cursor must be a non-negative integer");
    }
    return bridgeEvents(stub, {
      after,
      runId: url.searchParams.get("runId") || null,
      follow: url.searchParams.get("follow") === "1",
    }, c.req.raw.signal);
  }
  const cursor = c.req.query("after");
  const after = cursor === "latest" ? "latest" : cursor ? Number(cursor) : 0;
  const runId = c.req.query("runId") || null;
  return c.json(await stub.getEvents({ after, runId }));
});

app.get("/v2/agents/:idOrKey/ws", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "run", true);
  return stub.fetch(new Request("https://agent.internal/ws", c.req.raw));
});

app.get("/v2/agents/:idOrKey/history", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "read");
  const afterParam = c.req.query("after");
  const beforeParam = c.req.query("before");
  const before = beforeParam === "latest" ? Number.MAX_SAFE_INTEGER : beforeParam === undefined ? undefined : Number(beforeParam);
  if (before !== undefined && (afterParam !== undefined || !Number.isSafeInteger(before) || before < 1)) {
    throw new ApiError(400, "invalid_request", "Use either after or before, where before is a positive sequence or latest");
  }
  const after = afterParam ? Number(afterParam) : 0;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : 50;
  return c.json(await stub.getHistory({ after, limit, before }));
});

app.put("/v2/agents/:idOrKey/history/import", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  const input = parseV1History(await c.req.json().catch(() => null));
  const receipt = await sha256Hex(JSON.stringify([input.source, input.messages]));
  return c.json(await stub.importV1History(input, receipt));
});

app.post("/v2/agents/:idOrKey/compact", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "run");
  const body = (await c.req.json().catch(() => ({}))) as { summary?: string; keepLast?: number };
  return c.json(await stub.compactHistory(body));
});

app.post("/v2/agents/:idOrKey/reset-context", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "run");
  const body = (await c.req.json().catch(() => ({}))) as { summary?: string; keepLast?: number };
  return c.json(await stub.resetContext(body));
});

app.post("/v2/agents/:idOrKey/fork", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  const body = (await c.req.json().catch(() => ({}))) as { key?: string; atSeq?: number };
  return c.json(await stub.forkAgent(body));
});

app.post("/v2/agents/:idOrKey/inputs/:inputId", async (c) => {
  const { auth, stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "input");
  const body = (await c.req.json().catch(() => ({}))) as {
    approved?: boolean;
    answer?: unknown;
    wait?: boolean;
    actor?: string;
  };
  if (body.actor !== undefined && auth.kind !== "tenant") {
    throw new ApiError(403, "forbidden", "A tenant credential is required to set the input actor");
  }
  return c.json(await stub.respondToInput(c.req.param("inputId"), body, auth.kind === "tenant"));
});

app.get("/v2/agents/:idOrKey/inputs", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "read");
  return c.json({ runs: await stub.getRunsWithPendingInputs() });
});

app.post("/v2/agents/:idOrKey/schedules", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  const body = (await c.req.json()) as {
    intervalSeconds?: number;
    cron?: string;
    cronExpr?: string;
    prompt: string;
  };
  return c.json(await stub.createSchedule(body), 201);
});

app.get("/v2/agents/:idOrKey/schedules", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "read");
  return c.json(await stub.listSchedules());
});

app.delete("/v2/agents/:idOrKey/schedules/:scheduleId", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  return c.json(await stub.deleteSchedule(c.req.param("scheduleId")));
});

app.post("/v2/agents/:idOrKey/workflows", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "run");
  const body = (await c.req.json()) as {
    code: string;
    idempotencyKey?: string;
    wait?: boolean;
  };
  const out = await stub.runWorkflow(body);
  return c.json(out, out.status === "completed" ? 200 : 422);
});

app.post("/v2/agents/:idOrKey/dream", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "run");
  return c.json(await stub.triggerDream());
});

// ---- 4. Stateless Runs, Decisions, Voice (on AgentDO), Channels, Media & Webhooks ----

app.post("/v2/runs", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const body = (await c.req.json()) as StatelessRunInput;
  const out = await executeStatelessRun(c.env, auth.tenantId, body, c.req.raw.signal);
  return c.json(out);
});

app.post("/v2/decisions", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const body = (await c.req.json()) as DecisionRequest;
  const out = await runDecisionClassifier(c.env, auth.tenantId, body);
  return c.json(out);
});

app.post("/v2/voice/sessions", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  const body = (await c.req.json()) as {
    agentIdOrKey: string;
    provider?: "openai" | "elevenlabs";
    voice?: string;
    instructions?: string;
  };
  if (!body.agentIdOrKey) {
    throw new ApiError(400, "invalid_request", "`agentIdOrKey` is required");
  }
  const agentRow = await getTenantStub(c.env, auth.tenantId).resolveAgent(body.agentIdOrKey);
  if (!agentRow) {
    throw new ApiError(404, "agent_not_found", `Agent '${body.agentIdOrKey}' not found`);
  }
  assertAgentAccess(auth, agentRow.id, "run");

  const sessionId = mintVoiceSessionId(agentRow.id);
  const created = await getAgentStub(c.env, agentRow.id).createVoiceSession({
    sessionId,
    provider: body.provider,
    voice: body.voice,
    instructions: body.instructions,
  });
  return c.json(created);
});

app.get("/v2/voice/sessions/:id", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  const sessionId = c.req.param("id");
  const agentId = parseVoiceSessionAgentId(sessionId);
  if (!agentId) {
    throw new ApiError(404, "voice_session_not_found", "Voice session not found");
  }
  assertAgentAccess(auth, agentId, "read");
  const session = await getAgentStub(c.env, agentId).getVoiceSession(sessionId);
  if (session.tenantId !== auth.tenantId) {
    throw new ApiError(403, "forbidden", "Voice session belongs to a different tenant");
  }
  return c.json(session);
});

app.post("/v2/voice/sessions/:id/tool", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  const sessionId = c.req.param("id");
  const agentId = parseVoiceSessionAgentId(sessionId);
  if (!agentId) {
    throw new ApiError(404, "voice_session_not_found", "Voice session not found");
  }
  assertAgentAccess(auth, agentId, "run");
  const session = await getAgentStub(c.env, agentId).getVoiceSession(sessionId);
  if (session.tenantId !== auth.tenantId) {
    throw new ApiError(403, "forbidden", "Voice session belongs to a different tenant");
  }
  const body = (await c.req.json()) as {
    name: string;
    args?: Record<string, unknown>;
    callId?: string;
  };
  const out = await getAgentStub(c.env, agentId).execVoiceTool(sessionId, body);
  return c.json(out, out.ok ? 200 : 422);
});

app.get("/v2/voice/sessions/:id/ws", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw, { allowQueryToken: true });
  const sessionId = c.req.param("id");
  const agentId = parseVoiceSessionAgentId(sessionId);
  if (!agentId) {
    throw new ApiError(404, "voice_session_not_found", "Voice session not found");
  }
  assertAgentAccess(auth, agentId, "run");
  const session = await getAgentStub(c.env, agentId).getVoiceSession(sessionId);
  if (session.tenantId !== auth.tenantId) {
    throw new ApiError(403, "forbidden", "Voice session belongs to a different tenant");
  }
  return getAgentStub(c.env, agentId).fetch(
    new Request(
      `https://agent.internal/voice-ws?sessionId=${encodeURIComponent(sessionId)}`,
      c.req.raw,
    ),
  );
});

app.post("/v2/channels", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const body = (await c.req.json()) as {
    kind?: "slack" | "email" | "http";
    name?: string;
    definition?: string;
    agentConfig?: AgentUpsertInput;
    outboundUrl?: string;
    secret?: string;
  };
  const created = await createChannelRecord(c.env, auth.tenantId, body);
  return c.json(created, 201);
});

app.get("/v2/channels", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const channels = await listChannelRecords(c.env, auth.tenantId);
  return c.json({ channels });
});

app.delete("/v2/channels/:id", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const deleted = await deleteChannelRecord(c.env, auth.tenantId, c.req.param("id"));
  if (!deleted) {
    throw new ApiError(404, "not_found", "Channel not found");
  }
  return c.json({ deleted: true });
});

app.post("/v2/channels/:id/inbound", async (c) => {
  let authedTenantId: string | undefined;
  if (c.req.header("Authorization")) {
    const auth = await authenticateRequest(c.env, c.req.raw);
    assertTenantScope(auth);
    authedTenantId = auth.tenantId;
  }
  const rawBody = await c.req.text();
  const out = await handleChannelInbound(
    c.env,
    c.req.param("id"),
    rawBody,
    c.req.raw.headers,
    authedTenantId,
  );
  return c.json(out);
});

app.post("/v2/transcriptions", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  return handleTranscriptionRequest(c.env, auth.tenantId, c.req.raw);
});

app.post("/v2/speech", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  return handleSpeechRequest(c.env, auth.tenantId, c.req.raw);
});

app.post("/v2/images", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  return handleImageGenerateRequest(c.env, auth.tenantId, c.req.raw);
});

app.get("/v2/images/:id", async (c) => {
  let tenantId: string | undefined;
  if (c.req.header("Authorization")) {
    const auth = await authenticateRequest(c.env, c.req.raw);
    tenantId = auth.tenantId;
  }
  return handleImageGetRequest(c.env, c.req.param("id"), tenantId);
});

app.post("/v2/webhooks", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const body = (await c.req.json()) as {
    url: string;
    events?: string[];
    secret?: string;
  };
  if (typeof body.url !== "string" || !body.url.startsWith("http")) {
    throw new ApiError(400, "invalid_request", "`url` must be a valid HTTP(S) URL");
  }
  const created = await createWebhookRecord(c.env, auth.tenantId, body);
  return c.json(created, 201);
});

app.get("/v2/webhooks", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const webhooks = await listWebhookRecords(c.env, auth.tenantId);
  return c.json({ webhooks });
});

app.delete("/v2/webhooks/:id", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const deleted = await deleteWebhookRecord(c.env, auth.tenantId, c.req.param("id"));
  if (!deleted) {
    throw new ApiError(404, "not_found", "Webhook not found");
  }
  return c.json({ deleted: true });
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  async queue(
    batch: MessageBatch<QueueMessagePayload>,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await processEventsQueueBatch(batch, env);
  },
};
