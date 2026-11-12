// The result cache (docs/design/workflow-simplification.md, "Cut 1"): workflows are not edited; to change one, its owner
// aborts it and starts a new one, and the new one's agent() and job() effects whose kind and arguments match a result an
// earlier workflow of the same owner finished are answered from here instead of running (and being paid for) again.
//
// One object per scope (`tenant:owner-agent`, or `tenant:api` for workflows started with an API key), SQLite:
// - an entry is keyed by its kind and its canonical arguments; an effect that reads a volume (an agent() on a fork of
//   `repo`, a job() `at` one) adds that volume's version when it was looked up, just before it started, so a result is
//   only found again while the volume is unchanged since (cacheKey; workflow-runner.ts `ResultCache`);
// - only ok results land here (the runner offers them: workflow-runner.ts `ResultCache`), at most 1 MiB each;
// - an entry lives 7 days from its last hit; a scope keeps at most 2,000 entries and 64 MiB, the least recently hit
//   going first;
// - an entry whose result names a fork keeps that fork alive (the source workflow's janitor pins it, workflow-forks.ts);
//   when the entry goes, the source workflow is told (`forkReleased`) and deletes the fork, retried from this object's
//   alarm until it answers.
// The journal is the truth: a hit is journaled with its outcome, so a replay never asks again.
import { DurableObject } from "cloudflare:workers";

export const RESULT_CACHE_LIMITS = Object.freeze({
  ttlMs: 7 * 86_400_000,
  entries: 2_000,
  bytes: 64 * 1024 * 1024,
  entryBytes: 1024 * 1024,
  /** A release the source workflow did not take is tried again this long after, doubling to an hour. */
  releaseRetryMs: 60_000, releaseRetryMaxMs: 3_600_000,
});

export interface ResultCacheEnv {
  WORKFLOWS?: { getByName(name: string): { forkReleased(fork: string): Promise<unknown> } };
}

/** What a scope's cache answers a lookup with. */
export type CachedResult = { value: unknown; source: string };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS results (
    kind TEXT NOT NULL, key_hash TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, source_workflow TEXT NOT NULL,
    body TEXT NOT NULL, bytes INTEGER NOT NULL, fork TEXT, created_at INTEGER NOT NULL, last_hit_at INTEGER NOT NULL,
    PRIMARY KEY (kind, key_hash))`,
  `CREATE INDEX IF NOT EXISTS results_lru ON results (last_hit_at)`,
  `CREATE TABLE IF NOT EXISTS releases (fork TEXT PRIMARY KEY, workflow TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL)`,
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

export class WorkflowResults extends DurableObject<ResultCacheEnv> {
  private readonly sql: SqlStorage;
  constructor(ctx: DurableObjectState, env: ResultCacheEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
  }
  private now() { return Date.now(); }

  /** The entry for `kind` and `key`, if live: its hit refreshes its life. */
  async lookup(kind: string, key: string): Promise<CachedResult | undefined> {
    const hash = await sha256(key), now = this.now();
    const row = this.sql.exec<{ key: string; body: string; source: string; last_hit_at: number }>(
      "SELECT key, body, source, last_hit_at FROM results WHERE kind = ? AND key_hash = ?", kind, hash).toArray()[0];
    // A hash is not the key: the stored key must be the same text.
    if (!row || row.key !== key) return undefined;
    if (Number(row.last_hit_at) + RESULT_CACHE_LIMITS.ttlMs <= now) { await this.evict(`kind = ? AND key_hash = ?`, [kind, hash]); await this.arm(); return undefined; }
    this.sql.exec("UPDATE results SET last_hit_at = ? WHERE kind = ? AND key_hash = ?", now, kind, hash);
    return { value: JSON.parse(row.body), source: row.source };
  }

  /**
   * Keep a finished result. The first result for a key stays (a later equal one is not stored); `stored` says whether
   * this one was, so its workflow keeps its fork pinned only then. Too large, it is not stored.
   */
  async put(entry: { kind: string; key: string; source: string; workflow: string; value: unknown; fork?: string }): Promise<{ stored: boolean }> {
    const body = JSON.stringify(entry.value ?? null), bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > RESULT_CACHE_LIMITS.entryBytes) return { stored: false };
    const hash = await sha256(entry.key), now = this.now();
    const inserted = this.sql.exec(
      `INSERT OR IGNORE INTO results (kind, key_hash, key, source, source_workflow, body, bytes, fork, created_at, last_hit_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.kind, hash, entry.key, entry.source, entry.workflow, body, bytes, entry.fork ?? null, now, now).rowsWritten > 0;
    if (inserted) await this.trim();
    await this.arm();
    // Trimmed straight away (the scope was full and this was the least recently hit): not kept after all.
    const kept = inserted && this.sql.exec("SELECT 1 FROM results WHERE kind = ? AND key_hash = ? AND source = ?", entry.kind, hash, entry.source).toArray().length > 0;
    return { stored: kept };
  }

  /** The scope's caps: the least recently hit entries go until it fits. */
  private async trim() {
    const total = () => this.sql.exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM results").one();
    for (let current = total(); Number(current.n) > RESULT_CACHE_LIMITS.entries || Number(current.bytes) > RESULT_CACHE_LIMITS.bytes; current = total()) {
      const oldest = this.sql.exec<{ kind: string; key_hash: string }>("SELECT kind, key_hash FROM results ORDER BY last_hit_at, created_at LIMIT 1").one();
      await this.evict("kind = ? AND key_hash = ?", [oldest.kind, oldest.key_hash]);
    }
  }

  /** Remove entries; each that kept a fork has its source workflow told, now or from the alarm. */
  private async evict(where: string, params: unknown[]) {
    const gone = this.sql.exec<{ fork: string | null; source_workflow: string }>(`SELECT fork, source_workflow FROM results WHERE ${where}`, ...params).toArray();
    this.sql.exec(`DELETE FROM results WHERE ${where}`, ...params);
    for (const row of gone) if (row.fork)
      this.sql.exec("INSERT OR IGNORE INTO releases (fork, workflow, tries, next_at) VALUES (?, ?, 0, ?)", row.fork, row.source_workflow, this.now());
  }

  /** Tell source workflows their forks are free; one that does not answer is told again later. */
  private async release() {
    const now = this.now();
    for (const row of this.sql.exec<{ fork: string; workflow: string; tries: number }>("SELECT fork, workflow, tries FROM releases WHERE next_at <= ?", now).toArray()) {
      // Still kept by another entry (the same fork answered twice): not free yet.
      if (this.sql.exec("SELECT 1 FROM results WHERE fork = ? LIMIT 1", row.fork).toArray().length) { this.sql.exec("DELETE FROM releases WHERE fork = ?", row.fork); continue; }
      try {
        if (this.env.WORKFLOWS) await this.env.WORKFLOWS.getByName(row.workflow).forkReleased(row.fork);
        this.sql.exec("DELETE FROM releases WHERE fork = ?", row.fork);
      } catch (error) {
        const tries = Number(row.tries) + 1;
        this.sql.exec("UPDATE releases SET tries = ?, next_at = ? WHERE fork = ?", tries,
          now + Math.min(RESULT_CACHE_LIMITS.releaseRetryMaxMs, RESULT_CACHE_LIMITS.releaseRetryMs * 2 ** (tries - 1)), row.fork);
        console.error(JSON.stringify({ type: "workflow_cache_release_failed", fork: row.fork, workflow: row.workflow, tries, error: error instanceof Error ? error.message.slice(0, 200) : String(error) }));
      }
    }
  }

  /** The next expiry or release retry. */
  private async arm() {
    const expiry = this.sql.exec<{ at: number | null }>("SELECT MIN(last_hit_at) AS at FROM results").one().at;
    const release = this.sql.exec<{ at: number | null }>("SELECT MIN(next_at) AS at FROM releases").one().at;
    const candidates = [expiry === null ? undefined : Number(expiry) + RESULT_CACHE_LIMITS.ttlMs, release === null ? undefined : Number(release)].filter((at): at is number => at !== undefined);
    if (!candidates.length) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), this.now() + 1_000));
  }

  /** Expired entries go (their forks released), then releases are told. */
  override async alarm() {
    await this.evict("last_hit_at <= ?", [this.now() - RESULT_CACHE_LIMITS.ttlMs]);
    await this.release();
    await this.arm();
  }

  /** TEST_MODE and operators: what the scope holds (no bodies). */
  async stats() {
    return this.sql.exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM results").one();
  }
}
