import { readSvgRequest, renderSvg, resolveRenderFiles } from "./svg-render.ts";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
  hashPassword,
  mintAgentToken,
  mintTenantApiKey,
  mintVoiceSessionId,
  openSecret,
  parseVoiceSessionAgentId,
  randomId,
  sealSecret,
  sha256Hex,
  verifyPassword,
} from "./crypto.ts";
import { runDecisionClassifier, type DecisionRequest } from "./decisions.ts";
import { parseV1History } from "./history-import.ts";
import {
  handleImageGenerateRequest,
  handleImageGetRequest,
  handleImageModerationRequest,
  handleSpeechRequest,
  handleTranscriptionRequest,
  handleVoiceSearchRequest,
} from "./media.ts";
import {
  mcpProtectedResourceMetadata,
  serveHostedTenantMcp,
  servePerAgentMcp,
} from "./hosted-mcp.ts";
import { listV2Models } from "./models.ts";
import { recordOpsTenantRegistration, registerOpsRoutes } from "./ops-api.ts";
import { executeStatelessRun, type StatelessRunInput } from "./stateless-run.ts";
import { bridgeEvents } from "./sse-bridge.ts";
import { DEFAULT_MODEL_ID } from "./providers.ts";
import { getTenantStub, TenantDO } from "./tenant-do.ts";
import { VoiceCallDO } from "./voice-call-do.ts";
import {
  handleCreateVoiceCall,
  handleElevenLabsPostCall,
  handleElevenLabsTool,
  handleEndVoiceCall,
  handleGetVoiceCall,
  handleListVoiceCalls,
  handleUpdateVoiceCall,
  handleVoiceCallTranscript,
} from "./voice-api.ts";
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
import { signed as signLegacyWebhook, verifySignature as verifyLegacyWebhookSignature, webhookInbound, webhookSettings } from "./lib/webhook.ts";

export { TenantDO, AgentDO, VoiceCallDO };
export { LegacyGatewayTextExecution } from "./legacy-gateway-text-execution.ts";

const app = new Hono<{ Bindings: Env }>();

const defaultCors = cors();
function isHostedMcpPath(path: string): boolean {
  return (
    path === "/mcp" ||
    path === "/v2/mcp" ||
    /^\/v2\/agents\/[^/]+\/mcp$/.test(path) ||
    path === "/.well-known/oauth-protected-resource/v2/mcp" ||
    /^\/\.well-known\/oauth-protected-resource\/v2\/agents\/[^/]+\/mcp$/.test(path) ||
    path === "/v2/.well-known/oauth-protected-resource/mcp" ||
    /^\/v2\/\.well-known\/oauth-protected-resource\/agents\/[^/]+\/mcp$/.test(path)
  );
}

app.use("*", async (c, next) => {
  if (isHostedMcpPath(c.req.path)) return next();
  return defaultCors(c, next);
});

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

// ---- 0. Hosted MCP Endpoints (Tenant & Per-Agent Streamable HTTP) ----

app.all("/v2/mcp", (c) => serveHostedTenantMcp(c.req.raw, c.env, c.executionCtx));
app.all("/mcp", (c) => serveHostedTenantMcp(c.req.raw, c.env, c.executionCtx));
app.all("/v2/agents/:idOrKey/mcp", (c) =>
  servePerAgentMcp(c.req.raw, c.env, c.executionCtx, c.req.param("idOrKey")),
);
app.on(["GET", "OPTIONS"], "/.well-known/oauth-protected-resource/v2/mcp", (c) =>
  mcpProtectedResourceMetadata(c.req.raw, c.env, "/v2/mcp"),
);
app.on(["GET", "OPTIONS"], "/.well-known/oauth-protected-resource/v2/agents/:idOrKey/mcp", (c) =>
  mcpProtectedResourceMetadata(
    c.req.raw,
    c.env,
    `/v2/agents/${encodeURIComponent(c.req.param("idOrKey"))}/mcp`,
  ),
);
app.on(["GET", "OPTIONS"], "/v2/.well-known/oauth-protected-resource/mcp", (c) =>
  mcpProtectedResourceMetadata(c.req.raw, c.env, "/v2/mcp"),
);
app.on(["GET", "OPTIONS"], "/v2/.well-known/oauth-protected-resource/agents/:idOrKey/mcp", (c) =>
  mcpProtectedResourceMetadata(
    c.req.raw,
    c.env,
    `/v2/agents/${encodeURIComponent(c.req.param("idOrKey"))}/mcp`,
  ),
);

// ---- 1. Tenants, Keys, Providers, Billing & Definitions (Per-Tenant TenantDO RPC) ----

const createTenantHandler = async (c: { env: Env; req: { raw: Request; json: () => Promise<unknown> }; json: (data: unknown, status?: 201) => Response }) => {
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
    kind?: "self_serve" | "operator_made" | "operator";
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

  await recordOpsTenantRegistration(c.env, {
    tenantId: profile.id,
    name: profile.name,
    kind: body.kind === "operator" || body.kind === "self_serve" ? body.kind : "operator_made",
    createdAt: profile.createdAt,
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
};

app.post("/v2/tenants", createTenantHandler);
app.post("/v2/admin/tenants", createTenantHandler);

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

const ALLOWED_API_STYLES = new Set([
  "openai-chat",
  "openai-responses",
  "openai-codex",
  "anthropic",
  "gemini",
]);

function parseProviderUpsertBody(body: {
  apiKey?: unknown;
  baseUrl?: unknown;
  modelAliases?: unknown;
  headers?: unknown;
  apiStyle?: unknown;
}) {
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const headersRaw = body.headers;
  let headers: Record<string, string> | null | undefined = undefined;
  if (headersRaw !== undefined) {
    if (headersRaw === null) {
      headers = null;
    } else if (typeof headersRaw !== "object" || Array.isArray(headersRaw)) {
      throw new ApiError(400, "invalid_request", "`headers` must be a map of header names to string values");
    } else {
      headers = {};
      for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
        if (!k.trim() || typeof v !== "string" || !v.trim()) {
          throw new ApiError(400, "invalid_request", "`headers` must map non-empty header names to non-empty strings");
        }
        headers[k.trim()] = v.trim();
      }
    }
  }
  if (!apiKey && (!headers || Object.keys(headers).length === 0)) {
    throw new ApiError(400, "invalid_request", "`apiKey` or non-empty `headers` is required");
  }
  const aliases = body.modelAliases;
  if (aliases !== undefined && (
    aliases === null || typeof aliases !== "object" || Array.isArray(aliases) ||
    Object.entries(aliases as Record<string, unknown>).some(([model, deployment]) =>
      !model.trim() || model !== model.trim() || typeof deployment !== "string" ||
      !deployment.trim() || deployment !== deployment.trim())
  )) {
    throw new ApiError(400, "invalid_request", "`modelAliases` must map model IDs to non-empty upstream model names");
  }
  let apiStyle: "openai-chat" | "openai-responses" | "openai-codex" | "anthropic" | "gemini" | null | undefined = undefined;
  if (body.apiStyle !== undefined) {
    if (body.apiStyle === null || body.apiStyle === "") {
      apiStyle = null;
    } else if (typeof body.apiStyle === "string" && ALLOWED_API_STYLES.has(body.apiStyle)) {
      apiStyle = body.apiStyle as "openai-chat" | "openai-responses" | "openai-codex" | "anthropic" | "gemini";
    } else {
      throw new ApiError(400, "invalid_request", "`apiStyle` must be one of openai-chat, openai-responses, openai-codex, anthropic, gemini");
    }
  }
  return {
    apiKey,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim() || null : null,
    modelAliases: aliases as Record<string, string> | undefined,
    headers,
    apiStyle,
  };
}

app.put("/v2/providers/:provider", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const provider = c.req.param("provider").toLowerCase();
  const parsed = parseProviderUpsertBody(await c.req.json());
  const out = await getTenantStub(c.env, auth.tenantId).setProviderSecret(
    provider,
    parsed.apiKey,
    parsed.baseUrl,
    parsed.modelAliases,
    {
      ...(parsed.headers !== undefined ? { headers: parsed.headers } : {}),
      ...(parsed.apiStyle !== undefined ? { apiStyle: parsed.apiStyle } : {}),
    },
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

app.put("/v2/key-scopes/:scope/providers/:provider", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const scope = c.req.param("scope").trim();
  if (!scope || scope.length > 100) {
    throw new ApiError(400, "invalid_request", "Key scope must be 1-100 characters");
  }
  const provider = c.req.param("provider").toLowerCase();
  const parsed = parseProviderUpsertBody(await c.req.json());
  const out = await getTenantStub(c.env, auth.tenantId).setProviderSecret(
    provider,
    parsed.apiKey,
    parsed.baseUrl,
    parsed.modelAliases,
    {
      scope,
      ...(parsed.headers !== undefined ? { headers: parsed.headers } : {}),
      ...(parsed.apiStyle !== undefined ? { apiStyle: parsed.apiStyle } : {}),
    },
  );
  return c.json(out);
});

app.get("/v2/key-scopes/:scope/providers", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const scope = c.req.param("scope").trim();
  if (!scope) throw new ApiError(400, "invalid_request", "Key scope is required");
  const providers = await getTenantStub(c.env, auth.tenantId).listProviders(scope);
  return c.json({ scope, providers });
});

app.delete("/v2/key-scopes/:scope/providers/:provider", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const scope = c.req.param("scope").trim();
  await getTenantStub(c.env, auth.tenantId).deleteProvider(c.req.param("provider"), scope);
  return c.json({ deleted: true });
});

app.delete("/v2/key-scopes/:scope", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const scope = c.req.param("scope").trim();
  await getTenantStub(c.env, auth.tenantId).deleteKeyScope(scope);
  return c.json({ deleted: true });
});

app.get("/v2/models", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const filtered = await listV2Models(c.env, auth.tenantId, {
    provider: c.req.query("provider"),
    availableOnly: c.req.query("available") === "true",
    keyScope: c.req.query("keyScope"),
  });
  return c.json(filtered);
});

app.get("/v2/usage", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const rawDays = Number(c.req.query("days") ?? 30);
  const days = Number.isFinite(rawDays) ? Math.min(365, Math.max(1, Math.floor(rawDays))) : 30;
  const rows = await getTenantStub(c.env, auth.tenantId).getUsageDays(days);
  return c.json({ days: rows });
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

const READ_ALL_MAX_FILES = 1_000;
const READ_ALL_MAX_BYTES = 16 * 1024 * 1024;
const READ_ALL_CONCURRENCY = 16;

app.get("/v2/repos/:repoId/read-all", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const repo = await getTenantStub(c.env, auth.tenantId).getRepo(c.req.param("repoId"));
  const cfs = new CamelFsClient(c.env, auth.tenantId);
  const at = c.req.query("at") || repo.defaultRef;
  const prefix = c.req.query("path") || "";
  const listed = await cfs.ls(repo.lineage, { at, path: prefix, recursive: true });
  const fileEntries = listed.entries.filter((e) => e.type === "file");
  if (fileEntries.length > READ_ALL_MAX_FILES) {
    throw new ApiError(413, "repo_too_many_files", `Repository has ${fileEntries.length} files (limit ${READ_ALL_MAX_FILES})`);
  }
  let totalBytes = 0;
  for (const e of fileEntries) totalBytes += e.size;
  if (totalBytes > READ_ALL_MAX_BYTES) {
    throw new ApiError(413, "repo_too_large", `Repository total size ${totalBytes} exceeds ${READ_ALL_MAX_BYTES} bytes`);
  }
  const files: Array<{
    path: string;
    size: number;
    mode: number;
    hash: string;
    binary: boolean;
    content: string | null;
    base64: string | null;
  }> = new Array(fileEntries.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(READ_ALL_CONCURRENCY, fileEntries.length) }, async () => {
    while (cursor < fileEntries.length) {
      const idx = cursor++;
      const entry = fileEntries[idx]!;
      const read = await cfs.read(repo.lineage, { at: listed.commit, path: entry.path });
      files[idx] = {
        path: entry.path,
        size: read.size,
        mode: read.mode,
        hash: entry.hash,
        binary: read.binary,
        content: read.content,
        base64: read.base64,
      };
    }
  });
  await Promise.all(workers);
  return c.json({ commit: listed.commit, files });
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
    modelIndexUpdates: prep.modelIndexUpdates,
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
        model: input.model ?? defCfg?.model,
        keyScope: input.keyScope !== undefined ? (input.keyScope?.trim() || null) : defCfg?.keyScope,
        initialModel: prep.model,
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
      model: initResult.config.model,
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

app.patch("/v2/agents/:idOrKey/model", async (c) => {
  const { stub, modelIndexUpdates } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  const body = await c.req.json().catch(() => null) as { model?: unknown; expectedModel?: unknown; keyScope?: unknown } | null;
  if (typeof body?.model !== "string" || !body.model.trim() ||
      typeof body.expectedModel !== "string" || !body.expectedModel.trim()) {
    throw new ApiError(400, "invalid_request", "model and expectedModel are required");
  }
  if (body.keyScope !== undefined && body.keyScope !== null && typeof body.keyScope !== "string") {
    throw new ApiError(400, "invalid_request", "keyScope must be a string or null");
  }
  if (!modelIndexUpdates) {
    throw new ApiError(503, "model_update_unavailable", "The tenant is still using an earlier runtime version");
  }
  return c.json(await stub.updateModelIfIdle(
    body.model.trim(),
    body.expectedModel.trim(),
    body.keyScope === undefined ? undefined : (body.keyScope?.trim() || null),
  ));
});

app.patch("/v2/agents/:idOrKey/spend-limit", async (c) => {
  const { auth, agentId, stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  const body = await c.req.json().catch(() => null) as { spendLimitUsd?: unknown; expectedSpendLimitUsd?: unknown } | null;
  if (typeof body?.spendLimitUsd !== "number" || !Number.isFinite(body.spendLimitUsd) || body.spendLimitUsd < 0 ||
      typeof body.expectedSpendLimitUsd !== "number" || !Number.isFinite(body.expectedSpendLimitUsd) || body.expectedSpendLimitUsd < 0) {
    throw new ApiError(400, "invalid_spend_limit", "Spend limits must be finite non-negative numbers");
  }
  return c.json(await stub.updateSpendLimitIfIdle({ tenantId: auth.tenantId, agentId }, body.spendLimitUsd, body.expectedSpendLimitUsd));
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

async function startAgentRun(request: Request, env: Env, ctx: Pick<ExecutionContext, "waitUntil">, idOrKey: string, legacyActor = false) {
  const creds = await parseRequestCredentials(env, request);
  if (creds.kind === "admin") {
    throw new ApiError(401, "unauthorized", "Missing Bearer token");
  }
  const body = (await request.json()) as StartRunInput;
  if (body.actor !== undefined && creds.kind !== "tenant" && !legacyActor) {
    throw new ApiError(403, "forbidden", "A tenant credential is required to set the run actor");
  }
  const preacquireRunId = body.whileRunning !== "steer" ? randomId("run", 8) : undefined;
  const tenantStub = getTenantStub(env, creds.tenantId);
  const prep = await tenantStub.authorizeAndPrepareRun({
    credKind: creds.kind,
    tokenHash: creds.tokenHash,
    agentIdFromToken: creds.kind === "agent" ? creds.agentId : undefined,
    idOrKey,
    defaultModel: env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID,
    ...(body.keyScope !== undefined ? { keyScopeOverride: body.keyScope?.trim() || null } : {}),
    operation: "run",
    includeProviderCredentials: true,
    preacquireRunId,
  });
  try {
    return Response.json(
      await getAgentStub(env, prep.agentId).startRun(body, {
        runId: preacquireRunId,
        preacquiredSlot: prep.slotAcquired,
        prefetchedProvider: prep.prefetchedProvider,
        prefetchedBalanceUsd: prep.balanceUsd,
      }),
    );
  } catch (err) {
    if (prep.slotAcquired && preacquireRunId) {
      ctx.waitUntil(tenantStub.releaseSlot(preacquireRunId).catch(() => {}));
    }
    throw err;
  }
}

app.post("/v2/agents/:idOrKey/runs", (c) => startAgentRun(c.req.raw, c.env, c.executionCtx, c.req.param("idOrKey")));

app.get("/v2/agents/:idOrKey/runs", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "read");
  return c.json(await stub.getRunState());
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

app.get("/v2/agents/:idOrKey/history/import", async (c) => {
  const { auth, agentId, stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  c.header("Cache-Control", "no-store");
  return c.json(await stub.getV1HistoryImportProof({ tenantId: auth.tenantId, agentId }));
});

app.put("/v2/agents/:idOrKey/history/import", async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  const input = parseV1History(await c.req.json().catch(() => null));
  if (input.appendAfter !== undefined) {
    throw new ApiError(400, "invalid_history", "Use the chunk import endpoint");
  }
  const receipt = await sha256Hex(JSON.stringify([input.source, input.messages]));
  return c.json(await (input.messages.some(message => message.content.legacyInlineImages)
    ? stub.importV1HistoryWithInlineImages(input, receipt)
    : stub.importV1History(input, receipt)));
});

// Older Worker versions must reject the route instead of interpreting a chunk as a full replacement.
app.put("/v2/agents/:idOrKey/history/import/chunk", bodyLimit({
  maxSize: 1024 * 1024,
  onError: () => { throw new ApiError(413, "history_chunk_too_large", "The history chunk exceeds 1 MiB"); },
}), async (c) => {
  const { stub } = await getAgentTarget(c.env, c.req.raw, c.req.param("idOrKey"), "admin");
  const input = parseV1History(await c.req.json().catch(() => null));
  if (input.appendAfter === undefined) throw new ApiError(400, "invalid_history", "The chunk requires an append offset");
  const receipt = await sha256Hex(JSON.stringify(["v1-history-chunk", input.source, input.previous, input.appendAfter, input.messages]));
  return c.json(await stub.appendV1HistoryChunk(input, receipt));
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

app.post("/v2/runs/text", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  if (auth.tenantId !== c.env.BUILDER_CUTOVER_CREDIT_TENANT_ID) {
    throw new ApiError(404, "not_found", "Text runs are unavailable for this tenant");
  }
  const key = c.req.header("idempotency-key")?.toLowerCase();
  if (!key || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(key)) {
    throw new ApiError(400, "invalid_request", "Text runs require a UUID v4 Idempotency-Key");
  }
  const body = await c.req.json().catch(() => null) as { input?: string; instructions?: string; outputSchema?: Record<string, unknown>; timeoutMs?: number } | null;
  const { input, instructions, outputSchema, timeoutMs } = body ?? {};
  if (typeof input !== "string" || !input.trim() || (instructions !== undefined && typeof instructions !== "string") ||
      typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 ||
      (outputSchema !== undefined && (outputSchema?.type !== "object" || outputSchema.additionalProperties !== true ||
        Object.keys(outputSchema).length !== 2))) {
    throw new ApiError(400, "invalid_request", "Text runs need text, a deadline of at most 60000 ms, and optionally JSON object output");
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([c.req.raw.signal, deadline]);
  const tenant = getTenantStub(c.env, auth.tenantId);
  const leaseId = randomId("srun", 8);
  let acquired = false;
  try {
    // New duplicate claims use their own name. Existing tenant objects can still be on an older
    // version during deferred upgrades, so they only receive the original billing and quota RPCs.
    await getTenantStub(c.env, `camelrun:text-run-admission:${auth.tenantId}`).claimTextRun(key);
    await tenant.checkRateLimit("runs");
    await tenant.acquireSlot(leaseId, leaseId, timeoutMs);
    acquired = true;
    signal.throwIfAborted();
    const reply = await executeStatelessRun(c.env, auth.tenantId, {
      input, instructions, outputSchema, model: DEFAULT_MODEL_ID, maxSteps: 1,
    }, signal, true);
    signal.throwIfAborted();
    return c.json(reply);
  } catch (error) {
    if (deadline.aborted) throw new ApiError(408, "deadline_exceeded", "The model exceeded its deadline");
    throw error;
  } finally {
    if (acquired) await tenant.releaseSlot(leaseId).catch(() => {});
  }
});

app.post("/v2/decisions", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const body = (await c.req.json()) as DecisionRequest;
  const out = await runDecisionClassifier(c.env, auth.tenantId, body);
  return c.json(out);
});

app.post("/v2/voice/calls", (c) => handleCreateVoiceCall(c));
app.get("/v2/voice/calls", (c) => handleListVoiceCalls(c));
app.get("/v2/voice/calls/:id", (c) => handleGetVoiceCall(c));
app.patch("/v2/voice/calls/:id", (c) => handleUpdateVoiceCall(c));
app.delete("/v2/voice/calls/:id", (c) => handleEndVoiceCall(c, false));
app.post("/v2/voice/calls/:id/end", (c) => handleEndVoiceCall(c, true));
app.post("/v2/voice/calls/:id/transcript", (c) => handleVoiceCallTranscript(c));
app.post("/v2/voice/providers/elevenlabs/post-call", (c) => handleElevenLabsPostCall(c));
app.post("/v2/voice/providers/elevenlabs/tools/:tool", (c) => handleElevenLabsTool(c));

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

app.get("/v2/voices/search", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  return handleVoiceSearchRequest(c.env, auth.tenantId, c.req.raw);
});

app.post("/v2/moderations/images", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  return handleImageModerationRequest(c.env, auth.tenantId, c.req.raw);
});

app.post("/v2/images", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  return handleImageGenerateRequest(c.env, auth.tenantId, c.req.raw);
});

app.post("/v2/images/render", async (c) => {
  const auth = await authenticateRequest(c.env, c.req.raw);
  assertTenantScope(auth);
  const body = await readSvgRequest(c.req.raw);
  if (!body || typeof body !== "object" || body.format !== undefined && body.format !== "png") {
    throw new ApiError(400, "invalid_svg", "Supply an SVG and select PNG output");
  }
  const files = await resolveRenderFiles(c.env, auth.tenantId, body.files);
  return c.json(await renderSvg(c.env, body.svg, files));
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

const LEGACY_CHANNELS_DO_NAME = "camelrun:legacy-webhook-channels";

async function legacyBridgeTenantId(v1Tenant: string): Promise<string> {
  return `tnt_${(await sha256Hex(`legacy-v1-tenant:${v1Tenant}`)).slice(0, 16)}`;
}

async function ensureLegacyBridgeToken(env: Env, v1Tenant: string, initialCreditsUsd = 25): Promise<{ tenantId: string; token: string }> {
  const tenantId = await legacyBridgeTenantId(v1Tenant);
  const minted = await mintTenantApiKey(tenantId);
  const sealed = await sealSecret(minted.token, env.VAULT_SECRET);
  const res = await getTenantStub(env, tenantId).ensureLegacyBridgeTenant({
    tenantId,
    name: `v1:${v1Tenant}`,
    initialCreditsUsd,
    keyId: minted.id,
    keyPrefix: minted.prefix,
    keyHash: minted.keyHash,
    sealedToken: sealed,
  });
  return { tenantId, token: await openSecret(res.sealedToken, env.VAULT_SECRET) };
}

app.post("/v2/admin/legacy-channels", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
  const body = (await c.req.json()) as {
    id?: string;
    v1Tenant?: string;
    channelType?: string;
    name?: string;
    definitionId?: string | null;
    settings?: Record<string, unknown>;
    secret?: string;
    replyUrl?: string | null;
    initialCreditsUsd?: number;
  };
  if (!body.id?.trim() || !body.v1Tenant?.trim() || !body.secret?.trim()) {
    throw new ApiError(400, "invalid_request", "`id`, `v1Tenant`, and `secret` are required");
  }
  const { tenantId: v2TenantId } = await ensureLegacyBridgeToken(
    c.env,
    body.v1Tenant.trim(),
    body.initialCreditsUsd ?? 25,
  );
  const sealedSecret = await sealSecret(body.secret, c.env.VAULT_SECRET);
  const sealedReplyUrl = body.replyUrl?.trim()
    ? await sealSecret(body.replyUrl.trim(), c.env.VAULT_SECRET)
    : null;
  await getTenantStub(c.env, LEGACY_CHANNELS_DO_NAME).upsertLegacyWebhookChannel({
    id: body.id.trim(),
    v1Tenant: body.v1Tenant.trim(),
    v2TenantId,
    channelType: body.channelType?.trim() || "webhook",
    name: body.name?.trim() || body.id.trim(),
    definitionId: body.definitionId?.trim() || null,
    settingsJson: JSON.stringify(body.settings ?? {}),
    sealedSecret,
    sealedReplyUrl,
  });
  return c.json({ ok: true, id: body.id.trim(), v1Tenant: body.v1Tenant.trim(), v2TenantId });
});

app.post("/v2/admin/legacy-bridge-token", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
  const body = (await c.req.json()) as { v1Tenant?: string; initialCreditsUsd?: number };
  if (!body.v1Tenant?.trim()) {
    throw new ApiError(400, "invalid_request", "`v1Tenant` is required");
  }
  const { tenantId, token } = await ensureLegacyBridgeToken(
    c.env,
    body.v1Tenant.trim(),
    body.initialCreditsUsd ?? 25,
  );
  return c.json({ v1Tenant: body.v1Tenant.trim(), v2TenantId: tenantId, apiKey: token });
});

app.post("/v2/admin/voice-agent-token", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
  const body = (await c.req.json()) as { v1Tenant?: string; v2TenantId?: string; agentId?: string };
  const v1Tenant = body.v1Tenant?.trim();
  const agentId = body.agentId?.trim();
  if (!v1Tenant || !agentId) {
    throw new ApiError(400, "invalid_request", "`v1Tenant` and `agentId` are required");
  }
  const candidates: string[] = [];
  if (body.v2TenantId?.trim() && /^tnt_[0-9a-f]{16}$/.test(body.v2TenantId.trim())) {
    candidates.push(body.v2TenantId.trim());
  }
  const bridgeTenantId = await legacyBridgeTenantId(v1Tenant);
  if (!candidates.includes(bridgeTenantId)) {
    candidates.push(bridgeTenantId);
  }
  for (const tenantId of candidates) {
    const stub = getTenantStub(c.env, tenantId);
    const profile = await stub.getProfile();
    if (!profile) continue;
    const entry = await stub.resolveAgent(agentId);
    if (entry && entry.tenantId === tenantId) {
      const agentToken = await openSecret(entry.sealedToken, c.env.VAULT_SECRET);
      return c.json({ agentId: entry.id, tenantId, agentToken });
    }
  }
  throw new ApiError(404, "agent_not_found", "Unknown agent");
});

// ---- 5. Console Accounts (DO-backed, zero Postgres, admin-authenticated for ingress) ----

const CONSOLE_ACCOUNTS_DO_NAME = "__console_accounts__";
const DUMMY_PASSWORD_HASH = "0".repeat(64);
const DUMMY_PASSWORD_SALT = "0".repeat(32);

function normalizeConsoleEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

async function ensureTenantConsoleKey(
  env: Env,
  tenantId: string,
  displayName: string,
  existingSealedKey: string | null,
): Promise<{ apiKey: string; sealedConsoleKey: string }> {
  if (existingSealedKey) {
    return {
      apiKey: await openSecret(existingSealedKey, env.VAULT_SECRET),
      sealedConsoleKey: existingSealedKey,
    };
  }
  const tenantStub = getTenantStub(env, tenantId);
  const profile = await tenantStub.getProfile();
  const minted = await mintTenantApiKey(tenantId);
  if (!profile) {
    await tenantStub.initTenant({
      tenantId,
      name: displayName,
      tier: "pro",
      initialCreditsUsd: 0,
      keyId: minted.id,
      keyPrefix: minted.prefix,
      keyHash: minted.keyHash,
    });
  } else {
    await tenantStub.createApiKey({
      id: minted.id,
      name: "console-session",
      prefix: minted.prefix,
      keyHash: minted.keyHash,
      scopes: ["*"],
    });
  }
  const sealedConsoleKey = await sealSecret(minted.token, env.VAULT_SECRET);
  return { apiKey: minted.token, sealedConsoleKey };
}

app.post("/v2/admin/console/oauth-login", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    provider?: unknown;
    externalId?: unknown;
    email?: unknown;
    login?: unknown;
    name?: unknown;
  };
  const provider = body.provider === "github" || body.provider === "google" ? body.provider : null;
  const externalId = typeof body.externalId === "string" ? body.externalId.trim() : "";
  if (!provider || !externalId) {
    throw new ApiError(400, "invalid_request", "`provider` ('github' | 'google') and `externalId` are required");
  }
  const email = normalizeConsoleEmail(body.email);
  const login = typeof body.login === "string" && body.login.trim() ? body.login.trim() : email;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;

  const identityKeys = [`${provider}:${externalId}`];
  if (provider === "github" && login) identityKeys.push(`github_login:${login.toLowerCase()}`);
  if (email) identityKeys.push(`email:${email}`);

  const accountsStub = getTenantStub(c.env, CONSOLE_ACCOUNTS_DO_NAME);
  const existing = await accountsStub.lookupConsoleAccount({ identityKeys, email });
  const tenantId = existing?.tenantId ?? randomId("tnt", 8);
  const displayName = name || login || email || `${provider}-${externalId}`;
  const { apiKey, sealedConsoleKey } = await ensureTenantConsoleKey(
    c.env,
    tenantId,
    displayName,
    existing?.sealedConsoleKey ?? null,
  );
  const saved = await accountsStub.saveConsoleAccount({
    accountId: existing?.id,
    tenantId,
    identityKeys,
    email,
    login,
    name,
    sealedConsoleKey,
  });
  await recordOpsTenantRegistration(c.env, {
    tenantId: saved.tenantId,
    name: saved.name ?? displayName,
    kind: "self_serve",
    signIn: provider,
    email: saved.email,
    login: saved.login,
  });
  return c.json({
    tenantId: saved.tenantId,
    apiKey,
    email: saved.email,
    login: saved.login,
    name: saved.name,
    created: saved.created,
  });
});

app.post("/v2/admin/console/password-signup", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: unknown;
    password?: unknown;
    name?: unknown;
  };
  const email = normalizeConsoleEmail(body.email);
  if (!email) {
    throw new ApiError(400, "invalid_email", "Enter a valid email address");
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8 || password.length > 256) {
    throw new ApiError(400, "invalid_password", "Password must be between 8 and 256 characters");
  }
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : null;

  const accountsStub = getTenantStub(c.env, CONSOLE_ACCOUNTS_DO_NAME);
  const existing = await accountsStub.lookupConsoleAccount({ identityKeys: [`email:${email}`], email });
  if (existing) {
    throw new ApiError(409, "email_exists", "An account with this email already exists");
  }

  const { hash, salt } = await hashPassword(password);
  const tenantId = randomId("tnt", 8);
  const { apiKey, sealedConsoleKey } = await ensureTenantConsoleKey(c.env, tenantId, name || email, null);
  const saved = await accountsStub.saveConsoleAccount({
    tenantId,
    identityKeys: [`email:${email}`],
    email,
    login: email,
    name,
    passwordHash: hash,
    passwordSalt: salt,
    sealedConsoleKey,
    requireNewEmail: true,
  });
  await recordOpsTenantRegistration(c.env, {
    tenantId: saved.tenantId,
    name: saved.name ?? email,
    kind: "self_serve",
    signIn: "email",
    email: saved.email,
    login: saved.login,
  });
  return c.json(
    {
      tenantId: saved.tenantId,
      apiKey,
      email: saved.email,
      login: saved.login,
      name: saved.name,
      created: true,
    },
    201,
  );
});

app.post("/v2/admin/console/password-login", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
  const body = (await c.req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const email = normalizeConsoleEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password || password.length > 256) {
    throw new ApiError(401, "unauthorized", "Wrong email or password");
  }

  const accountsStub = getTenantStub(c.env, CONSOLE_ACCOUNTS_DO_NAME);
  const existing = await accountsStub.lookupConsoleAccount({ identityKeys: [`email:${email}`], email });
  const ok = existing?.passwordHash && existing?.passwordSalt
    ? await verifyPassword(password, existing.passwordHash, existing.passwordSalt)
    : (await verifyPassword(password, DUMMY_PASSWORD_HASH, DUMMY_PASSWORD_SALT), false);

  if (!existing || !ok) {
    throw new ApiError(401, "unauthorized", "Wrong email or password");
  }

  const { apiKey, sealedConsoleKey } = await ensureTenantConsoleKey(
    c.env,
    existing.tenantId,
    existing.name || existing.email || existing.tenantId,
    existing.sealedConsoleKey,
  );
  if (!existing.sealedConsoleKey) {
    await accountsStub.saveConsoleAccount({
      accountId: existing.id,
      tenantId: existing.tenantId,
      identityKeys: [`email:${email}`],
      sealedConsoleKey,
    });
  }
  return c.json({
    tenantId: existing.tenantId,
    apiKey,
    email: existing.email,
    login: existing.login ?? existing.email,
    name: existing.name,
  });
});

app.post("/v2/admin/console/link", async (c) => {
  if (!verifyAdminHeader(c.env, c.req.raw)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    tenantId?: unknown;
    email?: unknown;
    githubLogin?: unknown;
    githubId?: unknown;
    googleSub?: unknown;
    name?: unknown;
  };
  const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
  if (!tenantId) {
    throw new ApiError(400, "invalid_request", "`tenantId` is required");
  }
  const email = normalizeConsoleEmail(body.email);
  const githubLogin = typeof body.githubLogin === "string" && body.githubLogin.trim() ? body.githubLogin.trim() : null;
  const githubId = typeof body.githubId === "string" && body.githubId.trim() ? body.githubId.trim() : null;
  const googleSub = typeof body.googleSub === "string" && body.googleSub.trim() ? body.googleSub.trim() : null;
  const name = typeof body.name === "string" && body.name.trim() ? body.name.trim() : null;

  const identityKeys: string[] = [];
  if (email) identityKeys.push(`email:${email}`);
  if (githubLogin) identityKeys.push(`github_login:${githubLogin.toLowerCase()}`);
  if (githubId) identityKeys.push(`github:${githubId}`);
  if (googleSub) identityKeys.push(`google:${googleSub}`);
  if (identityKeys.length === 0) {
    throw new ApiError(400, "invalid_request", "Provide at least one of `email`, `githubLogin`, `githubId`, or `googleSub`");
  }

  const targetProfile = await getTenantStub(c.env, tenantId).getProfile();
  if (!targetProfile) {
    throw new ApiError(404, "tenant_not_found", `Tenant '${tenantId}' not found`);
  }

  const { sealedConsoleKey } = await ensureTenantConsoleKey(c.env, tenantId, name || targetProfile.name, null);
  const linked = await getTenantStub(c.env, CONSOLE_ACCOUNTS_DO_NAME).linkConsoleAccountToTenant({
    tenantId,
    identityKeys,
    email,
    login: githubLogin ?? email,
    name: name ?? targetProfile.name,
    sealedConsoleKey,
  });
  await recordOpsTenantRegistration(c.env, {
    tenantId,
    name: name ?? targetProfile.name,
    signIn: githubLogin || githubId ? "github" : googleSub ? "google" : email ? "email" : null,
    email,
    login: githubLogin ?? email,
    createdAt: targetProfile.createdAt,
  });
  return c.json({ ok: true, ...linked });
});

registerOpsRoutes(app);

/** Private binding used by the v1 adapter after it authenticates and loads a published migration route or translates v1 calls to v2. */
export class LegacyAgentRuns extends WorkerEntrypoint<Env> {
  async route(tenant: string, agent: string, request: Request): Promise<Response> {
    try {
      const path = new URL(request.url).pathname;
      const prefix = `/v2/agents/${agent}`;
      const tail = path.startsWith(prefix) ? path.slice(prefix.length) : "";
      const operation = tail.startsWith("/") ? tail.slice(1) : "";
      const write = request.method === "POST" && (operation === "runs" || operation === "abort");
      const patch = request.method === "PATCH" && operation === "model";
      const remove = request.method === "DELETE" && (operation === "" || operation === "detail");
      const read = request.method === "GET" && /^(?:detail|history|events|runs(?:\/[^/]+)?)$/.test(operation);
      if (!/^tnt_[0-9a-f]{16}$/.test(tenant) || !/^agt_[0-9a-f]{16}$/.test(agent) || (!write && !patch && !remove && !read)) {
        return errorResponse(404, "not_found", "Unsupported legacy agent route");
      }
      const entry = await getTenantStub(this.env, tenant).resolveAgent(agent);
      if (entry?.id !== agent || entry.tenantId !== tenant) return errorResponse(404, "agent_not_found", "Unknown agent");
      const token = await openSecret(entry.sealedToken, this.env.VAULT_SECRET);
      const headers = new Headers({ authorization: `Bearer ${token}` });
      for (const name of ["accept", "content-type"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const targetPath = operation === "detail" || operation === "" ? `/v2/agents/${agent}` : path;
      const scoped = new Request(new URL(targetPath + new URL(request.url).search, request.url), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      });
      if (request.method === "POST" && operation === "runs") {
        return await startAgentRun(scoped, this.env, this.ctx, agent, true);
      }
      return await app.fetch(scoped, this.env, this.ctx);
    } catch (error) {
      return toApiErrorResponse(error);
    }
  }

  async bridge(
    v1Tenant: string,
    path: string,
    request: Request,
    options?: { initialCreditsUsd?: number },
  ): Promise<Response> {
    try {
      if (!v1Tenant || v1Tenant.length > 128 || !path.startsWith("/v2/")) {
        return errorResponse(400, "invalid_request", "Invalid legacy bridge target");
      }
      const { token } = await ensureLegacyBridgeToken(this.env, v1Tenant, options?.initialCreditsUsd ?? 25);
      const headers = new Headers();
      headers.set("authorization", `Bearer ${token}`);
      for (const name of ["accept", "content-type", "idempotency-key"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
      const targetUrl = new URL(path, "https://legacy-v2.internal");
      const forwarded = new Request(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      });
      return await app.fetch(forwarded, this.env, this.ctx);
    } catch (error) {
      return toApiErrorResponse(error);
    }
  }

  async verifyBridgedAgentToken(
    token: string,
  ): Promise<{ tenantId: string; agentId: string; key: string } | null> {
    const match = /^cr_agt_(tnt_[0-9a-f]{16})_(agt_[0-9a-f]{16})\.[A-Za-z0-9_-]+$/.exec(token);
    if (!match) return null;
    const [, tenantId, agentId] = match;
    const tokenHash = await sha256Hex(token);
    const stub = getTenantStub(this.env, tenantId);
    const verified = await stub.verifyAgentToken(agentId, tokenHash);
    if (!verified) return null;
    const entry = await stub.resolveAgent(agentId);
    if (!entry) return null;
    return { tenantId, agentId, key: entry.key };
  }

  async resolveBridgedAgent(
    v1Tenant: string,
    idOrKey: string,
  ): Promise<{ tenantId: string; agentId: string; key: string; tokenHash: string } | null> {
    if (!v1Tenant || !idOrKey) return null;
    const tenantId = await legacyBridgeTenantId(v1Tenant);
    const stub = getTenantStub(this.env, tenantId);
    const profile = await stub.getProfile();
    if (!profile) return null;
    const entry = await stub.resolveAgent(idOrKey);
    if (!entry) return null;
    return { tenantId, agentId: entry.id, key: entry.key, tokenHash: entry.tokenHash };
  }

  async putMeta(v1Tenant: string, kind: string, id: string, data: unknown): Promise<void> {
    const tenantId = await legacyBridgeTenantId(v1Tenant);
    await ensureLegacyBridgeToken(this.env, v1Tenant);
    await getTenantStub(this.env, tenantId).putLegacyBridgeMeta(kind, id, data);
  }

  async getMeta<T = unknown>(v1Tenant: string, kind: string, id: string): Promise<T | null> {
    const tenantId = await legacyBridgeTenantId(v1Tenant);
    const stub = getTenantStub(this.env, tenantId);
    if (!(await stub.getProfile())) return null;
    return stub.getLegacyBridgeMeta<T>(kind, id);
  }

  async listMeta<T = unknown>(v1Tenant: string, kind: string): Promise<Array<{ id: string; data: T }>> {
    const tenantId = await legacyBridgeTenantId(v1Tenant);
    const stub = getTenantStub(this.env, tenantId);
    if (!(await stub.getProfile())) return [];
    return stub.listLegacyBridgeMeta<T>(kind);
  }

  async deleteMeta(v1Tenant: string, kind: string, id: string): Promise<boolean> {
    const tenantId = await legacyBridgeTenantId(v1Tenant);
    const stub = getTenantStub(this.env, tenantId);
    if (!(await stub.getProfile())) return false;
    return stub.deleteLegacyBridgeMeta(kind, id);
  }

  async legacyChannelWebhook(type: string, channelId: string, request: Request): Promise<Response | null> {
    try {
      if (type !== "webhook") return null;
      const row = await getTenantStub(this.env, LEGACY_CHANNELS_DO_NAME).getLegacyWebhookChannel(channelId);
      if (!row || row.channelType !== type) return null;

      const rawBody = await request.text();
      if (rawBody.length > 1024 * 1024) {
        return errorResponse(413, "payload_too_large", "Webhook body exceeds 1 MB");
      }
      const secret = await openSecret(row.sealedSecret, this.env.VAULT_SECRET);
      const parsedSettings = webhookSettings(JSON.parse(row.settingsJson || "{}"));
      const verified = await verifyLegacyWebhookSignature(parsedSettings.signature, secret, request.headers, rawBody);
      if (!verified) {
        return errorResponse(401, "invalid_signature", "Invalid webhook signature");
      }

      let payload: unknown;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        return errorResponse(400, "invalid_json", "Expected JSON webhook payload");
      }
      const inbound = webhookInbound(payload, request.headers, parsedSettings);
      if (!inbound) {
        return Response.json({ accepted: true, filtered: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
      }

      const tenantStub = getTenantStub(this.env, row.v2TenantId);
      const defEntry = row.definitionId ? await tenantStub.getDefinition(row.definitionId) : null;
      const defCfg = defEntry?.config ?? null;
      const safeConv = inbound.conversationId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 64) || "default";
      const agentKey = `ch_${row.id}_${safeConv}`;
      const existing = await tenantStub.resolveAgent(agentKey);
      const agentId = existing?.id ?? randomId("agt", 8);
      const mergedModel = defCfg?.model ?? this.env.DEFAULT_MODEL ?? DEFAULT_MODEL_ID;
      const mergedInstructions = defCfg?.instructions ?? `Channel agent for ${row.name}.`;

      if (!existing) {
        const { token, tokenHash } = await mintAgentToken(row.v2TenantId, agentId);
        const sealedToken = await sealSecret(token, this.env.VAULT_SECRET);
        await tenantStub.upsertAgentIndex({
          id: agentId,
          key: agentKey,
          tokenHash,
          sealedToken,
          model: mergedModel,
          repoId: defCfg?.repoId ?? null,
          branch: defCfg?.branch ?? "refs/heads/main",
          definitionSlug: row.definitionId,
        });
      }

      const agentStub = getAgentStub(this.env, agentId);
      await agentStub.initAgent({
        id: agentId,
        tenantId: row.v2TenantId,
        key: agentKey,
        model: mergedModel,
        instructions: mergedInstructions,
        definition: row.definitionId ?? undefined,
        tools: defCfg?.tools ?? [],
        mcpServers: defCfg?.mcpServers ?? [],
        builtins: defCfg?.builtins ?? [],
      });

      const replyUrl = row.sealedReplyUrl ? await openSecret(row.sealedReplyUrl, this.env.VAULT_SECRET) : null;
      const runWork = (async () => {
        const runRecord = await agentStub.startRun({
          prompt: inbound.text,
          idempotencyKey: `ch:${row.id}:${inbound.messageId}`,
          wait: true,
        });
        if (replyUrl && runRecord.text) {
          const msgId = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
          const outJson = JSON.stringify({
            type: "message",
            conversationId: inbound.conversationId,
            text: runRecord.text,
          });
          const sigHeaders = await signLegacyWebhook(msgId, outJson, secret);
          await fetch(replyUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...sigHeaders },
            body: outJson,
          }).catch(() => {});
        }
      })();
      this.ctx.waitUntil(runWork);

      return Response.json(
        { accepted: true, channelId: row.id, conversationId: inbound.conversationId, agentId },
        { status: 202, headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      return toApiErrorResponse(error);
    }
  }
}

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
