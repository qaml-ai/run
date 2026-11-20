import { TenantDO } from "../../worker/src/tenant-do.ts";
import { extractApiError } from "../../worker/src/types.ts";

export class CreditReserveTestTenant extends TenantDO {
  async ledger() {
    return this.ctx.storage.sql.exec<{ amount_usd: number; kind: string }>(
      "SELECT amount_usd, kind FROM credit_ledger ORDER BY rowid",
    ).toArray();
  }

  async reserveCollision(ref: string) {
    this.ctx.storage.sql.exec(
      "INSERT INTO credit_ledger (id, ref_id, amount_usd, kind, created_at) VALUES (?1, ?2, 0, 'grant', 0)",
      "fixture-reserved-ref", `builder-cutover-reserve:${ref}`,
    );
  }
}

export default {
  async fetch(request: Request, env: { TEST_TENANT: DurableObjectNamespace<CreditReserveTestTenant> }) {
    const [, mode, tenantId] = new URL(request.url).pathname.split("/");
    const tenant = env.TEST_TENANT.getByName(tenantId);
    const input = await request.json<{ amount?: number; ref?: string }>();
    try {
      switch (mode) {
        case "init": return Response.json(await tenant.initTenant({
          tenantId, name: tenantId, initialCreditsUsd: input.amount, keyId: "bare-test", keyPrefix: "test", keyHash: "hash",
        }));
        case "settle": return Response.json(await tenant.settleUsage({
          refId: input.ref ?? "", costUsd: input.amount ?? 0, model: "fixture/model", inputTokens: 10, outputTokens: 20, vmMs: 0,
        }));
        case "grant": return Response.json(await tenant.addCredits({ refId: input.ref ?? "", amountUsd: input.amount ?? 0 }));
        case "collision": await tenant.reserveCollision(input.ref ?? ""); return Response.json(null);
        case "read": return Response.json({ billing: await tenant.getBillingSummary(), ledger: await tenant.ledger() });
        default: return new Response(null, { status: 404 });
      }
    } catch (error) {
      const info = extractApiError(error);
      return Response.json({ code: info?.code ?? "fixture_error" }, { status: info?.status ?? 500 });
    }
  },
};
