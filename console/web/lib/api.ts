import { useCallback, useEffect, useState } from "react";

/** Base prefix proxied by camelrun-v2-ingress to camelrun-v2-prod (/v2/*) using the HttpOnly console session cookie. */
export const V2_API_BASE = "/console/v2";

export function v2Path(path: string): string {
  if (path.startsWith("/console/")) return path;
  if (path.startsWith("/v2/")) return `/console${path}`;
  if (path === "/v2") return V2_API_BASE;
  return `${V2_API_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfter?: number;
  constructor(status: number, message: string, code?: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export async function api<T = any>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<T> {
  return (await request<T>(path, init)).value;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<{ value: T; headers: Headers }> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const target = v2Path(path);
  const response = await fetch(target, {
    method,
    credentials: "same-origin",
    signal: init.signal,
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      // Required for any cookie-authenticated write; cross-site pages cannot send it.
      ...(method !== "GET" && method !== "HEAD" ? { "X-Agent-Runtime-Console": "1" } : {}),
      ...init.headers,
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let value: any = undefined;
  try { value = text ? JSON.parse(text) : undefined; } catch { value = text; }
  if (!response.ok) {
    const retry = Number(response.headers.get("Retry-After"));
    const errObj = value?.error;
    const message = typeof errObj === "string"
      ? errObj
      : typeof errObj?.message === "string"
        ? errObj.message
        : `HTTP ${response.status}`;
    const code = typeof errObj?.code === "string"
      ? errObj.code
      : typeof value?.code === "string"
        ? value.code
        : undefined;
    throw new ApiError(
      response.status,
      message,
      code,
      Number.isFinite(retry) && retry > 0 ? retry : undefined,
    );
  }
  return { value: value as T, headers: response.headers };
}

export function useApi<T>(path: string | undefined, intervalMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(undefined);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught)));
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(!!path);
    void reload();
    if (!intervalMs || !path) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs, path]);
  return { data, error, loading, reload };
}

// ---- CamelRun v2 API types ----

export interface Me {
  tenantId: string;
  tenant: string;
  name: string;
  balanceUsd: number;
  tier: string;
  busyAgents: { active: number; limit: number };
  login?: string;
}

export const accountLabel = (tenant: string) => (/^tnt_[0-9a-f]{16}$/.test(tenant) ? undefined : tenant);

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

export interface ProviderEntry {
  provider: string;
  baseUrl: string | null;
  apiStyle: string | null;
  modelAliases?: Record<string, string>;
  updatedAt: number;
}

export interface Model {
  id: string;
  provider: string;
  modelId: string;
  reasoning?: boolean;
  maxTokens?: number;
  input: string[];
  cost: { input: number; output: number };
  available: boolean;
}

export type BuiltinSuite =
  | "files"
  | "images"
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

export interface AgentSummary {
  id: string;
  key: string;
  model: string;
  repoId: string | null;
  branch: string;
  definition: string | null;
  running?: boolean;
  createdAt: number;
  updatedAt: number;
}

export type RunStatus = "queued" | "running" | "input_required" | "completed" | "failed" | "cancelled";

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  vmMs: number;
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
  toolCalls: { id: string; name: string; ok: boolean }[];
  filesChanged: string[];
  usage: RunUsage;
  error: { code: string; message: string } | null;
}

export interface AgentDetail {
  id: string;
  key: string;
  tenantId: string;
  model: string;
  keyScope?: string | null;
  instructions: string;
  definition?: string | null;
  tools: CustomToolSpec[];
  mcpServers: McpServerSpec[];
  builtins: BuiltinSuite[];
  queue: { mode: "each" | "batch"; windowMs: number };
  repoId: string | null;
  lineage: string | null;
  branch: string;
  spendLimitUsd: number;
  idleTtlSeconds: number;
  dreaming: { enabled: boolean; idleSeconds: number };
  status: "running" | "idle";
  activeRunId: string | null;
  messageCount: number;
  lastRun: RunRecord | null;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  seq: number;
  runId: string | null;
  role: "system" | "user" | "assistant" | "tool";
  content: {
    text?: string;
    files?: { path: string; commit: string; contentType: string; size?: number }[];
    toolCalls?: { id: string; name: string; argumentsJson?: string; args?: Record<string, unknown> }[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    meta?: Record<string, unknown>;
  };
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

export interface DefinitionConfig {
  model?: string;
  keyScope?: string | null;
  instructions?: string;
  builtins?: BuiltinSuite[];
  mcpServers?: McpServerSpec[];
  tools?: CustomToolSpec[];
  spendLimitUsd?: number;
  idleTtlSeconds?: number;
  dreaming?: { enabled: boolean; idleSeconds: number };
}

export interface Definition {
  slug: string;
  config: DefinitionConfig;
  createdAt: number;
  updatedAt: number;
}

export interface RepoRecord {
  repoId: string;
  name: string;
  lineage: string;
  defaultRef: string;
  commit: string;
  createdAt: number;
  refs?: { name: string; commit: string; tree: string; updatedAt: number }[];
}

export interface RepoLsEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  size: number;
  mode: number;
  hash: string;
}

export interface RepoReadResult {
  commit: string;
  path: string;
  size: number;
  mode: number;
  binary: boolean;
  content: string | null;
  base64: string | null;
}

export interface RepoCommit {
  commit: string;
  tree: string;
  parents: string[];
  author: string;
  message: string;
  createdAt: number;
}

export interface Channel {
  id: string;
  kind: "slack" | "email" | "http";
  name: string;
  definition: string | null;
  outboundUrl: string | null;
  createdAt: number;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: number;
}

export interface UsageDay {
  day: string;
  model: string;
  kind: string;
  cost: number;
  platformCost: number;
  responses: number;
  input: number;
  output: number;
}

export interface UsageResponse {
  days: UsageDay[];
}

export interface LedgerEntry {
  id: string;
  refId: string;
  amountUsd: number;
  kind: string;
  note: string | null;
  createdAt: number;
}

export interface Billing {
  balanceUsd: number;
  monthlyCapUsd: number;
  tier?: string;
  rateLimitRpm?: number;
  busyAgents: { busy: number; limit: number | null };
  usage: {
    day: string;
    model: string;
    runsCount: number;
    inputTokens: number;
    outputTokens: number;
    vmMs: number;
    costUsd: number;
  }[];
  recent?: LedgerEntry[];
}

// ---- Formatting helpers ----

export const formatUsd = (value: number) => {
  const abs = Math.abs(value);
  return `${value < 0 ? "−" : ""}$${abs === 0 || abs >= 0.01 ? abs.toFixed(2) : abs.toFixed(6).replace(/0+$/, "")}`;
};

export const formatNumber = (value: number) =>
  new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);

export const formatCost = (value: number) => `$${value === 0 || value >= 1 ? value.toFixed(2) : value.toFixed(4)}`;

export function formatAgo(value: number | null | undefined, now = Date.now()) {
  if (!value) return "—";
  const seconds = Math.max(0, (now - value) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

export const formatTime = (value?: number | null) =>
  value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

export const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  let size = value;
  for (; size >= 1024 && index < units.length - 1; index++) size /= 1024;
  return `${index ? size.toFixed(1) : size} ${units[index]}`;
};
