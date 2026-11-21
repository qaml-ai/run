/**
 * Shared types and pure date/formatting helpers for the CamelRun v2 `/ops`
 * admin dashboard (`console/web/pages/ops/*` and `v2/worker/src/ops-api.ts`).
 *
 * Kept free of any Postgres or Node-only dependencies so both the browser
 * bundle and Cloudflare Workers can import it directly.
 */

export const DAY_MS = 86_400_000;
export const USD_MICROS = 1_000_000;
export const ADMIN_WINDOW_DAYS = [7, 30, 90] as const;
export const ADMIN_MAX_WINDOW_DAYS = 365;
export const ADMIN_COHORT_WEEKS = 12;
export const ADMIN_FREE_CREDIT_ROWS = 200;
export const ADMIN_PROMPT_CHARS = 1500;
export const ADMIN_ACCOUNT_AGENTS = 50;
export const ADMIN_TREND_DAYS = 14;
export const ADMIN_TREND_MAX_DAYS = 90;
export const ADMIN_TIME_ZONE = "America/Chicago";

export type AdminAccountKind = "self_serve" | "operator_made" | "operator";

export interface AdminAccountName {
  tenant: string;
  name: string;
  kind: AdminAccountKind;
  sign_in: "github" | "google" | "email" | null;
  signed_up_at: string | null;
}

export interface AdminWindow {
  days: number;
  start_date: string;
  end_date: string;
  previous_start_date: string;
  incomplete_date: string;
  time_zone: "UTC";
}

export type AdminUsageKind = "models" | "compaction" | "voice" | "images" | "web" | "tool_search" | "compute";

export interface AdminCompare {
  current: number;
  previous: number;
}

export type AdminSourceKind = "plugin" | "ref" | "referrer" | "direct" | "not_captured";

export interface AdminSource {
  source: string;
  kind: AdminSourceKind;
  signups: number;
  made_agent: number;
  activated: number;
  active_two_days: number;
  paying: number;
  median_days_to_first_run: number | null;
}

export interface AdminAcquisition {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  sources: AdminSource[];
  total: AdminSource;
  daily: { date: string; counts: number[] }[];
  recorded_since: string | null;
}

export interface AdminGrowthDay {
  date: string;
  signups: number;
  github: number;
  google: number;
  email: number;
  active_new: number;
  active_returning: number;
  accounts: number;
}

export interface AdminCohort {
  week: string;
  size: number;
  active: number[];
}

export interface AdminFunnel {
  signed_up: number;
  made_agent: number;
  ran_model: number;
  came_back: number;
}

export interface AdminGrowth {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  accounts: number;
  tiles: {
    signups: AdminCompare;
    activated: AdminCompare;
    weekly_active: AdminCompare;
    weekly_returning: AdminCompare;
  };
  daily: AdminGrowthDay[];
  sign_in: { github: number; google: number; email: number };
  funnel: AdminFunnel;
  previous_funnel: AdminFunnel;
  median_days_to_first_run: number | null;
  cohorts: AdminCohort[];
}

export type AdminSpendDay = { date: string } & Record<AdminUsageKind, number>;

export type AdminPayer = "paying" | "free" | "operator" | "unbilled" | "staff";

export interface AdminSpendAccount extends AdminAccountName {
  payer: AdminPayer;
  cost: number;
  responses: number;
}

export interface AdminCheck {
  key: string;
  label: string;
  status: "ok" | "warn" | "bad" | "info";
  value: string;
  detail: string;
}

export interface AdminNode {
  node: string;
  draining: boolean;
  actors: number;
  expires_in_s: number;
}

export interface AdminHealth {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  spend: {
    window: AdminCompare;
    month_to_date: number;
    month_projection: number;
    last_month: number;
    daily: AdminSpendDay[];
    by_payer: Record<AdminPayer, number>;
    by_provider: { provider: string; cost: number; responses: number }[];
    top_accounts: AdminSpendAccount[];
    own_key_responses: number;
    platform_responses: number;
  };
  checks: AdminCheck[];
  nodes: AdminNode[];
}

export type McpClientKind = "chatgpt" | "codex" | "claude" | "other";

export const MCP_CLIENT_KINDS: readonly McpClientKind[] = ["chatgpt", "codex", "claude", "other"];
export const MCP_CLIENT_LABELS: Record<McpClientKind, string> = {
  chatgpt: "ChatGPT plugin",
  codex: "Codex plugin",
  claude: "Claude plugin",
  other: "Other MCP client",
};

export interface AdminMcp {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  daily: { date: string; kind: McpClientKind; signups: number; token_active_accounts: number }[];
  weekly: { week: string; kind: McpClientKind; token_active_accounts: number }[];
  funnel: { kind: McpClientKind; label: string; authorized: number; made_agent: number; ran_turn: number; came_back: number }[];
  limitations: string[];
}

export interface AdminRevenueDay {
  date: string;
  purchases: number;
  amount: number;
  refunds: number;
}

export interface AdminRevenueMonth {
  month: string;
  amount: number;
  refunds: number;
  buyers: number;
}

export type AdminFreeCreditBucket = "untouched" | "tried" | "using" | "nearly_out" | "used_up";

export interface AdminFreeCreditAccount extends AdminAccountName {
  via: "github" | "card" | "operator" | "other";
  given: number;
  used: number;
  left: number;
  bucket: AdminFreeCreditBucket;
  purchased: number;
  responses: number;
  active_days: number;
  last_active: string | null;
}

export interface AdminRevenue {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  tiles: {
    revenue: AdminCompare;
    refunds: AdminCompare;
    buyers: AdminCompare;
    first_purchases: AdminCompare;
    paying_accounts: number;
    auto_topup: number;
    outstanding_purchased: number;
    outstanding_free: number;
  };
  daily: AdminRevenueDay[];
  monthly: AdminRevenueMonth[];
  spend: {
    paying_charged: number;
    paying_provider_cost: number;
    free_charged: number;
    free_provider_cost: number;
  };
  free_credit: {
    accounts: number;
    given: number;
    used: number;
    buckets: Record<AdminFreeCreditBucket, number>;
    used_any: number;
    bought: number;
    without: number;
    decisions: { eligible: number; ineligible: number; disabled: number; legacy: number; card_unlocked: number };
    provider_cost: number;
    rows: AdminFreeCreditAccount[];
  };
}

export interface AdminUsageDay {
  date: string;
  self_serve: number;
  operator: number;
  other: number;
}

export interface AdminModelRow {
  model: string;
  responses: number;
  accounts: number;
  cost: number;
  self_serve_responses: number;
  self_serve_accounts: number;
}

export interface AdminConfiguredModel {
  model: string;
  agents: number;
  accounts: number;
  self_serve_agents: number;
  self_serve_accounts: number;
}

export interface AdminFeature {
  key: string;
  label: string;
  agents: number;
  self_serve_agents: number;
}

export interface AdminIntegration {
  key: string;
  label: string;
  accounts: number;
  self_serve_accounts: number;
}

export interface AdminUsageAccount extends AdminAccountName {
  staff: boolean;
  deleted: boolean;
  agents: number;
  responses: number;
  cost: number;
  platform_cost: number;
  active_days: number;
  last_active: string | null;
  models: string[];
  balance: number | null;
  purchased: number;
}

export interface AdminTopAgent {
  agent: string;
  name: string;
  model: string;
  kind: "agent" | "run" | "child";
  deleted: boolean;
  account: AdminAccountName & { staff: boolean };
  responses: number;
  end_users: number;
  active_days: number;
  last_at: string;
}

export interface AdminUsage {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  tiles: {
    active_accounts: AdminCompare;
    responses: AdminCompare;
    self_serve_responses: AdminCompare;
    agents_ran: AdminCompare;
    self_serve_agents_ran: AdminCompare;
    end_users: AdminCompare;
    self_serve_end_users: AdminCompare;
    live_agents: number;
    self_serve_live_agents: number;
  };
  daily: AdminUsageDay[];
  attempts_since: string | null;
  models: AdminModelRow[];
  configured_models: AdminConfiguredModel[];
  features: AdminFeature[];
  integrations: AdminIntegration[];
  mcp_clients: { client: string; accounts: number }[];
  accounts: AdminUsageAccount[];
  agents: AdminTopAgent[];
}

export interface AdminAccountAgent {
  agent: string;
  name: string;
  type: string;
  model: string;
  definition: string | null;
  builtins: string[];
  mcp_servers: string[];
  openapi: number;
  app_tools: number;
  code_mode: boolean;
  schedules: number;
  channel: string | null;
  responses: number;
  end_users: number;
  last_at: string | null;
  system_prompt: string;
  system_prompt_length: number;
}

export interface AdminAccountDetail {
  schema_version: 1;
  range: AdminWindow;
  generated_at: string;
  account: AdminAccountName & {
    staff: boolean;
    deleted: boolean;
    billing: "prepaid" | "none" | null;
    balance: number;
    purchased: number;
    granted: number;
    tier?: string;
    monthly_cap_usd?: number;
    concurrency_limit?: number;
    rate_limit_rpm?: number;
    busy_agents?: number;
  };
  usage: {
    responses: number;
    cost: number;
    platform_cost: number;
    active_days: number;
    models: { model: string; responses: number; cost: number }[];
  };
  daily: { date: string; responses: number }[];
  agents: AdminAccountAgent[];
  live_agents: number;
  channels: { type: string; name: string }[];
  counts: { api_keys: number; definitions: number; volumes: number; schedules: number };
  provider_keys: string[];
  mcp_clients: string[];
}

export interface AdminActivationCoverage {
  status: "full" | "partial" | "none" | "unavailable";
  since: string | null;
}

export interface AdminSignalsDay {
  date: string;
  signups: number;
  activations: number | null;
  payments: number;
  amount_minor: number;
}

export interface AdminSignals {
  schema_version: 1;
  range: { start_date: string; end_date: string; time_zone: string };
  generated_at: string;
  summary: {
    signups: number;
    activations: number | null;
    payments: number;
    paying_accounts: number;
    amount_minor: number;
    currency: "USD";
  };
  daily: AdminSignalsDay[];
  activation_coverage: AdminActivationCoverage;
}

export interface AdminTrendDay {
  date: string;
  signups: number;
  returning_active: number;
}

export interface AdminTrend {
  schema_version: 1;
  range: { start_date: string; end_date: string; time_zone: "UTC" };
  generated_at: string;
  daily: AdminTrendDay[];
  incomplete_date: string | null;
}

export class AdminWindowError extends Error {}

export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function parseAdminWindow(raw: number | string, now = Date.now()): {
  days: number;
  from: number;
  until: number;
  previousFrom: number;
  range: AdminWindow;
} {
  const days = typeof raw === "string" && raw.trim() === "" ? 30 : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > ADMIN_MAX_WINDOW_DAYS) {
    throw new AdminWindowError(`days must be a whole number from 1 to ${ADMIN_MAX_WINDOW_DAYS}`);
  }
  const today = startOfUtcDay(now);
  const from = today - (days - 1) * DAY_MS;
  const until = today + DAY_MS;
  const previousFrom = from - days * DAY_MS;
  return {
    days,
    from,
    until,
    previousFrom,
    range: {
      days,
      start_date: utcDate(from),
      end_date: utcDate(today),
      previous_start_date: utcDate(previousFrom),
      incomplete_date: utcDate(today),
      time_zone: "UTC",
    },
  };
}

export function windowDates(from: number, days: number): string[] {
  return Array.from({ length: days }, (_, index) => utcDate(from + index * DAY_MS));
}

export function freeCreditBucket(given: number, used: number): AdminFreeCreditBucket {
  const cent = 10_000;
  if (used < cent) return "untouched";
  if (given - used < cent) return "used_up";
  const share = used / given;
  return share < 0.25 ? "tried" : share < 0.75 ? "using" : "nearly_out";
}

export function maskSecrets(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[private key hidden]")
    .replace(
      /\b(?:sk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}|cr_(?:live|agt)_[A-Za-z0-9_.-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|whsec_[A-Za-z0-9+/=]{16,}|art_[0-9a-f]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|[MN][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,})/g,
      (secret) => `${secret.slice(0, 4)}…[hidden]`,
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[hidden]");
}
