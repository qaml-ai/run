import { DurableObject } from "cloudflare:workers";
import type { LegacyGatewayTextOwner, LegacyGatewayTextRouteStore } from "./legacy-gateway-text.ts";

/** Every request for a tenant uses this same first-writer-wins routing table. */
export class LegacyGatewayTextRoutes extends DurableObject<unknown> implements LegacyGatewayTextRouteStore {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS run_owners (
      id TEXT PRIMARY KEY,
      native_fingerprint TEXT,
      subject TEXT,
      bucket TEXT,
      CHECK ((native_fingerprint IS NULL AND subject IS NULL AND bucket IS NULL) OR
        (native_fingerprint IS NOT NULL AND subject IS NOT NULL AND bucket IS NOT NULL))
    )`);
  }

  #current(id: string): LegacyGatewayTextOwner | null {
    const row = this.ctx.storage.sql.exec<{ native_fingerprint: string | null; subject: string; bucket: string }>(
      "SELECT native_fingerprint, subject, bucket FROM run_owners WHERE id = ?", id,
    ).toArray()[0];
    if (!row) return null;
    return row.native_fingerprint === null ? { owner: "legacy" } : {
      owner: "native", fingerprint: row.native_fingerprint, subject: row.subject, bucket: row.bucket,
    };
  }

  async lookup(id: string): Promise<LegacyGatewayTextOwner | null> {
    return this.#current(id);
  }

  async pin(id: string, owner: LegacyGatewayTextOwner): Promise<LegacyGatewayTextOwner> {
    return this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO run_owners VALUES (?, ?, ?, ?)", id,
        owner.owner === "native" ? owner.fingerprint : null, owner.owner === "native" ? owner.subject : null,
        owner.owner === "native" ? owner.bucket : null);
      return this.#current(id)!;
    });
  }
}
