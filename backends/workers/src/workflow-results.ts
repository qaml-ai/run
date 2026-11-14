import { DurableObject } from "cloudflare:workers";
import { repoContext, type RepoEnv } from "./repos/registry.ts";
import { branch } from "./repos/write.ts";
import { RepoError } from "./repos/repo-policy.ts";
import type { FileBindings } from "./files.ts";

export const RESULT_CACHE_LIMITS = Object.freeze({
  ttlMs: 7 * 86_400_000,
  entries: 2_000,
  bytes: 64 * 1024 * 1024,
  entryBytes: 1024 * 1024,
  forkEntryMs: 3 * 86_400_000,
});

/** What a scope's cache answers a lookup with. */
export type CachedResult = { value: unknown; source: string; fork?: { repo: string; version: string } };
type CacheEntry = { kind: string; key: string; source: string; workflow: string; value: unknown; fork?: { tenant: string; owner: string; repo: string; version: string } };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS results (
    kind TEXT NOT NULL, key_hash TEXT NOT NULL, key TEXT NOT NULL, source TEXT NOT NULL, source_workflow TEXT NOT NULL,
    body TEXT NOT NULL, bytes INTEGER NOT NULL, fork TEXT, created_at INTEGER NOT NULL, last_hit_at INTEGER NOT NULL,
    expires_at INTEGER, PRIMARY KEY (kind, key_hash))`,
  `CREATE INDEX IF NOT EXISTS results_lru ON results (last_hit_at)`,

];

export async function sha256(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The cache key of an effect: its canonical arguments (the VM's JSON, which already keys an effect's identity), and for
 * a repo reader its resolved tree, or a volume reader its seq before it started.
 */
export function cacheKey(args: string, baseSeq?: number | string) {
  return baseSeq === undefined ? args : `${args}\n@base:${baseSeq}`;
}

export class WorkflowResults extends DurableObject<FileBindings> {
  private readonly sql: SqlStorage;
  private writes = Promise.resolve();
  constructor(ctx: DurableObjectState, env: FileBindings) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("DROP TABLE IF EXISTS forks");
    for (const statement of SCHEMA) this.sql.exec(statement);
  }
  protected now() { return Date.now(); }
  /** The entry for `kind` and `key`, if live: its hit refreshes its life. */
  async lookup(kind: string, key: string): Promise<CachedResult | undefined> {
    const hash = await sha256(key), now = this.now();
    const row = this.sql.exec<{ key: string; body: string; source: string; last_hit_at: number; expires_at: number | null; fork: string | null }>(
      "SELECT key, body, source, last_hit_at, expires_at, fork FROM results WHERE kind = ? AND key_hash = ?", kind, hash).toArray()[0];
    // A hash is not the key: the stored key must be the same text.
    if (!row || row.key !== key) return undefined;
    if (Number(row.last_hit_at) + RESULT_CACHE_LIMITS.ttlMs <= now || (row.expires_at !== null && Number(row.expires_at) <= now)) {
      this.evict("kind = ? AND key_hash = ?", [kind, hash]);
      await this.arm();
      return undefined;
    }
    this.sql.exec("UPDATE results SET last_hit_at = ? WHERE kind = ? AND key_hash = ?", now, kind, hash);
    return { value: JSON.parse(row.body), source: row.source, ...(row.fork ? { fork: JSON.parse(row.fork) } : {}) };
  }

  /** Keep the first result for a key, within the size bounds. */
  put(entry: CacheEntry): Promise<{ stored: boolean }> {
    const write = this.writes.then(() => this.store(entry));
    this.writes = write.then(() => {}, () => {});
    return write;
  }

  private async store(entry: CacheEntry): Promise<{ stored: boolean }> {
    const body = JSON.stringify(entry.value ?? null), bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > RESULT_CACHE_LIMITS.entryBytes) return { stored: false };
    const hash = await sha256(entry.key);
    const now = this.now(), fork = entry.fork;
    if (this.sql.exec('SELECT 1 FROM results WHERE kind = ? AND key_hash = ?', entry.kind, hash).toArray().length) return { stored: false };
    let expiresAt: number | null = null;
    if (fork) {
      const ctx = await repoContext(this.env as RepoEnv, fork.tenant, fork.repo);
      const owner = `cache:${fork.tenant}:${fork.owner}`, name = `cache/${(await sha256(`${owner}\0${hash}`)).slice(0, 16)}`;
      let retained = await ctx.repo.ref(name);
      if (retained && retained.owner !== owner) throw new RepoError('Cache ref belongs to another owner', 409, 'exists');
      if (retained && (retained.version !== fork.version || retained.expiresAt! <= Date.now())) {
        await ctx.repo.deleteRef(name, retained.version);
        retained = null;
      }
      if (!retained) retained = await branch(ctx, { name, from: { version: fork.version }, owner, ttlSeconds: RESULT_CACHE_LIMITS.forkEntryMs / 1000 });
      if (!retained?.expiresAt) throw new Error('Cache ref has no expiry');
      expiresAt = Math.min(now + RESULT_CACHE_LIMITS.forkEntryMs, retained.expiresAt);
    }
    const inserted = this.sql.exec(
      `INSERT OR IGNORE INTO results (kind, key_hash, key, source, source_workflow, body, bytes, fork, created_at, last_hit_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.kind, hash, entry.key, entry.source, entry.workflow, body, bytes, fork ? JSON.stringify({ repo: fork.repo, version: fork.version }) : null, now, now,
      expiresAt).rowsWritten > 0;
    if (inserted) this.trim();
    await this.arm();
    // Trimmed straight away (the scope was full and this was the least recently hit): not kept after all.
    const kept = inserted && this.sql.exec("SELECT 1 FROM results WHERE kind = ? AND key_hash = ? AND source = ?", entry.kind, hash, entry.source).toArray().length > 0;
    return { stored: kept };
  }

  /** The scope's caps: the least recently hit entries go until it fits. */
  private trim() {
    const total = () => this.sql.exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM results").one();
    for (let current = total(); Number(current.n) > RESULT_CACHE_LIMITS.entries || Number(current.bytes) > RESULT_CACHE_LIMITS.bytes; current = total()) {
      const oldest = this.sql.exec<{ kind: string; key_hash: string }>("SELECT kind, key_hash FROM results ORDER BY last_hit_at, created_at LIMIT 1").one();
      this.evict("kind = ? AND key_hash = ?", [oldest.kind, oldest.key_hash]);
    }
  }

  private evict(where: string, params: unknown[]) {
    this.sql.exec(`DELETE FROM results WHERE ${where}`, ...params);
  }

  /** The next entry expiry. */
  private async arm() {
    const one = (query: string) => { const at = this.sql.exec<{ at: number | null }>(query).one().at; return at === null ? undefined : Number(at); };
    const lastHit = one("SELECT MIN(last_hit_at) AS at FROM results"), expires = one("SELECT MIN(expires_at) AS at FROM results");
    const candidates = [
      lastHit === undefined ? undefined : lastHit + RESULT_CACHE_LIMITS.ttlMs,
      expires,
    ].filter((at): at is number => at !== undefined);
    if (!candidates.length) { await this.ctx.storage.deleteAlarm(); return; }
    await this.ctx.storage.setAlarm(Math.max(Math.min(...candidates), this.now() + 1_000));
  }

  /** Expired entries go; camel-fs expires cache refs. */
  override async alarm() {
    const now = this.now();
    this.evict("last_hit_at <= ? OR (expires_at IS NOT NULL AND expires_at <= ?)", [now - RESULT_CACHE_LIMITS.ttlMs, now]);
    await this.arm();
  }

  /** TEST_MODE and operators: what the scope holds (no bodies). */
  async stats() {
    return this.sql.exec<{ n: number; bytes: number }>("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM results").one();
  }
}
