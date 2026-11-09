import type { T } from "./http.ts";
import { observeBackend } from "./evidence.ts";
import type { FileGrant, TokenClaims } from "../../src/identity.ts";

export type ModelReply = (body: any, index: number) => object;
export type CallOptions = { method?: string; body?: unknown; headers?: Record<string, string>; token?: string | null };
export type Reply = { status: number; json: any; text: string; headers: Headers };
export type TenantSeed = { token?: string; credits?: number; billingMode?: "none" | "prepaid"; config?: Record<string, unknown>; operator?: boolean; email?: string; suppressed?: boolean };
export type FixtureOptions = {
  respond?: ModelReply;
  env?: Record<string, string>;
  tenants?: object;
  /** Fail the first real image resize job, then allow normal retries. */
  failImageResizeOnce?: boolean;
  triggerMaintenance?: boolean;
  /** Local STS/token endpoint used by the real Anthropic federation adapter. */
  anthropicFederationEndpoint?: string;
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
  imageResizeFailureCount(): Promise<number>;
  /** Reproduce a legacy stored model at restart; adapters must not emulate its billing behavior. */
  restartWithLegacyModel(agent: string, model: Record<string, unknown>): Promise<void>;
  seedTenant(id: string, options?: TenantSeed): Promise<{ id: string; token: string }>;
  seedIdempotencyLock(lock: { tenant: string; key: string; fingerprint: string; createdAt: number }): Promise<void>;
  setScheduleDueAt(agent: string, schedule: string, dueAt: number): Promise<void>;
  /** Make an agent's pending inputs due now, as if no one had answered in time; the backend's own expiry (its scheduler, or its alarm) then answers them. */
  expireInputs(agent: string): Promise<void>;
  /** Seed only the shared inbox index, independently of either backend's input authority. */
  seedInbox(rows: import('./fixtures/inbox.ts').InboxSeed[]): Promise<void>;
  setScheduleLegacyHistory(agent: string, schedule: string, history: "none"): Promise<void>;
  resetChildSettlement(parent: string): Promise<void>;
  deleteEndUser(tenant: string, endUser: string): Promise<void>;
  /** A definition as stored before the workflow builtin was removed (#624): its builtins and settings name it. */
  seedLegacyWorkflowDefinition(definition: string): Promise<void>;
  countOAuthRefreshTokens(): Promise<number>;
  ageUsedOAuthRefreshToken(token: string, milliseconds: number): Promise<void>;
  revokeOAuthGrants(): Promise<void>;
  seedOAuthAccessToken(grant: { grantId: string; tenant: string; clientId: string; clientName: string; login: string; scope: string; resource: string; token: string; expiresAt: number }): Promise<void>;
  /** One self-serve account with use, credit, a channel, schedules and what it can connect (fixtures/ops-seed.ts). */
  seedOpsAccount(now: number): Promise<void>;
  expireAccountEmailLinks(): Promise<void>;
  seedConsoleIdentity(tenant: string, identity: { method: "google" | "github"; subject: string | number; email?: string; login: string }): Promise<string>;
  seedEndUserUsage(usage: { tenant: string; endUser: string; bucket: string; amount: number; key: string; metadata?: Record<string, unknown>; at: number }): Promise<void>;
  seedStripeCustomer(tenant: string, customer: { customer: string; legacyCustomer?: string }): Promise<void>;
  setRejectRunEvents(enabled: boolean): Promise<void>;
  updateLegacyUsageWebhook(url: string): Promise<void>;
  seedJourneyAccount(input: { login: string; githubId: number; startingGrant: number; accountRef?: string }): Promise<{ tenant: string; token: string }>;
  /** Shared-agent cases only: queries on the membership tables, shared by both backends. */
  sharedAgentsQuery(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  /** Inbox storage contract: only the asking agent's index columns, on either backend. */
  inputIndex(agent: string): Promise<{ state: string; version: number; priority: string; priority_rank: number; blocking: boolean; responders: string[] }[]>;
  /** Trigger delivery/reservation state, shared by both backends. */
  triggerQuery(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  /** Channel cases only: a query on the channel tables (fixtures/channel-state.ts), which both backends share. */
  channelQuery(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
  /**
   * Email channel cases only (env AGENT_EMAIL_DOMAIN): a raw message as the backend's mail ingress receives it, with
   * SES's verdicts on it (fixtures/email.ts translates them for Workers). Resolves with the ingress's HTTP status.
   */
  deliverEmail(raw: string, receipt?: import("./fixtures/email.ts").Receipt): Promise<number>;
  drain(): Promise<void>;
  waitForAgentIdle(agent: string): Promise<void>;
  failAgentLoad(agent: string): Promise<void>;
  failInboxAgent(agent: string): Promise<void>;
  advanceInboxVersion(agent: string): Promise<void>;
  ageInboxReceipt(requestId: string): Promise<void>;
  pruneInboxReceipts(): Promise<number>;
  agentRecovery(agent: string): Promise<{ failures: number; retryAt: number }>;
  setAgentRecovery(agent: string, state: { failures?: number; retryAt?: number }): Promise<void>;
  failNextAdmissionWrite(agent: string): Promise<void>;
  now(): Promise<number>;
  /** Wait for real backend time; does not pretend the backend clock advanced. */
  advanceTime(ms: number): Promise<void>;
  close(): Promise<void>;
  stop(): Promise<void>;
  restart(options?: { env?: Record<string, string>; crash?: boolean }): Promise<void>;
  signFileToken(grant: FileGrant, expiresAt: number): Promise<string>;
  signIdentityToken(audience: string, claims: TokenClaims): Promise<string>;
}

export async function createFixture(t: T, options: FixtureOptions = {}): Promise<ContractFixture> {
  const env = { ...options.env, ...await options.prepare?.(t) };
  const backend = process.env.CONTRACT_BACKEND ?? "node";
  if (backend === "node") {
    const { createNodeFixture } = await import("./fixtures/node.ts");
    const fixture = await createNodeFixture(t, { ...options, env });
    t.after(observeBackend(fixture.base, backend));
    return fixture;
  }
  if (backend === "workers") {
    const { createWorkersFixture } = await import("./fixtures/workers.ts");
    const fixture = await createWorkersFixture(t, { ...options, env });
    t.after(observeBackend(fixture.base, backend));
    return fixture;
  }
  throw new Error(`Unknown CONTRACT_BACKEND: ${backend}`);
}
