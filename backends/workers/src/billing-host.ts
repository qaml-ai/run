import type { Sql } from "./postgres.ts";
import type { UsageTier } from "../../../src/pricing.ts";

/** Host contracts used by the unchanged billing service. No filesystem-backed tenant registry. */
export interface Tenants {
  billing(tenant: string): "prepaid" | "none" | undefined;
  has(tenant: string): boolean;
  internal(tenant: string): boolean;
  maxAgents(tenant: string): number | undefined;
  maxStorageBytes(tenant: string): number | undefined;
  codeLimits(tenant: string): { cpuMs?: number; maxTimeoutMs?: number; concurrent?: number };
  decisionConcurrency(tenant: string): number | undefined;
  runLimits(tenant: string): { maxResponses?: number; maxSeconds?: number };
}
export const databaseTenants: Tenants = {
  billing: () => undefined, has: () => false, internal: () => false,
  maxAgents: () => undefined, maxStorageBytes: () => undefined,
  codeLimits: () => ({}), decisionConcurrency: () => undefined, runLimits: () => ({}),
};
type Sealed = { iv: string; tag: string; ciphertext: string };
export interface Accounts { seal(aad: string, plaintext: string): Sealed; unseal(aad: string, sealed: Sealed): string }
export interface Journey {
  cardVerified(sql: Sql, tenant: string): Promise<void>;
  creditPurchased(sql: Sql, input: { tenant: string; amountMinor: number; payment: string }): Promise<void>;
  autoTopupEnabled(sql: Sql, input: any): Promise<void>;
}
export type StorageMeter = (key: string, bytes: number) => void;
export interface Storage { metered?: boolean; objects?(prefix: string): AsyncIterable<{ key: string; bytes: number }> }
export interface StorageUsage {
  reconcile(storage: Storage, options: { now: number }): Promise<unknown>;
  flush(): Promise<unknown>;
  tenantBytes(): Promise<Map<string, number>>;
}
export type BusyLimit =
  | { limit: number; source: "tenant" | "internal" | "default" }
  | { limit: number; source: "tier"; tier: string; paid: number; next?: { tier: string; paid: number; limit: number } };
// Same SQL and tier projection as src/busy-agents.ts. The Workers admission adapter
// supplies its own live counter to API summaries; ECS leases are not synthesized.
export async function busyCount(sql: Sql, tenant: string) {
  const { rows } = await sql.query(`
    select count(*) as busy from busy_agents b join runtime_nodes n on n.node = b.node and n.session = b.session
    where b.tenant = $1 and n.expires_at > now()`, [tenant]);
  return Number(rows[0].busy);
}
export function tierLimit(tier: UsageTier, next: UsageTier | undefined, paid: number): BusyLimit {
  return { limit: tier.busyAgents, source: "tier", tier: tier.name, paid, ...(next ? { next: { tier: next.name, paid: next.paid, limit: next.busyAgents } } : {}) };
}
/** Logs a class of failure, never potentially secret-bearing provider messages. */
export const safeError = (error: unknown) => error instanceof Error ? error.name : "Error";
