import { useCallback, useEffect, useState } from "react";

/** The console uses the same /v1 API as scripts; its session cookie authenticates it. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  const response = await fetch(path, {
    method, credentials: "same-origin",
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      // Required for any cookie-authenticated write; cross-site pages cannot send it.
      ...(method !== "GET" ? { "X-Agent-Runtime-Console": "1" } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  let value: any = undefined;
  try { value = text ? JSON.parse(text) : undefined; } catch { value = text; }
  if (!response.ok) throw new ApiError(response.status, value?.error ?? `HTTP ${response.status}`);
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

export interface Me { tenant: string; via: "operator" | "token" | "console"; login?: string; canStoreKeys: boolean }
export interface KeyStatus { provider: string; source: "tenant" | "admin" | "platform"; last4?: string; setAt?: number }
export interface Provider { id: string; models: number; apiKey: boolean; requires?: string; key: KeyStatus | null }
export interface Model {
  id: string; provider: string; modelId: string; name: string; api: string; reasoning: boolean; input: string[];
  contextWindow: number; maxTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; available: boolean;
}
export interface AgentSummary { id: string; name: string; type: string; model: string; connected: boolean; running: boolean; expiresAt: number | null }
export interface RequestRecord {
  id: string; method: string; state: "running" | "completed"; startedAt?: number; endedAt?: number; prompt?: string;
  outcome?: { result?: unknown; error?: string; uncertain?: boolean };
}
export interface AgentDetail extends AgentSummary {
  definition?: { id: string; revision: number };
  tools: { name: string; description: string }[]; systemPrompt: string; requests: RequestRecord[];
}
export interface ApiToken { id: string; name: string; prefix: string; createdAt: number }
export interface Usage {
  since: number;
  totals: { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  days: { day: string; model: string; kind: "turn" | "compaction"; responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; platformCost: number }[];
}
/** Credit amounts are integer micro-USD. */
export type LedgerKind = "grant" | "purchase" | "usage" | "storage" | "adjustment" | "refund";
export interface LedgerEntry { id: number; kind: LedgerKind; amount: number; metadata: Record<string, any>; createdAt: number }
export interface Billing {
  billing: "prepaid" | "none"; balance: number; freeCredit: boolean; checkout: boolean;
  month: { since: number } & Record<LedgerKind, number>;
  recent: LedgerEntry[];
  rates: { agentHour: number; storageGbMonth: number; purchaseFeeBps: number; minPurchase: number; maxPurchase: number };
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
  mcpServers?: { name: string; url: string; headerNames?: string[]; auth?: { type: "bearer" } }[];
  openApi?: { name: string; spec?: string; baseUrl: string; tools: string[]; allowTools?: string[]; denyTools?: string[]; exposure?: string; timeoutMs?: number; headerNames?: string[]; auth?: { type: "bearer" } }[];
}
export interface Channel {
  id: string; type: string; name: string; webhookUrl?: string; definition?: string;
  access: { public: boolean; allow: string[] }; limits: { perSenderPerMinute: number; turnsPerDay: number };
  greeting?: string; account: Record<string, string>; credentials: Record<string, string>; createdAt: number;
}
