import { guardAlarms } from "./alarm-guard.ts";
import { DurableObject } from "cloudflare:workers";
import { CapacityError, CapacityLedger, tenantCaps, type CapacityEnv, type Grant, type SlotKind, type TenantLimits } from "./workflow-capacity.ts";

/** What a workflow is told when a request it queued is granted. WorkflowObject implements it (`WORKFLOWS` binding). */
export interface CapacityListener { capacityGranted(tenant: string, grants: Grant[]): Promise<unknown> }
type Env = CapacityEnv & { WORKFLOWS?: { getByName(name: string): CapacityListener } };

/**
 * One tenant's workflow capacity (workflow-capacity.ts), named by the tenant id. Waiting workflows are woken by the
 * release, expiry or close that frees a slot, through `capacityGranted`, never by polling. Its one alarm is for the next
 * lease to expire, set strictly in the future: an alarm never arms itself for now (the wake spiral of #794). A workflow
 * that misses a wake learns its grants from its next `renew`.
 */
export class WorkflowCapacity extends DurableObject<Env> {
  private readonly ledger: CapacityLedger;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    guardAlarms(this, ctx, "WorkflowCapacity", { test: (env as { TEST_MODE?: unknown }).TEST_MODE === "1" });
    this.ledger = new CapacityLedger(ctx.storage.sql, write => ctx.storage.transactionSync(write));
  }

  /** `limits`: the tenant's busy-agent and computer limits, which the host resolves (billing, tenants). */
  async open(workflow: string, asked: { concurrency?: number; jobConcurrency?: number; leaseMs?: number }, limits: TenantLimits) {
    return refusable(async () => {
      const { caps, grants } = this.ledger.open(workflow, asked, tenantCaps(this.env, this.tenant(), limits));
      await this.settled(grants);
      return { ok: true as const, caps };
    });
  }
  async acquire(workflow: string, kind: SlotKind, key: string, leaseMs?: number) {
    return refusable(async () => {
      const { acquired, grants } = this.ledger.acquire(workflow, kind, key, leaseMs);
      await this.settled(grants);
      return { ok: true as const, ...acquired };
    });
  }
  async release(workflow: string, id: string) {
    await this.settled(this.ledger.release(workflow, id));
  }
  async renew(workflow: string, leaseMs?: number) {
    return refusable(async () => {
      const { held, waiting, grants } = this.ledger.renew(workflow, leaseMs);
      await this.settled(grants);
      return { ok: true as const, held, waiting };
    });
  }
  async close(workflow: string) {
    await this.settled(this.ledger.close(workflow));
  }
  async usage(workflow?: string) { return this.ledger.usage(workflow); }

  /** The tenant this object is for: it is named by the tenant id (`workflowCapacity`). */
  private tenant() {
    const name = this.ctx.id.name;
    if (!name) throw new Error("WorkflowCapacity is addressed by tenant name");
    return name;
  }

  async alarm() {
    await this.settled(this.ledger.expire());
  }

  /** After a change: the alarm moves to the next expiry (never now), then the workflows granted a slot are told. */
  private async settled(grants: Grant[]) {
    const next = this.ledger.nextExpiry();
    const current = await this.ctx.storage.getAlarm();
    if (next === undefined) { if (current !== null) await this.ctx.storage.deleteAlarm(); }
    else if (current === null || current > next || current <= Date.now()) await this.ctx.storage.setAlarm(next);
    if (!grants.length) return;
    const byWorkflow = new Map<string, Grant[]>();
    for (const grant of grants) byWorkflow.set(grant.workflow, [...byWorkflow.get(grant.workflow) ?? [], grant]);
    const workflows = this.env.WORKFLOWS;
    if (!workflows) return;
    const tenant = this.tenant();
    this.ctx.waitUntil(Promise.all([...byWorkflow].map(([workflow, granted]) => workflows.getByName(workflow).capacityGranted(tenant, granted)
      .catch(error => console.error(JSON.stringify({ type: "workflow_capacity_wake_failed", workflow, error: error instanceof Error ? error.name : "Error" }))))));
  }
}

/** A refusal the caller acts on (`workflow_limit`, `workflow_not_open`, `invalid`) as a value: RPC keeps no error class. */
async function refusable<T>(run: () => Promise<T>): Promise<T | { ok: false; code: string; message: string }> {
  try { return await run(); }
  catch (error) { if (error instanceof CapacityError) return { ok: false, code: error.code, message: error.message }; throw error; }
}

/** A tenant's capacity object, or undefined where the binding is absent (a deployment without workflows). */
export function workflowCapacity(env: { WORKFLOW_CAPACITY?: DurableObjectNamespace<WorkflowCapacity> }, tenant: string) {
  return env.WORKFLOW_CAPACITY?.getByName(tenant);
}
