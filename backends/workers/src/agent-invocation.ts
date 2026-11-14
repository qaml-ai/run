import type { Billing, BillingReads, BillingTenantRow } from "./billing.ts";

export class AgentInvocation {
  private readonly rows = new Map<string, Promise<BillingTenantRow>>();

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
