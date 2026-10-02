import type { Storage } from "../shared/storage.ts";
import type { Db } from "./db.ts";
import { errorText } from "./protocol.ts";
import type { VolumeService } from "./volumes.ts";

const chunkKey = (tenant: string, hash: string) => `chunks/${tenant}/${hash.slice(0, 2)}/${hash}`;

/**
 * Storage garbage collection: chunks (chunks/<tenant>/…) nothing refers to any more stop being stored
 * and metered, and deleted volumes' own objects go. A chunk is referred to by a live volume's files, a
 * live volume's snapshots, or a FileRef an agent holds (`chunk_pins`, written as each FileRef is made).
 *
 * Collection is mark and sweep in two passes: a chunk found unreferenced becomes a candidate, and is
 * deleted by a later pass, at least `graceMs` on, if it is still unreferenced and has not been written
 * or pinned since (`chunk_touches`). A writer touches a chunk before it writes it, and the deleting pass
 * reads the chunk, deletes it, then checks for a touch again, putting the chunk back if one came: so a
 * writer whose write found the chunk there (a no-op) never loses it. Only chunks a write stored (with a
 * touch) are ever collected.
 */
export class StorageGc {
  private readonly db: Db;
  private readonly storage: Storage;
  private readonly volumes: VolumeService;
  private readonly graceMs: number;
  private readonly intervalMs: number;
  /** Mark and find what is due, and log it, but delete nothing (AGENT_GC_DRY_RUN). */
  private readonly dryRun: boolean;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(options: { db: Db; storage: Storage; volumes: VolumeService; graceMs?: number; intervalMs?: number; dryRun?: boolean }) {
    this.db = options.db;
    this.storage = options.storage;
    this.volumes = options.volumes;
    this.graceMs = options.graceMs ?? 24 * 60 * 60_000;
    this.intervalMs = options.intervalMs ?? 6 * 60 * 60_000;
    this.dryRun = options.dryRun ?? false;
  }

  /** Collect one tenant's storage now. */
  async run(tenant: string, now = Date.now()) {
    const marked = await this.mark(tenant);
    // Deleted volumes' own objects: their chunks are unreferenced now, and collected below as any.
    const { rows: deleted } = await this.db.query("select id from volumes where tenant = $1 and deleted_at is not null and deleted_at <= $2 and purged_at is null", [tenant, now - this.graceMs]);
    if (!this.dryRun) for (const { id } of deleted) await this.volumes.purge(id);
    const touched = (await this.db.query("select hash, at from chunk_touches where tenant = $1", [tenant])).rows as { hash: string; at: string }[];
    const unreferenced = touched.filter(row => !marked.has(row.hash)).map(row => row.hash);
    // Candidates referred to again, or touched since they were found, start over.
    await this.db.query("delete from gc_candidates where tenant = $1 and not (hash = any($2::text[]))", [tenant, unreferenced]);
    await this.db.query(`delete from gc_candidates c using chunk_touches t where c.tenant = $1 and t.tenant = c.tenant and t.hash = c.hash and t.at > c.first_seen`, [tenant]);
    // Due: found unreferenced by an earlier pass a grace period ago, unreferenced still, and not written or pinned since.
    const { rows: due } = await this.db.query("select hash, first_seen from gc_candidates where tenant = $1 and first_seen <= $2", [tenant, now - this.graceMs]);
    // What this pass finds, a later one collects.
    await this.db.query("insert into gc_candidates (tenant, hash, first_seen) select $1, hash, $3 from unnest($2::text[]) as hash on conflict do nothing", [tenant, unreferenced, now]);
    let removed = 0, restored = 0;
    if (this.dryRun) {
      const would = (due as { hash: string }[]).filter(row => !marked.has(row.hash)).map(row => row.hash);
      console.log(JSON.stringify({ type: "storage_gc_dry_run", tenant, wouldRemove: would.length, volumes: deleted.map(row => row.id), chunks: would.slice(0, 100) }));
      return { marked: marked.size, candidates: unreferenced.length, removed: 0, restored: 0, purgedVolumes: 0, wouldRemove: would.length };
    }
    for (const { hash, first_seen: seen } of due as { hash: string; first_seen: string }[]) {
      if (marked.has(hash)) continue;
      // Claimed by taking its candidate row: of two collections at once (a lease that ran over), one deletes it.
      if (!(await this.db.query("delete from gc_candidates where tenant = $1 and hash = $2 and first_seen = $3", [tenant, hash, seen])).rowCount) continue;
      const key = chunkKey(tenant, hash);
      const data = await this.storage.readBlob(key);
      if (data) await this.storage.removeBlob(key);
      // A writer that touched it meanwhile may have found it still there and not written it: put it back.
      const again = (await this.db.query("select 1 from chunk_touches where tenant = $1 and hash = $2 and at > $3", [tenant, hash, seen])).rowCount;
      if (again) {
        if (data) { await this.storage.writeBlob(key, data); restored++; }
      } else {
        await this.db.query("delete from chunk_touches where tenant = $1 and hash = $2 and at <= $3", [tenant, hash, seen]);
        if (data) removed++;
      }
    }
    return { marked: marked.size, candidates: unreferenced.length, removed, restored, purgedVolumes: deleted.length, wouldRemove: 0 };
  }

  /** Every chunk something refers to: live volumes' files and snapshots, and agents' pins. */
  private async mark(tenant: string) {
    const marked = new Set<string>();
    const add = (hashes: Iterable<string>) => { for (const hash of hashes) marked.add(hash); };
    const { rows: volumes } = await this.db.query("select id from volumes where tenant = $1 and deleted_at is null", [tenant]);
    for (const { id } of volumes) add(await this.volumes.referencedChunks(id));
    const { rows: snapshots } = await this.db.query("select s.id, s.volume from volume_snapshots s join volumes v on v.id = s.volume where v.tenant = $1 and v.deleted_at is null", [tenant]);
    for (const { id, volume } of snapshots) add(await this.volumes.snapshotChunks(volume, id));
    add((await this.db.query("select hash from chunk_pins where tenant = $1", [tenant])).rows.map(row => row.hash as string));
    return marked;
  }

  /** Collect the next tenant that is due, if any: claimed with a lease, so nodes share the work. */
  async next(now = Date.now()) {
    const { rows } = await this.db.query(`
      update storage_gc set claimed_until = $2, next_run = $3
      where tenant = (select tenant from storage_gc where next_run <= $1 and (claimed_until is null or claimed_until < $1) order by next_run limit 1 for update skip locked)
      returning tenant`, [now, now + 60 * 60_000, now + this.intervalMs]);
    if (!rows[0]) return undefined;
    try { return { tenant: rows[0].tenant as string, ...await this.run(rows[0].tenant, now) }; }
    finally { await this.db.query("update storage_gc set claimed_until = null where tenant = $1", [rows[0].tenant]).catch(() => {}); }
  }

  start(pollMs = 60_000) {
    this.timer ??= setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.next()
        .then(result => { if (result?.removed || result?.purgedVolumes) console.log(JSON.stringify({ type: "storage_collected", ...result })); })
        .catch(error => console.error(JSON.stringify({ type: "storage_gc_failed", error: errorText(error) })))
        .finally(() => { this.running = false; });
    }, pollMs);
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
