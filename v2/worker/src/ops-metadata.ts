import type { Env } from "./types.ts";

export const GITHUB_STARTER_PLATFORM_CREDIT_USD = 5;
export const SELF_SERVE_INFRA_CREDIT_USD = 5;

export interface SignupSource {
  ref?: string;
  referrer?: string;
}

export interface StoredSignupSource {
  tenantId: string;
  source: SignupSource;
  recordedAt: number;
}

export interface InfraCreditRecord {
  tenantId: string;
  grantedUsd: number;
  usedUsd: number;
  remainingUsd: number;
  note?: string | null;
  createdAt: number;
  updatedAt: number;
  grantRefs: string[];
  settledRefs: string[];
}

const SIGNUP_SOURCE_PREFIX = "ops/signup-sources/";
const INFRA_CREDIT_PREFIX = "ops/infra-credits/";

const REF_RE = /^[a-z0-9][a-z0-9._/-]{0,63}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

// Process-local fallback for local unit tests that run without an R2 MEDIA_BUCKET binding.
const memorySignupSources = new Map<string, StoredSignupSource>();
const memoryInfraCredits = new Map<string, InfraCreditRecord>();

function roundUsd(value: number): number {
  return Number(value.toFixed(8));
}

function signupSourceKey(tenantId: string): string {
  return `${SIGNUP_SOURCE_PREFIX}${tenantId}.json`;
}

function infraCreditKey(tenantId: string): string {
  return `${INFRA_CREDIT_PREFIX}${tenantId}.json`;
}

export function normalizeSignupSource(
  input: { ref?: unknown; from?: unknown; referrer?: unknown } | null | undefined,
  refused = false,
): SignupSource | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rawRef = typeof input.ref === "string" ? input.ref.trim().toLowerCase() : "";
  const rawHost =
    typeof input.referrer === "string"
      ? input.referrer.trim().toLowerCase().replace(/^www\./, "")
      : typeof input.from === "string"
        ? input.from.trim().toLowerCase().replace(/^www\./, "")
        : "";
  const out: SignupSource = {};
  if (REF_RE.test(rawRef)) out.ref = rawRef;
  if (!refused && HOST_RE.test(rawHost)) out.referrer = rawHost;
  return out;
}

export async function recordSignupSourceOnce(
  env: Env,
  tenantId: string,
  source: SignupSource,
  recordedAt = Date.now(),
): Promise<boolean> {
  const cleanId = tenantId.trim();
  if (!cleanId) return false;
  const normalized = normalizeSignupSource(source);
  if (!normalized) return false;

  const record: StoredSignupSource = {
    tenantId: cleanId,
    source: normalized,
    recordedAt,
  };

  if (!env.MEDIA_BUCKET) {
    if (memorySignupSources.has(cleanId)) return false;
    memorySignupSources.set(cleanId, record);
    return true;
  }

  try {
    const key = signupSourceKey(cleanId);
    const existing = await env.MEDIA_BUCKET.head(key);
    if (existing) return false;
    await env.MEDIA_BUCKET.put(key, JSON.stringify(record), {
      httpMetadata: { contentType: "application/json" },
    });
    return true;
  } catch {
    return false;
  }
}

export async function loadAllSignupSources(env: Env): Promise<Map<string, StoredSignupSource>> {
  const out = new Map<string, StoredSignupSource>();
  if (!env.MEDIA_BUCKET) {
    for (const [k, v] of memorySignupSources) out.set(k, v);
    return out;
  }

  try {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const listed = await env.MEDIA_BUCKET.list({
        prefix: SIGNUP_SOURCE_PREFIX,
        limit: 1000,
        cursor,
      });
      for (const obj of listed.objects) {
        if (obj.key.endsWith(".json")) keys.push(obj.key);
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);

    const concurrency = 20;
    let idx = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
        while (idx < keys.length) {
          const key = keys[idx++]!;
          try {
            const obj = await env.MEDIA_BUCKET!.get(key);
            if (!obj) continue;
            const parsed = (await obj.json()) as Partial<StoredSignupSource> | null;
            const tenantId = typeof parsed?.tenantId === "string" && parsed.tenantId.trim()
              ? parsed.tenantId.trim()
              : key.slice(SIGNUP_SOURCE_PREFIX.length, -".json".length);
            const normalized = normalizeSignupSource(parsed?.source);
            if (!tenantId || !normalized) continue;
            out.set(tenantId, {
              tenantId,
              source: normalized,
              recordedAt: typeof parsed?.recordedAt === "number" && Number.isFinite(parsed.recordedAt)
                ? parsed.recordedAt
                : Date.now(),
            });
          } catch {
            // Skip unreadable object
          }
        }
      }),
    );
  } catch {
    // Non-fatal; return whatever was loaded
  }
  return out;
}

export async function getInfraCredit(env: Env, tenantId: string): Promise<InfraCreditRecord | null> {
  const cleanId = tenantId.trim();
  if (!cleanId) return null;
  if (!env.MEDIA_BUCKET) {
    return memoryInfraCredits.get(cleanId) ?? null;
  }
  try {
    const obj = await env.MEDIA_BUCKET.get(infraCreditKey(cleanId));
    if (!obj) return null;
    const parsed = (await obj.json()) as Partial<InfraCreditRecord> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const grantedUsd = Number(parsed.grantedUsd ?? 0);
    const usedUsd = Number(parsed.usedUsd ?? 0);
    const remainingUsd = Number(parsed.remainingUsd ?? Math.max(0, grantedUsd - usedUsd));
    return {
      tenantId: cleanId,
      grantedUsd: Number.isFinite(grantedUsd) ? roundUsd(grantedUsd) : 0,
      usedUsd: Number.isFinite(usedUsd) ? roundUsd(usedUsd) : 0,
      remainingUsd: Number.isFinite(remainingUsd) ? roundUsd(Math.max(0, remainingUsd)) : 0,
      note: typeof parsed.note === "string" ? parsed.note : null,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      grantRefs: Array.isArray(parsed.grantRefs) ? parsed.grantRefs.filter((r): r is string => typeof r === "string") : [],
      settledRefs: Array.isArray(parsed.settledRefs) ? parsed.settledRefs.filter((r): r is string => typeof r === "string") : [],
    };
  } catch {
    return null;
  }
}

async function saveInfraCredit(env: Env, record: InfraCreditRecord): Promise<void> {
  if (!env.MEDIA_BUCKET) {
    memoryInfraCredits.set(record.tenantId, record);
    return;
  }
  await env.MEDIA_BUCKET.put(infraCreditKey(record.tenantId), JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
  });
}

export async function grantInfraCredit(
  env: Env,
  tenantId: string,
  amountUsd: number,
  opts?: { refId?: string; note?: string | null },
): Promise<InfraCreditRecord> {
  const cleanId = tenantId.trim();
  const delta = roundUsd(Number(amountUsd));
  const now = Date.now();
  const existing = await getInfraCredit(env, cleanId);
  const refId = opts?.refId?.trim() || undefined;

  if (existing && refId && existing.grantRefs.includes(refId)) {
    return existing;
  }

  const nextGranted = roundUsd(Math.max(0, (existing?.grantedUsd ?? 0) + delta));
  const nextRemaining = roundUsd(Math.max(0, (existing?.remainingUsd ?? 0) + delta));
  const grantRefs = [...(existing?.grantRefs ?? []), ...(refId ? [refId] : [])].slice(-200);

  const next: InfraCreditRecord = {
    tenantId: cleanId,
    grantedUsd: nextGranted,
    usedUsd: existing?.usedUsd ?? 0,
    remainingUsd: nextRemaining,
    note: opts?.note ?? existing?.note ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    grantRefs,
    settledRefs: existing?.settledRefs ?? [],
  };
  await saveInfraCredit(env, next);
  return next;
}

export async function consumeInfraCredit(
  env: Env,
  tenantId: string,
  costUsd: number,
  refId: string,
): Promise<{ coveredUsd: number; uncoveredUsd: number; remainingUsd: number }> {
  const cleanCost = roundUsd(Math.max(0, Number(costUsd)));
  if (cleanCost <= 0) {
    const existing = await getInfraCredit(env, tenantId);
    return { coveredUsd: 0, uncoveredUsd: 0, remainingUsd: existing?.remainingUsd ?? 0 };
  }

  const existing = await getInfraCredit(env, tenantId);
  if (!existing || existing.remainingUsd <= 0) {
    return { coveredUsd: 0, uncoveredUsd: cleanCost, remainingUsd: 0 };
  }

  const cleanRef = refId.trim();
  if (cleanRef && existing.settledRefs.includes(cleanRef)) {
    return { coveredUsd: 0, uncoveredUsd: 0, remainingUsd: existing.remainingUsd };
  }

  const coveredUsd = roundUsd(Math.min(existing.remainingUsd, cleanCost));
  const uncoveredUsd = roundUsd(Math.max(0, cleanCost - coveredUsd));
  const remainingUsd = roundUsd(Math.max(0, existing.remainingUsd - coveredUsd));
  const usedUsd = roundUsd(existing.usedUsd + coveredUsd);

  const next: InfraCreditRecord = {
    ...existing,
    usedUsd,
    remainingUsd,
    updatedAt: Date.now(),
    settledRefs: [...existing.settledRefs, ...(cleanRef ? [cleanRef] : [])].slice(-200),
  };
  await saveInfraCredit(env, next);
  return { coveredUsd, uncoveredUsd, remainingUsd };
}
