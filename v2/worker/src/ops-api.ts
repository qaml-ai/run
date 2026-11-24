import type { Hono } from "hono";
import {
  ADMIN_ACCOUNT_AGENTS,
  ADMIN_COHORT_WEEKS,
  ADMIN_FREE_CREDIT_ROWS,
  ADMIN_PROMPT_CHARS,
  ADMIN_TIME_ZONE,
  ADMIN_TREND_DAYS,
  ADMIN_TREND_MAX_DAYS,
  AdminWindowError,
  DAY_MS,
  MCP_CLIENT_KINDS,
  MCP_CLIENT_LABELS,
  USD_MICROS,
  freeCreditBucket,
  maskSecrets,
  parseAdminWindow,
  startOfUtcDay,
  utcDate,
  windowDates,
  type AdminAccountAgent,
  type AdminAccountDetail,
  type AdminAccountKind,
  type AdminAccountName,
  type AdminAcquisition,
  type AdminCheck,
  type AdminCohort,
  type AdminFreeCreditAccount,
  type AdminFreeCreditBucket,
  type AdminFunnel,
  type AdminGrowth,
  type AdminGrowthDay,
  type AdminHealth,
  type AdminMcp,
  type AdminPayer,
  type AdminRevenue,
  type AdminRevenueDay,
  type AdminRevenueMonth,
  type AdminSource,
  type AdminSourceKind,
  type AdminSignals,
  type AdminSpendAccount,
  type AdminSpendDay,
  type AdminTopAgent,
  type AdminTrend,
  type AdminUsage,
  type AdminUsageAccount,
  type AdminUsageDay,
  type AdminUsageKind,
} from "../../../shared/ops-types.ts";
import { getAgentStub } from "./agent-do.ts";
import { verifyAdminHeader } from "./auth.ts";
import { listAllOAuthGrants, listTenantOAuthGrants, type OAuthGrantRecord } from "./oauth.ts";
import {
  getInfraCredit,
  grantInfraCredit,
  loadAllSignupSources,
  normalizeSignupSource,
  type SignupSource,
  type StoredSignupSource,
} from "./ops-metadata.ts";
import { getTenantStub, type OpsRegisteredTenant, type TenantOpsSnapshot } from "./tenant-do.ts";
import { ApiError, type Env } from "./types.ts";

export const CONSOLE_ACCOUNTS_DO_NAME = "__console_accounts__";

const DEFAULT_STAFF_DOMAINS = ["camelai.com", "qaml.ai"];
const FANOUT_CONCURRENCY = 20;

interface HydratedTenant {
  reg: OpsRegisteredTenant;
  snapshot: TenantOpsSnapshot;
  kind: AdminAccountKind;
  staff: boolean;
  counted: boolean;
  name: string;
  createdAt: number;
  signIn: AdminAccountName["sign_in"];
}

function getStaffDomains(env: Env): Set<string> {
  const extra = (env.OPS_INTERNAL_DOMAINS ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  return new Set([...DEFAULT_STAFF_DOMAINS, ...extra]);
}

function isStaffEmail(email: string | null | undefined, domains: Set<string>): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  return domains.has(email.slice(at + 1).toLowerCase());
}

function isOperatorReserveTenant(env: Env, tenantId: string): boolean {
  if (env.BUILDER_CUTOVER_CREDIT_TENANT_ID && tenantId === env.BUILDER_CUTOVER_CREDIT_TENANT_ID) {
    return true;
  }
  const appIds = (env.APP_RUNTIME_CREDIT_TENANT_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return appIds.includes(tenantId);
}

function toMicros(usdAmount: number): number {
  return Math.round(usdAmount * USD_MICROS);
}

function classifyProvider(model: string): string {
  const stripped = model.replace(/^(?:compaction|transcription|image):/, "");
  const slash = stripped.indexOf("/");
  if (slash > 0) return stripped.slice(0, slash).toLowerCase();
  if (stripped.startsWith("claude")) return "anthropic";
  if (stripped.startsWith("gpt-") || stripped.startsWith("o1") || stripped.startsWith("o3") || stripped.startsWith("o4")) return "openai";
  if (stripped.startsWith("gemini")) return "gemini";
  return "other";
}

function classifyUsageKind(model: string): AdminUsageKind {
  const lower = model.toLowerCase();
  if (lower.startsWith("compaction:")) return "compaction";
  if (lower.startsWith("image:")) return "images";
  if (
    lower.startsWith("voice:") ||
    lower.startsWith("transcription:") ||
    lower.startsWith("speech:") ||
    lower.startsWith("elevenlabs/") ||
    lower.includes("realtime")
  ) {
    return "voice";
  }
  if (lower.startsWith("web:")) return "web";
  return "models";
}

const FEATURE_LABELS: Record<string, string> = {
  workspace: "Persistent workspace",
  web_search: "Web search",
  x_search: "X search",
  web_fetch: "Reads web pages",
  codemode: "Code mode",
  files: "Workspace files",
  human: "Human in the loop",
  images: "Makes images",
  generate_image: "Makes images",
  mcp: "MCP servers",
  app_tools: "App tools",
  schedule: "Schedules",
  delegate: "Sub-agents",
  agents: "Sub-agents",
  ask_user: "Asks a person",
};

function featureLabel(key: string): string {
  return FEATURE_LABELS[key] ?? key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

function dateInTimeZone(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: ADMIN_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  }
}

function hostOf(url: unknown): string {
  try {
    return typeof url === "string" ? new URL(url).host : "?";
  } catch {
    return "?";
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function weekStartUtc(dateStr: string): string {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  const dow = (Math.floor(ms / DAY_MS) + 3) % 7; // Monday = 0
  return utcDate(ms - dow * DAY_MS);
}

function accountNameOf(t: HydratedTenant): AdminAccountName {
  return {
    tenant: t.reg.tenantId,
    name: t.name,
    kind: t.kind,
    sign_in: t.signIn,
    signed_up_at: t.createdAt > 0 ? new Date(t.createdAt).toISOString() : null,
  };
}

function isStarterGrantLedgerEntry(entry: { kind: string; refId: string }): boolean {
  return entry.kind === "grant" || entry.refId.startsWith("starter_grant:");
}

function effectiveLedgerTotals(snapshot: TenantOpsSnapshot): {
  purchasedUsd: number;
  grantedUsd: number;
  refundedUsd: number;
  usageUsd: number;
  firstTopupAt: number | null;
} {
  let reclassifiedGrantUsd = 0;
  let earliestPaidTopupAt: number | null = null;
  let sawAnyPaidEntry = false;
  for (const entry of snapshot.ledger) {
    if ((entry.kind === "topup" || entry.kind === "purchase") && entry.amountUsd > 0) {
      if (isStarterGrantLedgerEntry(entry)) {
        reclassifiedGrantUsd += entry.amountUsd;
      } else {
        sawAnyPaidEntry = true;
        earliestPaidTopupAt =
          earliestPaidTopupAt === null ? entry.createdAt : Math.min(earliestPaidTopupAt, entry.createdAt);
      }
    }
  }
  const purchasedUsd = Math.max(0, Number((snapshot.ledgerSummary.purchasedUsd - reclassifiedGrantUsd).toFixed(8)));
  const grantedUsd = Math.max(0, Number((snapshot.ledgerSummary.grantedUsd + reclassifiedGrantUsd).toFixed(8)));
  const firstTopupAt =
    reclassifiedGrantUsd > 0
      ? (sawAnyPaidEntry ? earliestPaidTopupAt : null)
      : snapshot.ledgerSummary.firstTopupAt;
  return {
    purchasedUsd,
    grantedUsd,
    refundedUsd: snapshot.ledgerSummary.refundedUsd,
    usageUsd: snapshot.ledgerSummary.usageUsd,
    firstTopupAt,
  };
}

function payerOf(t: HydratedTenant): AdminPayer {
  if (t.kind === "operator") return "operator";
  if (t.staff) return "staff";
  const ledger = effectiveLedgerTotals(t.snapshot);
  if (ledger.purchasedUsd - ledger.refundedUsd > 0) return "paying";
  if (ledger.grantedUsd > 0 || t.snapshot.profile.balanceUsd > 0) return "free";
  return "unbilled";
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await fn(items[idx]!);
      }
    }),
  );
  return results;
}

async function collectTenants(
  env: Env,
  lookbackDays: number,
  snapshotOpts?: { currentFromMs?: number; currentUntilMs?: number; previousFromMs?: number },
): Promise<{ tenants: HydratedTenant[]; registeredCount: number; failedCount: number }> {
  const registry = await getTenantStub(env, CONSOLE_ACCOUNTS_DO_NAME).listOpsTenants();
  const staffDomains = getStaffDomains(env);
  let failedCount = 0;

  const settled = await mapWithConcurrency(registry, FANOUT_CONCURRENCY, async (reg) => {
    try {
      const snapshot = await getTenantStub(env, reg.tenantId).getOpsSnapshot(lookbackDays, snapshotOpts);
      if (!snapshot) return null;
      const staff = isStaffEmail(reg.email, staffDomains);
      const kind: AdminAccountKind =
        reg.kind === "operator" || (reg.kind !== "self_serve" && isOperatorReserveTenant(env, reg.tenantId))
          ? "operator"
          : reg.kind;
      const counted = kind === "self_serve" && !staff;
      const createdAt = Math.min(reg.createdAt || snapshot.profile.createdAt, snapshot.profile.createdAt);
      const name = reg.login || reg.email || reg.name || snapshot.profile.name || reg.tenantId;
      return {
        reg,
        snapshot,
        kind,
        staff,
        counted,
        name,
        createdAt,
        signIn: reg.signIn,
      } satisfies HydratedTenant;
    } catch {
      failedCount++;
      return null;
    }
  });

  return {
    tenants: settled.filter((item): item is HydratedTenant => item !== null),
    registeredCount: registry.length,
    failedCount,
  };
}

function tenantActiveDays(t: HydratedTenant): Set<string> {
  const days = new Set<string>();
  for (const row of t.snapshot.usageDaily) {
    const kind = classifyUsageKind(row.model);
    if (row.runsCount > 0 && (kind === "models" || kind === "voice")) {
      days.add(row.day);
    }
  }
  return days;
}

function buildGrowth(tenants: HydratedTenant[], rawDays: string, now = Date.now()): AdminGrowth {
  const win = parseAdminWindow(rawDays, now);
  const dates = windowDates(win.from, win.days);
  const dateSet = new Set(dates);
  const prevStartStr = utcDate(win.previousFrom);
  const startStr = utcDate(win.from);
  const endStr = utcDate(win.until - DAY_MS);

  const counted = tenants.filter((t) => t.counted);
  const today = startOfUtcDay(now);
  const thisWeekEnd = today; // last 7 whole UTC days = yesterday back (today - 7d .. today - 1d)
  const thisWeekStartStr = utcDate(thisWeekEnd - 7 * DAY_MS);
  const thisWeekLastStr = utcDate(thisWeekEnd - DAY_MS);
  const prevWeekStartStr = utcDate(thisWeekEnd - 14 * DAY_MS);
  const prevWeekLastStr = utcDate(thisWeekEnd - 8 * DAY_MS);

  const dailyMap = new Map<string, AdminGrowthDay>();
  for (const date of dates) {
    dailyMap.set(date, {
      date,
      signups: 0,
      github: 0,
      google: 0,
      email: 0,
      active_new: 0,
      active_returning: 0,
      accounts: 0,
    });
  }

  let signupsCurrent = 0;
  let signupsPrevious = 0;
  let activatedCurrent = 0;
  let activatedPrevious = 0;
  let weeklyActiveCurrent = 0;
  let weeklyActivePrevious = 0;
  let weeklyReturningCurrent = 0;
  let weeklyReturningPrevious = 0;
  const signInTotals = { github: 0, google: 0, email: 0 };

  const funnel: AdminFunnel = { signed_up: 0, made_agent: 0, ran_model: 0, came_back: 0 };
  const previousFunnel: AdminFunnel = { signed_up: 0, made_agent: 0, ran_model: 0, came_back: 0 };
  const firstRunDeltas: number[] = [];

  // 12-week Monday UTC cohorts
  const currentMondayMs = today - ((Math.floor(today / DAY_MS) + 3) % 7) * DAY_MS;
  const cohortStarts = Array.from({ length: ADMIN_COHORT_WEEKS }, (_, i) =>
    currentMondayMs - (ADMIN_COHORT_WEEKS - 1 - i) * 7 * DAY_MS,
  );
  const cohorts: AdminCohort[] = cohortStarts.map((startMs, idx) => ({
    week: utcDate(startMs),
    size: 0,
    active: Array.from({ length: ADMIN_COHORT_WEEKS - idx }, () => 0),
  }));
  const cohortIndexByWeek = new Map(cohorts.map((c, idx) => [c.week, idx]));

  for (const t of counted) {
    const signupDay = utcDate(t.createdAt);
    const activeDays = tenantActiveDays(t);
    const sortedActive = [...activeDays].sort();
    const firstActive = sortedActive[0] ?? null;
    const hasAgent = t.snapshot.totalAgents > 0;
    const cameBack = sortedActive.some((d) => d > signupDay);

    // Current window signups
    if (t.createdAt >= win.from && t.createdAt < win.until) {
      signupsCurrent++;
      funnel.signed_up++;
      if (hasAgent || firstActive !== null) funnel.made_agent++;
      if (firstActive !== null) {
        activatedCurrent++;
        funnel.ran_model++;
        const deltaDays = Math.max(0, Math.round((Date.parse(`${firstActive}T00:00:00Z`) - startOfUtcDay(t.createdAt)) / DAY_MS));
        firstRunDeltas.push(deltaDays);
      }
      if (cameBack) funnel.came_back++;

      const bucket = dailyMap.get(signupDay);
      if (bucket) {
        bucket.signups++;
        if (t.signIn === "github") { bucket.github++; signInTotals.github++; }
        else if (t.signIn === "google") { bucket.google++; signInTotals.google++; }
        else if (t.signIn === "email") { bucket.email++; signInTotals.email++; }
      }
    } else if (t.createdAt >= win.previousFrom && t.createdAt < win.from) {
      signupsPrevious++;
      previousFunnel.signed_up++;
      if (hasAgent || firstActive !== null) previousFunnel.made_agent++;
      if (firstActive !== null) {
        activatedPrevious++;
        previousFunnel.ran_model++;
      }
      if (cameBack) previousFunnel.came_back++;
    }

    // Daily active new vs returning
    for (const d of activeDays) {
      if (!dateSet.has(d)) continue;
      const bucket = dailyMap.get(d)!;
      if (signupDay === d) bucket.active_new++;
      else if (signupDay < d) bucket.active_returning++;
    }

    // Weekly active (last 7 whole UTC days, and the 7 before)
    const activeThisWeek = sortedActive.some((d) => d >= thisWeekStartStr && d <= thisWeekLastStr);
    if (activeThisWeek) {
      weeklyActiveCurrent++;
      if (signupDay < thisWeekStartStr) weeklyReturningCurrent++;
    }
    const activePrevWeek = sortedActive.some((d) => d >= prevWeekStartStr && d <= prevWeekLastStr);
    if (activePrevWeek) {
      weeklyActivePrevious++;
      if (signupDay < prevWeekStartStr) weeklyReturningPrevious++;
    }

    // Cohorts
    const signupWeek = weekStartUtc(signupDay);
    const cohortIdx = cohortIndexByWeek.get(signupWeek);
    if (cohortIdx !== undefined) {
      const cohort = cohorts[cohortIdx]!;
      cohort.size++;
      const cohortStartMs = cohortStarts[cohortIdx]!;
      const activeWeeks = new Set<number>();
      for (const d of activeDays) {
        const dMs = Date.parse(`${d}T00:00:00Z`);
        const offset = Math.floor((dMs - cohortStartMs) / (7 * DAY_MS));
        if (offset >= 0 && offset < cohort.active.length) {
          activeWeeks.add(offset);
        }
      }
      for (const offset of activeWeeks) {
        cohort.active[offset] = (cohort.active[offset] ?? 0) + 1;
      }
    }
  }

  // Cumulative accounts per day in the window
  const daily: AdminGrowthDay[] = dates.map((date) => {
    const row = dailyMap.get(date)!;
    const endOfDayMs = Date.parse(`${date}T00:00:00Z`) + DAY_MS;
    row.accounts = counted.filter((t) => t.createdAt < endOfDayMs).length;
    return row;
  });

  // Unused string vars guard
  void prevStartStr;
  void startStr;
  void endStr;

  return {
    schema_version: 1,
    range: win.range,
    generated_at: new Date(now).toISOString(),
    accounts: counted.length,
    tiles: {
      signups: { current: signupsCurrent, previous: signupsPrevious },
      activated: { current: activatedCurrent, previous: activatedPrevious },
      weekly_active: { current: weeklyActiveCurrent, previous: weeklyActivePrevious },
      weekly_returning: { current: weeklyReturningCurrent, previous: weeklyReturningPrevious },
    },
    daily,
    sign_in: signInTotals,
    funnel,
    previous_funnel: previousFunnel,
    median_days_to_first_run: median(firstRunDeltas),
    cohorts,
  };
}

const SIGNUP_PLUGIN_WINDOW_MS = 3_600_000; // 1 hour

/**
 * First OAuth grant created within 1 hour of self-serve signup attributes that signup to its MCP plugin.
 * Matches v1 `src/admin-mcp.ts` (`mcpSignupAttribution`).
 */
function mcpSignupAttributionMap(
  tenants: HydratedTenant[],
  grants: OAuthGrantRecord[],
  from: number,
  until: number,
): Map<string, { kind: (typeof MCP_CLIENT_KINDS)[number]; date: string }> {
  const earliestByTenant = new Map<string, OAuthGrantRecord>();
  for (const g of grants) {
    const prev = earliestByTenant.get(g.tenantId);
    if (!prev || g.createdAt < prev.createdAt || (g.createdAt === prev.createdAt && g.grantId < prev.grantId)) {
      earliestByTenant.set(g.tenantId, g);
    }
  }
  const out = new Map<string, { kind: (typeof MCP_CLIENT_KINDS)[number]; date: string }>();
  for (const t of tenants) {
    if (!t.counted || t.createdAt < from || t.createdAt >= until) continue;
    const first = earliestByTenant.get(t.reg.tenantId);
    if (!first) continue;
    if (first.createdAt >= t.createdAt && first.createdAt <= t.createdAt + SIGNUP_PLUGIN_WINDOW_MS) {
      out.set(t.reg.tenantId, { kind: first.clientKind, date: utcDate(t.createdAt) });
    }
  }
  return out;
}

function classifyAcquisitionSource(
  stored: SignupSource | null | undefined,
): [string, AdminSourceKind] {
  if (!stored) return ["Not captured", "not_captured"];
  const normalized = normalizeSignupSource(stored);
  if (!normalized) return ["Not captured", "not_captured"];
  if (normalized.ref) return [normalized.ref, "ref"];
  if (normalized.referrer) return [normalized.referrer, "referrer"];
  return ["Direct", "direct"];
}

function blankAcquisitionRow(source: string, kind: AdminSourceKind): AdminSource {
  return {
    source,
    kind,
    signups: 0,
    made_agent: 0,
    activated: 0,
    active_two_days: 0,
    paying: 0,
    median_days_to_first_run: null,
  };
}

function buildAcquisition(
  tenants: HydratedTenant[],
  grants: OAuthGrantRecord[],
  rawDays: string,
  r2Sources: Map<string, StoredSignupSource> = new Map(),
  now = Date.now(),
): AdminAcquisition {
  const win = parseAdminWindow(rawDays, now);
  const dates = windowDates(win.from, win.days);
  const counted = tenants.filter((t) => t.counted && t.createdAt >= win.from && t.createdAt < win.until);
  const plugins = mcpSignupAttributionMap(tenants, grants, win.from, win.until);

  let recordedSinceMs: number | null = null;
  for (const t of tenants) {
    if (!t.counted) continue;
    const stored = r2Sources.get(t.reg.tenantId);
    const hasSource = Boolean(stored || t.reg.signupSource);
    if (hasSource) {
      const ts = stored ? Math.min(t.createdAt, stored.recordedAt) : t.createdAt;
      recordedSinceMs = recordedSinceMs === null ? ts : Math.min(recordedSinceMs, ts);
    }
  }

  const sources = new Map<string, AdminSource>();
  const daily = new Map<string, Map<string, number>>(dates.map((date) => [date, new Map()]));
  const waits = new Map<AdminSource, number[]>();
  const total = blankAcquisitionRow("All", "direct");

  for (const t of counted) {
    const signupDay = utcDate(t.createdAt);
    const activeDays = tenantActiveDays(t);
    const sorted = [...activeDays].sort();
    const madeAgent = t.snapshot.totalAgents > 0 || sorted.length > 0;
    const isActivated = sorted.length > 0;
    const ledger = effectiveLedgerTotals(t.snapshot);
    const isPaying = ledger.purchasedUsd - ledger.refundedUsd > 0;
    const deltaDays = isActivated
      ? Math.max(0, Math.round((Date.parse(`${sorted[0]!}T00:00:00Z`) - startOfUtcDay(t.createdAt)) / DAY_MS))
      : null;

    const plugin = plugins.get(t.reg.tenantId);
    const stored = r2Sources.get(t.reg.tenantId)?.source ?? t.reg.signupSource ?? null;
    const [label, kind]: [string, AdminSourceKind] = plugin
      ? [MCP_CLIENT_LABELS[plugin.kind], "plugin"]
      : classifyAcquisitionSource(stored);
    const key = `${kind}:${label}`;
    let row = sources.get(key);
    if (!row) {
      row = blankAcquisitionRow(label, kind);
      sources.set(key, row);
    }

    for (const target of [row, total]) {
      target.signups++;
      if (madeAgent) target.made_agent++;
      if (isActivated) target.activated++;
      if (activeDays.size >= 2) target.active_two_days++;
      if (isPaying) target.paying++;
      if (deltaDays !== null) {
        const list = waits.get(target) ?? [];
        list.push(deltaDays);
        waits.set(target, list);
      }
    }

    const dayMap = daily.get(signupDay);
    if (dayMap) {
      dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
    }
  }

  for (const [row, list] of waits) {
    row.median_days_to_first_run = median(list);
  }

  const ranked = [...sources.entries()].sort((a, b) => b[1].signups - a[1].signups || a[0].localeCompare(b[0]));

  return {
    schema_version: 1,
    range: win.range,
    generated_at: new Date(now).toISOString(),
    sources: ranked.map(([, row]) => row),
    total,
    daily: dates.map((date) => {
      const countsMap = daily.get(date)!;
      return {
        date,
        counts: ranked.map(([key]) => countsMap.get(key) ?? 0),
      };
    }),
    recorded_since: recordedSinceMs !== null ? new Date(recordedSinceMs).toISOString() : null,
  };
}

function buildUsage(
  tenants: HydratedTenant[],
  grants: OAuthGrantRecord[],
  rawDays: string,
  now = Date.now(),
): AdminUsage {
  const win = parseAdminWindow(rawDays, now);
  const dates = windowDates(win.from, win.days);
  const startStr = utcDate(win.from);
  const endStr = utcDate(win.until - DAY_MS);
  const prevStartStr = utcDate(win.previousFrom);

  const dailyMap = new Map<string, AdminUsageDay>();
  for (const date of dates) {
    dailyMap.set(date, { date, self_serve: 0, operator: 0, other: 0 });
  }

  let activeAccountsCur = 0;
  let activeAccountsPrev = 0;
  let allActiveAccountsCur = 0;
  let allActiveAccountsPrev = 0;
  let responsesCur = 0;
  let responsesPrev = 0;
  let selfServeResponsesCur = 0;
  let selfServeResponsesPrev = 0;
  let liveAgents = 0;
  let selfServeLiveAgents = 0;
  let agentsRanCur = 0;
  let agentsRanPrev = 0;
  let selfServeAgentsRanCur = 0;
  let selfServeAgentsRanPrev = 0;
  let endUsersCur = 0;
  let endUsersPrev = 0;
  let selfServeEndUsersCur = 0;
  let selfServeEndUsersPrev = 0;
  let earliestUsageAt: number | null = null;

  const modelStats = new Map<
    string,
    { responses: number; cost: number; accounts: Set<string>; ssResponses: number; ssAccounts: Set<string> }
  >();
  const cfgModelStats = new Map<
    string,
    { agents: number; accounts: Set<string>; ssAgents: number; ssAccounts: Set<string> }
  >();
  const featureStats = new Map<string, { label: string; agents: number; ssAgents: number }>();
  const integrationStats = new Map<string, { label: string; accounts: Set<string>; ssAccounts: Set<string> }>();
  const recordIntegration = (key: string, label: string, tenantId: string, isSelfServe: boolean) => {
    let entry = integrationStats.get(key);
    if (!entry) {
      entry = { label, accounts: new Set(), ssAccounts: new Set() };
      integrationStats.set(key, entry);
    }
    entry.accounts.add(tenantId);
    if (isSelfServe) entry.ssAccounts.add(tenantId);
  };

  const accounts: AdminUsageAccount[] = [];
  const topAgents: AdminTopAgent[] = [];

  const activeGrantsByTenant = new Map<string, OAuthGrantRecord[]>();
  const mcpClientAccounts = new Map<string, Set<string>>();
  for (const g of grants) {
    if (g.revokedAt != null) continue;
    const list = activeGrantsByTenant.get(g.tenantId) ?? [];
    list.push(g);
    activeGrantsByTenant.set(g.tenantId, list);
    const set = mcpClientAccounts.get(g.clientName) ?? new Set<string>();
    set.add(g.tenantId);
    mcpClientAccounts.set(g.clientName, set);
  }

  for (const t of tenants) {
    const isCounted = t.counted;
    liveAgents += t.snapshot.totalAgents;
    if (isCounted) selfServeLiveAgents += t.snapshot.totalAgents;

    if (typeof t.snapshot.earliestUsageAt === "number" && t.snapshot.earliestUsageAt > 0) {
      earliestUsageAt =
        earliestUsageAt === null
          ? t.snapshot.earliestUsageAt
          : Math.min(earliestUsageAt, t.snapshot.earliestUsageAt);
    }

    // Configured models across ALL live agents (from SQL GROUP BY, with fallback for unrecycled DOs)
    if (Array.isArray(t.snapshot.configuredModels)) {
      for (const cm of t.snapshot.configuredModels) {
        const m = cm.model || "unknown";
        let entry = cfgModelStats.get(m);
        if (!entry) {
          entry = { agents: 0, accounts: new Set(), ssAgents: 0, ssAccounts: new Set() };
          cfgModelStats.set(m, entry);
        }
        entry.agents += cm.count;
        entry.accounts.add(t.reg.tenantId);
        if (isCounted) {
          entry.ssAgents += cm.count;
          entry.ssAccounts.add(t.reg.tenantId);
        }
      }
    } else {
      for (const agent of t.snapshot.agents) {
        const m = agent.model || "unknown";
        let entry = cfgModelStats.get(m);
        if (!entry) {
          entry = { agents: 0, accounts: new Set(), ssAgents: 0, ssAccounts: new Set() };
          cfgModelStats.set(m, entry);
        }
        entry.agents++;
        entry.accounts.add(t.reg.tenantId);
        if (isCounted) {
          entry.ssAgents++;
          entry.ssAccounts.add(t.reg.tenantId);
        }
      }
    }

    // Agent features aggregated across all live agents
    if (t.snapshot.featureCounts) {
      for (const [key, cnt] of Object.entries(t.snapshot.featureCounts)) {
        if (cnt <= 0) continue;
        let entry = featureStats.get(key);
        if (!entry) {
          entry = { label: featureLabel(key), agents: 0, ssAgents: 0 };
          featureStats.set(key, entry);
        }
        entry.agents += cnt;
        if (isCounted) entry.ssAgents += cnt;
      }
    }

    // Per-agent run stats (from credit_ledger aggregation, with fallback to agents_index if DO not yet recycled)
    if (Array.isArray(t.snapshot.topAgentUsage)) {
      const ranCur = t.snapshot.agentsRanCurrent ?? t.snapshot.topAgentUsage.length;
      const ranPrev = t.snapshot.agentsRanPrevious ?? 0;
      const euCur = t.snapshot.endUsersCurrent ?? 0;
      const euPrev = t.snapshot.endUsersPrevious ?? 0;
      agentsRanCur += ranCur;
      agentsRanPrev += ranPrev;
      endUsersCur += euCur;
      endUsersPrev += euPrev;
      if (isCounted) {
        selfServeAgentsRanCur += ranCur;
        selfServeAgentsRanPrev += ranPrev;
        selfServeEndUsersCur += euCur;
        selfServeEndUsersPrev += euPrev;
      }
      for (const item of t.snapshot.topAgentUsage) {
        topAgents.push({
          agent: item.agentId,
          name: item.agentKey || item.agentId,
          model: item.model,
          kind: "agent",
          deleted: item.deleted,
          account: { ...accountNameOf(t), staff: t.staff },
          responses: item.responses,
          end_users: item.endUsers,
          active_days: item.activeDays,
          last_at: new Date(item.lastAt).toISOString(),
        });
      }
    } else {
      for (const agent of t.snapshot.agents) {
        if (agent.updatedAt >= win.from && agent.updatedAt < win.until) {
          agentsRanCur++;
          if (isCounted) selfServeAgentsRanCur++;
          topAgents.push({
            agent: agent.id,
            name: agent.key || agent.id,
            model: agent.model,
            kind: "agent",
            deleted: false,
            account: { ...accountNameOf(t), staff: t.staff },
            responses: 0,
            end_users: 0,
            active_days: 1,
            last_at: new Date(agent.updatedAt).toISOString(),
          });
        }
      }
    }

    // Integrations
    if (t.snapshot.providers.length > 0) recordIntegration("own_keys", "Own model keys", t.reg.tenantId, isCounted);
    if (t.snapshot.counts.webhooks > 0) recordIntegration("webhook", "Webhooks", t.reg.tenantId, isCounted);
    if (t.snapshot.counts.repos > 0) recordIntegration("repos", "Repositories", t.reg.tenantId, isCounted);
    if ((activeGrantsByTenant.get(t.reg.tenantId)?.length ?? 0) > 0) {
      recordIntegration("mcp_clients", "Connected an MCP client", t.reg.tenantId, isCounted);
    }
    for (const ch of t.snapshot.channels) {
      const label = ch.kind === "slack" ? "Slack" : ch.kind === "email" ? "Email" : "HTTP channel";
      recordIntegration(`channel_${ch.kind}`, label, t.reg.tenantId, isCounted);
    }

    let tResponsesCur = 0;
    let tResponsesPrev = 0;
    let tCostCur = 0;
    const tActiveDays = new Set<string>();
    let lastActive: string | null = null;
    const tModelCounts = new Map<string, number>();

    for (const u of t.snapshot.usageDaily) {
      if (u.runsCount <= 0 && u.costUsd <= 0) continue;
      if (lastActive === null || u.day > lastActive) lastActive = u.day;

      if (u.day >= startStr && u.day <= endStr) {
        tResponsesCur += u.runsCount;
        tCostCur += u.costUsd;
        if (u.runsCount > 0) tActiveDays.add(u.day);
        tModelCounts.set(u.model, (tModelCounts.get(u.model) ?? 0) + u.runsCount);

        responsesCur += u.runsCount;
        if (isCounted) selfServeResponsesCur += u.runsCount;

        const dayBucket = dailyMap.get(u.day);
        if (dayBucket) {
          if (isCounted) dayBucket.self_serve += u.runsCount;
          else if (t.kind === "operator") dayBucket.operator += u.runsCount;
          else dayBucket.other += u.runsCount;
        }

        let mEntry = modelStats.get(u.model);
        if (!mEntry) {
          mEntry = { responses: 0, cost: 0, accounts: new Set(), ssResponses: 0, ssAccounts: new Set() };
          modelStats.set(u.model, mEntry);
        }
        mEntry.responses += u.runsCount;
        mEntry.cost += u.costUsd;
        mEntry.accounts.add(t.reg.tenantId);
        if (isCounted) {
          mEntry.ssResponses += u.runsCount;
          mEntry.ssAccounts.add(t.reg.tenantId);
        }
      } else if (u.day >= prevStartStr && u.day < startStr) {
        tResponsesPrev += u.runsCount;
        responsesPrev += u.runsCount;
        if (isCounted) selfServeResponsesPrev += u.runsCount;
      }
    }

    if (tResponsesCur > 0) allActiveAccountsCur++;
    if (tResponsesPrev > 0) allActiveAccountsPrev++;
    if (isCounted && tResponsesCur > 0) activeAccountsCur++;
    if (isCounted && tResponsesPrev > 0) activeAccountsPrev++;

    const topModels = [...tModelCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([model]) => model);

    // Include accounts with responses or live agents so operators can open any active/registered tenant
    if (tResponsesCur > 0 || t.snapshot.totalAgents > 0 || t.snapshot.profile.balanceUsd !== 0) {
      accounts.push({
        ...accountNameOf(t),
        staff: t.staff,
        deleted: false,
        agents: t.snapshot.totalAgents,
        responses: tResponsesCur,
        cost: tCostCur,
        platform_cost: tCostCur,
        active_days: tActiveDays.size,
        last_active: lastActive,
        models: topModels,
        balance: toMicros(t.snapshot.profile.balanceUsd),
        purchased: toMicros(Math.max(0, effectiveLedgerTotals(t.snapshot).purchasedUsd - effectiveLedgerTotals(t.snapshot).refundedUsd)),
      });
    }
  }

  accounts.sort((a, b) => b.responses - a.responses || b.agents - a.agents);
  topAgents.sort((a, b) => b.responses - a.responses || Date.parse(b.last_at) - Date.parse(a.last_at));

  return {
    schema_version: 1,
    range: win.range,
    generated_at: new Date(now).toISOString(),
    tiles: {
      active_accounts: { current: activeAccountsCur, previous: activeAccountsPrev },
      all_active_accounts: { current: allActiveAccountsCur, previous: allActiveAccountsPrev },
      responses: { current: responsesCur, previous: responsesPrev },
      self_serve_responses: { current: selfServeResponsesCur, previous: selfServeResponsesPrev },
      agents_ran: { current: agentsRanCur, previous: agentsRanPrev },
      self_serve_agents_ran: { current: selfServeAgentsRanCur, previous: selfServeAgentsRanPrev },
      end_users: { current: endUsersCur, previous: endUsersPrev },
      self_serve_end_users: { current: selfServeEndUsersCur, previous: selfServeEndUsersPrev },
      live_agents: liveAgents,
      self_serve_live_agents: selfServeLiveAgents,
    },
    daily: dates.map((date) => dailyMap.get(date)!),
    attempts_since: earliestUsageAt !== null ? new Date(earliestUsageAt).toISOString() : null,
    models: [...modelStats.entries()]
      .map(([model, s]) => ({
        model,
        responses: s.responses,
        accounts: s.accounts.size,
        cost: s.cost,
        self_serve_responses: s.ssResponses,
        self_serve_accounts: s.ssAccounts.size,
      }))
      .sort((a, b) => b.responses - a.responses),
    configured_models: [...cfgModelStats.entries()]
      .map(([model, s]) => ({
        model,
        agents: s.agents,
        accounts: s.accounts.size,
        self_serve_agents: s.ssAgents,
        self_serve_accounts: s.ssAccounts.size,
      }))
      .sort((a, b) => b.agents - a.agents),
    features: [...featureStats.entries()]
      .map(([key, s]) => ({
        key,
        label: s.label,
        agents: s.agents,
        self_serve_agents: s.ssAgents,
      }))
      .sort((a, b) => b.agents - a.agents),
    integrations: [...integrationStats.entries()]
      .map(([key, s]) => ({
        key,
        label: s.label,
        accounts: s.accounts.size,
        self_serve_accounts: s.ssAccounts.size,
      }))
      .sort((a, b) => b.accounts - a.accounts),
    mcp_clients: [...mcpClientAccounts.entries()]
      .map(([client, accts]) => ({ client, accounts: accts.size }))
      .sort((a, b) => b.accounts - a.accounts || a.client.localeCompare(b.client)),
    accounts: accounts.slice(0, 200),
    agents: topAgents.slice(0, 50),
  };
}

function buildRevenue(tenants: HydratedTenant[], rawDays: string, now = Date.now()): AdminRevenue {
  const win = parseAdminWindow(rawDays, now);
  const dates = windowDates(win.from, win.days);
  const startStr = utcDate(win.from);
  const endStr = utcDate(win.until - DAY_MS);

  const dailyMap = new Map<string, AdminRevenueDay>();
  for (const date of dates) {
    dailyMap.set(date, { date, purchases: 0, amount: 0, refunds: 0 });
  }

  // Last 12 calendar months (UTC), oldest first
  const nowDate = new Date(now);
  const monthlyMap = new Map<string, { month: string; amount: number; refunds: number; buyers: Set<string> }>();
  const months: string[] = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth() - i, 1));
    const ym = d.toISOString().slice(0, 7);
    months.push(ym);
    monthlyMap.set(ym, { month: ym, amount: 0, refunds: 0, buyers: new Set() });
  }

  let revCur = 0;
  let revPrev = 0;
  let refCur = 0;
  let refPrev = 0;
  const buyersCur = new Set<string>();
  const buyersPrev = new Set<string>();
  let firstPurchasesCur = 0;
  let firstPurchasesPrev = 0;
  let payingAccounts = 0;
  let outstandingPurchased = 0;
  let outstandingFree = 0;

  let payingCharged = 0;
  let freeCharged = 0;
  let freeProviderCostAllTime = 0;

  const buckets: Record<AdminFreeCreditBucket, number> = {
    untouched: 0,
    tried: 0,
    using: 0,
    nearly_out: 0,
    used_up: 0,
  };
  let freeAccountsCount = 0;
  let freeGivenTotal = 0;
  let freeUsedTotal = 0;
  let freeUsedAny = 0;
  let freeBought = 0;
  let freeWithout = 0;
  const freeRows: AdminFreeCreditAccount[] = [];

  for (const t of tenants) {
    if (t.staff || t.kind === "operator" || t.kind === "operator_made") continue;
    const ledgerTotals = effectiveLedgerTotals(t.snapshot);
    const netPurchasedUsd = Math.max(0, ledgerTotals.purchasedUsd - ledgerTotals.refundedUsd);
    const grantedUsd = Math.max(0, ledgerTotals.grantedUsd);
    const balanceUsd = Math.max(0, t.snapshot.profile.balanceUsd);
    const isPaying = netPurchasedUsd > 0;
    if (isPaying) payingAccounts++;

    // Free credit is spent first; remaining balance up to netPurchasedUsd is purchased, rest is free.
    const freeLeftUsd = Math.max(0, Math.min(grantedUsd, grantedUsd - ledgerTotals.usageUsd, balanceUsd));
    const purchasedLeftUsd = Math.max(0, balanceUsd - freeLeftUsd);
    outstandingPurchased += toMicros(purchasedLeftUsd);
    outstandingFree += toMicros(freeLeftUsd);

    if (ledgerTotals.firstTopupAt !== null) {
      if (ledgerTotals.firstTopupAt >= win.from && ledgerTotals.firstTopupAt < win.until) {
        firstPurchasesCur++;
      } else if (ledgerTotals.firstTopupAt >= win.previousFrom && ledgerTotals.firstTopupAt < win.from) {
        firstPurchasesPrev++;
      }
    }

    for (const entry of t.snapshot.ledger) {
      const entryDate = utcDate(entry.createdAt);
      const entryMonth = entryDate.slice(0, 7);
      const amtMicros = toMicros(Math.abs(entry.amountUsd));

      if ((entry.kind === "topup" || entry.kind === "purchase") && entry.amountUsd > 0 && !isStarterGrantLedgerEntry(entry)) {
        if (entry.createdAt >= win.from && entry.createdAt < win.until) {
          revCur += amtMicros;
          buyersCur.add(t.reg.tenantId);
          const dRow = dailyMap.get(entryDate);
          if (dRow) {
            dRow.purchases++;
            dRow.amount += amtMicros;
          }
        } else if (entry.createdAt >= win.previousFrom && entry.createdAt < win.from) {
          revPrev += amtMicros;
          buyersPrev.add(t.reg.tenantId);
        }
        const mRow = monthlyMap.get(entryMonth);
        if (mRow) {
          mRow.amount += amtMicros;
          mRow.buyers.add(t.reg.tenantId);
        }
      } else if (entry.kind === "refund") {
        if (entry.createdAt >= win.from && entry.createdAt < win.until) {
          refCur += amtMicros;
          const dRow = dailyMap.get(entryDate);
          if (dRow) dRow.refunds += amtMicros;
        } else if (entry.createdAt >= win.previousFrom && entry.createdAt < win.from) {
          refPrev += amtMicros;
        }
        const mRow = monthlyMap.get(entryMonth);
        if (mRow) mRow.refunds += amtMicros;
      }
    }

    let winUsageUsd = 0;
    let totalResponses = 0;
    const activeDaySet = new Set<string>();
    let lastActive: string | null = null;
    for (const u of t.snapshot.usageDaily) {
      if (u.runsCount > 0) {
        activeDaySet.add(u.day);
        if (lastActive === null || u.day > lastActive) lastActive = u.day;
      }
      totalResponses += u.runsCount;
      if (u.day >= startStr && u.day <= endStr) {
        winUsageUsd += u.costUsd;
      }
    }

    if (isPaying) {
      payingCharged += winUsageUsd;
    } else {
      freeCharged += winUsageUsd;
    }

    if (t.counted) {
      if (grantedUsd > 0) {
        freeProviderCostAllTime += Math.min(grantedUsd, t.snapshot.ledgerSummary.usageUsd);
        const givenMicros = toMicros(grantedUsd);
        const usedMicros = Math.min(givenMicros, toMicros(t.snapshot.ledgerSummary.usageUsd));
        const leftMicros = Math.max(0, givenMicros - usedMicros);
        const bucket = freeCreditBucket(givenMicros, usedMicros);
        freeAccountsCount++;
        freeGivenTotal += givenMicros;
        freeUsedTotal += usedMicros;
        buckets[bucket]++;
        if (usedMicros >= 10_000) freeUsedAny++;
        if (isPaying) freeBought++;
        freeRows.push({
          ...accountNameOf(t),
          via: t.signIn === "github" ? "github" : "operator",
          given: givenMicros,
          used: usedMicros,
          left: leftMicros,
          bucket,
          purchased: toMicros(netPurchasedUsd),
          responses: totalResponses,
          active_days: activeDaySet.size,
          last_active: lastActive,
        });
      } else {
        freeWithout++;
      }
    }
  }

  freeRows.sort((a, b) => b.used - a.used || b.given - a.given);

  const monthly: AdminRevenueMonth[] = months.map((m) => {
    const entry = monthlyMap.get(m)!;
    return { month: entry.month, amount: entry.amount, refunds: entry.refunds, buyers: entry.buyers.size };
  });

  return {
    schema_version: 1,
    range: win.range,
    generated_at: new Date(now).toISOString(),
    tiles: {
      revenue: { current: revCur, previous: revPrev },
      refunds: { current: refCur, previous: refPrev },
      buyers: { current: buyersCur.size, previous: buyersPrev.size },
      first_purchases: { current: firstPurchasesCur, previous: firstPurchasesPrev },
      paying_accounts: payingAccounts,
      auto_topup: 0,
      outstanding_purchased: outstandingPurchased,
      outstanding_free: outstandingFree,
    },
    daily: dates.map((date) => dailyMap.get(date)!),
    monthly,
    spend: {
      paying_charged: toMicros(payingCharged),
      paying_provider_cost: payingCharged,
      free_charged: toMicros(freeCharged),
      free_provider_cost: freeCharged,
    },
    free_credit: {
      accounts: freeAccountsCount,
      given: freeGivenTotal,
      used: freeUsedTotal,
      buckets,
      used_any: freeUsedAny,
      bought: freeBought,
      without: freeWithout,
      decisions: { eligible: freeAccountsCount, ineligible: 0, disabled: 0, legacy: 0, card_unlocked: 0 },
      provider_cost: freeProviderCostAllTime,
      rows: freeRows.slice(0, ADMIN_FREE_CREDIT_ROWS),
    },
  };
}

async function probeCamelfsHealth(env: Env): Promise<AdminCheck> {
  const baseUrl = env.CAMELFS_URL?.trim();
  if (!baseUrl) {
    return {
      key: "camelfsd",
      label: "camelfsd storage",
      status: "warn",
      value: "Unconfigured",
      detail: "CAMELFS_URL is not set on this worker.",
    };
  }
  const started = Date.now();
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/healthz`, {
      method: "GET",
      signal: AbortSignal.timeout(3_000),
    });
    const latencyMs = Date.now() - started;
    if (res.ok) {
      return {
        key: "camelfsd",
        label: "camelfsd storage",
        status: latencyMs > 1500 ? "warn" : "ok",
        value: `${latencyMs} ms`,
        detail: `${new URL(baseUrl).host} responded HTTP ${res.status}.`,
      };
    }
    return {
      key: "camelfsd",
      label: "camelfsd storage",
      status: "bad",
      value: `HTTP ${res.status}`,
      detail: `${new URL(baseUrl).host}/healthz returned HTTP ${res.status} (${latencyMs} ms).`,
    };
  } catch (caught) {
    return {
      key: "camelfsd",
      label: "camelfsd storage",
      status: "bad",
      value: "Unreachable",
      detail: caught instanceof Error ? caught.message : "Health probe failed.",
    };
  }
}

async function buildHealth(
  env: Env,
  tenants: HydratedTenant[],
  registeredCount: number,
  failedCount: number,
  rawDays: string,
  now = Date.now(),
): Promise<AdminHealth> {
  const win = parseAdminWindow(rawDays, now);
  const dates = windowDates(win.from, win.days);
  const startStr = utcDate(win.from);
  const endStr = utcDate(win.until - DAY_MS);
  const prevStartStr = utcDate(win.previousFrom);

  const today = startOfUtcDay(now);
  const todayDate = new Date(today);
  const monthStartStr = utcDate(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth(), 1));
  const lastMonthStartStr = utcDate(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth() - 1, 1));
  const todayStr = utcDate(today);
  const last7StartStr = utcDate(today - 7 * DAY_MS);
  const monthDays = new Date(Date.UTC(todayDate.getUTCFullYear(), todayDate.getUTCMonth() + 1, 0)).getUTCDate();
  const daysElapsedBeforeToday = todayDate.getUTCDate() - 1;
  const daysLeft = Math.max(0, monthDays - daysElapsedBeforeToday);

  const dailyMap = new Map<string, AdminSpendDay>();
  for (const date of dates) {
    dailyMap.set(date, {
      date,
      models: 0,
      compaction: 0,
      voice: 0,
      images: 0,
      web: 0,
      tool_search: 0,
      compute: 0,
    });
  }

  let windowCur = 0;
  let windowPrev = 0;
  let monthToDate = 0;
  let monthBeforeToday = 0;
  let lastMonth = 0;
  let last7Whole = 0;
  let ownKeyResponses = 0;
  let platformResponses = 0;

  const byPayer: Record<AdminPayer, number> = { paying: 0, free: 0, operator: 0, unbilled: 0, staff: 0 };
  const byProvider = new Map<string, { cost: number; responses: number }>();
  const topAccounts: AdminSpendAccount[] = [];

  let totalAgents = 0;
  let totalBusyAgents = 0;
  let lowBalanceActiveTenants = 0;

  for (const t of tenants) {
    totalAgents += t.snapshot.totalAgents;
    totalBusyAgents += t.snapshot.busyAgents;
    const payer = payerOf(t);

    let tCostCur = 0;
    let tResponsesCur = 0;

    for (const u of t.snapshot.usageDaily) {
      if (u.day >= startStr && u.day <= endStr) {
        windowCur += u.costUsd;
        tCostCur += u.costUsd;
        tResponsesCur += u.runsCount;
        const ownKeyRuns =
          typeof u.ownKeyRuns === "number"
            ? Math.min(u.runsCount, Math.max(0, u.ownKeyRuns))
            : (u.costUsd === 0 && !u.model.startsWith("mock") && u.runsCount > 0 && t.snapshot.providers.length > 0
                ? u.runsCount
                : 0);
        const platformRuns = Math.max(0, u.runsCount - ownKeyRuns);
        ownKeyResponses += ownKeyRuns;
        platformResponses += platformRuns;
        byPayer[payer] += u.costUsd;

        const dRow = dailyMap.get(u.day);
        if (dRow) {
          const kind = classifyUsageKind(u.model);
          dRow[kind] += u.costUsd;
        }

        const prov = classifyProvider(u.model);
        const pEntry = byProvider.get(prov) ?? { cost: 0, responses: 0 };
        pEntry.cost += u.costUsd;
        pEntry.responses += u.runsCount;
        byProvider.set(prov, pEntry);
      } else if (u.day >= prevStartStr && u.day < startStr) {
        windowPrev += u.costUsd;
      }

      if (u.day >= monthStartStr) {
        monthToDate += u.costUsd;
        if (u.day < todayStr) monthBeforeToday += u.costUsd;
      } else if (u.day >= lastMonthStartStr && u.day < monthStartStr) {
        lastMonth += u.costUsd;
      }

      if (u.day >= last7StartStr && u.day < todayStr) {
        last7Whole += u.costUsd;
      }
    }

    if (tCostCur > 0 || tResponsesCur > 0) {
      topAccounts.push({
        ...accountNameOf(t),
        payer,
        cost: tCostCur,
        responses: tResponsesCur,
      });
    }
    if (tResponsesCur > 0 && t.snapshot.profile.balanceUsd <= 0 && t.snapshot.providers.length === 0) {
      lowBalanceActiveTenants++;
    }
  }

  topAccounts.sort((a, b) => b.cost - a.cost || b.responses - a.responses);
  const monthProjection = Math.max(monthToDate, monthBeforeToday + (last7Whole / 7) * daysLeft);

  const camelfsCheck = await probeCamelfsHealth(env);
  const checks: AdminCheck[] = [
    camelfsCheck,
    {
      key: "tenants_registry",
      label: "Registered tenants",
      status: failedCount > 0 ? "warn" : "ok",
      value: `${tenants.length} / ${registeredCount}`,
      detail: failedCount > 0
        ? `${failedCount} tenant Durable Object(s) failed to answer the ops snapshot.`
        : "All registered TenantDO instances answered.",
    },
    {
      key: "v2_agents",
      label: "Active v2 agents",
      status: "info",
      value: `${totalBusyAgents} running`,
      detail: `${totalAgents.toLocaleString("en-US")} live agents across ${tenants.length.toLocaleString("en-US")} registered tenants.`,
    },
    {
      key: "balance_health",
      label: "Active tenants out of credit",
      status: lowBalanceActiveTenants > 0 ? "warn" : "ok",
      value: String(lowBalanceActiveTenants),
      detail: lowBalanceActiveTenants > 0
        ? `${lowBalanceActiveTenants} active tenant(s) have $0 or negative balance without BYOK provider keys.`
        : "No active tenants are blocked on zero credit balance.",
    },
  ];

  // Problems first (bad -> warn -> ok -> info)
  const order: Record<AdminCheck["status"], number> = { bad: 0, warn: 1, ok: 2, info: 3 };
  checks.sort((a, b) => order[a.status] - order[b.status]);

  return {
    schema_version: 1,
    range: win.range,
    generated_at: new Date(now).toISOString(),
    spend: {
      window: { current: windowCur, previous: windowPrev },
      month_to_date: monthToDate,
      month_projection: monthProjection,
      last_month: lastMonth,
      daily: dates.map((date) => dailyMap.get(date)!),
      by_payer: byPayer,
      by_provider: [...byProvider.entries()]
        .map(([provider, s]) => ({ provider, cost: s.cost, responses: s.responses }))
        .sort((a, b) => b.cost - a.cost),
      top_accounts: topAccounts.slice(0, 50),
      own_key_responses: ownKeyResponses,
      platform_responses: platformResponses,
    },
    checks,
    nodes: [],
  };
}

function buildMcp(
  tenants: HydratedTenant[],
  grants: OAuthGrantRecord[],
  rawDays: string,
  now = Date.now(),
): AdminMcp {
  const win = parseAdminWindow(rawDays, now);
  const dates = windowDates(win.from, win.days);
  const countedById = new Map<string, HydratedTenant>();
  for (const t of tenants) {
    if (t.counted) countedById.set(t.reg.tenantId, t);
  }

  // Daily grid: every UTC date x every MCP client kind
  const daily = dates.flatMap((date) =>
    MCP_CLIENT_KINDS.map((kind) => ({ date, kind, signups: 0, token_active_accounts: 0 })),
  );
  const byDayKind = new Map(daily.map((row) => [`${row.date}/${row.kind}`, row]));

  // 1. Plugin-attributed signups (first OAuth grant within 1 hour of self-serve account creation)
  const signups = mcpSignupAttributionMap(tenants, grants, win.from, win.until);
  for (const entry of signups.values()) {
    const row = byDayKind.get(`${entry.date}/${entry.kind}`);
    if (row) row.signups++;
  }

  // 2. Daily & weekly token-active accounts based on grant `usedAt`
  const dayTenants = new Map<string, Set<string>>();
  const weekTenants = new Map<string, Set<string>>();
  const activeUpperBound = Math.min(win.until, now + 1);
  for (const g of grants) {
    if (!countedById.has(g.tenantId)) continue;
    if (g.usedAt === null || g.usedAt < win.from || g.usedAt >= activeUpperBound) continue;
    const dayStr = utcDate(g.usedAt);
    const weekStr = weekStartUtc(dayStr);
    const dayKey = `${dayStr}/${g.clientKind}`;
    const weekKey = `${weekStr}/${g.clientKind}`;
    if (!dayTenants.has(dayKey)) dayTenants.set(dayKey, new Set());
    if (!weekTenants.has(weekKey)) weekTenants.set(weekKey, new Set());
    dayTenants.get(dayKey)!.add(g.tenantId);
    weekTenants.get(weekKey)!.add(g.tenantId);
  }
  for (const [key, set] of dayTenants) {
    const row = byDayKind.get(key);
    if (row) row.token_active_accounts = set.size;
  }

  const weekLabels = [...new Set(dates.map((date) => weekStartUtc(date)))];
  const weekly = weekLabels.flatMap((week) =>
    MCP_CLIENT_KINDS.map((kind) => ({
      week,
      kind,
      token_active_accounts: weekTenants.get(`${week}/${kind}`)?.size ?? 0,
    })),
  );

  // 3. Funnel across self-serve accounts signed up in window that authorized each kind by now
  const grantsByTenant = new Map<string, OAuthGrantRecord[]>();
  for (const g of grants) {
    if (g.createdAt > now) continue;
    const list = grantsByTenant.get(g.tenantId) ?? [];
    list.push(g);
    grantsByTenant.set(g.tenantId, list);
  }

  const funnel = MCP_CLIENT_KINDS.map((kind) => ({
    kind,
    label: MCP_CLIENT_LABELS[kind],
    authorized: 0,
    made_agent: 0,
    ran_turn: 0,
    came_back: 0,
  }));
  const funnelByKind = new Map(funnel.map((row) => [row.kind, row]));

  for (const t of countedById.values()) {
    if (t.createdAt < win.from || t.createdAt >= win.until) continue;
    const tenantGrants = grantsByTenant.get(t.reg.tenantId);
    if (!tenantGrants || tenantGrants.length === 0) continue;

    const kinds = new Set(tenantGrants.map((g) => g.clientKind));
    const activeDays = [...tenantActiveDays(t)].sort();
    const firstRun = activeDays[0] ?? null;
    const lastRun = activeDays.at(-1) ?? null;
    const madeAgent = t.snapshot.totalAgents > 0 || firstRun !== null;
    const cameBack = firstRun !== null && lastRun !== null && lastRun > firstRun;

    for (const kind of kinds) {
      const f = funnelByKind.get(kind);
      if (!f) continue;
      f.authorized++;
      if (madeAgent) f.made_agent++;
      if (firstRun !== null) f.ran_turn++;
      if (cameBack) f.came_back++;
    }
  }

  return {
    schema_version: 1,
    range: win.range,
    generated_at: new Date(now).toISOString(),
    daily,
    weekly,
    funnel,
    limitations: [
      "Activity is the latest token issuance, refresh, or throttled access-token use in each OAuth grant, not per-request MCP call counts. Earlier days are overwritten when used_at advances. Weeks are Monday UTC, clipped to the selected window.",
      "Sign-ups use the first OAuth grant within one hour of account creation. Registration names and redirect hosts are client-declared, not verified vendor identity.",
      "The funnel includes self-serve accounts signed up in the window that authorized each kind by now. Agent creation and model-response usage are account-wide, not proof of work through that plugin. Return means a model response on a UTC day after the first response; an account can appear under multiple kinds.",
    ],
  };
}

async function buildAccountDetail(
  env: Env,
  tenantId: string,
  rawDays: string,
  now = Date.now(),
): Promise<AdminAccountDetail | null> {
  const win = parseAdminWindow(rawDays, now);
  const dates = windowDates(win.from, win.days);
  const startStr = utcDate(win.from);
  const endStr = utcDate(win.until - DAY_MS);

  const [snapshot, registry, tenantGrants, infraCredit] = await Promise.all([
    getTenantStub(env, tenantId).getOpsSnapshot(Math.max(win.days, 90), {
      currentFromMs: win.from,
      currentUntilMs: win.until,
      previousFromMs: win.previousFrom,
    }),
    getTenantStub(env, CONSOLE_ACCOUNTS_DO_NAME).listOpsTenants().catch(() => [] as OpsRegisteredTenant[]),
    listTenantOAuthGrants(env, tenantId).catch(() => [] as OAuthGrantRecord[]),
    getInfraCredit(env, tenantId).catch(() => null),
  ]);
  if (!snapshot) return null;

  const reg = registry.find((r) => r.tenantId === tenantId) ?? null;
  const staffDomains = getStaffDomains(env);
  const staff = isStaffEmail(reg?.email, staffDomains);
  const kind: AdminAccountKind = reg
    ? (reg.kind === "operator" || (reg.kind !== "self_serve" && isOperatorReserveTenant(env, tenantId)) ? "operator" : reg.kind)
    : isOperatorReserveTenant(env, tenantId)
      ? "operator"
      : "operator_made";
  const name = reg?.login || reg?.email || reg?.name || snapshot.profile.name || tenantId;
  const createdAt = Math.min(reg?.createdAt || snapshot.profile.createdAt, snapshot.profile.createdAt);

  const dailyResponses = new Map<string, number>();
  for (const d of dates) dailyResponses.set(d, 0);

  let responses = 0;
  let cost = 0;
  const activeDaySet = new Set<string>();
  const modelMap = new Map<string, { responses: number; cost: number }>();

  for (const u of snapshot.usageDaily) {
    if (u.day < startStr || u.day > endStr) continue;
    responses += u.runsCount;
    cost += u.costUsd;
    if (u.runsCount > 0) {
      activeDaySet.add(u.day);
      dailyResponses.set(u.day, (dailyResponses.get(u.day) ?? 0) + u.runsCount);
    }
    const prev = modelMap.get(u.model) ?? { responses: 0, cost: 0 };
    prev.responses += u.runsCount;
    prev.cost += u.costUsd;
    modelMap.set(u.model, prev);
  }

  // Hydrate up to ADMIN_ACCOUNT_AGENTS live agents from AgentDO in parallel (most used in window first)
  let totalSchedules = 0;
  const topUsageById = new Map((snapshot.topAgentUsage ?? []).map((u) => [u.agentId, u]));
  const liveAgentById = new Map(snapshot.agents.map((a) => [a.id, a]));
  const orderedTargetAgents: Array<{
    id: string;
    key: string;
    model: string;
    definition: string | null;
    updatedAt: number;
  }> = [];
  const seenAgentIds = new Set<string>();
  for (const top of snapshot.topAgentUsage ?? []) {
    if (top.deleted || seenAgentIds.has(top.agentId)) continue;
    const live = liveAgentById.get(top.agentId);
    seenAgentIds.add(top.agentId);
    orderedTargetAgents.push({
      id: top.agentId,
      key: live?.key ?? top.agentKey,
      model: live?.model ?? top.model,
      definition: live?.definition ?? null,
      updatedAt: live?.updatedAt ?? top.lastAt,
    });
    if (orderedTargetAgents.length >= ADMIN_ACCOUNT_AGENTS) break;
  }
  for (const agent of snapshot.agents) {
    if (orderedTargetAgents.length >= ADMIN_ACCOUNT_AGENTS) break;
    if (seenAgentIds.has(agent.id)) continue;
    seenAgentIds.add(agent.id);
    orderedTargetAgents.push(agent);
  }

  const agents = await mapWithConcurrency(orderedTargetAgents, 10, async (entry): Promise<AdminAccountAgent> => {
    const ledgerUsage = topUsageById.get(entry.id);
    try {
      const stub = getAgentStub(env, entry.id);
      const [state, schedRes, runStats] = await Promise.all([
        stub.getState(),
        stub.listSchedules().catch(() => ({ schedules: [] })),
        stub.getOpsRunStats(win.from, win.until).catch(() => null),
      ]);
      const schedCount = schedRes.schedules.length;
      totalSchedules += schedCount;
      const rawPrompt = state.instructions ?? "";
      const masked = maskSecrets(rawPrompt);
      const responsesCount = runStats
        ? Math.max(runStats.responses, ledgerUsage?.responses ?? 0)
        : (ledgerUsage?.responses ?? (state.lastRun ? 1 : 0));
      const endUsersCount = runStats
        ? Math.max(runStats.endUsers, ledgerUsage?.endUsers ?? 0)
        : (ledgerUsage?.endUsers ?? 0);
      const lastAtMs =
        runStats?.lastAt ??
        ledgerUsage?.lastAt ??
        (state.lastRun ? state.lastRun.startedAt : entry.updatedAt);
      return {
        agent: entry.id,
        name: entry.key || entry.id,
        type: "general",
        model: state.model || entry.model,
        definition: state.definition ?? entry.definition,
        builtins: state.builtins ?? [],
        mcp_servers: (state.mcpServers ?? []).map((s) => hostOf(s.url)),
        openapi: 0,
        app_tools: (state.tools ?? []).length,
        code_mode: (state.builtins ?? []).includes("codemode"),
        schedules: schedCount,
        channel: null,
        responses: responsesCount,
        end_users: endUsersCount,
        last_at: lastAtMs ? new Date(lastAtMs).toISOString() : null,
        system_prompt: masked.slice(0, ADMIN_PROMPT_CHARS),
        system_prompt_length: masked.length,
      };
    } catch {
      return {
        agent: entry.id,
        name: entry.key || entry.id,
        type: "general",
        model: entry.model,
        definition: entry.definition,
        builtins: [],
        mcp_servers: [],
        openapi: 0,
        app_tools: 0,
        code_mode: false,
        schedules: 0,
        channel: null,
        responses: ledgerUsage?.responses ?? 0,
        end_users: ledgerUsage?.endUsers ?? 0,
        last_at: new Date(ledgerUsage?.lastAt ?? entry.updatedAt).toISOString(),
        system_prompt: "",
        system_prompt_length: 0,
      };
    }
  });
  agents.sort((a, b) => b.responses - a.responses || (b.last_at ? Date.parse(b.last_at) : 0) - (a.last_at ? Date.parse(a.last_at) : 0));

  const ledgerTotals = effectiveLedgerTotals(snapshot);
  const netPurchased = Math.max(0, ledgerTotals.purchasedUsd - ledgerTotals.refundedUsd);

  return {
    schema_version: 1,
    range: win.range,
    generated_at: new Date(now).toISOString(),
    account: {
      tenant: tenantId,
      name,
      kind,
      sign_in: reg?.signIn ?? null,
      signed_up_at: createdAt > 0 ? new Date(createdAt).toISOString() : null,
      staff,
      deleted: false,
      billing: "prepaid",
      balance: toMicros(snapshot.profile.balanceUsd),
      purchased: toMicros(netPurchased),
      granted: toMicros(Math.max(0, ledgerTotals.grantedUsd)),
      ...(infraCredit ? { infra_credit: toMicros(infraCredit.remainingUsd) } : {}),
      tier: snapshot.profile.tier,
      monthly_cap_usd: snapshot.profile.monthlyCapUsd,
      concurrency_limit: snapshot.profile.concurrencyLimit,
      rate_limit_rpm: snapshot.profile.rateLimitRpm,
      busy_agents: snapshot.busyAgents,
    },
    usage: {
      responses,
      cost,
      platform_cost: cost,
      active_days: activeDaySet.size,
      models: [...modelMap.entries()]
        .map(([model, s]) => ({ model, responses: s.responses, cost: s.cost }))
        .sort((a, b) => b.responses - a.responses),
    },
    daily: dates.map((date) => ({ date, responses: dailyResponses.get(date) ?? 0 })),
    agents,
    live_agents: snapshot.totalAgents,
    channels: snapshot.channels.map((c) => ({ type: c.kind, name: c.name })),
    counts: {
      api_keys: snapshot.counts.apiKeys,
      definitions: snapshot.counts.definitions,
      volumes: snapshot.counts.repos,
      schedules: totalSchedules,
    },
    provider_keys: snapshot.providers,
    mcp_clients: [...new Set(tenantGrants.filter((g) => g.revokedAt === null).map((g) => g.clientName))].sort(),
  };
}

function buildSignals(
  tenants: HydratedTenant[],
  startDate: string,
  endDate: string,
  timeZone: string,
  now = Date.now(),
): AdminSignals {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new ApiError(400, "invalid_date", "invalid_date");
  }
  const dayCount = Math.floor((endMs - startMs) / DAY_MS) + 1;
  if (dayCount > 366) {
    throw new ApiError(422, "range_too_long", "range_too_long");
  }
  const dates = windowDates(startMs, dayCount);
  const dailyMap = new Map(dates.map((date) => [date, { date, signups: 0, activations: 0 as number | null, payments: 0, amount_minor: 0 }]));
  const payingTenants = new Set<string>();

  for (const t of tenants) {
    if (!t.counted) continue;
    const signupDay = dateInTimeZone(t.createdAt, timeZone);
    const sRow = dailyMap.get(signupDay);
    if (sRow) sRow.signups++;

    const active = [...tenantActiveDays(t)].sort();
    if (active[0]) {
      const aRow = dailyMap.get(active[0]);
      if (aRow && aRow.activations !== null) aRow.activations++;
    }

    for (const l of t.snapshot.ledger) {
      if ((l.kind === "topup" || l.kind === "purchase") && l.amountUsd > 0 && !isStarterGrantLedgerEntry(l)) {
        const lDay = dateInTimeZone(l.createdAt, timeZone);
        const lRow = dailyMap.get(lDay);
        if (lRow) {
          lRow.payments++;
          lRow.amount_minor += Math.round(l.amountUsd * 100);
          payingTenants.add(t.reg.tenantId);
        }
      }
    }
  }

  const daily = dates.map((d) => dailyMap.get(d)!);
  return {
    schema_version: 1,
    range: { start_date: startDate, end_date: endDate, time_zone: timeZone },
    generated_at: new Date(now).toISOString(),
    summary: {
      signups: daily.reduce((s, r) => s + r.signups, 0),
      activations: daily.reduce((s, r) => s + (r.activations ?? 0), 0),
      payments: daily.reduce((s, r) => s + r.payments, 0),
      paying_accounts: payingTenants.size,
      amount_minor: daily.reduce((s, r) => s + r.amount_minor, 0),
      currency: "USD",
    },
    daily,
    activation_coverage: { status: "full", since: null },
  };
}

function buildActivityTrend(
  tenants: HydratedTenant[],
  rawDays: number,
  endDateParam: string | undefined,
  now = Date.now(),
): AdminTrend {
  const days = Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= ADMIN_TREND_MAX_DAYS ? rawDays : ADMIN_TREND_DAYS;
  const todayStr = utcDate(now);
  const endStr = endDateParam && /^\d{4}-\d{2}-\d{2}$/.test(endDateParam) ? endDateParam : todayStr;
  const endMs = Date.parse(`${endStr}T00:00:00Z`);
  if (!Number.isFinite(endMs)) throw new ApiError(400, "invalid_date", "invalid_date");
  const startMs = endMs - (days - 1) * DAY_MS;
  const dates = windowDates(startMs, days);
  const dailyMap = new Map(dates.map((date) => [date, { date, signups: 0, returning_active: 0 }]));

  for (const t of tenants) {
    if (!t.counted) continue;
    const signupDay = utcDate(t.createdAt);
    const sRow = dailyMap.get(signupDay);
    if (sRow) sRow.signups++;
    for (const activeDay of tenantActiveDays(t)) {
      if (activeDay > signupDay) {
        const aRow = dailyMap.get(activeDay);
        if (aRow) aRow.returning_active++;
      }
    }
  }

  return {
    schema_version: 1,
    range: { start_date: dates[0]!, end_date: dates.at(-1)!, time_zone: "UTC" },
    generated_at: new Date(now).toISOString(),
    daily: dates.map((d) => dailyMap.get(d)!),
    incomplete_date: dates.includes(todayStr) ? todayStr : null,
  };
}

function requireAdmin(env: Env, request: Request): void {
  if (!verifyAdminHeader(env, request)) {
    throw new ApiError(401, "unauthorized", "Invalid or missing X-Admin-Key");
  }
}

function parseDaysOrThrow(raw: string | undefined): string {
  const value = raw ?? "30";
  try {
    parseAdminWindow(value);
  } catch (err) {
    if (err instanceof AdminWindowError) {
      throw new ApiError(400, "invalid_window", err.message);
    }
    throw err;
  }
  return value;
}

export async function recordOpsTenantRegistration(
  env: Env,
  input: {
    tenantId: string;
    name?: string | null;
    kind?: "self_serve" | "operator_made" | "operator";
    signIn?: "github" | "google" | "email" | null;
    email?: string | null;
    login?: string | null;
    signupSource?: SignupSource | null;
    createdAt?: number;
  },
): Promise<void> {
  try {
    await getTenantStub(env, CONSOLE_ACCOUNTS_DO_NAME).registerOpsTenant(input);
  } catch {
    // Non-critical ops index update; never fail the primary tenant/auth write path.
  }
}

export function registerOpsRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/v2/admin/ops/me", (c) => {
    requireAdmin(c.env, c.req.raw);
    const viewer = c.req.header("x-ops-viewer")?.trim() || "admin";
    return c.json({ viewer }, 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/tenants", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const tenants = await getTenantStub(c.env, CONSOLE_ACCOUNTS_DO_NAME).listOpsTenants();
    return c.json({ tenants }, 200, { "Cache-Control": "no-store" });
  });

  app.post("/v2/admin/ops/register-tenant", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const body = (await c.req.json().catch(() => ({}))) as {
      tenantId?: unknown;
      name?: unknown;
      kind?: unknown;
      signIn?: unknown;
      email?: unknown;
      login?: unknown;
      tenants?: Array<{
        tenantId?: unknown;
        name?: unknown;
        kind?: unknown;
        signIn?: unknown;
        email?: unknown;
        login?: unknown;
      }>;
    };

    const items = Array.isArray(body.tenants) ? body.tenants : [body];
    if (items.length === 0) {
      throw new ApiError(400, "invalid_request", "Provide `tenantId` or a non-empty `tenants` array");
    }

    const registered: OpsRegisteredTenant[] = [];
    for (const item of items) {
      const tenantId = typeof item.tenantId === "string" ? item.tenantId.trim() : "";
      if (!tenantId || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(tenantId)) {
        throw new ApiError(400, "invalid_request", "Each entry requires a valid `tenantId`");
      }
      const profile = await getTenantStub(c.env, tenantId).getProfile().catch(() => null);
      const kind =
        item.kind === "self_serve" || item.kind === "operator_made" || item.kind === "operator"
          ? item.kind
          : isOperatorReserveTenant(c.env, tenantId)
            ? "operator"
            : "operator_made";
      const signIn =
        item.signIn === "github" || item.signIn === "google" || item.signIn === "email"
          ? item.signIn
          : null;
      const saved = await getTenantStub(c.env, CONSOLE_ACCOUNTS_DO_NAME).registerOpsTenant({
        tenantId,
        name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : (profile?.name ?? null),
        kind,
        signIn,
        email: typeof item.email === "string" && item.email.trim() ? item.email.trim().toLowerCase() : null,
        login: typeof item.login === "string" && item.login.trim() ? item.login.trim() : null,
        createdAt: profile?.createdAt,
      });
      registered.push(saved);
    }

    return c.json(
      Array.isArray(body.tenants) ? { ok: true, registered } : { ok: true, tenant: registered[0] },
      200,
      { "Cache-Control": "no-store" },
    );
  });

  app.get("/v2/admin/ops/growth", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const days = parseDaysOrThrow(c.req.query("days"));
    const { tenants } = await collectTenants(c.env, Math.max(Number(days) * 2, ADMIN_COHORT_WEEKS * 7 + 14));
    return c.json(buildGrowth(tenants, days), 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/acquisition", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const days = parseDaysOrThrow(c.req.query("days"));
    const [{ tenants }, grants, r2Sources] = await Promise.all([
      collectTenants(c.env, Math.max(Number(days), 90)),
      listAllOAuthGrants(c.env).catch(() => [] as OAuthGrantRecord[]),
      loadAllSignupSources(c.env),
    ]);
    return c.json(buildAcquisition(tenants, grants, days, r2Sources), 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/usage", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const days = parseDaysOrThrow(c.req.query("days"));
    const now = Date.now();
    const win = parseAdminWindow(days, now);
    const [{ tenants }, grants] = await Promise.all([
      collectTenants(c.env, Number(days) * 2 + 2, {
        currentFromMs: win.from,
        currentUntilMs: win.until,
        previousFromMs: win.previousFrom,
      }),
      listAllOAuthGrants(c.env).catch(() => [] as OAuthGrantRecord[]),
    ]);
    return c.json(buildUsage(tenants, grants, days, now), 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/revenue", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const days = parseDaysOrThrow(c.req.query("days"));
    const { tenants } = await collectTenants(c.env, Math.max(Number(days) * 2, 370));
    return c.json(buildRevenue(tenants, days), 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/health", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const days = parseDaysOrThrow(c.req.query("days"));
    const { tenants, registeredCount, failedCount } = await collectTenants(c.env, Math.max(Number(days) * 2, 70));
    const report = await buildHealth(c.env, tenants, registeredCount, failedCount, days);
    return c.json(report, 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/mcp", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const days = parseDaysOrThrow(c.req.query("days"));
    const [{ tenants }, grants] = await Promise.all([
      collectTenants(c.env, Math.max(Number(days), 90)),
      listAllOAuthGrants(c.env).catch(() => [] as OAuthGrantRecord[]),
    ]);
    return c.json(buildMcp(tenants, grants, days), 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/account", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const days = parseDaysOrThrow(c.req.query("days"));
    const tenant = c.req.query("tenant") ?? "";
    if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(tenant)) {
      return c.json({ error: "tenant must be an account id" }, 400, { "Cache-Control": "no-store" });
    }
    const detail = await buildAccountDetail(c.env, tenant, days);
    if (!detail) {
      return c.json({ error: "account_not_found" }, 404, { "Cache-Control": "no-store" });
    }
    return c.json(detail, 200, { "Cache-Control": "no-store" });
  });

  app.post("/v2/admin/ops/account/credits", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const body = (await c.req.json().catch(() => ({}))) as {
      tenantId?: unknown;
      amountUsd?: unknown;
      note?: unknown;
      refId?: unknown;
      kind?: unknown;
      creditType?: unknown;
    };
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!tenantId || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(tenantId)) {
      throw new ApiError(400, "invalid_request", "`tenantId` is required");
    }
    const amountUsd = Number(body.amountUsd);
    if (!Number.isFinite(amountUsd) || amountUsd === 0) {
      throw new ApiError(400, "invalid_request", "`amountUsd` must be a non-zero number");
    }
    const creditType = body.creditType === "infra" ? "infra" : "platform";
    const kind = body.kind === "grant" ? "grant" : "topup";
    const viewer = c.req.header("x-ops-viewer")?.trim() || "operator";
    const refId =
      typeof body.refId === "string" && body.refId.trim()
        ? body.refId.trim()
        : `ops:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
    const note =
      typeof body.note === "string" && body.note.trim()
        ? `${body.note.trim()} (by ${viewer})`
        : `Operator adjustment by ${viewer}`;

    if (creditType === "infra") {
      const rec = await grantInfraCredit(c.env, tenantId, amountUsd, { refId, note });
      return c.json(
        {
          ok: true,
          tenantId,
          creditType: "infra",
          infraCreditUsd: rec.remainingUsd,
          grantedUsd: rec.grantedUsd,
          refId,
        },
        200,
        { "Cache-Control": "no-store" },
      );
    }

    const out = await getTenantStub(c.env, tenantId).addCredits({
      amountUsd,
      refId,
      note,
      kind,
    });
    return c.json({ ok: true, tenantId, balanceUsd: out.balanceUsd, refId }, 200, { "Cache-Control": "no-store" });
  });

  app.patch("/v2/admin/ops/account", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const body = (await c.req.json().catch(() => ({}))) as {
      tenantId?: unknown;
      tier?: unknown;
      monthlyCapUsd?: unknown;
      concurrencyLimit?: unknown;
      rateLimitRpm?: unknown;
      name?: unknown;
    };
    const tenantId = typeof body.tenantId === "string" ? body.tenantId.trim() : "";
    if (!tenantId || !/^[A-Za-z0-9_.:@-]{1,200}$/.test(tenantId)) {
      throw new ApiError(400, "invalid_request", "`tenantId` is required");
    }
    const monthlyCapUsd = body.monthlyCapUsd !== undefined ? Number(body.monthlyCapUsd) : undefined;
    if (monthlyCapUsd !== undefined && (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd < 0)) {
      throw new ApiError(400, "invalid_request", "`monthlyCapUsd` must be 0 or greater");
    }
    const concurrencyLimit = body.concurrencyLimit !== undefined ? Number(body.concurrencyLimit) : undefined;
    if (concurrencyLimit !== undefined && (!Number.isInteger(concurrencyLimit) || concurrencyLimit < 1)) {
      throw new ApiError(400, "invalid_request", "`concurrencyLimit` must be a positive integer");
    }
    const rateLimitRpm = body.rateLimitRpm !== undefined ? Number(body.rateLimitRpm) : undefined;
    if (rateLimitRpm !== undefined && (!Number.isInteger(rateLimitRpm) || rateLimitRpm < 1)) {
      throw new ApiError(400, "invalid_request", "`rateLimitRpm` must be a positive integer");
    }

    const profile = await getTenantStub(c.env, tenantId).updateTenantLimits({
      tier: typeof body.tier === "string" ? body.tier : undefined,
      monthlyCapUsd,
      concurrencyLimit,
      rateLimitRpm,
      name: typeof body.name === "string" ? body.name : undefined,
    });
    return c.json({ ok: true, profile }, 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/product-signals", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const timeZone = c.req.query("time_zone") ?? ADMIN_TIME_ZONE;
    const today = dateInTimeZone(Date.now(), timeZone);
    const start = c.req.query("start_date") ?? today;
    const end = c.req.query("end_date") ?? today;
    const { tenants } = await collectTenants(c.env, 370);
    return c.json(buildSignals(tenants, start, end, timeZone), 200, { "Cache-Control": "no-store" });
  });

  app.get("/v2/admin/ops/activity-trend", async (c) => {
    requireAdmin(c.env, c.req.raw);
    const days = Number(c.req.query("days") ?? ADMIN_TREND_DAYS);
    const endDate = c.req.query("end_date") ?? undefined;
    const { tenants } = await collectTenants(c.env, ADMIN_TREND_MAX_DAYS + 7);
    return c.json(buildActivityTrend(tenants, days, endDate), 200, { "Cache-Control": "no-store" });
  });

  app.post("/v2/admin/ops/report", (c) => {
    requireAdmin(c.env, c.req.raw);
    return c.json({ error: "report_not_configured" }, 503, { "Cache-Control": "no-store" });
  });
}
