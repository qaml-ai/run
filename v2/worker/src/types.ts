import type { DurableObject } from "cloudflare:workers";
import type { TenantDO } from "./tenant-do.ts";
import type { ToolImageRef } from "./tool-images.ts";
import type { AgentDO } from "./agent-do.ts";
import type { VoiceCallDO } from "./voice-call-do.ts";

export type RpcStub<T extends DurableObject<Env>> = DurableObjectStub<undefined> & {
  [K in Exclude<keyof T, keyof DurableObject<Env>>]: T[K];
};

export interface Env {
  MEDIA_BUCKET?: R2Bucket;
  IMAGES?: ImagesBinding;
  BROWSER?: BrowserRun;
  SVG_RENDERER?: Fetcher;
  EVENTS_QUEUE?: Queue<QueueMessagePayload>;
  TENANT_DO: DurableObjectNamespace<TenantDO>;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
  VOICE_CALL_DO?: DurableObjectNamespace<VoiceCallDO>;
  CODEMODE_SANDBOX?: DurableObjectNamespace;
  ADMIN_SECRET: string;
  VAULT_SECRET: string;
  BUILDER_CUTOVER_CREDIT_TENANT_ID?: string;
  APP_RUNTIME_CREDIT_TENANT_IDS?: string;
  OPS_INTERNAL_DOMAINS?: string;
  CAMELFS_URL: string;
  CAMELFS_SIGNING_KEY?: string;
  CAMELFS_DEV_TOKEN?: string;
  TOOL_IDENTITY_ISSUER?: string;
  TOOL_IDENTITY_PRIVATE_JWK?: string;
  DEFAULT_MODEL?: string;
  BROWSER_DEFAULT_ENGINE?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_BROWSER_RUN_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_BROWSER_RUN_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  AZURE_OPENAI_SOL_ENDPOINT?: string;
  AZURE_OPENAI_SOL_API_KEY?: string;
  AZURE_OPENAI_LUNA_ENDPOINT?: string;
  AZURE_OPENAI_LUNA_API_KEY?: string;
  AZURE_OPENAI_REALTIME_ENDPOINT?: string;
  AZURE_OPENAI_REALTIME_API_KEY?: string;
  AZURE_OPENAI_REALTIME_MODELS?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  VOICE_OPENAI_BASE_URL?: string;
  VOICE_ELEVENLABS_BASE_URL?: string;
  VOICE_PUBLIC_URL?: string;
  AGENT_VOICE_SESSIONS_PER_TENANT?: string;
}

export type AuthKind = "admin" | "tenant" | "agent";

export interface AuthContext {
  kind: AuthKind;
  tenantId: string;
  keyId?: string;
  agentId?: string;
  scopes: string[];
}

export type BuiltinSuite =
  | "files"
  | "images"
  | "browser"
  | "bash"
  | "codemode"
  | "delegate"
  | "workflows"
  | "web_search"
  | "web_fetch"
  | "human"
  | "skills"
  | "tool_search";

export interface CustomToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  url?: string;
  headers?: Record<string, string>;
  requiresApproval?: boolean;
  deferred?: boolean;
}

export interface McpServerSpec {
  name: string;
  url: string;
  headers?: Record<string, string>;
  auth?: { type: "runtime" };
  audience?: string;
  allowTools?: string[];
  deferred?: boolean;
}

export interface ToolIdentity {
  subject: string;
  context?: Record<string, unknown>;
}

export interface QueueModeConfig {
  mode: "each" | "batch";
  windowMs: number;
}

export interface DreamingConfig {
  enabled: boolean;
  idleSeconds: number;
}

export interface CompactOnIdleConfig {
  enabled: boolean;
  /** Idle duration in seconds after which prompt cache is assumed cold (default 600 = 10 min). */
  idleSeconds: number;
  /** Minimum estimated uncompacted context tokens required to trigger idle-resume compaction (default 12_000). */
  minTokens?: number;
  /** Approximate recent tokens kept verbatim when compacting on idle resume (default 4_000). */
  keepRecentTokens?: number;
}

export const DEFAULT_COMPACT_ON_IDLE_SECONDS = 600;
export const DEFAULT_COMPACT_ON_IDLE_MIN_TOKENS = 12_000;
export const DEFAULT_COMPACT_ON_IDLE_KEEP_RECENT_TOKENS = 4_000;

export function normalizeCompactOnIdleConfig(
  raw: unknown,
): CompactOnIdleConfig | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "invalid_request", "`compactOnIdle` must be an object or null");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enabled !== undefined && typeof obj.enabled !== "boolean") {
    throw new ApiError(400, "invalid_request", "`compactOnIdle.enabled` must be a boolean");
  }
  const enabled = obj.enabled ?? false;

  let idleSeconds = DEFAULT_COMPACT_ON_IDLE_SECONDS;
  if (obj.idleSeconds !== undefined) {
    if (
      typeof obj.idleSeconds !== "number" ||
      !Number.isFinite(obj.idleSeconds) ||
      obj.idleSeconds < 1
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "`compactOnIdle.idleSeconds` must be a finite integer >= 1",
      );
    }
    idleSeconds = Math.floor(obj.idleSeconds);
  }

  let minTokens: number | undefined;
  if (obj.minTokens !== undefined) {
    if (
      typeof obj.minTokens !== "number" ||
      !Number.isFinite(obj.minTokens) ||
      obj.minTokens < 0
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "`compactOnIdle.minTokens` must be a finite number >= 0",
      );
    }
    minTokens = Math.floor(obj.minTokens);
  }

  let keepRecentTokens: number | undefined;
  if (obj.keepRecentTokens !== undefined) {
    if (
      typeof obj.keepRecentTokens !== "number" ||
      !Number.isFinite(obj.keepRecentTokens) ||
      obj.keepRecentTokens < 0
    ) {
      throw new ApiError(
        400,
        "invalid_request",
        "`compactOnIdle.keepRecentTokens` must be a finite number >= 0",
      );
    }
    keepRecentTokens = Math.floor(obj.keepRecentTokens);
  }

  return {
    enabled,
    idleSeconds,
    ...(minTokens !== undefined ? { minTokens } : {}),
    ...(keepRecentTokens !== undefined ? { keepRecentTokens } : {}),
  };
}

export type AgentEngine = "pi";

export interface AgentConfig {
  id: string;
  tenantId: string;
  key: string;
  engine?: AgentEngine;
  model: string;
  keyScope?: string | null;
  instructions: string;
  definition?: string | null;
  tools: CustomToolSpec[];
  mcpServers: McpServerSpec[];
  toolIdentity?: ToolIdentity;
  builtins: BuiltinSuite[];
  skills?: string[];
  queue: QueueModeConfig;
  repoId: string | null;
  lineage: string | null;
  branch: string;
  spendLimitUsd: number;
  idleTtlSeconds: number;
  compactThresholdTokens?: number;
  compactOnIdle?: CompactOnIdleConfig;
  dreaming: DreamingConfig;
  createdAt: number;
  updatedAt: number;
}

export interface AgentUpsertInput {
  engine?: AgentEngine;
  model?: string;
  keyScope?: string | null;
  instructions?: string;
  definition?: string;
  tools?: CustomToolSpec[];
  mcpServers?: McpServerSpec[];
  toolIdentity?: ToolIdentity;
  builtins?: BuiltinSuite[];
  skills?: string[];
  queue?: Partial<QueueModeConfig>;
  repoId?: string | null;
  branch?: string;
  spendLimitUsd?: number;
  idleTtlSeconds?: number;
  compactThresholdTokens?: number;
  compactOnIdle?: Partial<CompactOnIdleConfig> | null;
  dreaming?: Partial<DreamingConfig>;
  /** Optional first run prompt to create + start an agent in a single HTTP request. */
  prompt?: string;
  idempotencyKey?: string;
  whileRunning?: "queue" | "steer";
  wait?: boolean;
  outputSchema?: Record<string, unknown> | null;
  maxSteps?: number;
  supersedeInputs?: boolean;
}

export type RunStatus =
  | "queued"
  | "running"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd: number;
  vmMs: number;
  byok?: boolean;
}

export interface ToolCallSummary {
  id: string;
  name: string;
  ok: boolean;
}

export interface PendingInputView {
  id: string;
  runId: string;
  toolCallId: string;
  kind: "approval" | "question";
  prompt: Record<string, unknown>;
  status: "pending" | "answered" | "denied" | "expired" | "superseded" | "cancelled";
  expiresAt: number;
}

export interface RunErrorShape {
  code: string;
  message: string;
}

export interface RunRecord {
  id: string;
  agentId: string;
  actor?: string;
  idempotencyKey: string | null;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  text: string;
  output: unknown;
  batchedInto: string | null;
  inputs: PendingInputView[];
  toolCalls: ToolCallSummary[];
  filesChanged: string[];
  usage: RunUsage;
  error: RunErrorShape | null;
}

export interface RunFile {
  path: string;
  commit: string;
  contentType: string;
}

export interface StoredRunFile extends RunFile {
  lineage: string;
  size: number;
  resized?: ToolImageRef;
}

export interface StartRunInput {
  prompt: string;
  actor?: string;
  keyScope?: string | null;
  files?: RunFile[];
  idempotencyKey?: string;
  whileRunning?: "queue" | "steer";
  wait?: boolean;
  outputSchema?: Record<string, unknown> | null;
  maxSteps?: number;
  spendLimitUsd?: number;
  supersedeInputs?: boolean;
}

export interface StartRunHints {
  runId?: string;
  preacquiredSlot?: boolean;
  prefetchedProvider?: { model: string; keyScope?: string | null; credentials: ProviderCredentials | null };
  prefetchedBalanceUsd?: number;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCallInvocation {
  id: string;
  name: string;
  argumentsJson: string;
  args: Record<string, unknown>;
}

export interface StoredMessageContent {
  toolImages?: ToolImageRef[];
  text?: string;
  files?: StoredRunFile[];
  toolCalls?: ToolCallInvocation[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export interface StoredMessage {
  seq: number;
  runId: string | null;
  role: ChatRole;
  content: StoredMessageContent;
  tokensEst: number;
  createdAt: number;
}

export interface AgentEventRecord {
  seq: number;
  runId: string | null;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ScheduleRecord {
  id: string;
  intervalSeconds: number | null;
  cronExpr: string | null;
  prompt: string;
  nextDueAt: number;
  enabled: boolean;
}

export interface ChildAgentRecord {
  id: string;
  childAgentId: string;
  childAgentKey: string;
  parentRunId: string | null;
  status: "running" | "completed" | "failed";
  result: unknown;
}

export type ProviderApiStyle =
  | "openai-chat"
  | "openai-responses"
  | "openai-codex"
  | "anthropic"
  | "gemini";

export interface ProviderCredentials {
  provider: string;
  apiKey: string;
  baseUrl?: string | null;
  modelAliases?: Record<string, string>;
  headers?: Record<string, string>;
  apiStyle?: ProviderApiStyle | null;
  scope?: string | null;
}

export type ModelStreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; argumentsJson: string; args: Record<string, unknown> }
  | { type: "done"; inputTokens: number; outputTokens: number; stopReason: string; cacheReadTokens?: number };

export interface LlmToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type QueueMessagePayload =
  | {
      kind: "webhook";
      tenantId: string;
      eventType: string;
      eventId: string;
      createdAt: number;
      payload: Record<string, unknown>;
    }
  | {
      kind: "channel_reply";
      tenantId: string;
      channelId: string;
      channelKind: string;
      outboundUrl: string;
      sealedSecret?: string | null;
      threadId: string;
      agentId: string;
      runId: string;
      replyText: string;
      meta?: Record<string, unknown>;
    };

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Extracts structured HTTP status/code/message from either a local `ApiError`
 * or an RPC-reconstructed Error serialized via `enhanced_error_serialization`.
 */
export function extractApiError(
  err: unknown,
): { status: number; code: string; message: string } | null {
  if (err instanceof ApiError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  if (err && typeof err === "object") {
    const record = err as { status?: unknown; code?: unknown; message?: unknown };
    if (typeof record.status === "number" && typeof record.code === "string") {
      return {
        status: record.status,
        code: record.code,
        message:
          typeof record.message === "string" && record.message.length > 0
            ? record.message
            : record.code,
      };
    }
  }
  return null;
}

export function jsonResponse(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extraHeaders ?? {}),
    },
  });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

export function toApiErrorResponse(err: unknown): Response {
  const apiErr = extractApiError(err);
  if (apiErr) {
    return errorResponse(apiErr.status, apiErr.code, apiErr.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return errorResponse(500, "internal_error", message);
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

export function emptyUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, costUsd: 0, vmMs: 0 };
}
