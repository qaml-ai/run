import type { DurableObject } from "cloudflare:workers";
import type { TenantDO } from "./tenant-do.ts";
import type { AgentDO } from "./agent-do.ts";

export type RpcStub<T extends DurableObject<Env>> = DurableObjectStub<undefined> & {
  [K in Exclude<keyof T, keyof DurableObject<Env>>]: T[K];
};

export interface Env {
  MEDIA_BUCKET?: R2Bucket;
  EVENTS_QUEUE?: Queue<QueueMessagePayload>;
  TENANT_DO: DurableObjectNamespace<TenantDO>;
  AGENT_DO: DurableObjectNamespace<AgentDO>;
  ADMIN_SECRET: string;
  VAULT_SECRET: string;
  CAMELFS_URL: string;
  CAMELFS_SIGNING_KEY?: string;
  CAMELFS_DEV_TOKEN?: string;
  TOOL_IDENTITY_ISSUER?: string;
  TOOL_IDENTITY_PRIVATE_JWK?: string;
  DEFAULT_MODEL?: string;
  OPENAI_API_KEY?: string;
  AZURE_OPENAI_SOL_ENDPOINT?: string;
  AZURE_OPENAI_SOL_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  ELEVENLABS_API_KEY?: string;
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
  | "bash"
  | "codemode"
  | "delegate"
  | "workflows"
  | "web_search"
  | "web_fetch"
  | "human";

export interface CustomToolSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  url?: string;
  headers?: Record<string, string>;
  requiresApproval?: boolean;
}

export interface McpServerSpec {
  name: string;
  url: string;
  headers?: Record<string, string>;
  auth?: { type: "runtime" };
  audience?: string;
  allowTools?: string[];
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

export interface AgentConfig {
  id: string;
  tenantId: string;
  key: string;
  model: string;
  instructions: string;
  definition?: string | null;
  tools: CustomToolSpec[];
  mcpServers: McpServerSpec[];
  toolIdentity?: ToolIdentity;
  builtins: BuiltinSuite[];
  queue: QueueModeConfig;
  repoId: string | null;
  lineage: string | null;
  branch: string;
  spendLimitUsd: number;
  idleTtlSeconds: number;
  dreaming: DreamingConfig;
  createdAt: number;
  updatedAt: number;
}

export interface AgentUpsertInput {
  model?: string;
  instructions?: string;
  definition?: string;
  tools?: CustomToolSpec[];
  mcpServers?: McpServerSpec[];
  toolIdentity?: ToolIdentity;
  builtins?: BuiltinSuite[];
  queue?: Partial<QueueModeConfig>;
  repoId?: string | null;
  branch?: string;
  spendLimitUsd?: number;
  idleTtlSeconds?: number;
  dreaming?: Partial<DreamingConfig>;
  /** Optional first run prompt to create + start an agent in a single HTTP request. */
  prompt?: string;
  idempotencyKey?: string;
  whileRunning?: "queue" | "steer";
  wait?: boolean;
  outputSchema?: Record<string, unknown> | null;
  maxSteps?: number;
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
  costUsd: number;
  vmMs: number;
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
  status: "pending" | "answered" | "denied" | "expired";
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
}

export interface StartRunInput {
  prompt: string;
  actor?: string;
  files?: RunFile[];
  idempotencyKey?: string;
  whileRunning?: "queue" | "steer";
  wait?: boolean;
  outputSchema?: Record<string, unknown> | null;
  maxSteps?: number;
  spendLimitUsd?: number;
}

export interface StartRunHints {
  runId?: string;
  preacquiredSlot?: boolean;
  prefetchedProvider?: { model: string; credentials: ProviderCredentials | null };
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

export interface ProviderCredentials {
  provider: string;
  apiKey: string;
  baseUrl?: string | null;
  modelAliases?: Record<string, string>;
}

export type ModelStreamChunk =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call"; id: string; name: string; argumentsJson: string; args: Record<string, unknown> }
  | { type: "done"; inputTokens: number; outputTokens: number; stopReason: string };

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
