import { useCallback, useEffect, useState } from "react";
import { helpRequestScope, recordHelpFailure } from "./help-context";

/** The console uses the same /v1 API as scripts; its session cookie authenticates it. */
export class ApiError extends Error {
  status: number;
  code?: string;
  retryAfter?: number;
  constructor(status: number, message: string, code?: string, retryAfter?: number) {
    super(message); this.status = status; this.code = code; this.retryAfter = retryAfter;
  }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const scope = helpRequestScope();
  let response: Response;
  let text: string;
  try {
    response = await fetch(path, {
      method, credentials: "same-origin",
      headers: {
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        // Required for any cookie-authenticated write; cross-site pages cannot send it.
        ...(method !== "GET" ? { "X-Agent-Runtime-Console": "1" } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    text = await response.text();
  } catch (error) {
    recordHelpFailure(scope, method, path, 0);
    throw error;
  }
  let value: any = undefined;
  try { value = text ? JSON.parse(text) : undefined; } catch { value = text; }
  if (!response.ok) {
    recordHelpFailure(scope, method, path, response.status);
    const retry = Number(response.headers.get("Retry-After"));
    throw new ApiError(response.status, value?.error ?? `HTTP ${response.status}`, typeof value?.code === "string" ? value.code : undefined,
      Number.isFinite(retry) && retry > 0 ? retry : undefined);
  }
  return value as T;
}

export function useApi<T>(path: string | undefined, intervalMs?: number) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(!!path);
  const reload = useCallback(async () => {
    if (!path) return;
    try { setData(await api<T>(path)); setError(undefined); }
    catch (caught) { setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught))); }
    finally { setLoading(false); }
  }, [path]);
  useEffect(() => {
    setLoading(!!path);
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs, path]);
  return { data, error, loading, reload };
}

/** `login` (Google address or GitHub login) and `name` are the person; `tenant` is the account's id, for the API and support only. */
export interface Me { tenant: string; via: "operator" | "token" | "console" | "oauth"; login?: string; name?: string; canStoreKeys: boolean }
/** How to name an account on pages that only have its id: sign-in ids (`u-…`) mean nothing to people. */
export const accountLabel = (tenant: string) => /^u-[0-9a-f]{16,32}$/.test(tenant) ? undefined : tenant;
export interface KeyStatus { provider: string; source: "tenant" | "admin" | "platform"; last4?: string; setAt?: number }
export interface Provider { id: string; kind: "model" | "search" | "fetch"; models: number; apiKey: boolean; requires?: string; key: KeyStatus | null }
export interface Model {
  id: string; provider: string; modelId: string; name: string; api: string; reasoning: boolean; input: string[];
  contextWindow: number; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; available: boolean;
}
export interface AgentSummary {
  id: string; name: string; type: string; model: string; connected: boolean; running: boolean; expiresAt: number | null;
  /** A sub-agent's parent: the agent whose delegate call made it. */
  parentAgentId?: string;
}
export interface RequestRecord {
  id: string; method: string; state: "running" | "completed"; startedAt?: number; endedAt?: number; prompt?: string;
  outcome?: { result?: unknown; error?: string; uncertain?: boolean };
}
export interface ApplyResult { agent: string; requestId: string; status: "updated" | "queued" | "failed"; error?: string }
export type Exposure = "direct" | "codemode" | "both";
export interface ToolSource {
  kind: "channel" | "application" | "files" | "builtin" | "mcp" | "openapi"; name: string;
  status: "listed" | "unlisted" | "error"; error?: string; listedAt?: number; connected?: boolean; url?: string; exposure?: Exposure;
  tools: { name: string; description: string; exposure?: Exposure; parameters?: Record<string, unknown>; excluded?: string }[];
}
export interface AgentDetail extends AgentSummary {
  definition?: { id: string; revision: number };
  tools: { name: string; description: string }[]; toolSources: ToolSource[]; systemPrompt: string; requests: RequestRecord[]; mounts?: Mount[];
  /** For a fork: the agent it was forked from, and the index of that agent's last message it began with. */
  forkedFrom?: { agentId: string; atMessage: number | null };
  /** A sub-agent: the run of parentAgentId that made it. */
  parentRunId?: string;
  /** The definition a handoff gave the conversation to, which runs the agent now. */
  handedOff?: { definition: { id: string; revision: number }; name: string; at: number } | null;
}
export interface ApiToken { id: string; name: string; prefix: string; createdAt: number }
export interface OAuthGrant { id: string; clientName: string; login: string | null; scope: string; createdAt: number; usedAt: number | null }
export interface Usage {
  since: number;
  totals: { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  days: { day: string; model: string; kind: "turn" | "compaction"; responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; platformCost: number }[];
}
/** Credit amounts are integer micro-USD. */
export type LedgerKind = "grant" | "purchase" | "usage" | "storage" | "adjustment" | "refund";
export interface LedgerEntry { id: number; kind: LedgerKind; amount: number; metadata: Record<string, any>; createdAt: number }
export interface BusyAgents {
  busy?: number; limit: number; source: "tier" | "tenant" | "default"; tier?: string; paid?: number;
  next?: { tier: string; paid: number; limit: number };
}
export interface Billing {
  billing: "prepaid" | "none"; balance: number; purchased: number; freeCredit: boolean; checkout: boolean;
  /** How many agents may be busy at once, and why; a prepaid tenant's tier moves up as soon as a payment lands. */
  busyAgents: BusyAgents;
  /** `cardCheck`: verifying a card (POST /v1/billing/card-check) would add this much starting credit. */
  startingCredit: { status: "granted" | "not_eligible" | "not_granted" | "not_applicable"; amount: number; cardCheck?: { amount: number } };
  month: { since: number } & Record<LedgerKind, number>;
  recent: LedgerEntry[];
  rates: { agentHour: number; storageGbMonth: number; openrouterCreditMultiplier?: number; purchaseFeeBps: number; minPurchase: number; maxPurchase: number; webSearch: Record<string, number>; webRender: number };
}
/** Micro-USD as dollars: cents, or finer for amounts under a cent. */
export const formatMicros = (value: number) => {
  const usd = Math.abs(value) / 1_000_000;
  return `${value < 0 ? "−" : ""}$${usd === 0 || usd >= 0.01 ? usd.toFixed(2) : usd.toFixed(6).replace(/0+$/, "")}`;
};

export const formatNumber = (value: number) => new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
export const formatCost = (value: number) => `$${value === 0 || value >= 1 ? value.toFixed(2) : value.toFixed(4)}`;
export const formatTime = (value?: number) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
export interface Definition {
  id: string; name: string; revision: number; model?: string; systemPrompt?: string; thinkingLevel?: string;
  limits?: { ttlSeconds?: number | null }; mounts?: unknown[]; createdAt: number; updatedAt: number; builtins?: string[];
  /** On a save: builtins its agents cannot use yet (no key), and how to fix it. */
  warnings?: string[];
  mcpServers?: { name: string; url: string; headerNames?: string[]; auth?: { type: "bearer" } }[];
  openApi?: { name: string; spec?: string; baseUrl: string; tools: string[]; allowTools?: string[]; denyTools?: string[]; exposure?: string; timeoutMs?: number; headerNames?: string[]; auth?: { type: "bearer" } }[];
}
export interface Channel {
  id: string; type: string; name: string; webhookUrl?: string; definition?: string;
  access: { public: boolean; allow: string[] }; limits: { perSenderPerMinute: number; turnsPerDay: number };
  greeting?: string; settings?: Record<string, any>; account: Record<string, string>; credentials: Record<string, string>; createdAt: number;
}

export interface ManagedDiscordConfig { enabled: boolean; applicationId?: string; installPath?: string; limits?: { servers: number; turnsPerDay: number } }
export interface ManagedDiscordBinding {
  guildId: string; guildName: string; state: "active" | "paused" | "disconnected";
  installationState: "present" | "unavailable" | "removed"; channelId: string | null;
  allowedChannelIds: string[]; channel?: Channel;
  applied?: { agent: string; status: "updated" | "queued" | "failed"; error?: string }[];
  /** On a save: builtins of its definition it cannot use yet (no key), and how to fix it. */
  warnings?: string[];
}
export interface DiscordGuildChannel { id: string; name: string; type: number }

export interface VolumeSummary { id: string; name: string; createdAt: number }
export interface Volume extends VolumeSummary { seq: number; files: number; bytes: number; origin?: { volume: string; snapshot?: string; seq: number } }
export interface Snapshot { id: string; volume: string; name: string; seq: number; createdAt: number; files: number; bytes: number }
export interface VolumeFile { path: string; version: number; size: number; updatedAt: number; by?: string; contentType: string }
export interface FileLink { url: string; method: "GET" | "PUT"; volume: string; path: string; expiresAt: number; maxBytes?: number; contentType?: string }
export interface Mount { volumeId: string; path: string; mode: "ro" | "rw"; subpath?: string; notify?: boolean }
/** A file in the transcript: `path` is where the agent saw it, `volume` the volume it was in. */
export interface FileRef {
  type: "file"; path: string; volume: string; version: number; size: number; contentType: string;
  media?: { kind: "image"; mimeType: string; width: number; height: number } | { kind: "pdf"; pages: number } | { kind: "none"; reason: string };
}
/** What a run's outcome adds to its result: files written (paths as the agent saw them), and those handed over with present_file. */
export interface RunFiles { files?: { path: string; version: number; size: number; contentType: string }[]; presented?: (FileRef & { caption?: string })[] }

/** A volume file's path as a URL path, each segment encoded. */
export const filePath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
export const signLink = (volume: string, path: string) => api<FileLink>(`/v1/volumes/${volume}/links`, { body: { path } });

/** PUT a file with upload progress, which fetch cannot report. */
export function putFile(url: string, file: Blob, onProgress?: (fraction: number) => void): Promise<any> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    request.setRequestHeader("X-Agent-Runtime-Console", "1");
    if (file.type) request.setRequestHeader("Content-Type", file.type);
    request.upload.onprogress = event => { if (event.lengthComputable) onProgress?.(event.loaded / event.total); };
    request.onload = () => {
      let value: any; try { value = JSON.parse(request.responseText); } catch { value = undefined; }
      if (request.status >= 200 && request.status < 300) resolve(value);
      else reject(new ApiError(request.status, value?.error ?? `HTTP ${request.status}`));
    };
    request.onerror = () => reject(new ApiError(0, "The upload failed"));
    request.send(file);
  });
}

export const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB"];
  let index = 0;
  for (; value >= 1024 && index < units.length - 1; index++) value /= 1024;
  return `${index ? value.toFixed(1) : value} ${units[index]}`;
};

export interface AlertChoices { low: boolean; depleted: boolean; problems: boolean; receipts: boolean }
export interface BillingRecipient { id: string; email: string; status: "pending" | "verified" | "bounced" | "unsubscribed"; events: AlertChoices }
export interface BillingAlerts { threshold: number; emailEnabled: boolean; recipients: BillingRecipient[] }
export interface BillingCard { brand: string; last4: string; expMonth: number; expYear: number }
export interface PaymentMethod { portal: boolean; customer: boolean; card: BillingCard | null }
export interface AutoTopupQuote { id: string; version: string; threshold: number; amount: number; fee: number; total: number; monthlyLimit: number; card: BillingCard | null; immediate: boolean; expiresAt: number }
export interface AutoTopup {
  enabled: boolean; state: "off" | "on" | "processing" | "cancelling" | "action_required" | "paused_declined" | "paused_no_card" | "paused_expired" | "limit_reached" | "reconcile";
  version: number; threshold: number; amount: number; fee: number; total: number; monthlyLimit: number;
  usedThisPeriod: number; held: number; resetsAt: number;
  attempt: { id: string; state: string; amount: number; fee: number; total: number; card: BillingCard | null; invoiceUrl: string | null; canRetry: boolean; submitted: boolean } | null;
}

export type TelemetryProtocol = "http/protobuf" | "http/json";
/** Where the tenant's traces go (`GET /v1/telemetry`): header names only, their values are never returned. */
export interface Telemetry {
  endpoint: string; protocol: TelemetryProtocol; sampleRate: number; include: { content: boolean }; headers: string[];
  createdAt: number; updatedAt: number;
  status: { lastExportAt: number | null; lastError: string | null; lastErrorAt: number | null };
}
export interface TelemetryTest { ok: boolean; status?: number; error?: string; traceId: string; spanId: string }
