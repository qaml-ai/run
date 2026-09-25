import { transaction, type Db, type Sql } from "./db.ts";
import type { Storage, StorageMeter } from "../shared/storage.ts";

export type OwnerKind = "agent" | "volume" | "tenant";

/** Whose an object is, from its key; undefined for keys that are no one's (not billed). */
export function storageOwner(key: string): { kind: OwnerKind; id: string } | undefined {
  const agent = /^(?:sessions\/|client-sessions\/)(client_[a-f0-9]{40})/.exec(key)?.[1];
  if (agent) return { kind: "agent", id: agent };
  const volume = /^volumes\/(vol_[a-f0-9]{24})\//.exec(key)?.[1];
  if (volume) return { kind: "volume", id: volume };
  const tenant = /^chunks\/([a-z0-9][a-z0-9-]{0,39})\//.exec(key)?.[1];
  if (tenant) return { kind: "tenant", id: tenant };
  return undefined;
}

/** Where objects are kept, by owner: what `reconcile` lists. */
const PREFIXES = ["sessions/", "client-sessions/", "volumes/", "chunks/"];

/**
 * What each owner keeps in Storage, tracked as objects are created and deleted, so
 * the daily storage charge reads a table instead of listing the bucket. Owners are
 * agents (their transcript and journal logs), volumes (tree logs and snapshot file
 * maps) and tenants (content-addressed file chunks, shared by a tenant's volumes and
 * so counted once each). Storage reports each object it creates or deletes to
 * `meter`; deltas are added up in memory and written every few seconds to
 * `storage_usage`, one row per owner. What this cannot see (a node that dies with
 * deltas unwritten, a delete that fails halfway, writes by nodes older than
 * metering) is drift that `reconcile`, a full listing, corrects.
 */
export class StorageUsage {
  readonly db: Db;
  private pending = new Map<string, number>();
  private timer?: ReturnType<typeof setTimeout>;
  private flushes: Promise<void> = Promise.resolve();
  private readonly flushMs: number;

  constructor(db: Db, options: { flushMs?: number } = {}) {
    this.db = db;
    this.flushMs = options.flushMs ?? 5_000;
  }

  /** For Storage: an object of `bytes` (negative: deleted) at `key`. */
  readonly meter: StorageMeter = (key, bytes) => {
    const owner = storageOwner(key);
    if (!owner || !bytes) return;
    const id = `${owner.kind}:${owner.id}`;
    this.pending.set(id, (this.pending.get(id) ?? 0) + bytes);
    this.timer ??= setTimeout(() => void this.flush().catch(error => console.error(JSON.stringify({ type: "storage_usage_flush_failed", error: String(error) }))), this.flushMs);
    this.timer.unref?.();
  };

  /** Write the deltas recorded so far. Flushes run one at a time; deltas a failed flush did not write are kept for the next. */
  flush(): Promise<void> {
    const run = this.flushes.then(() => this.write());
    this.flushes = run.catch(() => {});
    return run;
  }

  private async write() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.pending.size) return;
    const deltas = this.pending;
    this.pending = new Map();
    const rows = [...deltas].filter(([, bytes]) => bytes).map(([id, bytes]) => {
      const colon = id.indexOf(":");
      return { kind: id.slice(0, colon), owner: id.slice(colon + 1), bytes };
    });
    try {
      // In key order, so flushes on different nodes lock rows in the same order.
      await this.db.query(`
        insert into storage_usage (kind, owner, bytes)
        select kind, owner, bytes from jsonb_to_recordset($1::jsonb) as t(kind text, owner text, bytes bigint) order by kind, owner
        on conflict (kind, owner) do update set bytes = storage_usage.bytes + excluded.bytes`, [JSON.stringify(rows)]);
    } catch (error) {
      for (const [id, bytes] of deltas) this.pending.set(id, (this.pending.get(id) ?? 0) + bytes);
      this.timer ??= setTimeout(() => void this.flush().catch(() => {}), this.flushMs);
      this.timer.unref?.();
      throw error;
    }
  }

  /**
   * Bytes stored per tenant, as tracked: its chunks, its agents' logs (not purged ones',
   * whose objects are gone) and its volumes' (deleted volumes' too, as their objects stay).
   */
  async tenantBytes(sql: Sql = this.db): Promise<Map<string, number>> {
    const { rows } = await sql.query(`
      select tenant, sum(bytes) as bytes from (
        select u.owner as tenant, greatest(u.bytes, 0) as bytes from storage_usage u where u.kind = 'tenant'
        union all
        select a.tenant, greatest(u.bytes, 0) from storage_usage u join agents a on a.id = u.owner where u.kind = 'agent' and a.purged_at is null
        union all
        select v.tenant, greatest(u.bytes, 0) from storage_usage u join volumes v on v.id = u.owner where u.kind = 'volume'
      ) as owned group by tenant having sum(bytes) > 0`);
    return new Map(rows.map(row => [row.tenant as string, Number(row.bytes)]));
  }

  /**
   * Replace the tracked totals with a full listing of Storage: every owner's bytes as
   * listed, and owners with nothing listed removed. Deltas written while the listing
   * runs may be counted twice or not at all, for objects created or deleted meanwhile;
   * the error is that churn, until the next reconciliation. Notes the day, which the
   * storage job reads to tell when the next is due. Returns what it found, and each
   * tenant's bytes before and after; `dryRun` changes nothing.
   */
  async reconcile(storage: Storage, options: { now?: number; dryRun?: boolean } = {}) {
    if (!storage.objects) throw new Error("This storage cannot list its objects");
    await this.flush();
    const listed = new Map<string, { kind: OwnerKind; owner: string; bytes: number }>();
    for (const prefix of PREFIXES) {
      for await (const { key, bytes } of storage.objects(prefix)) {
        const owner = storageOwner(key);
        if (!owner) continue;
        const id = `${owner.kind}:${owner.id}`;
        const entry = listed.get(id) ?? { kind: owner.kind, owner: owner.id, bytes: 0 };
        entry.bytes += bytes;
        listed.set(id, entry);
      }
    }
    const rows = [...listed.values()];
    const bytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    let before = new Map<string, number>(), after = new Map<string, number>();
    const dryRun = new Error("dry run");
    await transaction(this.db, async sql => {
      await sql.query("lock table storage_usage in exclusive mode");
      before = await this.tenantBytes(sql);
      await sql.query("delete from storage_usage");
      for (let index = 0; index < rows.length; index += 5000) {
        await sql.query(`
          insert into storage_usage (kind, owner, bytes)
          select kind, owner, bytes from jsonb_to_recordset($1::jsonb) as t(kind text, owner text, bytes bigint)`, [JSON.stringify(rows.slice(index, index + 5000))]);
      }
      await sql.query(`
        insert into billing_jobs (name, done_day) values ('storage-reconcile', $1::date)
        on conflict (name) do update set done_day = excluded.done_day`, [new Date(options.now ?? Date.now()).toISOString().slice(0, 10)]);
      after = await this.tenantBytes(sql);
      if (options.dryRun) throw dryRun;
    }).catch(error => { if (error !== dryRun) throw error; });
    if (!options.dryRun) console.log(JSON.stringify({ type: "storage_reconciled", owners: rows.length, bytes }));
    return { owners: rows.length, bytes, before, after };
  }
}
