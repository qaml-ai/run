import { InvocationPool } from "./invocation-pool.ts";
import type { Billing, BillingReads, BillingTenantRow } from "./billing.ts";

/** Tenant policy and Postgres connections for one call. */
export class AgentInvocation {
  private readonly rows = new Map<string, Promise<BillingTenantRow>>();

  private pool?: InvocationPool;
  private ended = false;

  postgres(open: ConstructorParameters<typeof InvocationPool>[0]): InvocationPool {
    if (this.ended) throw new Error("Postgres invocation has ended");
    return this.pool ??= new InvocationPool(open);
  }

  async end() {
    this.ended = true;
    await this.pool?.end();
  }

  static async run<T>(work: (invocation: AgentInvocation) => T | Promise<T>): Promise<T> {
    const invocation = new AgentInvocation();
    try { return await work(invocation); }
    finally { await invocation.end(); }
  }

  tenant(billing: Billing, tenant: string): BillingReads {
    return { row: () => {
      let row = this.rows.get(tenant);
      if (!row) {
        row = billing.readTenant(tenant);
        this.rows.set(tenant, row);
      }
      return row;
    } };
  }
}
