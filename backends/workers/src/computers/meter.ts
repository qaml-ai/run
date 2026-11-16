import type { AgentInvocation } from "../agent-invocation.ts";
export const INSTANCE_TYPES = ["lite", "standard-1", "standard-2", "standard-3", "standard-4"] as const;
export type InstanceType = (typeof INSTANCE_TYPES)[number];

/** Each instance type's provisioned vCPU, memory (GiB) and disk (GB), retained for existing definition sizes. */
export const INSTANCE_RESOURCES: Record<InstanceType, { vcpu: number; memoryGiB: number; diskGB: number }> = {
  lite: { vcpu: 1 / 16, memoryGiB: 0.25, diskGB: 2 },
  "standard-1": { vcpu: 0.5, memoryGiB: 4, diskGB: 8 },
  "standard-2": { vcpu: 1, memoryGiB: 6, diskGB: 12 },
  "standard-3": { vcpu: 2, memoryGiB: 8, diskGB: 16 },
  "standard-4": { vcpu: 4, memoryGiB: 12, diskGB: 20 },
};

/**
 * Who pays for a computer's time: the agent (and its tenant) whose tool or session uses it. With `kind: "workflow"`,
 * `agent` is a workflow's id: a job of a workflow no agent owns (an API key started it), paid by its tenant, its usage
 * recorded under the workflow (meter-billing.ts).
 */
export type ComputerPayer = { tenant: string; agent: string; kind?: "workflow" };
/** A durable compute receipt. Its ID identifies the same charge across settlement retries. */
export type ComputerCharge = ComputerPayer & { id: string; instance: string; startedAt: number; endedAt: number; seconds: number; costUsd: number };
export interface MeterBilling {
  /** Refuse (throw) when the payer may not start platform compute: an agent spend limit, or spent prepaid credit. */
  admit(payer: ComputerPayer, invocation?: AgentInvocation): Promise<void>;
  /** Record and charge a finished session, once per `id`. */
  charge(charge: ComputerCharge): Promise<void>;
}
