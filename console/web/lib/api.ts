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

export async function api<T = any>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  return (await request<T>(path, init)).value;
}

/** A GET of a paged list: its page, and the cursor of the next (the X-Next-Cursor header) while there are more. */
export async function apiPage<T>(path: string): Promise<{ items: T[]; next?: string }> {
  const { value, headers } = await request<T[]>(path);
  return { items: value, next: headers.get("X-Next-Cursor") ?? undefined };
}

async function request<T>(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ value: T; headers: Headers }> {
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
        ...init.headers,
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
  return { value: value as T, headers: response.headers };
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

/** `useApi` for one page of a paged list (`apiPage`): polled with `intervalMs`, that page only. */
export function useApiPage<T>(path: string | undefined, intervalMs?: number) {
  const [data, setData] = useState<{ items: T[]; next?: string; path: string }>();
  const [error, setError] = useState<ApiError>();
  const reload = useCallback(async () => {
    if (!path) return;
    try { const page = await apiPage<T>(path); setData({ ...page, path }); setError(undefined); }
    catch (caught) { setError(caught instanceof ApiError ? caught : new ApiError(0, String(caught))); }
  }, [path]);
  useEffect(() => {
    void reload();
    if (!intervalMs) return;
    const timer = setInterval(() => void reload(), intervalMs);
    return () => clearInterval(timer);
  }, [reload, intervalMs]);
  // A page another query left is not this one's: loading until this one's arrives.
  const current = data?.path === path ? data : undefined;
  return { items: current?.items, next: current?.next, stale: !current && !!data, previous: data?.items, error, reload };
}

/** `login` (Google or sign-in address, or GitHub login) and `name` are the person; `tenant` is the account's id, for the API and support only. */
export interface Me { tenant: string; via: "operator" | "token" | "console" | "oauth"; login?: string; name?: string; signIn?: "github" | "google" | "password"; canStoreKeys: boolean }
/** How to name an account on pages that only have its id: sign-in ids (`u-…`) mean nothing to people. */
/** The admin site's GET /api/stats (src/admin-site.ts): every tenant, for the team. Amounts are micro-USD, costs USD. */
export interface AdminStats {
  viewer: string;
  days: number;
  signups: { total: number; last24h: number; last7d: number; last30d: number; deleted: number; github: number; google: number; email: number; operator: number };
  activation: { tenants: number; withToken: number; withAgent: number; withUsage: number; purchased: number };
  agents: { live: number; tenants: number };
  purchases: { count: number; buyers: number; amount: number };
  daily: { day: string; signups: number; activeTenants: number; responses: number; cost: number; platformCost: number }[];
  recent: {
    tenant: string; github: string | null; googleEmail: string | null; signIn: "github" | "google" | "email" | "operator" | null;
    createdAt: number; deleted: boolean; tokens: number; agents: number; responses: number; cost: number; balance: number; purchased: number;
  }[];
}
export const accountLabel = (tenant: string) => /^u-[0-9a-f]{16,32}$/.test(tenant) ? undefined : tenant;
export interface KeyStatus { provider: string; source: "tenant" | "admin" | "platform"; last4?: string; setAt?: number; region?: string }
export interface Provider { id: string; kind: "model" | "search" | "fetch" | "speech"; models: number; apiKey: boolean; requires?: string; key: KeyStatus | null }
export interface Model {
  id: string; provider: string; modelId: string; name: string; api: string; reasoning: boolean; input: string[];
  contextWindow: number; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; available: boolean;
  /** Whether tool-call arguments stream as the model writes them (true), arrive in one piece (false), or were not measured. */
  toolCallStreaming: boolean | "unknown";
}
export interface AgentSummary {
  id: string; name: string; type: string; model: string; connected: boolean; running: boolean; expiresAt: number | null;
  /** The key it was made with (an upsert's, or an Idempotency-Key); null without one. */
  key?: string | null;
  /** A sub-agent's parent: the agent whose delegate call made it. */
  parentAgentId?: string;
  /** In GET /v1/agents: its workspace (null: none), when its latest run ended, and its latest failed run (a class, never text). */
  workspaceId?: string | null;
  lastActiveAt?: number | null;
  lastError?: { at: number; class: string } | null;
}
/** GET /v1/agents' page size in the console, and its filters. */
export const AGENT_PAGE = 50;
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
}
export interface ApiToken { id: string; name: string; prefix: string; createdAt: number }
export interface OAuthGrant { id: string; clientName: string; login: string | null; scope: string; createdAt: number; usedAt: number | null }
export interface Workspace { id: string; name: string; archived: boolean; createdAt: number; updatedAt: number }
export interface WorkspaceMembership { kind: "agent" | "definition"; id: string; workspaceId: string | null }
export interface Usage {
  workspaces?: { id: string | null; name: string; responses: number; cost: number }[];
  since: number;
  totals: { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  days: { day: string; model: string; kind: "turn" | "compaction" | "transcription" | "image" | "speech" | "decision" | "computer" | "browser"; responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; platformCost: number }[];
  /** Without workspaceId: each workspace's spend by UTC day (null: Unassigned). */
  workspaceDays?: { day: string; workspace: string | null; responses: number; cost: number }[];
}
/** Credit amounts are integer micro-USD. */
export type LedgerKind = "grant" | "purchase" | "usage" | "storage" | "adjustment" | "refund";
export interface LedgerEntry { id: number; kind: LedgerKind; amount: number; metadata: Record<string, any>; createdAt: number }
export interface BusyAgents {
  busy?: number; /** null: no limit (the internal tier). */ limit: number | null; source: "tier" | "tenant" | "internal" | "default"; tier?: string; paid?: number;
  next?: { tier: string; paid: number; limit: number };
}
export interface Billing {
  billing: "prepaid" | "none"; balance: number; purchased: number; freeCredit: boolean; checkout: boolean;
  /** How many agents may be busy at once, and why; a prepaid tenant's tier moves up as soon as a payment lands. */
  busyAgents: BusyAgents;
  /** The account's run rate limit (null: none), and on free credit what buying credit raises it to. */
  runsPerMinute?: { limit: number; afterPurchase?: number | null } | null;
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
/** "now", "5m ago", "3h ago", "2d ago", then the date: how long ago something happened. */
export function formatAgo(value: number | null | undefined, now = Date.now()) {
  if (!value) return "—";
  const seconds = Math.max(0, (now - value) / 1000);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 30 * 86400) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}
export const formatTime = (value?: number) => value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
export interface Definition {
  id: string; name: string; revision: number; model?: string; systemPrompt?: string; thinkingLevel?: string;
  limits?: { ttlSeconds?: number | null }; mounts?: unknown[]; createdAt: number; updatedAt: number; builtins?: string[];
  /** On a save: builtins its agents cannot use yet (no key), and how to fix it. */
  warnings?: string[];
  mcpServers?: { name: string; url: string; headerNames?: string[]; auth?: { type: "bearer" | "runtime" | "exchange"; url?: string; audience?: string } }[];
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
/** `system`: the server's system channel; `canPost`: whether Camel may view and send there (absent when unknown). */
export interface DiscordGuildChannel { id: string; name: string; type: number; system?: boolean; canPost?: boolean }

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
  /** Audio transcribed when it was attached, or why it was not. */
  transcript?: { text: string; language?: string; seconds: number; model: string };
  untranscribed?: string;
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

