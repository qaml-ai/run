import { createHash } from "node:crypto";
import type { BillingReads } from "./billing.ts";
import type { Accounts } from "./accounts.ts";
import { RateLimits, rateLimitConfig, type RateLimitOptions } from "./account-rate-limits.ts";
import type { PostgresEnv } from "./postgres.ts";

// Request wrappers may clone env. The IP buckets belong to the Worker isolate,
// while the account reference refreshes so a tenants reload applies immediately.
const limits = new Map<string, { service: RateLimits; accounts: Accounts; touched: number }>();
export function accountRateLimits(env: PostgresEnv & Record<string, unknown>, accounts: Accounts, secret: string): RateLimits {
  const settings = Object.entries(env).filter(([name]) => name.startsWith("AGENT_RATE_LIMIT_") || name === "AGENT_TRUST_CF_CONNECTING_IP").sort(([a], [b]) => a.localeCompare(b));
  const key = createHash("sha256").update(JSON.stringify([env.HYPERDRIVE.connectionString, secret, settings])).digest("hex");
  let cached = limits.get(key);
  if (cached) {
    cached.accounts = accounts;
    cached.touched = Date.now();
    return cached.service;
  }
  for (const [name, value] of limits) if (Date.now() - value.touched > 3_600_000) limits.delete(name);
  // Account configuration remains request-scoped; only the source limiter's
  // bounded in-memory token buckets survive across HTTP requests.
  const current = { accounts };
  const service = new RateLimits({
    db: accounts.db,
    config: rateLimitConfig(env as unknown as NodeJS.ProcessEnv),
    hashKey: secret,
    nodes: () => 1,
    free: tenant => current.accounts.billing.onFreeCredit(tenant),
    override: (tenant, limit) => current.accounts.tenants.has(tenant) ? current.accounts.tenants.rateLimit(tenant, limit) : current.accounts.billing.rateLimit(tenant, limit),
    tier: (tenant, limit) => current.accounts.billing.tierRateLimit(tenant, limit),
    exempt: tenant => current.accounts.tenants.has(tenant),
  });
  cached = Object.assign(current, { service, touched: Date.now() });
  limits.set(key, cached);
  return service;
}

export function rateBilling(accounts: Accounts, reads?: BillingReads) {
  const { billing, tenants } = accounts;
  return {
    free: tenant => billing.onFreeCredit(tenant, reads),
    override: (tenant, limit) => tenants.has(tenant) ? tenants.rateLimit(tenant, limit) : billing.rateLimit(tenant, limit, reads),
    tier: (tenant, limit) => billing.tierRateLimit(tenant, limit, reads),
    exempt: tenant => tenants.has(tenant),
  } satisfies Required<Pick<RateLimitOptions, "free" | "override" | "tier" | "exempt">>;
}
