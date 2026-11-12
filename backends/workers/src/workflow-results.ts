// The result cache (docs/design/workflow-simplification.md, "Cut 1"): workflows are not edited; to change one, its owner
// aborts it and starts a new one, and the new one's agent() and job() effects whose kind and arguments match a result an
// earlier workflow of the same owner finished are answered from here instead of running (and being paid for) again.
//
// One object per scope (`tenant:owner-agent`, or `tenant:api` for workflows started with an API key), SQLite:
// - an entry is keyed by its kind and its canonical arguments; an effect that reads a volume (an agent() on a fork of
//   `repo`, a job() `at` one) adds that volume's version when it was looked up, just before it started, so a result is
//   only found again while the volume is unchanged since (cacheKey; workflow-runner.ts `ResultCache`);
// - only ok results land here (the runner offers them), at most 1 MiB each;
// - an entry lives 7 days from its last hit; a scope keeps at most 2,000 entries and 64 MiB, the least recently hit
//   going first.
//
// Forks have one owner at a time. An agent() with `repo` answers with the fork its child edited, which the workflow that
// made it owns. When that workflow ends it asks here (`adopt`): if an entry names the fork, this object owns it from then
// on and deletes it when its last entry goes (retried from the alarm); if not, the workflow deletes it, and an entry that
// would name it later is refused. A hit never shares the fork: the workflow that got it makes its own copy
// (WorkflowObject). An entry with a fork lives at most `forkEntryMs` (3 days), well inside the life of the base snapshot its fork (and
// a copy of it) commits against (FORK_SNAPSHOT_TTL_MS).
//
// The journal is the truth: a hit is journaled with its outcome, so a replay never asks again.
import { DurableObject } from "cloudflare:workers";
import { deleteFork, FORK_SNAPSHOT_TTL_MS } from "./workflow-volumes.ts";
import type { FileBindings } from "./files.ts";

export const RESULT_CACHE_LIMITS = Object.freeze({
  ttlMs: 7 * 86_400_000,
  entries: 2_000,
  bytes: 64 * 1024 * 1024,
  entryBytes: 1024 * 1024,
  /**
   * An entry naming a fork: at most this long from when it was kept, so a hit's copy still has 4 days of its base
   * snapshot's life (FORK_SNAPSHOT_TTL_MS) to commit in.
   */
  forkEntryMs: FORK_SNAPSHOT_TTL_MS - 4 * 86_400_000,
  /** A fork its workflow kept for itself is refused this long (a put that lost the race with the end). */
  refusedMs: 86_400_000,
  /** A delete that failed is tried again this long after, doubling to an hour. */
  retryMs: 60_000, retryMaxMs: 3_600_000,
});

/** What a scope's cache answers a lookup with. */
export type CachedResult = { value: unknown; source: string };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS results (
    kind TEXT NOT NULL, key_hash TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, source_workflow TEXT NOT NULL,
    body TEXT NOT NULL, bytes INTEGER NOT NULL, fork TEXT, created_at INTEGER NOT NULL, last_hit_at INTEGER NOT NULL,
    expires_at INTEGER, PRIMARY KEY (kind, key_hash))`,
  `CREATE INDEX IF NOT EXISTS results_lru ON results (last_hit_at)`,
  // A fork an entry names: owned once its workflow handed it over (`adopt`), refused once its workflow kept it;
  // `delete_at` once an owned fork has no entry left.
  `CREATE TABLE IF NOT EXISTS forks (fork TEXT PRIMARY KEY, tenant TEXT NOT NULL, owned INTEGER NOT NULL DEFAULT 0,
    refused_at INTEGER, delete_at INTEGER, tries INTEGER NOT NULL DEFAULT 0)`,
];

export async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The cache key of an effect: its canonical arguments (the VM's JSON, which already keys an effect's identity), and for
 * one that reads a volume that volume's version before it started (`baseSeq`).
 */
export function cacheKey(args: string, baseSeq?: number) {
  return baseSeq === undefined ? args : `${args}\n@base:${baseSeq}`;
}

export class WorkflowResults extends DurableObject<FileBindings> {
  private readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: FileBindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }
  protected now() { return Date.now(); }
  /** Delete a fork this object owns (a seam for tests). */
  protected async deleteFork(tenant: string, fork: string) { await deleteFork(this.env, tenant, fork); }

  /** The entry for `kind` and `key`, if live: its hit refreshes its life. */
  async lookup(kind: string, key: string): Promise<CachedResult | undefined> {
    const hash = await sha256(key), now = this.now();
    const row = this.sql.exec<{ key: string; body: string; source: string; last_hit_at: number; expires_at: number | null }>(
      "SELECT key, body, source, last_hit_at, expires_at FROM results WHERE kind = ? AND key_hash = ?", kind, hash).toArray()[0];
    // A hash is not the key: the stored key must be the same text.
    if (!row || row.key !== key) return undefined;
    if (Number(row.last_hit_at) + RESULT_CACHE_LIMITS.ttlMs <= now || (row.expires_at !== null && Number(row.expires_at) <= now)) {
      this.evict("kind = ? AND key_hash = ?", [kind, hash]);
      await this.arm();
      return undefined;
    }
    this.sql.exec("UPDATE results SET last_hit_at = ? WHERE kind = ? AND key_hash = ?", now, kind, hash);
    return { value: JSON.parse(row.body), source: row.source };
  }

  /**
   * Keep a finished result. The first result for a key stays (a later equal one is not stored); too large, or naming a
   * fork its workflow already kept for itself, it is not stored. `stored` says whether it was.
   */
  async put(entry: { kind: string; key: string; source: string; workflow: string; value: unknown; fork?: { tenant: string; volume: string } }): Promise<{ stored: boolean }> {
    const body = JSON.stringify(entry.value ?? null), bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > RESULT_CACHE_LIMITS.entryBytes) return { stored: false };
    const hash = await sha256(entry.key);
    // From here to the insert nothing awaits, so an `adopt` cannot come in between the refusal check and the insert.
    const now = this.now(), fork = entry.fork;
    if (fork && this.sql.exec("SELECT 1 FROM forks WHERE fork = ? AND refused_at IS NOT NULL", fork.volume).toArray().length) return { stored: false };
    const inserted = this.sql.exec(
      `INSERT OR IGNORE INTO results (kind, key_hash, key, source, source_workflow, body, bytes, fork, created_at, last_hit_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.kind, hash, entry.key, entry.source, entry.workflow, body, bytes, fork?.volume ?? null, now, now,
      fork ? now + RESULT_CACHE_LIMITS.forkEntryMs : null).rowsWritten > 0;
    if (inserted && fork) this.sql.exec("INSERT OR IGNORE INTO forks (fork, tenant) VALUES (?, ?)", fork.volume, fork.tenant);
    if (inserted) this.trim();
    await this.arm();
    // Trimmed straight away (the scope was full and this was the least recently hit): not kept after all.
    const kept = inserted && this.sql.exec("SELECT 1 FROM results WHERE kind = ? AND key_hash = ? AND source = ?", entry.kind, hash, entry.source).toArray().length > 0;
    return { stored: kept };
  }

  /**
   * The workflow that made `fork` ended: this object takes it over if an entry names it, and deletes it when the last
   * such entry goes. If none does, or the fork's base moved on since it was made (`moved`: a commit landed there, so no
   * key its entries have can be made again), it stays the workflow's to delete, and an entry naming it is refused from
   * now on. Answers whether this object owns it now.
   */
  async adopt(fork: string, tenant: string, moved = false): Promise<boolean> {
    if (moved) this.sql.exec("DELETE FROM results WHERE fork = ?", fork);
    if (this.sql.exec("SELECT 1 FROM results WHERE fork = ? LIMIT 1", fork).toArray().length) {
      this.sql.exec("INSERT INTO forks (fork, tenant, owned) VALUES (?, ?, 1) ON CONFLICT (fork) DO UPDATE SET owned = 1", fork, tenant);
      return true;
    }
    this.sql.exec(`INSERT INTO forks (fork, tenant, refused_at) VALUES (?, ?, ?)
      ON CONFLICT (fork) DO UPDATE SET refused_at = excluded.refused_at, owned = 0, delete_at = NULL`, fork, tenant, this.now());
    await this.arm();
    return false;
  }

  /** The scope's caps: the least recently hit entries go until it fits. */
  private trim() {
    const total = () => this.sql.exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM results").one();
    for (let current = total(); Number(current.n) > RESULT_CACHE_LIMITS.entries || Number(current.bytes) > RESULT_CACHE_LIMITS.bytes; current = total()) {
      const oldest = this.sql.exec<{ kind: string; key_hash: string }>("SELECT kind, key_hash FROM results ORDER BY last_hit_at, created_at LIMIT 1").one();
      this.evict("kind = ? AND key_hash = ?", [oldest.kind, oldest.key_hash]);
    }
  }

  /** Remove entries; an owned fork no entry names any more is due to be deleted. */
  private evict(where: string, params: unknown[]) {
    const forks = this.sql.exec<{ fork: string | null }>(`SELECT fork FROM results WHERE ${where}`, ...params).toArray()
      .map(row => row.fork).filter((fork): fork is string => fork !== null);
    this.sql.exec(`DELETE FROM results WHERE ${where}`, ...params);
    for (const fork of forks) if (!this.sql.exec("SELECT 1 FROM results WHERE fork = ? LIMIT 1", fork).toArray().length) {
      this.sql.exec("UPDATE forks SET delete_at = COALESCE(delete_at, ?) WHERE fork = ? AND owned = 1", this.now(), fork);
      // Not handed over yet: its workflow still owns it (and deletes it at its end, adopt finding no entry).
      this.sql.exec("DELETE FROM forks WHERE fork = ? AND owned = 0 AND refused_at IS NULL", fork);
    }
  }

  /** Delete the owned forks that are due; one that fails is tried again later. */
  private async deleteDue() {
    const now = this.now();
    for (const row of this.sql.exec<{ fork: string; tenant: string; tries: number }>("SELECT fork, tenant, tries FROM forks WHERE delete_at IS NOT NULL AND delete_at <= ?", now).toArray()) {
      try {
        await this.deleteFork(row.tenant, row.fork);
        this.sql.exec("DELETE FROM forks WHERE fork = ?", row.fork);
      } catch (error) {
        const tries = Number(row.tries) + 1;
        this.sql.exec("UPDATE forks SET tries = ?, delete_at = ? WHERE fork = ?", tries,
          now + Math.min(RESULT_CACHE_LIMITS.retryMaxMs, RESULT_CACHE_LIMITS.retryMs * 2 ** (tries - 1)), row.fork);
        console.error(JSON.stringify({ type: "workflow_cache_fork_delete_failed", fork: row.fork, tries, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
      }
    }
  }

  /** The next expiry, fork delete, or refusal to forget. */
  private async arm() {
    const one = (query: string) => { const at = this.sql.exec<{ at: number | null }>(query).one().at; return at === null ? undefined : Number(at); };
    const lastHit = one("SELECT MIN(last_hit_at) AS at FROM results"), expires = one("SELECT MIN(expires_at) AS at FROM results");
    const refused = one("SELECT MIN(refused_at) AS at FROM forks WHERE refused_at IS NOT NULL");
    const candidates = [
      lastHit === undefined ? undefined : lastHit + RESULT_CACHE_LIMITS.ttlMs,
      expires,
      one("SELECT MIN(delete_at) AS at FROM forks"),
      refused === undefined ? undefined : refused + RESULT_CACHE_LIMITS.refusedMs,
    ].filter((at): at is number => at !== undefined);
    if (!candidates.length) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), this.now() + 1_000));
  }

  /** Expired entries go (their owned forks with them), due forks are deleted, old refusals are forgotten. */
  override async alarm() {
    const now = this.now();
    this.evict("last_hit_at <= ? OR (expires_at IS NOT NULL AND expires_at <= ?)", [now - RESULT_CACHE_LIMITS.ttlMs, now]);
    await this.deleteDue();
    this.sql.exec("DELETE FROM forks WHERE owned = 0 AND refused_at IS NOT NULL AND refused_at <= ?", now - RESULT_CACHE_LIMITS.refusedMs);
    await this.arm();
  }

  /** TEST_MODE and operators: what the scope holds (no bodies). */
  async stats() {
    return this.sql.exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM results").one();
  }
}
