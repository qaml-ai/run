import { DurableObject } from "cloudflare:workers";
import type { LegacyGatewayTextOwner, LegacyGatewayTextRouteStore } from "./legacy-gateway-text.ts";

/** Every request for a tenant uses this same first-writer-wins routing table. */
export class LegacyGatewayTextRoutes extends DurableObject<unknown> implements LegacyGatewayTextRouteStore {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS run_owners (
      id TEXT PRIMARY KEY,
      native_fingerprint TEXT
    )`);
  }

  private current(id: string): LegacyGatewayTextOwner | null {
    const row = this.ctx.storage.sql.exec<{ native_fingerprint: string | null }>(
      "SELECT native_fingerprint FROM run_owners WHERE id = ?", id,
    ).toArray()[0];
    if (!row) return null;
    return row.native_fingerprint === null ? { owner: "legacy" } : { owner: "native", fingerprint: row.native_fingerprint };
  }

  async lookup(id: string): Promise<LegacyGatewayTextOwner | null> {
    return this.current(id);
  }

  async pin(id: string, owner: LegacyGatewayTextOwner): Promise<LegacyGatewayTextOwner> {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO run_owners VALUES (?, ?)", id, owner.owner === "native" ? owner.fingerprint : null);
      return this.current(id)!;
    });
  }
}
