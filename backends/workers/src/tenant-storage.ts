import type { TenantAdmission } from "./tenant.ts";

/** Native immutable file bytes. The tenant object orders deltas and daily repairs. */
export class TenantStorage {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly storage: DurableObjectStorage;
  private readonly bucket: R2Bucket;
  private readonly now: () => number;
  static readonly reconcileMs = 24 * 60 * 60 * 1000;

  constructor(
    storage: DurableObjectStorage,
    bucket: R2Bucket,
    now = Date.now,
  ) {
    this.storage = storage;
    this.bucket = bucket;
    this.now = now;
    this.initialize();
  }

  initialize() {
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS storage_objects (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL)");
    this.storage.sql.exec("CREATE TABLE IF NOT EXISTS storage_total (id INTEGER PRIMARY KEY CHECK(id=1), tenant TEXT NOT NULL, bytes INTEGER NOT NULL, reconciled_at INTEGER NOT NULL)");
  }

  private ordered<T>(work: () => Promise<T>): Promise<T> {
    const next = this.pending.then(work);
    this.pending = next.catch(() => {});
    return next;
  }

  private state() {
    return this.storage.sql.exec<{ tenant: string; bytes: number; reconciled_at: number }>("SELECT tenant,bytes,reconciled_at FROM storage_total WHERE id=1").toArray()[0];
  }

  private async ready(tenant: string) {
    this.initialize();
    const state = this.state();
    if (state && state.tenant !== tenant) throw new Error("Storage tenant changed");
    if (!state) await this.reconcile(tenant);
    else if (state.reconciled_at + TenantStorage.reconcileMs <= this.now())
      // A delayed alarm must not turn an ordinary upload into a full-prefix scan.
      await this.storage.setAlarm(this.now());
    return this.state()!;
  }

  private async reconcile(tenant: string) {
    const sql = this.storage.sql;
    // Stage on disk so a large tenant does not need its inventory held in memory.
    sql.exec("CREATE TABLE IF NOT EXISTS storage_listing (key TEXT PRIMARY KEY, bytes INTEGER NOT NULL)");
    sql.exec("DELETE FROM storage_listing");
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix: `files/${encodeURIComponent(tenant)}/`, ...(cursor ? { cursor } : {}) });
      this.storage.transactionSync(() => {
        for (const object of page.objects) sql.exec("INSERT OR REPLACE INTO storage_listing VALUES(?,?)", object.key, object.size);
      });
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    this.storage.transactionSync(() => {
      sql.exec("DELETE FROM storage_objects");
      sql.exec("INSERT INTO storage_objects SELECT * FROM storage_listing");
      sql.exec("INSERT OR REPLACE INTO storage_total SELECT 1,?,coalesce(sum(bytes),0),? FROM storage_listing", tenant, this.now());
      sql.exec("DELETE FROM storage_listing");
    });
    await this.storage.setAlarm(this.now() + TenantStorage.reconcileMs);
  }

  used(tenant: string): Promise<number> {
    return this.ordered(async () => (await this.ready(tenant)).bytes);
  }

  /** Absolute sizes make successful-write retries and late reconciliation idempotent. */
  record(tenant: string, key: string, bytes: number): Promise<void> {
    return this.ordered(async () => {
      if (!key.startsWith(`files/${encodeURIComponent(tenant)}/`) || !Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error("Invalid native storage object");
      await this.ready(tenant);
      this.storage.transactionSync(() => {
        const previous = this.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM storage_objects WHERE key=?", key).toArray()[0]?.bytes ?? 0;
        this.storage.sql.exec("INSERT OR REPLACE INTO storage_objects VALUES(?,?)", key, bytes);
        this.storage.sql.exec("UPDATE storage_total SET bytes=bytes+? WHERE id=1", bytes - previous);
      });
    });
  }

  deleted(tenant: string, key: string): Promise<void> {
    return this.ordered(async () => {
      if (!key.startsWith(`files/${encodeURIComponent(tenant)}/`)) throw new Error("Invalid native storage object");
      await this.ready(tenant);
      this.storage.transactionSync(() => {
        const previous = this.storage.sql.exec<{ bytes: number }>("SELECT bytes FROM storage_objects WHERE key=?", key).toArray()[0]?.bytes ?? 0;
        this.storage.sql.exec("DELETE FROM storage_objects WHERE key=?", key);
        this.storage.sql.exec("UPDATE storage_total SET bytes=bytes-? WHERE id=1", previous);
      });
    });
  }

  alarm(): Promise<void> {
    return this.ordered(async () => {
      this.initialize();
      const state = this.state();
      if (state) await this.reconcile(state.tenant);
    });
  }
}

export interface NativeStorageBindings {
  TENANTS: DurableObjectNamespace<TenantAdmission>;
}

export const recordNativeFile = (env: NativeStorageBindings, tenant: string, key: string, bytes: number) =>
  env.TENANTS.getByName(tenant).recordNativeFile(tenant, key, bytes);
export const deleteNativeFile = (env: NativeStorageBindings, tenant: string, key: string) =>
  env.TENANTS.getByName(tenant).deleteNativeFile(tenant, key);
