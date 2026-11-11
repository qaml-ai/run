import type { Placement } from "../../../shared/owner.ts";
import type { CodemodeSandboxDurableObject } from "@earendil-works/pi-codemode/cloudflare";
import type { ComputerBindings } from "./computers/tool.ts";
import type { ControlEnv, TurnReceipt } from "./control.ts";
import type { FileBindings } from "./files.ts";
import type { TenantAdmission } from "./tenant.ts";
import type { ComputerEnv } from "./computers/service.ts";
import type { AdminEnv } from "./admin-api.ts";
import type { MediaBindings } from "./media-api.ts";
import type { KeyEnv } from "./security-services.ts";
import type { AccountEnv } from "./account-services.ts";
import type { AgentConfiguration } from "./api-contract.ts";
import type { CamelAgent } from "./agent.ts";

export type Config = {
  id: string;
  tenantId: string;
  revision: number;
  expiresAt: number | null;
  config: AgentConfiguration;
  resolvedModel?: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>;
  runtimeOrigin?: string;
};

export type RequestRecord = {
  id: string;
  sharedAgent?: import("../../../src/shared-agents.ts").SharedAgent | null;
  heldForInput?: true;
  inputAdmissionRetry?: { attempts: number; at: number };
  method: string;
  params?: Record<string, unknown>;
  endUser?: string;
  configurationOrder?: number;
  configurationOrigin?: string;
  configurationWait?: number;
  configurationWaitSequence?: number;
  replaceConfiguration?: boolean;
  piId?: string;
  task?: number;
  steer?: "queued" | "accepted";
  steeredInto?: string;
  /** Accepted while its logical turn was live, which may span native Pi runs. */
  steerCommitted?: true;
  /** Held for the next turn of an agent whose queue batches (batch-queue.ts): its hold's key, until a release gives it to Pi. */
  batchHeld?: string;
  /** A held prompt that ran in another's turn, with the prompts waiting beside it: that prompt's request. */
  batchedInto?: string;
  /** A held prompt whose turn took the prompts after it too (each batchedInto it), in order. */
  batch?: string[];
  metadata?: unknown;
  /** Where this run stands in a delegation chain, as its owner placed it through the binding (shared/owner.ts). */
  delegation?: Placement;
  /** Its ending is in this agent's outbox for its owner (ending-outbox.ts). */
  endingStaged?: true;
  actor?: string;
  usageBaseline?: Record<string, number>;
  fingerprint: string;
  billing?: { tenantId: string; agentId: string; model?: string };
  agentSpendAt?: number | null;
  state: "queued" | "running" | "completed";
  startedAt: number;
  endedAt?: number;
  began?: number;
  accepted?: boolean;
  admitted?: boolean;
  noticeQueued?: true;
  outcome?: { result?: unknown; error?: string };
  status?: string;
  error?: string;
};

export interface Env
  extends ComputerBindings,
    ControlEnv,
    FileBindings,
    KeyEnv,
    AccountEnv,
    ComputerEnv,
    MediaBindings,
    AdminEnv {
  TENANTS: DurableObjectNamespace<TenantAdmission>;
  RATE_LIMITER?: RateLimit;
  CODEMODE_SANDBOX: DurableObjectNamespace<CodemodeSandboxDurableObject>;
  AGENTS: DurableObjectNamespace<CamelAgent>;
  AI: Ai;
  MODEL: string;
  API_TOKEN: string;
  AGENT_SECRETS_KEY?: string;
  AGENT_PUBLIC_URL?: string;
  PUBLIC_ASSETS?: Fetcher;
  TEST_MODEL?: string;
  /** Local fault injection only; absent from deployable configurations. */
  TEST_HOOKS?: string;
  PILOT_DB_PROFILE?: string;
  TEST_MODEL_BASE_URL?: string;
  TEST_TURN_COST_MICROS?: string;
  TENANT_MAX_ACTIVE?: string;
  SCHEDULE_EMAIL_FROM?: string;
  SCHEDULE_OPERATOR_TENANTS?: string;
}

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });

export const canonical = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((item) => JSON.parse(canonical(item)))
        : Object.fromEntries(
            Object.entries(value)
              .filter(([, item]) => item !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, JSON.parse(canonical(item))]),
          )
      : value,
  );

export type BillingReceipt = TurnReceipt;

export const reqKey = (id: string) => `request:${id}`;
