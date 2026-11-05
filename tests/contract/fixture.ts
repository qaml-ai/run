import type { T } from "./http.ts";
import { evidence } from "./evidence.ts";

export type ModelReply = (body: any, index: number) => object;
export type CallOptions = { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null };
export type Reply = { status: number; json: any; text: string; headers: Headers };
export type TenantSeed = { token?: string; credits?: number; billingMode?: "none" | "prepaid"; config?: Record<string, unknown>; operator?: boolean; email?: string; suppressed?: boolean };
export type FixtureOptions = {
  respond?: ModelReply;
  env?: Record<string, string>;
  tenants?: object;
  /** Create additional local fake endpoints before starting either backend. */
  prepare?: (t: T) => Promise<Record<string, string>>;
};

/** Only fixture implementations can touch backend storage or processes. Credits are integer micro-USD. */
export interface ContractFixture {
  base: string;
  /** Test process diagnostics, used only by retained log-redaction assertions. */
  logs: string[];
  call(path: string, init?: CallOptions): Promise<Reply>;
  prompt(agent: string, text: string, token?: string, extra?: Record<string, unknown>): Promise<any>;
  model: { url: string; bodies: any[]; keys: string[]; headers: any[] };
  setModel(respond: ModelReply): void;
  seedTenant(id: string, options?: TenantSeed): Promise<{ id: string; token: string }>;
  seedIdempotencyLock(lock: { tenant: string; key: string; fingerprint: string; createdAt: number }): Promise<void>;
  setScheduleDueAt(agent: string, schedule: string, dueAt: number): Promise<void>;
  setScheduleLegacyHistory(agent: string, schedule: string, history: "none"): Promise<void>;
  resetChildSettlement(parent: string): Promise<void>;
  now(): Promise<number>;
  /** Wait for real backend time; does not pretend the backend clock advanced. */
  advanceTime(ms: number): Promise<void>;
  close(): Promise<void>;
}

export async function createFixture(t: T, options: FixtureOptions = {}): Promise<ContractFixture> {
  const env = { ...options.env, ...await options.prepare?.(t) };
  const backend = process.env.CONTRACT_BACKEND ?? "node";
  if (backend === "node") {
    const { createNodeFixture } = await import("./fixtures/node.ts");
    const fixture = await createNodeFixture(t, { ...options, env });
    if (evidence.getStore()) evidence.getStore()!.backend = backend;
    return fixture;
  }
  if (backend === "workers") {
    const { createWorkersFixture } = await import("./fixtures/workers.ts");
    const fixture = await createWorkersFixture(t, { ...options, env });
    if (evidence.getStore()) evidence.getStore()!.backend = backend;
    return fixture;
  }
  throw new Error(`Unknown CONTRACT_BACKEND: ${backend}`);
}
